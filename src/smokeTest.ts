/**
 * Quick smoke test script — run with: npm run smoke-test
 * Creates a fake Claude Code session in a temp directory, then runs
 * the adapter + renderers to verify the full pipeline works.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { ClaudeCodeAdapter } from "./adapters/claudeCodeAdapter";
import { renderJson } from "./renderers/jsonRenderer";
import { renderMarkdown } from "./renderers/markdownRenderer";

async function main(): Promise<void> {
  // 1. Create a fake Claude Code session
  const projectsDir = path.join(os.tmpdir(), "convo-think-smoke-projects");
  const projectPath = "home-user-test-project";
  const sessionId = "smoke-test-001";

  fs.mkdirSync(path.join(projectsDir, projectPath), { recursive: true });

  // Mirrors the real on-disk wire format: top-level `type`, with the
  // actual payload nested under `message.content` as a block array.
  const jsonl = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2025-01-15T10:00:00Z",
      cwd: "/home/user/test-project",
      message: {
        role: "user",
        content: [{ type: "text", text: "Please read package.json and edit src/foo.ts" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2025-01-15T10:00:05Z",
      cwd: "/home/user/test-project",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I need to read package.json first, then edit foo.ts to add the new function.",
          },
          { type: "text", text: "I'll read package.json and edit src/foo.ts." },
          { type: "tool_use", name: "Read", input: { file_path: "/home/user/test-project/package.json" } },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a2",
      timestamp: "2025-01-15T10:00:10Z",
      cwd: "/home/user/test-project",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/home/user/test-project/src/foo.ts", diff: "+12 -3 lines of diff" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a3",
      timestamp: "2025-01-15T10:00:15Z",
      cwd: "/home/user/test-project",
      message: {
        role: "assistant",
        // Empty thinking with signature (known bug)
        content: [
          { type: "thinking", thinking: "", signature: "some-signature" },
          { type: "text", text: "Done editing foo.ts." },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2025-01-15T10:00:20Z",
      cwd: "/home/user/test-project",
      message: {
        role: "user",
        content: [{ type: "text", text: "Thanks!" }],
      },
    }),
  ].join("\n");

  fs.writeFileSync(path.join(projectsDir, projectPath, `${sessionId}.jsonl`), jsonl, "utf-8");

  console.log("=== Smoke Test: Claude Code Adapter ===\n");

  // 2. Load session via adapter
  const adapter = new ClaudeCodeAdapter();

  // Override the projects dir for testing (avoids needing the vscode API)
  adapter.setProjectsDir(projectsDir);

  const session = await adapter.loadSession(sessionId, projectPath);

  console.log("Session loaded:");
  console.log(`  source: ${session.session.source}`);
  console.log(`  session_id: ${session.session.session_id}`);
  console.log(`  project_path: ${session.session.project_path}`);
  console.log(`  turns: ${session.turns.length}`);
  console.log();

  // 3. Print turn details
  session.turns.forEach((turn, i) => {
    console.log(`--- Turn ${i + 1} (${turn.role}) ---`);
    console.log(`  thinking.status: ${turn.thinking.status}`);
    if (turn.thinking.text) {
      console.log(`  thinking.text: ${turn.thinking.text.substring(0, 60)}...`);
    }
    console.log(`  content: ${turn.content.substring(0, 60)}...`);
    if (turn.file_access.length > 0) {
      console.log(`  file_access:`);
      turn.file_access.forEach((fa) => {
        console.log(`    ${fa.action} ${fa.path} (${fa.tool})${fa.diff_summary ? " — " + fa.diff_summary : ""}`);
      });
    }
    console.log();
  });

  // 4. Render to JSON and Markdown
  const json = renderJson(session);
  const md = renderMarkdown(session, { includeThinking: true });

  console.log("=== JSON output (first 500 chars) ===");
  console.log(json.substring(0, 500));
  console.log("...\n");

  console.log("=== Markdown output ===");
  console.log(md);

  // 5. Cleanup
  fs.rmSync(projectsDir, { recursive: true, force: true });
  console.log("\n=== Smoke test passed! ===");
}

main().catch((err) => {
  console.error("Smoke test FAILED:", err);
  process.exit(1);
});
