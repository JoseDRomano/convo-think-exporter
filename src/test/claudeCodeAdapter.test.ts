/**
 * Tests for the Claude Code adapter.
 */

import * as assert from "assert";

import { ClaudeCodeAdapter } from "../adapters/claudeCodeAdapter";
import {
  cleanupSampleClaudeSession,
  setupSampleClaudeSession,
} from "./fixtures";

suite("ClaudeCodeAdapter", () => {
  let projectsDir: string;
  let projectPath: string;
  let sessionId: string;

  setup(() => {
    const setup = setupSampleClaudeSession();
    projectsDir = setup.projectsDir;
    projectPath = setup.projectPath;
    sessionId = setup.sessionId;
  });

  teardown(() => {
    cleanupSampleClaudeSession(projectsDir);
  });

  test("discoverSessions finds the sample session", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    assert.strictEqual(session.session.source, "claude-code");
    assert.strictEqual(session.session.session_id, sessionId);
    assert.strictEqual(session.session.project_path, projectPath);
  });

  test("loadSession produces the correct number of turns", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    // 2 user turns + 3 assistant turns = 5
    assert.strictEqual(session.turns.length, 5);
  });

  test("user turns have not_supported thinking", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    const userTurns = session.turns.filter((t) => t.role === "user");
    assert.strictEqual(userTurns.length, 2);
    for (const t of userTurns) {
      assert.strictEqual(t.thinking.status, "not_supported");
      assert.strictEqual(t.thinking.text, null);
    }
  });

  test("first assistant turn has present thinking", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");
    assert.strictEqual(assistantTurns[0].thinking.status, "present");
    assert.ok(assistantTurns[0].thinking.text?.includes("read package.json"));
  });

  test("empty thinking with signature is marked as empty (known bug)", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");
    // The last assistant turn should have empty thinking
    const lastAssistant = assistantTurns[assistantTurns.length - 1];
    assert.strictEqual(lastAssistant.thinking.status, "empty");
    assert.strictEqual(lastAssistant.thinking.text, null);
  });

  test("file_access is captured from tool_use blocks", async () => {
    const adapter = new ClaudeCodeAdapter();
    adapter.setProjectsDir(projectsDir);
    const session = await adapter.loadSession(sessionId, projectPath);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");

    // First assistant turn has a Read tool_use
    const readFiles = assistantTurns[0].file_access;
    assert.strictEqual(readFiles.length, 1);
    assert.strictEqual(readFiles[0].action, "read");
    assert.strictEqual(readFiles[0].tool, "Read");
    assert.ok(readFiles[0].path.includes("package.json"));

    // Second assistant turn has an Edit tool_use
    const editFiles = assistantTurns[1].file_access;
    assert.strictEqual(editFiles.length, 1);
    assert.strictEqual(editFiles[0].action, "edit");
    assert.strictEqual(editFiles[0].tool, "Edit");
    assert.ok(editFiles[0].path.includes("foo.ts"));
  });
});
