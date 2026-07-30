/**
 * Logger — wraps VS Code OutputChannel for structured, non-failing logging.
 * Each adapter logs warnings for missing/unexpected fields instead of
 * crashing silently.
 */

// Lazy-load vscode so the logger works in plain Node (smoke tests)
type VSCode = typeof import("vscode");
let _vscode: VSCode | undefined;
function vscode(): VSCode {
  if (!_vscode) {
    _vscode = require("vscode") as VSCode;
  }
  return _vscode;
}

type OutputChannel = import("vscode").OutputChannel;
let channel: OutputChannel | undefined;

export function initLogger(context: import("vscode").ExtensionContext): void {
  channel = vscode().window.createOutputChannel("Convo Think Export");
  context.subscriptions.push(channel);
}

function ts(): string {
  return new Date().toISOString();
}

export function log(msg: string): void {
  channel?.appendLine(`[${ts()}] ${msg}`);
  if (!channel) {
    console.log(`[${ts()}] ${msg}`);
  }
}

export function warn(msg: string): void {
  channel?.appendLine(`[${ts()}] WARN  ${msg}`);
  if (!channel) {
    console.warn(`[${ts()}] WARN  ${msg}`);
  }
}

export function error(msg: string): void {
  channel?.appendLine(`[${ts()}] ERROR ${msg}`);
  if (!channel) {
    console.error(`[${ts()}] ERROR ${msg}`);
  }
}

export function showOutput(): void {
  channel?.show();
}
