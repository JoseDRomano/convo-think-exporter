/**
 * JSON renderer — simply serializes the canonical session to JSON.
 * Validates against the Zod schema before emitting.
 */

import type { ExportedSession } from "../types";
import { ZodExportedSession } from "../types";
import { error } from "../logger";

export function renderJson(session: ExportedSession): string {
  const result = ZodExportedSession.safeParse(session);
  if (!result.success) {
    error(`Schema validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    throw new Error(`Exported session does not match canonical schema: ${result.error.message}`);
  }
  return JSON.stringify(result.data, null, 2);
}
