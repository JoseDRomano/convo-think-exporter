/**
 * Tests for the renderers.
 */

import * as assert from "assert";

import { renderJson } from "../renderers/jsonRenderer";
import { renderMarkdown } from "../renderers/markdownRenderer";
import type { ExportedSession } from "../types";
import { SCHEMA_VERSION } from "../types";

function sampleSession(): ExportedSession {
  return {
    schema_version: SCHEMA_VERSION,
    session: {
      source: "claude-code",
      source_version: "1.0.0",
      session_id: "test-001",
      project_path: "/home/user/project",
      started_at: "2025-01-15T10:00:00Z",
      exported_at: "2025-01-15T11:00:00Z",
    },
    turns: [
      {
        id: "u1",
        role: "user",
        timestamp: "2025-01-15T10:00:00Z",
        thinking: { status: "not_supported", text: null },
        content: "Please edit src/foo.ts",
        file_access: [],
      },
      {
        id: "a1",
        role: "assistant",
        timestamp: "2025-01-15T10:00:05Z",
        thinking: { status: "present", text: "I need to edit foo.ts." },
        content: "Done editing foo.ts.",
        file_access: [
          {
            path: "src/foo.ts",
            action: "edit",
            tool: "Edit",
            diff_summary: "+12 -3 lines",
          },
        ],
      },
    ],
  };
}

suite("JSON Renderer", () => {
  test("produces valid JSON matching the schema", () => {
    const json = renderJson(sampleSession());
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.schema_version, "1.0");
    assert.strictEqual(parsed.session.source, "claude-code");
    assert.strictEqual(parsed.turns.length, 2);
  });

  test("throws on invalid session", () => {
    const bad = sampleSession() as unknown as { schema_version: string };
    bad.schema_version = "9.9";
    assert.throws(() => renderJson(bad as unknown as ExportedSession));
  });
});

suite("Markdown Renderer", () => {
  test("includes session header", () => {
    const md = renderMarkdown(sampleSession());
    assert.ok(md.includes("# Sessão:"));
    assert.ok(md.includes("claude-code"));
  });

  test("includes thinking in details block", () => {
    const md = renderMarkdown(sampleSession());
    assert.ok(md.includes("<details><summary>Thinking</summary>"));
    assert.ok(md.includes("I need to edit foo.ts."));
  });

  test("excludes thinking when includeThinking is false", () => {
    const md = renderMarkdown(sampleSession(), { includeThinking: false });
    assert.ok(!md.includes("<details><summary>Thinking</summary>"));
  });

  test("includes file access entries", () => {
    const md = renderMarkdown(sampleSession());
    assert.ok(md.includes("**Ficheiros acedidos:**"));
    assert.ok(md.includes("src/foo.ts"));
    assert.ok(md.includes("+12 -3 lines"));
  });
});
