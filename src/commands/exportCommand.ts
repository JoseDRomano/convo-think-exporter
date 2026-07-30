/**
 * Export command — discovers sessions via the adapter registry, shows a
 * quick pick, loads the chosen session, renders it, and saves the file(s).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type { SessionInfo } from "../types";
import { AdapterRegistry } from "../adapters";
import { renderJson } from "../renderers/jsonRenderer";
import { renderMarkdown } from "../renderers/markdownRenderer";
import { error, log, showOutput, warn } from "../logger";

export class ExportCommand {
  constructor(private readonly registry: AdapterRegistry) {}

  async execute(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let sessions: SessionInfo[];
    try {
      sessions = await this.registry.discoverAllSessions(workspacePath);
    } catch (e) {
      error(`Failed to discover sessions: ${e}`);
      vscode.window.showErrorMessage("Failed to discover agent sessions. Check the output log.");
      showOutput();
      return;
    }

    if (sessions.length === 0) {
      vscode.window.showInformationMessage(
        "No agent sessions found. Make sure the source tools (e.g. Claude Code) have stored sessions locally."
      );
      return;
    }

    // Sort by started_at descending (most recent first)
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
      placeHolder: "Select a session to export",
      title: "Export Agent Context",
    });

    if (!chosen) {
      return;
    }

    await this.exportSession(chosen.session);
  }

  private async exportSession(info: SessionInfo): Promise<void> {
    const adapter = this.registry.get(info.source);
    if (!adapter) {
      error(`No adapter registered for source: ${info.source}`);
      return;
    }

    let session;
    try {
      session = await adapter.loadSession(info.session_id, info.project_path);
    } catch (e) {
      error(`Failed to load session ${info.session_id}: ${e}`);
      vscode.window.showErrorMessage(`Failed to load session: ${e}`);
      showOutput();
      return;
    }

    const config = vscode.workspace.getConfiguration("convoThinkExport");
    const format = config.get<string>("outputFormat") || "both";
    const includeThinking = config.get<boolean>("includeThinking") ?? true;
    const outputDir = config.get<string>("outputDirectory") || workspaceDefaultDir();

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const baseName = `${info.source}-${info.session_id}`;
    const savedFiles: string[] = [];

    try {
      if (format === "json" || format === "both") {
        const json = renderJson(session);
        const filePath = path.join(outputDir, `${baseName}.json`);
        fs.writeFileSync(filePath, json, "utf-8");
        savedFiles.push(filePath);
        log(`Saved JSON: ${filePath}`);
      }

      if (format === "markdown" || format === "both") {
        const md = renderMarkdown(session, { includeThinking });
        const filePath = path.join(outputDir, `${baseName}.md`);
        fs.writeFileSync(filePath, md, "utf-8");
        savedFiles.push(filePath);
        log(`Saved Markdown: ${filePath}`);
      }
    } catch (e) {
      error(`Failed to render session: ${e}`);
      vscode.window.showErrorMessage(`Failed to render session: ${e}`);
      showOutput();
      return;
    }

    if (savedFiles.length === 0) {
      warn("No files were saved (unknown output format).");
      return;
    }

    const action = await vscode.window.showInformationMessage(
      `Exported ${savedFiles.length} file(s) to ${outputDir}`,
      "Open",
      "Reveal in Finder"
    );

    if (action === "Open") {
      for (const f of savedFiles) {
        const doc = await vscode.workspace.openTextDocument(f);
        await vscode.window.showTextDocument(doc);
      }
    } else if (action === "Reveal in Finder") {
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(savedFiles[0]));
    }
  }
}

function workspaceDefaultDir(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.tmpdir();
}
