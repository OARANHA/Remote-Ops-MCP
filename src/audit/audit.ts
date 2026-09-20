import fs from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { recordToolResult } from "../state/store.js";

/**
 * AUDIT BY DEFAULT — toda chamada de tool gera um evento JSONL em stdout
 * e em data/audit.jsonl. Nunca registrar segredos (os payloads já chegam
 * redigidos e aqui só vão metadados).
 */
export interface AuditEvent {
  ts: string;
  request_id: string;
  actor: string;
  target?: string;
  tool: string;
  mutation: boolean;
  duration_ms: number;
  result: "ok" | "denied" | "error";
  error_code?: string;
}

let ready = false;

export function initAuditFile(): void {
  const dir = path.dirname(env.AUDIT_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    ready = true;
  } catch (e) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: `audit file indisponível em ${dir} (${(e as Error).message}); audit segue apenas em stdout`,
      })
    );
  }
}

export function audit(e: AuditEvent, options: { countUsage?: boolean } = {}): void {
  if (options.countUsage !== false) {
    recordToolResult({ target: e.target, tool: e.tool, result: e.result, error_code: e.error_code });
  }
  const line = JSON.stringify(e);
  console.log(line);
  if (ready) {
    fs.appendFile(env.AUDIT_FILE, line + "\n", () => {
      /* falhas de append não derrubam o serviço */
    });
  }
}
