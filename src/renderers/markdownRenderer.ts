/**
 * Markdown renderer — generates human-readable (and LLM-parseable) output
 * from the canonical JSON model. Never the other way around.
 *
 * Thinking blocks are wrapped in <details> so they stay collapsed for
 * humans but are fully readable by an LLM.
 */

import type { ExportedSession, Turn } from "../types";

export function renderMarkdown(session: ExportedSession, options?: { includeThinking?: boolean }): string {
  const includeThinking = options?.includeThinking ?? true;
  const lines: string[] = [];

  const { session: meta } = session;
  lines.push(`# Sessão: ${meta.project_path} (${meta.source}, ${meta.started_at})`);
  lines.push("");
  lines.push(`- **Session ID:** \`${meta.session_id}\``);
  if (meta.source_version) {
    lines.push(`- **Source version:** ${meta.source_version}`);
  }
  lines.push(`- **Exported at:** ${meta.exported_at}`);
  lines.push("");

  session.turns.forEach((turn, i) => {
    renderTurn(turn, i + 1, lines, includeThinking);
  });

  return lines.join("\n");
}

function renderTurn(turn: Turn, index: number, lines: string[], includeThinking: boolean): void {
  const roleLabel = turn.role === "user" ? "Utilizador" : "Assistente";
  lines.push(`## Turno ${index} — ${roleLabel}`);
  lines.push("");

  if (turn.role === "assistant" && includeThinking) {
    renderThinking(turn, lines);
  }

  lines.push(turn.content || "—");
  lines.push("");

  if (turn.file_access.length > 0) {
    lines.push("**Ficheiros acedidos:**");
    for (const fa of turn.file_access) {
      const parts = [`- \`${fa.action}\` \`${fa.path}\` (${fa.tool})`];
      if (fa.diff_summary) {
        parts.push(`— ${fa.diff_summary}`);
      }
      lines.push(parts.join(" "));
    }
    lines.push("");
  }
}

function renderThinking(turn: Turn, lines: string[]): void {
  lines.push("<details><summary>Thinking</summary>");
  lines.push("");
  switch (turn.thinking.status) {
    case "present":
      lines.push(turn.thinking.text || "—");
      break;
    case "empty":
      lines.push("— não disponível (vazio) —");
      break;
    case "redacted":
      lines.push("— redacted —");
      break;
    case "not_supported":
      lines.push("— não disponível —");
      break;
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
}
