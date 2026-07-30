/**
 * Cursor adapter (stub — Phase 3).
 *
 * Reads `state.vscdb` (SQLite) from the workspace storage, table
 * `cursorDiskKV`, bubbles grouped by `composerId`. Extracts text,
 * reasoning blocks, and tool calls/diffs from each bubble.
 *
 * NOTE: Node's built-in `node:sqlite` (Node 22+) or a bundled
 * `better-sqlite3` can be used once this phase is active. Left as a
 * stub so the adapter registry can list it without failing.
 */

import type {
  Adapter,
  ExportedSession,
  SessionInfo,
} from "../types";
import { warn } from "../logger";

export class CursorAdapter implements Adapter {
  readonly source = "cursor" as const;

  async discoverSessions(_projectPath?: string): Promise<SessionInfo[]> {
    warn("Cursor adapter not yet implemented (Phase 3).");
    return [];
  }

  async loadSession(_sessionId: string, _projectPath?: string): Promise<ExportedSession> {
    throw new Error("Cursor adapter not yet implemented (Phase 3).");
  }
}
