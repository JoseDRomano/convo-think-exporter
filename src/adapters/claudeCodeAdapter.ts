/**
 * Claude Code adapter.
 *
 * Reads `~/.claude/projects/<project>/<session>.jsonl` files.
 *
 * Each line is a JSON object with a `type` field:
 *  - "user"        → user turn
 *  - "assistant"   → assistant turn (may contain thinking + tool_use)
 *  - "thinking"    → thinking block (sometimes empty with a `signature`)
 *  - "tool_use"     → tool invocation (Read, Edit, Write, Bash, ...)
 *  - "tool_result"  → result of a tool invocation
 *
 * Known bug: in some versions the thinking block comes empty even though
 * a `signature` is present — we mark `status: "empty"` in that case.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

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

interface ClaudeLine {
  type: string;
  uuid?: string;
  timestamp?: string;
  // assistant content blocks
  content?: Array<Record<string, unknown>> | string;
  // thinking
  thinking?: string;
  signature?: string;
  // tool_use
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  // user messages
  message?: string;
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
    const turns = this.parseLines(lines, projectPath || "");

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
    const lines: ClaudeLine[] = [];
    const stream = fs.createReadStream(filePath, "utf-8");
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const raw of rl) {
      const trimmed = raw.trim();
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

  private parseLines(lines: ClaudeLine[], projectPath: string): Turn[] {
    const turns: Turn[] = [];
    let pendingThinking: ThinkingBlock | null = null;
    let pendingFileAccess: FileAccessEntry[] = [];

    for (const line of lines) {
      switch (line.type) {
        case "thinking": {
          // Store thinking to attach to the next assistant turn
          if (line.thinking && line.thinking.trim().length > 0) {
            pendingThinking = { status: "present", text: line.thinking };
          } else if (line.signature) {
            // Known bug: thinking is empty but signature exists
            pendingThinking = { status: "empty", text: null };
          } else {
            pendingThinking = { status: "empty", text: null };
          }
          break;
        }

        case "user": {
          const content = this.extractText(line);
          turns.push({
            id: line.uuid || `turn-${turns.length + 1}`,
            role: "user",
            timestamp: tryTimestamp(line.timestamp) || new Date().toISOString(),
            thinking: { status: "not_supported", text: null },
            content,
            file_access: [],
          });
          break;
        }

        case "assistant": {
          const content = this.extractText(line);
          const thinking = pendingThinking || { status: "not_supported", text: null };
          const fileAccess = [...pendingFileAccess];

          // Also check for inline tool_use blocks in content array
          if (Array.isArray(line.content)) {
            for (const block of line.content) {
              if (block.type === "tool_use") {
                const fa = this.extractFileAccess(block as unknown as Record<string, unknown>, projectPath);
                if (fa) {
                  fileAccess.push(fa);
                }
              }
            }
          }

          turns.push({
            id: line.uuid || `turn-${turns.length + 1}`,
            role: "assistant",
            timestamp: tryTimestamp(line.timestamp) || new Date().toISOString(),
            thinking,
            content,
            file_access: fileAccess,
          });

          pendingThinking = null;
          pendingFileAccess = [];
          break;
        }

        case "tool_use": {
          const fa = this.extractFileAccess(line as unknown as Record<string, unknown>, projectPath);
          if (fa) {
            pendingFileAccess.push(fa);
          }
          break;
        }

        case "tool_result": {
          // Tool results don't generate turns; file access was already
          // captured from the tool_use entry.
          break;
        }

        default: {
          warn(`Unknown line type in Claude Code session: ${line.type}`);
          break;
        }
      }
    }

    return turns;
  }

  private extractText(line: ClaudeLine): string {
    if (typeof line.content === "string") {
      return line.content;
    }
    if (Array.isArray(line.content)) {
      return line.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
    }
    if (typeof line.message === "string") {
      return line.message;
    }
    return "";
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
