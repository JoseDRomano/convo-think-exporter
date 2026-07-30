/**
 * Copilot Chat adapter (stub — Phase 4).
 *
 * Uses the native export command (JSON) as input rather than accessing
 * internal storage — this is more stable across versions. If reasoning
 * is not present in the native export, it is documented as a known
 * limitation rather than reverse-engineered.
 */

import type {
  Adapter,
  ExportedSession,
  SessionInfo,
} from "../types";
import { warn } from "../logger";

export class CopilotChatAdapter implements Adapter {
  readonly source = "copilot-chat" as const;

  async discoverSessions(_projectPath?: string): Promise<SessionInfo[]> {
    warn("Copilot Chat adapter not yet implemented (Phase 4).");
    return [];
  }

  async loadSession(_sessionId: string, _projectPath?: string): Promise<ExportedSession> {
    throw new Error("Copilot Chat adapter not yet implemented (Phase 4).");
  }
}
