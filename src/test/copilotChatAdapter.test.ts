/**
 * Tests for the Copilot Chat adapter.
 */

import * as assert from "assert";
import * as path from "path";

import { CopilotChatAdapter } from "../adapters/copilotChatAdapter";
import {
  cleanupCopilotRealWorldShapesSession,
  cleanupSampleCopilotSession,
  cleanupStrayFilesInDefaultRoot,
  setupCopilotRealWorldShapesSession,
  setupSampleCopilotSession,
  setupStrayFilesInDefaultRoot,
} from "./fixtures";

suite("CopilotChatAdapter", () => {
  let storageRoot: string;
  let sessionId: string;
  let legacySessionId: string;

  setup(() => {
    const setup = setupSampleCopilotSession();
    storageRoot = setup.storageRoot;
    sessionId = setup.sessionId;
    legacySessionId = setup.legacySessionId;
  });

  teardown(() => {
    cleanupSampleCopilotSession(storageRoot);
  });

  // ── Discovery ───────────────────────────────────────────────────

  test("discoverSessions finds workspace and empty-window sessions", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const sessions = await adapter.discoverSessions();

    // Should find both the workspace session and the legacy empty-window session
    assert.ok(sessions.length >= 2, `expected >= 2 sessions, got ${sessions.length}`);
    const ids = sessions.map((s) => s.session_id);
    assert.ok(ids.includes(sessionId), `workspace session ${sessionId} not found`);
    assert.ok(ids.includes(legacySessionId), `legacy session ${legacySessionId} not found`);
  });

  test("discovered sessions have copilot-chat source", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const sessions = await adapter.discoverSessions();

    for (const s of sessions) {
      assert.strictEqual(s.source, "copilot-chat");
    }
  });

  test("discovered sessions have started_at from creationDate", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const sessions = await adapter.discoverSessions();
    const wsSession = sessions.find((s) => s.session_id === sessionId);

    assert.ok(wsSession);
    assert.ok(wsSession!.started_at);
    // creationDate 1785411742238 → ISO string
    assert.strictEqual(wsSession!.started_at, new Date(1785411742238).toISOString());
  });

  test("discovered sessions derive title from first user message", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const sessions = await adapter.discoverSessions();
    const wsSession = sessions.find((s) => s.session_id === sessionId);

    assert.ok(wsSession);
    assert.ok(wsSession!.label.includes("read package.json"));
  });

  // ── Load session (JSONL mutation log) ───────────────────────────

  test("loadSession produces user + assistant turns for each request", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    // 3 requests × 2 turns each = 6 turns
    assert.strictEqual(session.turns.length, 6);
    assert.strictEqual(session.session.source, "copilot-chat");
    assert.strictEqual(session.session.session_id, sessionId);
  });

  test("loadSession extracts user message content", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    const userTurns = session.turns.filter((t) => t.role === "user");
    assert.strictEqual(userTurns.length, 3);
    assert.strictEqual(userTurns[0].content, "Please read package.json and edit src/foo.ts");
    assert.strictEqual(userTurns[1].content, "Now edit src/foo.ts");
    assert.strictEqual(userTurns[2].content, "Thanks!");
  });

  test("loadSession extracts assistant markdown content", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");
    assert.strictEqual(assistantTurns.length, 3);
    assert.strictEqual(assistantTurns[0].content, "I'll read package.json and edit src/foo.ts.");
    assert.strictEqual(assistantTurns[1].content, "Done editing foo.ts.");
    assert.strictEqual(assistantTurns[2].content, "You're welcome!");
  });

  test("loadSession extracts thinking blocks", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");

    // First assistant turn has present thinking
    assert.strictEqual(assistantTurns[0].thinking.status, "present");
    assert.ok(assistantTurns[0].thinking.text?.includes("read package.json"));

    // Third assistant turn has empty thinking (edge case)
    assert.strictEqual(assistantTurns[2].thinking.status, "empty");
    assert.strictEqual(assistantTurns[2].thinking.text, null);
  });

  test("loadSession extracts file access from tool invocations", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");

    // First assistant turn has a Read tool invocation
    const readFiles = assistantTurns[0].file_access;
    assert.strictEqual(readFiles.length, 1);
    assert.strictEqual(readFiles[0].action, "read");
    assert.strictEqual(readFiles[0].tool, "Read");
    assert.ok(readFiles[0].path.includes("package.json"));
  });

  test("loadSession extracts file access from text edits", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    const assistantTurns = session.turns.filter((t) => t.role === "assistant");

    // Second assistant turn has a textEditGroup + editedFileEvents
    const editFiles = assistantTurns[1].file_access;
    assert.ok(editFiles.length >= 1, `expected >= 1 file access entry, got ${editFiles.length}`);
    const fooEdits = editFiles.filter((f) => f.path.includes("foo.ts"));
    assert.ok(fooEdits.length >= 1, "expected foo.ts in file access");
    assert.strictEqual(fooEdits[0].action, "edit");
  });

  test("loadSession extracts source version from BYOK model", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    assert.ok(session.session.source_version);
    assert.ok(session.session.source_version!.includes("pdmfc"));
    assert.ok(session.session.source_version!.includes("glm5.2"));
  });

  test("loadSession sets project_path from workingDirectory", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);

    assert.strictEqual(session.session.project_path, "/home/user/project");
  });

  // ── Mutation log splice replay (kind: 2) ────────────────────────

  test("loadSession replays multi-flush kind:2 response mutations without losing or duplicating parts", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);
    const assistantTurns = session.turns.filter((t) => t.role === "assistant");

    // The finalized thinking text (2nd flush) must be present in full...
    assert.ok(assistantTurns[0].thinking.text?.includes("add the new function"));
    // ...and the superseded partial draft (1st flush) must be replaced, not left duplicated alongside it.
    const partialMatches = assistantTurns[0].thinking.text?.match(/I need to read package\.json first/g) || [];
    assert.strictEqual(partialMatches.length, 1, "the partial draft thinking block should be replaced, not duplicated");

    // The markdown reply (2nd flush) and tool invocation (3rd flush) must both survive the splices.
    assert.strictEqual(assistantTurns[0].content, "I'll read package.json and edit src/foo.ts.");
    assert.strictEqual(assistantTurns[0].file_access.length, 1);
    assert.strictEqual(assistantTurns[0].file_access[0].tool, "Read");
  });

  test("loadSession preserves every request when kind:2 requests-array appends use varying i values", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(sessionId);
    const userTurns = session.turns.filter((t) => t.role === "user");

    assert.strictEqual(userTurns.length, 3, "all 3 requests must survive (a 'replace' bug would keep only the last)");
    assert.deepStrictEqual(
      userTurns.map((t) => t.content),
      ["Please read package.json and edit src/foo.ts", "Now edit src/foo.ts", "Thanks!"]
    );
  });

  // ── Load session (legacy flat JSON) ─────────────────────────────

  test("loadSession handles legacy flat JSON format", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    const session = await adapter.loadSession(legacySessionId);

    assert.strictEqual(session.session.session_id, legacySessionId);
    assert.strictEqual(session.turns.length, 2); // 1 request × 2 turns
    assert.strictEqual(session.turns[0].role, "user");
    assert.strictEqual(session.turns[0].content, "Hello, can you help me?");
    assert.strictEqual(session.turns[1].role, "assistant");
    assert.strictEqual(session.turns[1].content, "Of course! What do you need?");
  });

  // ── Real-world wire-format quirks ────────────────────────────────

  test("loadSession does not shred a mutation on an embedded U+2028 LINE SEPARATOR character", async () => {
    const { storageRoot: rwRoot, sessionId: rwId } = setupCopilotRealWorldShapesSession();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRoot(rwRoot);

      const session = await adapter.loadSession(rwId);
      const assistantTurns = session.turns.filter((t) => t.role === "assistant");

      assert.strictEqual(session.turns.length, 2, "the request must not be dropped as unparseable");
      assert.ok(assistantTurns[0].content.includes("Here is a summary:"));
      assert.ok(assistantTurns[0].content.includes("It exports a single function."));
    } finally {
      cleanupCopilotRealWorldShapesSession(rwRoot);
    }
  });

  test("loadSession extracts a bare IMarkdownString response part with no 'kind' tag", async () => {
    const { storageRoot: rwRoot, sessionId: rwId } = setupCopilotRealWorldShapesSession();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRoot(rwRoot);

      const session = await adapter.loadSession(rwId);
      const assistantTurns = session.turns.filter((t) => t.role === "assistant");

      assert.ok(assistantTurns[0].content.length > 0, "markdown text without a 'kind' tag must still be captured");
    } finally {
      cleanupCopilotRealWorldShapesSession(rwRoot);
    }
  });

  test("loadSession extracts file access from a toolInvocationSerialized part using toolId/invocationMessage.uris", async () => {
    const { storageRoot: rwRoot, sessionId: rwId } = setupCopilotRealWorldShapesSession();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRoot(rwRoot);

      const session = await adapter.loadSession(rwId);
      const assistantTurns = session.turns.filter((t) => t.role === "assistant");

      assert.strictEqual(assistantTurns[0].file_access.length, 1);
      assert.strictEqual(assistantTurns[0].file_access[0].tool, "copilot_readFile");
      assert.strictEqual(assistantTurns[0].file_access[0].action, "read");
      assert.ok(assistantTurns[0].file_access[0].path.includes("foo.ts"));
    } finally {
      cleanupCopilotRealWorldShapesSession(rwRoot);
    }
  });

  // ── Non-session files (settings.json, chatLanguageModels.json, etc.) ──

  test("discoverSessions does not scan the storage root itself for stray files when no override is configured", async () => {
    const { storageRoot: strayRoot, sessionId: strayId } = setupStrayFilesInDefaultRoot();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRootAsDefault(strayRoot);

      const sessions = await adapter.discoverSessions();
      const ids = sessions.map((s) => s.session_id);

      assert.ok(ids.includes(strayId), "the legitimate workspace session should still be found");
      assert.ok(!ids.includes("settings"), "settings.json must not be surfaced as a session");
      assert.ok(!ids.includes("chatLanguageModels"), "chatLanguageModels.json must not be surfaced as a session");
      assert.ok(!ids.includes("not-a-session"), "a shape-invalid file must not be surfaced even inside a real sessions dir");
    } finally {
      cleanupStrayFilesInDefaultRoot(strayRoot);
    }
  });

  test("discoverSessions excludes shape-invalid files even under an explicit storage override", async () => {
    const { storageRoot: strayRoot, sessionId: strayId } = setupStrayFilesInDefaultRoot();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRoot(strayRoot); // explicit override

      const sessions = await adapter.discoverSessions();
      const ids = sessions.map((s) => s.session_id);

      assert.ok(ids.includes(strayId));
      assert.ok(!ids.includes("not-a-session"), "shape validation must reject invalid files regardless of override state");
    } finally {
      cleanupStrayFilesInDefaultRoot(strayRoot);
    }
  });

  test("loadSession throws a clear parse error for a shape-invalid file, not a raw TypeError", async () => {
    const { storageRoot: strayRoot } = setupStrayFilesInDefaultRoot();
    try {
      const adapter = new CopilotChatAdapter();
      adapter.setStorageRoot(strayRoot); // explicit override enables the root-level fallback search

      await assert.rejects(() => adapter.loadSession("settings"), /Failed to parse Copilot Chat session/);
    } finally {
      cleanupStrayFilesInDefaultRoot(strayRoot);
    }
  });

  // ── Error handling ──────────────────────────────────────────────

  test("loadSession throws for non-existent session", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(storageRoot);

    await assert.rejects(
      () => adapter.loadSession("nonexistent-session-id"),
      /not found/i
    );
  });

  test("discoverSessions returns empty array for non-existent root", async () => {
    const adapter = new CopilotChatAdapter();
    adapter.setStorageRoot(path.join(storageRoot, "does-not-exist"));

    const sessions = await adapter.discoverSessions();
    assert.strictEqual(sessions.length, 0);
  });
});
