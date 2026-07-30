# convo-think-exporter

Visual Studio Code extension which main objective is to export the conversation and all the thinking that was made to a JSON file, allowing a more enriched context from one chat to another.

## Overview

`convo-think-exporter` reads the conversation history of AI coding agents (Claude Code, Cursor, Copilot Chat) directly from their local storage and exports it to a **canonical JSON format** with a **Markdown rendering**. The export preserves three things:

1. **The conversation** (user + assistant turns)
2. **The thinking / reasoning** associated with each assistant response
3. **The file access** (reads, edits, writes) performed during the session

The result can be pasted or loaded into another agent as initial context.

## Canonical JSON Schema

```json
{
  "schema_version": "1.0",
  "session": {
    "source": "claude-code | cursor | copilot-chat",
    "source_version": "string, se disponível",
    "session_id": "string",
    "project_path": "string",
    "started_at": "ISO-8601",
    "exported_at": "ISO-8601"
  },
  "turns": [
    {
      "id": "string",
      "role": "user | assistant",
      "timestamp": "ISO-8601",
      "thinking": {
        "status": "present | empty | redacted | not_supported",
        "text": "string | null"
      },
      "content": "string",
      "file_access": [
        {
          "path": "string (relativo ao projeto)",
          "action": "read | write | edit | delete",
          "tool": "nome da tool usada",
          "diff_summary": "string opcional"
        }
      ]
    }
  ]
}
```

### Design notes

- `thinking.status` is explicit rather than omitted — so the target model can distinguish "no thinking" from "thinking existed but couldn't be extracted" (Claude Code bug) from "redacted by the provider".
- `file_access` is attached to the turn that generated it, preserving causal context.
- `schema_version` is present from day one.

## Markdown rendering

Generated from the canonical JSON (never the reverse), with a fixed convention:

```markdown
# Sessão: <project_path> (<source>, <started_at>)

## Turno 1 — Utilizador
<conteúdo>

## Turno 2 — Assistente
<details><summary>Thinking</summary>

<texto do thinking, ou "— não disponível —">

</details>

<resposta final>

**Ficheiros acedidos:**
- `edit` `src/foo.ts` (Edit) — +12 -3 linhas
- `read` `package.json` (Read)
```

Thinking is wrapped in `<details>` so it stays collapsed for humans but is fully readable by an LLM.

## Commands

| Command | Description |
|---------|-------------|
| `Export Agent Context...` | Shows a picker of detected sessions and exports the selected one. |
| `Export Agent Context (summary only)` | Uses `vscode.lm` to condense long thinking blocks into bullet points. |
| `Refresh Sessions` | Refreshes the tree view of sessions. |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `convoThinkExport.outputFormat` | `both` | Output format: `json`, `markdown`, or `both`. |
| `convoThinkExport.includeThinking` | `true` | Include thinking/reasoning blocks in the export. |
| `convoThinkExport.claudeProjectsPath` | `""` | Override the Claude Code projects directory (defaults to `~/.claude/projects`). |
| `convoThinkExport.cursorDatabasePath` | `""` | Override the Cursor `state.vscdb` path. |
| `convoThinkExport.copilotChatStoragePath` | `""` | Override the VS Code User directory for Copilot Chat sessions (defaults to the platform-specific dir, e.g. `~/Library/Application Support/Code/User`). |
| `convoThinkExport.outputDirectory` | `""` | Directory for exported files (defaults to workspace root). |

## Architecture

```
┌─────────────────────────────────────────┐
│              VSCode UI Layer             │
│  comandos, tree view de sessões, settings│
└───────────────────┬───────────────────────┘
                    │
┌───────────────────▼───────────────────────┐
│         Normalizer / Modelo Intermédio     │
│   (o esquema JSON canónico)                │
└───────────────────┬───────────────────────┘
                    │
     ┌───────────────┼────────────────┐
     ▼               ▼                ▼
┌──────────┐   ┌──────────┐   ┌──────────────┐
│  Adapter  │   │  Adapter  │   │   Adapter     │
│Claude Code│   │  Cursor   │   │ Copilot Chat  │
│ (JSONL)   │   │ (SQLite)  │   │  (JSON)       │
└──────────┘   └──────────┘   └──────────────┘
                    │
             ┌──────▼──────┐
             │  Renderers   │
             │ JSON / MD    │
             └─────────────┘
```

Each adapter only knows how to convert one source format into the intermediate model. Nothing else in the code depends on the internal format of any tool — this isolates the point of failure when Cursor or Claude Code change versions.

### Resilience

- Each adapter runs isolated; a session that fails to parse doesn't break the export of others.
- Example fixtures (anonymized real sessions) are kept per source-version as regression tests.
- Clear logging of "field not found / unexpected format" instead of silent failure.

## Implementation phases

1. **MVP — Claude Code only**: JSON schema + Markdown renderer + manual export command. ✅
2. **Canonicalization + tests**: regression fixtures, schema validation (Zod), explicit `empty`/`redacted` handling. ✅
3. **Cursor**: SQLite adapter (stub present).
4. **Copilot Chat**: adapter reading JSONL mutation logs from VS Code storage (including external/BYOK model conversations). ✅
5. **UI/UX**: tree view, picker, settings, LLM summary command. ✅
6. **(Optional) Reimport mode**: inject exported Markdown/JSON as the first message of a new conversation.

## Development

```bash
npm install
npm run compile      # TypeScript compile
npm run watch        # Watch mode
npm run package      # Production bundle via esbuild
npm test             # Run VS Code extension tests
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Note on reuse in the target agent

The exported file should be treated as context material (system/user turn), not as "revived" thinking — no agent accepts a manually pasted thinking block as if it were genuine reasoning from a previous turn (the Anthropic API requires a cryptographic signature, for example). The thinking is exported as readable text within the conversation, not as a re-injectable block.

## License

Apache-2.0
