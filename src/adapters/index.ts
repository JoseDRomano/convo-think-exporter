/**
 * Adapter registry — holds all available adapters and lets the rest of
 * the code look them up by source name or iterate over all of them.
 */

import type { Adapter, AgentSource, SessionInfo } from "../types";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter";
import { CursorAdapter } from "./cursorAdapter";
import { CopilotChatAdapter } from "./copilotChatAdapter";

export class AdapterRegistry {
  private readonly adapters: Map<AgentSource, Adapter>;

  constructor() {
    this.adapters = new Map<AgentSource, Adapter>();
    this.register(new ClaudeCodeAdapter());
    this.register(new CursorAdapter());
    this.register(new CopilotChatAdapter());
  }

  private register(adapter: Adapter): void {
    this.adapters.set(adapter.source, adapter);
  }

  get(source: AgentSource): Adapter | undefined {
    return this.adapters.get(source);
  }

  all(): Adapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Discover sessions from all adapters, isolating failures so one
   * broken adapter doesn't prevent the others from listing.
   */
  async discoverAllSessions(projectPath?: string): Promise<SessionInfo[]> {
    const results: SessionInfo[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const sessions = await adapter.discoverSessions(projectPath);
        results.push(...sessions);
      } catch {
        // Logged by the adapter; continue
      }
    }
    return results;
  }
}
