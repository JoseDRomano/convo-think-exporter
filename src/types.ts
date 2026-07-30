/**
 * Canonical export schema — the central contract of the extension.
 * Every adapter converts from its source-specific format into these types,
 * and every renderer consumes them. Nothing else in the codebase should
 * depend on the internal format of any particular AI agent.
 */

export const SCHEMA_VERSION = "1.0" as const;

export type AgentSource = "claude-code" | "cursor" | "copilot-chat";

export type ThinkingStatus = "present" | "empty" | "redacted" | "not_supported";

export type FileAccessAction = "read" | "write" | "edit" | "delete";

export type TurnRole = "user" | "assistant";

export interface SessionMetadata {
  source: AgentSource;
  source_version?: string;
  session_id: string;
  project_path: string;
  started_at: string; // ISO-8601
  exported_at: string; // ISO-8601
}

export interface ThinkingBlock {
  status: ThinkingStatus;
  text: string | null;
}

export interface FileAccessEntry {
  path: string; // relative to project
  action: FileAccessAction;
  tool: string; // e.g. "Read", "Edit", "Write", "Bash"
  diff_summary?: string; // e.g. "+12 -3 lines"
}

export interface Turn {
  id: string;
  role: TurnRole;
  timestamp: string; // ISO-8601
  thinking: ThinkingBlock;
  content: string;
  file_access: FileAccessEntry[];
}

export interface ExportedSession {
  schema_version: typeof SCHEMA_VERSION;
  session: SessionMetadata;
  turns: Turn[];
}

// ── Zod schema for runtime validation ──────────────────────────────

import { z } from "zod";

export const ZodFileAccessEntry = z.object({
  path: z.string(),
  action: z.enum(["read", "write", "edit", "delete"]),
  tool: z.string(),
  diff_summary: z.string().optional(),
});

export const ZodThinkingBlock = z.object({
  status: z.enum(["present", "empty", "redacted", "not_supported"]),
  text: z.string().nullable(),
});

export const ZodTurn = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  timestamp: z.string(),
  thinking: ZodThinkingBlock,
  content: z.string(),
  file_access: z.array(ZodFileAccessEntry),
});

export const ZodSessionMetadata = z.object({
  source: z.enum(["claude-code", "cursor", "copilot-chat"]),
  source_version: z.string().optional(),
  session_id: z.string(),
  project_path: z.string(),
  started_at: z.string(),
  exported_at: z.string(),
});

export const ZodExportedSession = z.object({
  schema_version: z.literal("1.0"),
  session: ZodSessionMetadata,
  turns: z.array(ZodTurn),
});

// ── Adapter interface ──────────────────────────────────────────────

export interface SessionInfo {
  source: AgentSource;
  session_id: string;
  project_path: string;
  started_at?: string;
  label: string; // human-readable for pickers / tree views
}

export interface Adapter {
  readonly source: AgentSource;
  /** Discover available sessions for this adapter. */
  discoverSessions(projectPath?: string): Promise<SessionInfo[]>;
  /** Load and convert a single session into the canonical model. */
  loadSession(sessionId: string, projectPath?: string): Promise<ExportedSession>;
}
