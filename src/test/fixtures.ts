/**
 * Test fixtures for the Claude Code adapter.
 * These are anonymized samples representing the known line types and
 * edge cases (including the empty-thinking-with-signature bug).
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

/**
 * A minimal Claude Code session JSONL, in the real on-disk wire format:
 * top-level `type` ("user" | "assistant" | bookkeeping types like
 * "queue-operation"), with the actual payload nested under
 * `message.content` as an array of blocks (text / thinking / tool_use).
 * Covers thinking, tool_use, and the empty-thinking-with-signature bug.
 */
export const SAMPLE_CLAUDE_SESSION_JSONL = [
  // Bookkeeping line — should be skipped, not produce a turn.
  JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2025-01-15T09:59:59Z",
  }),
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2025-01-15T10:00:00Z",
    cwd: "/home/user/project",
    message: {
      role: "user",
      content: [{ type: "text", text: "Please read package.json and edit src/foo.ts" }],
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2025-01-15T10:00:05Z",
    cwd: "/home/user/project",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I need to read package.json first, then edit foo.ts." },
        { type: "text", text: "I'll read package.json and edit src/foo.ts." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/home/user/project/package.json" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a2",
    timestamp: "2025-01-15T10:00:10Z",
    cwd: "/home/user/project",
    message: {
      role: "assistant",
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
    },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2025-01-15T10:00:15Z",
    cwd: "/home/user/project",
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
    cwd: "/home/user/project",
    message: {
      role: "user",
      content: [{ type: "text", text: "Thanks!" }],
    },
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

// ── Copilot Chat fixtures ──────────────────────────────────────────

/**
 * A minimal Copilot Chat session in the JSONL mutation log format
 * (VS Code ≥ 1.109). Includes thinking, tool invocation, text edits,
 * and a BYOK external model — covering the scenario that was previously
 * not detected.
 *
 * Each line is a mutation:
 *   kind 0 = initial snapshot
 *   kind 1 = set field at path k to v
 *   kind 2 = splice the array at path k: replace elements from index i
 *     (or the array's current end if i is omitted) with the elements of
 *     v. Request 1's response is deliberately built up via three
 *     separate kind:2 flushes (mirroring how VS Code actually persists a
 *     streaming response — see real session evidence in
 *     copilotChatAdapter.ts's mutation-log comment) so the test suite
 *     exercises the splice replay, not just a single-shot push.
 */
export const SAMPLE_COPILOT_SESSION_JSONL = [
  // Initial snapshot — full session object with empty requests
  JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      creationDate: 1785411742238,
      initialLocation: "panel",
      responderUsername: "GitHub Copilot",
      sessionId: "copilot-test-001",
      hasPendingEdits: false,
      requests: [],
      pendingRequests: [],
      inputState: {
        attachments: [],
        mode: { id: "agent", kind: "agent" },
        selectedModel: {
          identifier: "pdmfc/glm5.2",
          metadata: {
            extension: { value: "pdmfc.pdmfc-provider", _lower: "pdmfc.pdmfc-provider" },
            id: "glm5.2",
            vendor: "pdmfc",
            name: "glm5.2",
            family: "pdmfc",
            isBYOK: true,
          },
        },
        inputText: "",
        selections: [],
        permissionLevel: "default",
        contrib: {},
      },
      workingDirectory: "/home/user/project",
    },
  }),
  // Append first request (no response yet — it arrives via the three
  // splice flushes below, the way a real streaming response does)
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        message: "Please read package.json and edit src/foo.ts",
        timestamp: 1785411743000,
        responseTimestamp: 1785411749000,
        modelId: "pdmfc/glm5.2",
      },
    ],
  }),
  // First streamed flush: a partial, not-yet-finalized thinking block
  JSON.stringify({
    kind: 2,
    k: ["requests", 0, "response"],
    v: [
      {
        kind: "thinking",
        value: "I need to read package.json first",
        id: "think-1",
      },
    ],
  }),
  // Second flush supersedes the partial thinking block (i: 0) with its
  // finalized text plus the markdown reply that has since streamed in
  JSON.stringify({
    kind: 2,
    k: ["requests", 0, "response"],
    i: 0,
    v: [
      {
        kind: "thinking",
        value: "I need to read package.json first, then edit foo.ts to add the new function.",
        id: "think-1",
        reasoningDurationMs: 1200,
      },
      {
        kind: "markdownContent",
        content: { value: "I'll read package.json and edit src/foo.ts." },
      },
    ],
  }),
  // Third flush appends the tool invocation (i: 2 == current length, a plain append)
  JSON.stringify({
    kind: 2,
    k: ["requests", 0, "response"],
    i: 2,
    v: [
      {
        kind: "toolInvocationSerialized",
        toolName: "Read",
        input: JSON.stringify({ file_path: "/home/user/project/package.json" }),
      },
    ],
  }),
  // Append second request (user turn 2 + assistant response 2 with edits) — arrives whole in one flush
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    i: 1,
    v: [
      {
        requestId: "req-2",
        message: "Now edit src/foo.ts",
        response: [
          {
            kind: "markdownContent",
            content: { value: "Done editing foo.ts." },
          },
          {
            kind: "textEditGroup",
            uri: { fsPath: "/home/user/project/src/foo.ts", external: "file:///home/user/project/src/foo.ts" },
            edits: [
              { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, newText: "export function foo() {}\n" },
            ],
          },
        ],
        timestamp: 1785411750000,
        responseTimestamp: 1785411756000,
        modelId: "pdmfc/glm5.2",
        editedFileEvents: [
          { uri: { fsPath: "/home/user/project/src/foo.ts", external: "file:///home/user/project/src/foo.ts" } },
        ],
      },
    ],
  }),
  // Append third request (empty thinking — edge case) — arrives whole in one flush
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-3",
        message: "Thanks!",
        response: [
          {
            kind: "thinking",
            value: "",
            id: "think-2",
          },
          {
            kind: "markdownContent",
            content: { value: "You're welcome!" },
          },
        ],
        timestamp: 1785411757000,
        responseTimestamp: 1785411758000,
        modelId: "pdmfc/glm5.2",
      },
    ],
  }),
].join("\n");

/**
 * Legacy flat JSON format (pre-1.109) — a single JSON object.
 */
export const SAMPLE_COPILOT_SESSION_JSON = JSON.stringify({
  version: 2,
  creationDate: 1785411742238,
  initialLocation: "panel",
  responderUsername: "GitHub Copilot",
  sessionId: "copilot-test-legacy-001",
  requests: [
    {
      requestId: "req-legacy-1",
      message: "Hello, can you help me?",
      response: [
        { kind: "markdownContent", content: { value: "Of course! What do you need?" } },
      ],
      timestamp: 1785411743000,
      responseTimestamp: 1785411749000,
    },
  ],
  workingDirectory: "/home/user/legacy-project",
}, undefined, 2);

/**
 * Sets up a fake Copilot Chat storage tree mimicking the VS Code layout:
 *   <root>/<workspaceId>/chatSessions/<sessionId>.jsonl
 *   <root>/globalStorage/emptyWindowChatSessions/<sessionId>.jsonl
 *
 * Returns the root path (to use as the storage root override).
 */
export function setupSampleCopilotSession(): {
  storageRoot: string;
  sessionId: string;
  legacySessionId: string;
} {
  const storageRoot = path.join(os.tmpdir(), "convo-think-test-copilot");
  const workspaceId = "test-workspace-001";
  const sessionId = "copilot-test-001";
  const legacySessionId = "copilot-test-legacy-001";

  // Clean up any previous run
  fs.rmSync(storageRoot, { recursive: true, force: true });

  // Workspace session (JSONL mutation log)
  // Layout: <root>/workspaceStorage/<wsId>/chatSessions/<sessionId>.jsonl
  const chatDir = path.join(storageRoot, "workspaceStorage", workspaceId, "chatSessions");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, `${sessionId}.jsonl`),
    SAMPLE_COPILOT_SESSION_JSONL,
    "utf-8"
  );

  // Empty-window session (legacy flat JSON)
  // Layout: <root>/globalStorage/emptyWindowChatSessions/<sessionId>.json
  const emptyDir = path.join(storageRoot, "globalStorage", "emptyWindowChatSessions");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(
    path.join(emptyDir, `${legacySessionId}.json`),
    SAMPLE_COPILOT_SESSION_JSON,
    "utf-8"
  );

  return { storageRoot, sessionId, legacySessionId };
}

export function cleanupSampleCopilotSession(storageRoot: string): void {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

/**
 * Sets up a fake storage root that mimics the real VS Code `User`
 * directory: stray non-session files (`settings.json`,
 * `chatLanguageModels.json`) sitting directly at the top level, sibling
 * to `workspaceStorage/`, plus one legitimate session correctly nested
 * under `workspaceStorage/<wsId>/chatSessions/` — alongside a second,
 * shape-invalid `.json` file dropped into that *same* legitimate
 * directory, to verify shape validation rejects bad files regardless of
 * where they're found (not just at the root).
 *
 * Use with `adapter.setStorageRootAsDefault(storageRoot)` to simulate
 * "this fake directory IS the computed platform default root" (no
 * explicit override), or with `adapter.setStorageRoot(storageRoot)` to
 * simulate an explicit `copilotChatStoragePath` override pointing here.
 */
export function setupStrayFilesInDefaultRoot(): {
  storageRoot: string;
  sessionId: string;
} {
  const storageRoot = path.join(os.tmpdir(), "convo-think-test-copilot-stray-root");
  const workspaceId = "test-workspace-002";
  const sessionId = "copilot-test-002";

  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  // Stray top-level files, exactly like the real VS Code User directory has.
  fs.writeFileSync(path.join(storageRoot, "settings.json"), JSON.stringify({ "editor.fontSize": 14 }), "utf-8");
  fs.writeFileSync(path.join(storageRoot, "chatLanguageModels.json"), "[]", "utf-8");

  // One legitimate session, correctly nested.
  const chatDir = path.join(storageRoot, "workspaceStorage", workspaceId, "chatSessions");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, `${sessionId}.jsonl`),
    JSON.stringify({
      kind: 0,
      v: {
        version: 3,
        creationDate: 1785411742238,
        sessionId,
        requests: [],
        workingDirectory: "/home/user/project",
      },
    }),
    "utf-8"
  );

  // A shape-invalid file dropped into the *legitimate* sessions directory.
  fs.writeFileSync(path.join(chatDir, "not-a-session.json"), JSON.stringify({ foo: "bar" }), "utf-8");

  return { storageRoot, sessionId };
}

export function cleanupStrayFilesInDefaultRoot(storageRoot: string): void {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

/**
 * A session exercising two real-world Copilot Chat wire-format quirks
 * observed on real VS Code installs, neither of which the naive
 * "one JSON object per line" reading (via Node's readline module) or a
 * strict `{kind, content}` part shape handles correctly:
 *
 * 1. A response's markdown text sometimes contains a U+2028 LINE
 *    SEPARATOR character. That's a perfectly ordinary, unescaped
 *    character inside a JSON string — but Node's `readline` module
 *    (unlike a plain string split, and unlike Python) treats U+2028 as
 *    a line terminator too, shredding the mutation into unparseable
 *    fragments if the reader is readline-based.
 * 2. A markdown response chunk is sometimes serialized as a bare
 *    IMarkdownString (no "kind" tag), and a toolInvocationSerialized
 *    part sometimes carries `toolId`/`invocationMessage.uris` instead
 *    of the `toolName`/`input` shape.
 */
export const SAMPLE_COPILOT_REALWORLD_SHAPES_JSONL = [
  JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      creationDate: 1785411742238,
      sessionId: "copilot-test-realworld-001",
      requests: [],
      workingDirectory: "/home/user/project",
    },
  }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "req-1",
        message: "Read foo.ts and summarize it",
        response: [
          // Bare IMarkdownString — no "kind" tag — containing a raw
          // U+2028 LINE SEPARATOR character inside the string value.
          {
            value: "Here is a summary: It exports a single function.",
            supportHtml: false,
            supportThemeIcons: false,
          },
          // Real toolInvocationSerialized shape: toolId + invocationMessage.uris,
          // no toolName/input.
          {
            kind: "toolInvocationSerialized",
            toolId: "copilot_readFile",
            invocationMessage: {
              value: "Reading foo.ts",
              uris: {
                "file:///home/user/project/foo.ts": {
                  path: "/home/user/project/foo.ts",
                  scheme: "file",
                },
              },
            },
            isComplete: true,
          },
        ],
        timestamp: 1785411743000,
        responseTimestamp: 1785411749000,
      },
    ],
  }),
].join("\n");

export function setupCopilotRealWorldShapesSession(): { storageRoot: string; sessionId: string } {
  const storageRoot = path.join(os.tmpdir(), "convo-think-test-copilot-realworld");
  const sessionId = "copilot-test-realworld-001";

  fs.rmSync(storageRoot, { recursive: true, force: true });
  const chatDir = path.join(storageRoot, "workspaceStorage", "test-workspace-003", "chatSessions");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, `${sessionId}.jsonl`), SAMPLE_COPILOT_REALWORLD_SHAPES_JSONL, "utf-8");

  return { storageRoot, sessionId };
}

export function cleanupCopilotRealWorldShapesSession(storageRoot: string): void {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}
