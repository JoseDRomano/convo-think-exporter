/**
 * Utility helpers shared across adapters.
 */

import * as path from "path";
import * as os from "os";

/** Expand ~ in a path. Returns the input unchanged if no tilde. */
export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Convert a path to be relative to projectPath, if possible. */
export function relativeToProject(filePath: string, projectPath: string): string {
  try {
    return path.relative(projectPath, filePath);
  } catch {
    return filePath;
  }
}

/** Generate a short diff summary string like "+12 -3 lines". */
export function diffSummary(added: number, removed: number): string {
  return `+${added} -${removed} lines`;
}

/** Try to parse a value as an ISO-8601 timestamp; return undefined on failure. */
export function tryTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  if (typeof value === "number") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return undefined;
}
