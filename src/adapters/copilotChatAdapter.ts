/**
 * Copilot Chat adapter.
 *
 * Reads VS Code Copilot Chat session files from disk. Sessions are stored
 * as JSONL append-only mutation logs (VS Code ≥ 1.109) or legacy flat JSON
 * files (pre-1.109).
 *
 * Storage locations (macOS paths shown; equivalent paths exist on other OSs):
 *   Workspace sessions:
 *     ~/Library/Application Support/Code/User/workspaceStorage/<wsId>/chatSessions/<sessionId>.jsonl
 *   Empty-window sessions:
 *     ~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/<sessionId>.jsonl
 *   Transferred sessions:
 *     ~/Library/Application Support/Code/User/globalStorage/transferredChatSessions/<sessionId>.json
 *
 * The JSONL format is a mutation log where each line is:
 *   { kind: 0, v: <full snapshot> }               — initial state
 *   { kind: 1, k: [<path>], v: <val> }             — set field at path k to v
 *   { kind: 2, k: [<path>], v: <val>, i?: <idx> }  — splice the array at
 *     path k: replace elements from index i (or the array's current
 *     length if i is omitted) onward with the elements of v. This is how
 *     VS Code persists both plain appends (new requests; new streamed
 *     response parts) and "supersede the not-yet-finalized tail" flushes
 *     that happen while a response is still streaming in.
 *
 * The storage layer is model-agnostic: conversations using external/BYOK
 * model providers are stored in exactly the same location and format as
 * default GitHub Copilot model conversations. The selected model identifier
 * (including `isBYOK: true`) is recorded in `inputState.selectedModel` and
 * per-request in `requests[].modelId`.
 */

import * as fs from "fs";
import * as path from "path";

import type {
  Adapter,
  ExportedSession,
  FileAccessEntry,
  SessionInfo,
  ThinkingBlock,
  Turn,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import { expandHome, relativeToProject, tryTimestamp } from "../utils";
import { warn } from "../logger";

// ── Copilot Chat serialization types (subset relevant to us) ───────

interface CopilotMutation {
  kind: 0 | 1 | 2;
  v: unknown;
  k?: Array<string | number>;
  /** Splice start index for kind:2 (array splice); absent = append at end. */
  i?: number;
}

interface CopilotSelectedModel {
  identifier: string;
  metadata: {
    name?: string;
    vendor?: string;
    family?: string;
    isBYOK?: boolean;
    [key: string]: unknown;
  };
}

interface CopilotInputState {
  selectedModel?: CopilotSelectedModel;
  inputText?: string;
  [key: string]: unknown;
}

interface CopilotResponsePart {
  // Some VS Code versions omit "kind" for a plain markdown chunk,
  // serializing a bare IMarkdownString ({value, supportHtml, ...})
  // instead of wrapping it as { kind: "markdownContent", content: {...} }.
  kind?: string;
  // markdownContent
  content?: { value?: string } | string;
  // thinking / bare markdown chunk
  value?: string;
  id?: string;
  reasoningDurationMs?: number;
  // toolInvocationSerialized (older/fixture shape)
  toolName?: string;
  input?: string;
  // toolInvocationSerialized (real VS Code shape): the tool's stable id
  // (e.g. "copilot_readFile") and a localized message whose `uris` map
  // resolves any file references it mentions.
  toolId?: string;
  invocationMessage?: { uris?: Record<string, { path?: string; fsPath?: string; external?: string }> };
  // textEditGroup
  uri?: { fsPath?: string; external?: string } | string;
  edits?: Array<{ range?: unknown; newText?: string }>;
  // inlineReference
  name?: string;
  // generic
  [key: string]: unknown;
}

interface CopilotChatRequest {
  requestId: string;
  message: string | { text?: string } | unknown;
  response?: CopilotResponsePart[] | undefined;
  timestamp?: number;
  responseTimestamp?: number;
  modelId?: string;
  agent?: { name?: string; extensionId?: string };
  editedFileEvents?: Array<{
    uri?: { fsPath?: string; external?: string } | string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface CopilotSessionData {
  version: number;
  sessionId: string;
  creationDate?: number;
  initialLocation?: string;
  responderUsername?: string;
  customTitle?: string;
  requests: CopilotChatRequest[];
  inputState?: CopilotInputState;
  workingDirectory?: string;
  [key: string]: unknown;
}

// ── Adapter ────────────────────────────────────────────────────────

export class CopilotChatAdapter implements Adapter {
  readonly source = "copilot-chat" as const;

  /**
   * Optional override for the storage root. When running inside VS Code,
   * the extension passes a getter that reads the
   * `convoThinkExport.copilotChatStoragePath` setting. When running in
   * plain Node (tests), the caller can set this directly.
   */
  private _storageRootOverride: string | undefined;

  /**
   * TEST-ONLY: like setStorageRoot(), but does NOT count as an explicit
   * override for hasExplicitOverride() — lets tests simulate "this fake
   * directory IS the computed platform default root" (which, like the
   * real VS Code User dir, may contain stray top-level files) without
   * depending on the real machine's actual default directory.
   */
  private _storageRootAsDefault: string | undefined;

  setStorageRoot(filePath: string): void {
    this._storageRootOverride = filePath;
  }

  setStorageRootAsDefault(filePath: string): void {
    this._storageRootAsDefault = filePath;
  }

  /**
   * Returns the storage root directory. When overridden (tests), returns
   * the override directly. Otherwise, resolves the VS Code user data dir
   * for the current platform.
   */
  private storageRoot(): string {
    if (this._storageRootOverride) {
      return this._storageRootOverride;
    }
    if (this._storageRootAsDefault) {
      return this._storageRootAsDefault;
    }
    // Lazy-load vscode so the adapter is usable outside VS Code (tests)
    const vscode = require("vscode") as typeof import("vscode");
    const override = vscode.workspace
      .getConfiguration("convoThinkExport")
      .get<string>("copilotChatStoragePath");
    if (override) {
      return expandHome(override);
    }
    return defaultCopilotStorageRoot();
  }

  /**
   * True when the caller explicitly configured a storage root — via
   * setStorageRoot() or the convoThinkExport.copilotChatStoragePath
   * setting. False when falling back to the computed platform default
   * (or the test-only setStorageRootAsDefault() stand-in for it) — in
   * that case the "scan root directly" fallbacks below must NOT run,
   * since the real default VS Code User dir always contains unrelated
   * top-level files (settings.json, chatLanguageModels.json, ...) that
   * are not chat sessions.
   */
  private hasExplicitOverride(): boolean {
    if (this._storageRootOverride) {
      return true;
    }
    try {
      const vscode = require("vscode") as typeof import("vscode");
      const override = vscode.workspace
        .getConfiguration("convoThinkExport")
        .get<string>("copilotChatStoragePath");
      return !!override;
    } catch {
      return false;
    }
  }

  async discoverSessions(projectPath?: string): Promise<SessionInfo[]> {
    const root = this.storageRoot();
    const sessions: SessionInfo[] = [];

    if (!fs.existsSync(root)) {
      warn(`Copilot Chat storage root not found: ${root}`);
      return sessions;
    }

    // The VS Code User directory contains:
    //   workspaceStorage/<wsId>/chatSessions/<sessionId>.jsonl
    //   globalStorage/emptyWindowChatSessions/<sessionId>.jsonl
    //   globalStorage/transferredChatSessions/<sessionId>.json
    //
    // We scan up to 3 levels deep to find all session files.

    // 1. Workspace sessions: root/workspaceStorage/<wsId>/chatSessions/
    const workspaceStorageDir = path.join(root, "workspaceStorage");
    if (fs.existsSync(workspaceStorageDir)) {
      for (const wsId of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
        if (!wsId.isDirectory()) {
          continue;
        }
        const chatDir = path.join(workspaceStorageDir, wsId.name, "chatSessions");
        if (fs.existsSync(chatDir)) {
          sessions.push(...await this.scanSessionsDir(chatDir, path.join(workspaceStorageDir, wsId.name)));
        }
      }
    }

    // 2. Empty-window sessions: root/globalStorage/emptyWindowChatSessions/
    const emptyWindowDir = path.join(root, "globalStorage", "emptyWindowChatSessions");
    if (fs.existsSync(emptyWindowDir)) {
      sessions.push(...await this.scanSessionsDir(emptyWindowDir, emptyWindowDir));
    }

    // 3. Transferred sessions: root/globalStorage/transferredChatSessions/
    const transferredDir = path.join(root, "globalStorage", "transferredChatSessions");
    if (fs.existsSync(transferredDir)) {
      sessions.push(...await this.scanSessionsDir(transferredDir, transferredDir));
    }

    // 4 & 5 only apply when the user explicitly pointed
    // copilotChatStoragePath at a non-standard directory — never against
    // the computed default root, which always contains unrelated
    // top-level files (settings.json, chatLanguageModels.json, ...).
    if (this.hasExplicitOverride()) {
      // 4. If the root itself contains chatSessions/ (when override points
      //    directly at a workspace storage dir), scan it too.
      const directChatDir = path.join(root, "chatSessions");
      if (fs.existsSync(directChatDir)) {
        sessions.push(...await this.scanSessionsDir(directChatDir, root));
      }

      // 5. If the root itself contains .jsonl/.json files (when override
      //    points directly at emptyWindowChatSessions), scan it.
      const rootFiles = this.hasSessionFiles(root);
      if (rootFiles) {
        sessions.push(...await this.scanSessionsDir(root, root));
      }
    }

    // Deduplicate by session_id
    const seen = new Set<string>();
    const unique = sessions.filter((s) => {
      if (seen.has(s.session_id)) {
        return false;
      }
      seen.add(s.session_id);
      return true;
    });

    // Filter by project path if provided
    if (projectPath) {
      return unique.filter(
        (s) => s.project_path.includes(projectPath) || projectPath.includes(s.project_path)
      );
    }

    return unique;
  }

  /** Check if a directory directly contains .jsonl or .json session files. */
  private hasSessionFiles(dir: string): boolean {
    try {
      return fs.readdirSync(dir).some((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
    } catch {
      return false;
    }
  }

  private async scanSessionsDir(dir: string, parentDir: string): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return sessions;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl") && !file.endsWith(".json")) {
        continue;
      }
      const sessionId = file.replace(/\.(jsonl|json)$/, "");
      const filePath = path.join(dir, file);

      let sessionData: CopilotSessionData | undefined;
      try {
        sessionData = await this.readSessionFile(filePath);
      } catch (e) {
        warn(`Failed to read Copilot Chat session ${filePath}: ${e}`);
        continue;
      }

      if (!sessionData) {
        continue;
      }

      const started_at = tryTimestamp(sessionData.creationDate);
      const projectPath = sessionData.workingDirectory || path.basename(parentDir);
      const title = sessionData.customTitle || this.deriveTitle(sessionData) || sessionId;

      sessions.push({
        source: this.source,
        session_id: sessionId,
        project_path: projectPath,
        started_at,
        label: `${title} (copilot-chat)`,
      });
    }

    return sessions;
  }

  async loadSession(sessionId: string, _projectPath?: string): Promise<ExportedSession> {
    const root = this.storageRoot();
    const filePath = this.findSessionFile(root, sessionId);

    if (!filePath) {
      throw new Error(`Copilot Chat session file not found for session ID: ${sessionId}`);
    }

    const data = await this.readSessionFile(filePath);
    if (!data) {
      throw new Error(`Failed to parse Copilot Chat session: ${sessionId}`);
    }

    const turns = this.parseRequests(data);
    const started_at = tryTimestamp(data.creationDate) || new Date().toISOString();
    const projectPath = data.workingDirectory || "";

    // Extract source version from the selected model if available
    let sourceVersion: string | undefined;
    const model = data.inputState?.selectedModel;
    if (model?.metadata?.vendor && model?.metadata?.name) {
      sourceVersion = `${model.metadata.vendor}/${model.metadata.name}`;
    }

    return {
      schema_version: SCHEMA_VERSION,
      session: {
        source: this.source,
        source_version: sourceVersion,
        session_id: sessionId,
        project_path: projectPath,
        started_at,
        exported_at: new Date().toISOString(),
      },
      turns,
    };
  }

  // ── File reading / mutation log replay ───────────────────────────

  private findSessionFile(root: string, sessionId: string): string | undefined {
    const searchDirs: string[] = [];

    // Workspace sessions: root/workspaceStorage/<wsId>/chatSessions/
    const workspaceStorageDir = path.join(root, "workspaceStorage");
    if (fs.existsSync(workspaceStorageDir)) {
      try {
        for (const wsId of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
          if (wsId.isDirectory()) {
            searchDirs.push(path.join(workspaceStorageDir, wsId.name, "chatSessions"));
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Empty-window and transferred sessions
    searchDirs.push(path.join(root, "globalStorage", "emptyWindowChatSessions"));
    searchDirs.push(path.join(root, "globalStorage", "transferredChatSessions"));

    // Direct chatSessions dir and the root itself are only valid search
    // locations when the user explicitly overrode the storage path — see
    // hasExplicitOverride() in discoverSessions() for why.
    if (this.hasExplicitOverride()) {
      searchDirs.push(path.join(root, "chatSessions"));
      searchDirs.push(root);
    }

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const ext of [".jsonl", ".json"]) {
        const candidate = path.join(dir, `${sessionId}${ext}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  /**
   * Read and parse a Copilot Chat session file. Handles both the current
   * JSONL mutation log format (≥1.109) and the legacy flat JSON format.
   */
  private async readSessionFile(filePath: string): Promise<CopilotSessionData | undefined> {
    const ext = path.extname(filePath);

    if (ext === ".json") {
      // Legacy flat JSON
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as CopilotSessionData;
      return this.isValidSessionData(parsed) ? parsed : undefined;
    }

    // JSONL mutation log — replay operations.
    //
    // Deliberately split on "\n" ourselves rather than using Node's
    // readline module: readline (like the ECMAScript LineTerminator
    // production it's modeled on) also treats U+2028 LINE SEPARATOR and
    // U+2029 PARAGRAPH SEPARATOR as line breaks. Real message text can
    // legitimately contain those characters (observed in practice), and
    // they need no special escaping inside a JSON string — but readline
    // would shred a single mutation's string value into several bogus
    // "lines" at every occurrence, each failing to parse on its own. A
    // plain split on the literal LF byte matches how the file was
    // actually written, one JSON value per line.
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines: CopilotMutation[] = [];
    for (const physicalLine of raw.split("\n")) {
      const trimmed = physicalLine.trim();
      if (!trimmed) {
        continue;
      }
      try {
        lines.push(JSON.parse(trimmed) as CopilotMutation);
      } catch (e) {
        warn(`Failed to parse line in ${filePath}: ${e}`);
      }
    }

    if (lines.length === 0) {
      return undefined;
    }

    // Replay the mutation log
    let state: Record<string, unknown> = {};

    for (const op of lines) {
      switch (op.kind) {
        case 0:
          // Initial snapshot — replace state entirely
          state = (op.v as Record<string, unknown>) || {};
          break;
        case 1:
          // Set field at path k to value v
          if (op.k && op.k.length > 0) {
            this.setAtPath(state, op.k, op.v);
          }
          break;
        case 2:
          // Splice at path k: replace the tail from index i (or the
          // array's end) with the elements of v.
          if (op.k && op.k.length > 0) {
            this.spliceAtPath(state, op.k, op.i, op.v);
          }
          break;
        default:
          warn(`Unknown mutation kind in Copilot Chat session: ${op.kind}`);
      }
    }

    return this.isValidSessionData(state) ? (state as unknown as CopilotSessionData) : undefined;
  }

  /**
   * Guards against treating an unrelated file (e.g. VS Code's own
   * settings.json or chatLanguageModels.json, which can sit alongside
   * real session files when scanning a broad or user-overridden
   * directory) as a Copilot Chat session. A real session always has a
   * `requests` array, even if empty.
   */
  private isValidSessionData(data: unknown): data is CopilotSessionData {
    return !!data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).requests);
  }

  /** Set a value at a nested path within the state object. */
  private setAtPath(obj: Record<string, unknown>, pathParts: Array<string | number>, value: unknown): void {
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const key = pathParts[i];
      if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[pathParts[pathParts.length - 1]] = value;
  }

  /**
   * Apply a "kind: 2" mutation at path k: replace the tail of the array
   * starting at `index` (or at the array's current end if `index` is
   * omitted) with the elements of `value`. This single splice covers
   * every real-world case observed: a plain append (new request; new
   * response parts with no prior flush for this request) and "finalize
   * the in-flight tail" flushes, where the last not-yet-finalized
   * part(s) get superseded by a fuller version plus whatever new parts
   * have since appeared, with `index` pointing at the first superseded
   * element. Array.prototype.splice clamps an out-of-range index itself.
   */
  private spliceAtPath(
    obj: Record<string, unknown>,
    pathParts: Array<string | number>,
    index: number | undefined,
    value: unknown
  ): void {
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const key = pathParts[i];
      if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    const lastKey = pathParts[pathParts.length - 1];
    if (!Array.isArray(current[lastKey])) {
      current[lastKey] = [];
    }
    const arr = current[lastKey] as unknown[];
    const items = Array.isArray(value) ? value : [value];
    const start = typeof index === "number" ? index : arr.length;
    arr.splice(start, arr.length - start, ...items);
  }

  // ── Parsing requests into canonical turns ────────────────────────

  private parseRequests(data: CopilotSessionData): Turn[] {
    const turns: Turn[] = [];
    const projectPath = data.workingDirectory || "";

    for (const req of data.requests) {
      const timestamp = tryTimestamp(req.timestamp) || new Date().toISOString();
      const responseTimestamp = tryTimestamp(req.responseTimestamp) || timestamp;

      // User turn
      const userContent = this.extractUserMessage(req);
      turns.push({
        id: req.requestId || `turn-${turns.length + 1}`,
        role: "user",
        timestamp,
        thinking: { status: "not_supported", text: null },
        content: userContent,
        file_access: [],
      });

      // Assistant turn
      const responseParts = req.response || [];
      const thinking = this.extractThinking(responseParts);
      const content = this.extractAssistantContent(responseParts);
      const fileAccess = this.extractFileAccess(responseParts, req, projectPath);

      turns.push({
        id: req.requestId ? `${req.requestId}-response` : `turn-${turns.length + 1}`,
        role: "assistant",
        timestamp: responseTimestamp,
        thinking,
        content,
        file_access: fileAccess,
      });
    }

    return turns;
  }

  private extractUserMessage(req: CopilotChatRequest): string {
    const msg = req.message;
    if (typeof msg === "string") {
      return msg;
    }
    if (msg && typeof msg === "object" && "text" in msg) {
      return (msg as { text?: string }).text || "";
    }
    // Fallback: try to stringify
    if (msg) {
      try {
        return JSON.stringify(msg);
      } catch {
        return "";
      }
    }
    return "";
  }

  private extractThinking(parts: CopilotResponsePart[]): ThinkingBlock {
    const thinkingParts = parts.filter((p) => p.kind === "thinking");

    if (thinkingParts.length === 0) {
      return { status: "not_supported", text: null };
    }

    // Concatenate all thinking parts
    const text = thinkingParts
      .map((p) => {
        if (typeof p.value === "string") {
          return p.value;
        }
        if (typeof p.content === "string") {
          return p.content;
        }
        return "";
      })
      .filter((t) => t.length > 0)
      .join("\n");

    if (text.trim().length > 0) {
      return { status: "present", text };
    }

    // Thinking parts exist but are empty
    return { status: "empty", text: null };
  }

  private extractAssistantContent(parts: CopilotResponsePart[]): string {
    const contentParts: string[] = [];

    for (const part of parts) {
      if (part.kind === undefined && typeof part.value === "string") {
        // Bare IMarkdownString chunk (no "kind" tag) — see the
        // CopilotResponsePart comment above.
        if (part.value.length > 0) {
          contentParts.push(part.value);
        }
        continue;
      }
      switch (part.kind) {
        case "markdownContent":
        case "markdownVuln": {
          const text = this.extractMarkdownText(part);
          if (text) {
            contentParts.push(text);
          }
          break;
        }
        case "treeData":
        case "inlineReference":
        case "progressMessage":
        case "commandButton":
        case "warning":
        case "systemNotification":
        case "questionCarousel":
        case "planReview":
        case "elicitation2":
        case "hook":
        case "autoModeResolution":
          // These are UI parts — skip for text content
          break;
        case "thinking":
        case "toolInvocationSerialized":
        case "textEditGroup":
        case "notebookEditGroup":
        case "codeblockUri":
        case "multiDiffData":
        case "undoStop":
          // Handled separately (thinking / file access)
          break;
        default:
          // Unknown part — try to extract text if possible
          break;
      }
    }

    return contentParts.join("\n\n");
  }

  private extractMarkdownText(part: CopilotResponsePart): string {
    // markdownContent: { content: { value: "..." } } or { content: "..." }
    const content = part.content;
    if (typeof content === "string") {
      return content;
    }
    if (content && typeof content === "object" && "value" in content) {
      return (content as { value?: string }).value || "";
    }
    return "";
  }

  private extractFileAccess(
    parts: CopilotResponsePart[],
    req: CopilotChatRequest,
    projectPath: string
  ): FileAccessEntry[] {
    const entries: FileAccessEntry[] = [];

    for (const part of parts) {
      switch (part.kind) {
        case "toolInvocationSerialized": {
          const toolName = part.toolName || part.toolId || "Tool";
          const inputStr = typeof part.input === "string" ? part.input : "";
          const action = this.inferToolAction(toolName);
          const filePath =
            this.extractFilePathFromToolInput(inputStr) ||
            this.extractFilePathFromUri(part.uri) ||
            this.extractFilePathFromInvocationMessage(part.invocationMessage);
          if (filePath) {
            entries.push({
              path: relativeToProject(filePath, projectPath),
              action,
              tool: toolName,
            });
          }
          break;
        }
        case "textEditGroup":
        case "notebookEditGroup": {
          const filePath = this.extractFilePathFromUri(part.uri);
          if (filePath) {
            const editCount = Array.isArray(part.edits) ? part.edits.length : 0;
            entries.push({
              path: relativeToProject(filePath, projectPath),
              action: "edit",
              tool: part.kind === "notebookEditGroup" ? "NotebookEdit" : "TextEdit",
              diff_summary: editCount > 0 ? `${editCount} edit(s)` : undefined,
            });
          }
          break;
        }
        case "inlineReference": {
          const filePath = this.extractFilePathFromUri(part.uri);
          if (filePath) {
            entries.push({
              path: relativeToProject(filePath, projectPath),
              action: "read",
              tool: "Reference",
            });
          }
          break;
        }
        case "codeblockUri": {
          const filePath = this.extractFilePathFromUri(part.uri);
          if (filePath) {
            entries.push({
              path: relativeToProject(filePath, projectPath),
              action: "read",
              tool: "CodeBlock",
            });
          }
          break;
        }
        case "multiDiffData": {
          // Multi-file diff — may contain multiple URIs
          const diffs = part as unknown as { edits?: Array<{ uri?: { fsPath?: string; external?: string } | string }> };
          if (Array.isArray(diffs.edits)) {
            for (const edit of diffs.edits) {
              const filePath = this.extractFilePathFromUri(edit.uri);
              if (filePath) {
                entries.push({
                  path: relativeToProject(filePath, projectPath),
                  action: "edit",
                  tool: "MultiDiff",
                });
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }

    // Also include editedFileEvents from the request level
    if (req.editedFileEvents) {
      for (const evt of req.editedFileEvents) {
        const filePath = this.extractFilePathFromUri(evt.uri);
        if (filePath) {
          entries.push({
            path: relativeToProject(filePath, projectPath),
            action: "edit",
            tool: "FileEvent",
          });
        }
      }
    }

    return entries;
  }

  private inferToolAction(toolName: string): FileAccessEntry["action"] {
    const lower = toolName.toLowerCase();
    if (lower.includes("read") || lower.includes("view") || lower.includes("grep") || lower.includes("search")) {
      return "read";
    }
    if (lower.includes("edit") || lower.includes("write") || lower.includes("create") || lower.includes("insert")) {
      return "edit";
    }
    if (lower.includes("delete") || lower.includes("remove")) {
      return "delete";
    }
    return "read";
  }

  private extractFilePathFromToolInput(input: string): string | undefined {
    if (!input) {
      return undefined;
    }
    // Try to parse as JSON and look for common file path fields
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      const keys = ["file_path", "filePath", "path", "uri", "fileName", "filename"];
      for (const key of keys) {
        if (typeof parsed[key] === "string") {
          return parsed[key] as string;
        }
        if (parsed[key] && typeof parsed[key] === "object") {
          const obj = parsed[key] as { fsPath?: string; external?: string };
          if (obj.fsPath) {
            return obj.fsPath;
          }
          if (obj.external) {
            return this.uriToPath(obj.external);
          }
        }
      }
    } catch {
      // Not JSON — check if it looks like a file path
      if (input.startsWith("/") || input.includes("/") || input.includes("\\")) {
        return input;
      }
    }
    return undefined;
  }

  private extractFilePathFromUri(
    uri: { fsPath?: string; external?: string; path?: string } | string | undefined
  ): string | undefined {
    if (!uri) {
      return undefined;
    }
    if (typeof uri === "string") {
      return this.uriToPath(uri);
    }
    if (uri.fsPath) {
      return uri.fsPath;
    }
    if (uri.external) {
      return this.uriToPath(uri.external);
    }
    // VS Code's URI.toJSON() form (e.g. inside invocationMessage.uris)
    // has neither fsPath nor external, only the bare posix-style path.
    if (uri.path) {
      return uri.path;
    }
    return undefined;
  }

  /**
   * Real toolInvocationSerialized parts carry no flat `input`/`uri`
   * field; the file(s) they touched are keyed by markdown-link URI
   * inside invocationMessage.uris, e.g.
   * { "file:///foo.ts#10-20": { fsPath: "/foo.ts", ... } }.
   */
  private extractFilePathFromInvocationMessage(
    message: CopilotResponsePart["invocationMessage"]
  ): string | undefined {
    const uris = message?.uris;
    if (!uris) {
      return undefined;
    }
    for (const value of Object.values(uris)) {
      const filePath = this.extractFilePathFromUri(value);
      if (filePath) {
        return filePath;
      }
    }
    return undefined;
  }

  private uriToPath(uri: string): string {
    // Convert file:// URI to filesystem path
    if (uri.startsWith("file://")) {
      try {
        return decodeURIComponent(uri.replace(/^file:\/\//, ""));
      } catch {
        return uri.replace(/^file:\/\//, "");
      }
    }
    return uri;
  }

  private deriveTitle(data: CopilotSessionData): string | undefined {
    const firstReq = data.requests?.[0];
    if (!firstReq) {
      return undefined;
    }
    const msg = this.extractUserMessage(firstReq);
    if (msg) {
      // Truncate to a reasonable title length
      const title = msg.split("\n")[0].trim();
      return title.length > 60 ? title.substring(0, 60) + "..." : title;
    }
    return undefined;
  }
}

// ── Platform-specific default storage root ─────────────────────────

/**
 * Returns the default Copilot Chat storage root for the current platform.
 * This is the VS Code `User` directory (parent of workspaceStorage and
 * globalStorage). The adapter scans subdirectories for `chatSessions/`
 * folders and also checks `globalStorage/emptyWindowChatSessions`.
 */
function defaultCopilotStorageRoot(): string {
  const home = require("os").homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Code", "User");
    case "win32":
      return path.join(home, "AppData", "Roaming", "Code", "User");
    case "linux":
      return path.join(home, ".config", "Code", "User");
    default:
      return path.join(home, ".config", "Code", "User");
  }
}
