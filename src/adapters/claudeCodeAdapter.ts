/**
 * Claude Code adapter.
 *
 * Reads `~/.claude/projects/<project>/<session>.jsonl` files.
 *
 * Each line is a JSON object with a top-level `type` field. The two that
 * carry turns are "user" and "assistant"; the actual message payload lives
 * nested under `message.content`, which is either a plain string or an
 * array of content blocks:
 *  - "text"             → visible reply / user text
 *  - "thinking"         → extended-thinking block (sometimes empty even
 *                          though a `signature` is present — known bug,
 *                          we mark `status: "empty"` in that case)
 *  - "redacted_thinking" → thinking redacted by the API
 *  - "tool_use"          → tool invocation (Read, Edit, Write, Bash, ...)
 *  - "tool_result"       → result of a tool invocation (appears inside a
 *                          later "user" line; carries no turn content)
 *
 * Everything else at the top level ("queue-operation", "attachment",
 * "file-history-snapshot", "ai-title", ...) is session/UI bookkeeping and
 * does not produce a turn.
 */

import * as fs from "fs";
import * as path from "path";

import type {
  Adapter,
  ExportedSession,
  FileAccessAction,
  FileAccessEntry,
  SessionInfo,
  ThinkingBlock,
  Turn,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import { expandHome, relativeToProject, tryTimestamp } from "../utils";
import { warn } from "../logger";

/** Non-turn bookkeeping line types that are expected and safe to skip silently. */
const IGNORED_LINE_TYPES = new Set([
  "queue-operation",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "ai-title",
  "last-prompt",
  "summary",
]);

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeMessage {
  role?: string;
  content?: string | ClaudeContentBlock[];
}

interface ClaudeLine {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: ClaudeMessage;
  // session metadata
  sessionId?: string;
  cwd?: string;
  version?: string;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly source = "claude-code" as const;

  /**
   * Optional override for the projects directory. When running inside
   * VS Code, the extension passes a getter that reads the
   * `convoThinkExport.claudeProjectsPath` setting. When running in
   * plain Node (smoke tests), the caller can set this directly.
   */
  private _projectsDirOverride: string | undefined;

  setProjectsDir(path: string): void {
    this._projectsDirOverride = path;
  }

  private projectsDir(): string {
    if (this._projectsDirOverride) {
      return this._projectsDirOverride;
    }
    // Lazy-load vscode so the adapter is usable outside VS Code (tests)
    const vscode = require("vscode") as typeof import("vscode");
    const override = vscode.workspace
      .getConfiguration("convoThinkExport")
      .get<string>("claudeProjectsPath");
    return expandHome(override || "~/.claude/projects");
  }

  async discoverSessions(projectPath?: string): Promise<SessionInfo[]> {
    const dir = this.projectsDir();
    const sessions: SessionInfo[] = [];

    if (!fs.existsSync(dir)) {
      warn(`Claude Code projects directory not found: ${dir}`);
      return sessions;
    }

    // Each subdirectory in projectsDir represents a project (encoded path).
    const projectDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const pdir of projectDirs) {
      const fullDir = path.join(dir, pdir.name);
      const jsonlFiles = fs.readdirSync(fullDir)
        .filter((f) => f.endsWith(".jsonl"));

      for (const file of jsonlFiles) {
        const sessionId = file.replace(/\.jsonl$/, "");
        const filePath = path.join(fullDir, file);

        // Try to get started_at from first line and project path from dir name.
        let started_at: string | undefined;
        try {
          const firstLine = fs.readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim())[0];
          if (firstLine) {
            const parsed = JSON.parse(firstLine) as ClaudeLine;
            started_at = tryTimestamp(parsed.timestamp);
          }
        } catch {
          /* ignore */
        }

        sessions.push({
          source: this.source,
          session_id: sessionId,
          project_path: pdir.name,
          started_at,
          label: `${pdir.name} / ${sessionId}`,
        });
      }
    }

    // Filter by project path if provided
    if (projectPath) {
      const encoded = projectPath.replace(/\//g, "-");
      return sessions.filter((s) => s.project_path.includes(encoded) || s.project_path.includes(projectPath));
    }

    return sessions;
  }

  async loadSession(sessionId: string, projectPath?: string): Promise<ExportedSession> {
    const dir = this.projectsDir();
    // Find the file
    let filePath: string | undefined;

    if (projectPath) {
      const candidate = path.join(dir, projectPath, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
      }
    }

    if (!filePath) {
      // Search all subdirectories
      const projectDirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const pdir of projectDirs) {
        const candidate = path.join(dir, pdir.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          filePath = candidate;
          projectPath = pdir.name;
          break;
        }
      }
    }

    if (!filePath) {
      throw new Error(`Session file not found for session ID: ${sessionId}`);
    }
    const lines = await this.readJsonl(filePath);
    // The dash-encoded directory name (e.g. "-Users-me-project") isn't a real
    // filesystem path, so use the `cwd` recorded on the transcript lines
    // themselves to resolve file_access paths relative to the actual project.
    const cwd = lines.find((l) => l.cwd)?.cwd || "";
    const turns = this.parseLines(lines, cwd);

    // Extract metadata from first line if available
    const firstLine = lines[0] || {};
    const started_at = tryTimestamp(firstLine.timestamp) || new Date().toISOString();

    return {
      schema_version: SCHEMA_VERSION,
      session: {
        source: this.source,
        source_version: firstLine.version,
        session_id: sessionId,
        project_path: projectPath || "",
        started_at,
        exported_at: new Date().toISOString(),
      },
      turns,
    };
  }

  private async readJsonl(filePath: string): Promise<ClaudeLine[]> {
    // Deliberately split on the literal "\n" byte rather than using Node's
    // readline module: readline also treats U+2028 LINE SEPARATOR and
    // U+2029 PARAGRAPH SEPARATOR as line breaks. Real assistant/user text
    // can legitimately contain those characters — they need no escaping
    // inside a JSON string — but readline would shred a single line's
    // string value into several bogus fragments at every occurrence, each
    // failing to parse on its own.
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines: ClaudeLine[] = [];
    for (const physicalLine of raw.split("\n")) {
      const trimmed = physicalLine.trim();
      if (!trimmed) {
        continue;
      }
      try {
        lines.push(JSON.parse(trimmed) as ClaudeLine);
      } catch (e) {
        warn(`Failed to parse line in ${filePath}: ${e}`);
      }
    }
    return lines;
  }

  private parseLines(lines: ClaudeLine[], cwd: string): Turn[] {
    const turns: Turn[] = [];

    for (const line of lines) {
      if (line.type !== "user" && line.type !== "assistant") {
        if (!IGNORED_LINE_TYPES.has(line.type)) {
          warn(`Unknown line type in Claude Code session: ${line.type}`);
        }
        continue;
      }

      const blocks = this.contentBlocks(line.message);
      const content = this.extractText(blocks);
      const thinking: ThinkingBlock =
        line.type === "assistant" ? this.extractThinking(blocks) : { status: "not_supported", text: null };

      const fileAccess: FileAccessEntry[] = [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          const fa = this.extractFileAccess(block as unknown as Record<string, unknown>, cwd);
          if (fa) {
            fileAccess.push(fa);
          }
        }
      }

      turns.push({
        id: line.uuid || `turn-${turns.length + 1}`,
        role: line.type === "user" ? "user" : "assistant",
        timestamp: tryTimestamp(line.timestamp) || new Date().toISOString(),
        thinking,
        content,
        file_access: fileAccess,
      });
    }

    return turns;
  }

  /** Normalize `message.content` (string or block array) into a block array. */
  private contentBlocks(message: ClaudeMessage | undefined): ClaudeContentBlock[] {
    const content = message?.content;
    if (typeof content === "string") {
      return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    if (Array.isArray(content)) {
      return content;
    }
    return [];
  }

  private extractText(blocks: ClaudeContentBlock[]): string {
    return blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }

  private extractThinking(blocks: ClaudeContentBlock[]): ThinkingBlock {
    const thinkingBlocks = blocks.filter((block) => block.type === "thinking");
    if (thinkingBlocks.length > 0) {
      const text = thinkingBlocks
        .map((block) => block.thinking || "")
        .filter((t) => t.trim().length > 0)
        .join("\n\n");
      if (text.length > 0) {
        return { status: "present", text };
      }
      // Known bug: thinking block present but blank, even though a signature exists.
      return { status: "empty", text: null };
    }
    if (blocks.some((block) => block.type === "redacted_thinking")) {
      return { status: "redacted", text: null };
    }
    return { status: "not_supported", text: null };
  }

  private extractFileAccess(entry: Record<string, unknown>, projectPath: string): FileAccessEntry | null {
    const tool = (entry.name as string) || "unknown";
    const input = (entry.input as Record<string, unknown>) || {};

    // Determine file path from common tool input fields
    const filePath =
      (input.file_path as string) ||
      (input.path as string) ||
      (input.fileName as string) ||
      null;

    if (!filePath) {
      // Tool didn't touch a file (e.g. Bash without file args)
      return null;
    }

    let action: FileAccessAction;
    switch (tool.toLowerCase()) {
      case "read":
        action = "read";
        break;
      case "edit":
      case "multiedit":
        action = "edit";
        break;
      case "write":
      case "create":
        action = "write";
        break;
      case "delete":
      case "remove":
        action = "delete";
        break;
      default:
        // Bash or other — infer from input
        action = "read";
        break;
    }

    // Try to compute a diff summary if diff info is available
    let diff_summary: string | undefined;
    if (typeof input.diff === "string") {
      const added = (input.diff.match(/^\+/gm) || []).length;
      const removed = (input.diff.match(/^-/gm) || []).length;
      if (added > 0 || removed > 0) {
        diff_summary = `+${added} -${removed} lines`;
      }
    }

    return {
      path: relativeToProject(filePath, projectPath),
      action,
      tool,
      diff_summary,
    };
  }
}
