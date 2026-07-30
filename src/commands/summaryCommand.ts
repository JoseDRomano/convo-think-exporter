/**
 * Summary export command — uses vscode.lm to condense long thinking blocks
 * into bullet points before rendering. Falls back to the full export if no
 * language model is available.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type { ExportedSession, Turn } from "../types";
import { AdapterRegistry } from "../adapters";
import { renderMarkdown } from "../renderers/markdownRenderer";
import { error, log, showOutput } from "../logger";

export class ExportSummaryCommand {
  constructor(private readonly registry: AdapterRegistry) {}

  async execute(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessions = await this.registry.discoverAllSessions(workspacePath);

    if (sessions.length === 0) {
      vscode.window.showInformationMessage("No agent sessions found.");
      return;
    }

    sessions.sort((a, b) => {
      const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
      const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
      return tb - ta;
    });

    const picks = sessions.map((s) => ({
      label: s.label,
      description: s.source,
      detail: s.started_at ? new Date(s.started_at).toLocaleString() : undefined,
      session: s,
    }));

    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: "Select a session to export as summary",
      title: "Export Agent Context (summary only)",
    });

    if (!chosen) {
      return;
    }

    const adapter = this.registry.get(chosen.session.source);
    if (!adapter) {
      error(`No adapter for source: ${chosen.session.source}`);
      return;
    }

    let session: ExportedSession;
    try {
      session = await adapter.loadSession(chosen.session.session_id, chosen.session.project_path);
    } catch (e) {
      error(`Failed to load session: ${e}`);
      vscode.window.showErrorMessage(`Failed to load session: ${e}`);
      showOutput();
      return;
    }

    // Summarize thinking blocks via LLM
    try {
      session = await this.summarizeThinking(session);
    } catch (e) {
      error(`LLM summarization failed, falling back to full thinking: ${e}`);
      // continue with original session
    }

    const config = vscode.workspace.getConfiguration("convoThinkExport");
    const outputDir = config.get<string>("outputDirectory") || workspacePath || os.tmpdir();
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const baseName = `${chosen.session.source}-${chosen.session.session_id}-summary`;
    const md = renderMarkdown(session, { includeThinking: true });
    const filePath = path.join(outputDir, `${baseName}.md`);
    fs.writeFileSync(filePath, md, "utf-8");
    log(`Saved summary: ${filePath}`);

    const action = await vscode.window.showInformationMessage(
      `Exported summary to ${filePath}`,
      "Open"
    );
    if (action === "Open") {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    }
  }

  private async summarizeThinking(session: ExportedSession): Promise<ExportedSession> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
      throw new Error("No language models available for summarization.");
    }

    const model = models[0];
    const summarizedTurns: Turn[] = [];

    for (const turn of session.turns) {
      if (turn.role === "assistant" && turn.thinking.status === "present" && turn.thinking.text) {
        const summary = await this.summarizeText(model, turn.thinking.text);
        summarizedTurns.push({
          ...turn,
          thinking: { status: "present", text: summary },
        });
      } else {
        summarizedTurns.push(turn);
      }
    }

    return { ...session, turns: summarizedTurns };
  }

  private async summarizeText(model: vscode.LanguageModelChat, text: string): Promise<string> {
    const messages = await model.sendRequest([
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        `Summarize the following reasoning into concise bullet points, preserving key decisions and rationale:\n\n${text}`
      ),
    ]);

    let result = "";
    for await (const chunk of messages.text) {
      result += chunk;
    }
    return result;
  }
}
