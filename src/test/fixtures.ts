/**
 * Test fixtures for the Claude Code adapter.
 * These are anonymized samples representing the known line types and
 * edge cases (including the empty-thinking-with-signature bug).
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

/** A minimal Claude Code session JSONL with thinking, tool_use, and the empty-thinking bug. */
export const SAMPLE_CLAUDE_SESSION_JSONL = [
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2025-01-15T10:00:00Z",
    message: "Please read package.json and edit src/foo.ts",
  }),
  JSON.stringify({
    type: "thinking",
    thinking: "I need to read package.json first, then edit foo.ts.",
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2025-01-15T10:00:05Z",
    content: [
      { type: "text", text: "I'll read package.json and edit src/foo.ts." },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/home/user/project/package.json" },
      },
    ],
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a2",
    timestamp: "2025-01-15T10:00:10Z",
    content: [
      {
        type: "tool_use",
        name: "Edit",
        input: {
          file_path: "/home/user/project/src/foo.ts",
          diff: "+12 -3 lines of diff",
        },
      },
    ],
  }),
  // Empty thinking with signature (known bug)
  JSON.stringify({
    type: "thinking",
    thinking: "",
    signature: "some-signature",
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2025-01-15T10:00:15Z",
    content: [{ type: "text", text: "Done editing foo.ts." }],
  }),
  JSON.stringify({
    type: "user",
    uuid: "u2",
    timestamp: "2025-01-15T10:00:20Z",
    message: "Thanks!",
  }),
].join("\n");

/**
 * Writes the sample session to a temp directory mimicking the Claude Code
 * projects layout and returns the paths.
 */
export function setupSampleClaudeSession(): {
  projectsDir: string;
  projectPath: string;
  sessionId: string;
} {
  const projectsDir = path.join(os.tmpdir(), "convo-think-test-projects");
  const projectPath = "home-user-project";
  const sessionId = "test-session-001";

  fs.mkdirSync(path.join(projectsDir, projectPath), { recursive: true });
  fs.writeFileSync(
    path.join(projectsDir, projectPath, `${sessionId}.jsonl`),
    SAMPLE_CLAUDE_SESSION_JSONL,
    "utf-8"
  );

  return { projectsDir, projectPath, sessionId };
}

export function cleanupSampleClaudeSession(projectsDir: string): void {
  fs.rmSync(projectsDir, { recursive: true, force: true });
}
