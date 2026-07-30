/**
 * Extension entry point — registers commands, views, and the adapter
 * registry.
 */

import * as vscode from "vscode";

import { AdapterRegistry } from "./adapters";
import { ExportCommand } from "./commands/exportCommand";
import { ExportSummaryCommand } from "./commands/summaryCommand";
import { initLogger, log } from "./logger";
import { SessionsTreeProvider, SessionTreeItem } from "./views/sessionsTreeProvider";
import type { SessionInfo } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  log("Activating Convo Think Exporter");

  initLogger(context);

  const registry = new AdapterRegistry();

  // Commands
  const exportCmd = new ExportCommand(registry);
  const summaryCmd = new ExportSummaryCommand(registry);

  context.subscriptions.push(
    vscode.commands.registerCommand("convoThinkExport.exportContext", () => exportCmd.execute())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("convoThinkExport.exportContextSummary", () => summaryCmd.execute())
  );

  // Tree view
  const treeProvider = new SessionsTreeProvider(registry);
  const treeView = vscode.window.createTreeView("convoThinkExport.sessionsView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("convoThinkExport.refreshSessions", () => treeProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "convoThinkExport.openSession",
      (item: SessionTreeItem | SessionInfo) => {
        const info = item instanceof SessionTreeItem ? item.sessionInfo : item;
        if (info) {
          exportCmd.execute().then(() => {}, () => {});
          // The export command shows its own picker; for direct tree clicks
          // we could add a dedicated path, but reusing the picker keeps it
          // simple for now.
        }
      }
    )
  );

  // Initial load
  treeProvider.refresh();

  log("Convo Think Exporter activated");
}

export function deactivate(): void {
  // nothing to clean up
}
