/**
 * Tree view provider — lists discovered agent sessions grouped by source.
 */

import * as vscode from "vscode";
import type { SessionInfo } from "../types";
import { AdapterRegistry } from "../adapters";
import { error } from "../logger";

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sessions: SessionInfo[] = [];

  constructor(private readonly registry: AdapterRegistry) {}

  refresh(): void {
    this.loadSessions().then(
      () => this._onDidChange.fire(),
      (e) => error(`Failed to load sessions for tree: ${e}`)
    );
  }

  private async loadSessions(): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.sessions = await this.registry.discoverAllSessions(workspacePath);
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (!element) {
      // Root: group by source
      const sources = Array.from(new Set(this.sessions.map((s) => s.source)));
      return sources.map(
        (source) =>
          new SessionTreeItem(
            source,
            source,
            vscode.TreeItemCollapsibleState.Expanded,
            "source",
            undefined
          )
      );
    }

    if (element.contextValue === "source") {
      const source = element.source!;
      return this.sessions
        .filter((s) => s.source === source)
        .map(
          (s) =>
            new SessionTreeItem(
              s.label,
              s.session_id,
              vscode.TreeItemCollapsibleState.None,
              "session",
              s
            )
        );
    }

    return [];
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sessionId: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: "source" | "session",
    public readonly sessionInfo?: SessionInfo
  ) {
    super(label, collapsibleState);
    if (contextValue === "source") {
      this.iconPath = new vscode.ThemeIcon("folder");
    } else {
      this.iconPath = new vscode.ThemeIcon("comment-discussion");
      this.tooltip = sessionInfo?.started_at
        ? `${label}\n${new Date(sessionInfo.started_at).toLocaleString()}`
        : label;
      this.command = {
        command: "convoThinkExport.openSession",
        title: "Open Session",
        arguments: [sessionInfo],
      };
    }
  }

  readonly source?: string;
}
