import { GLOBAL_MOCK } from "./lib/env.js";
import type { TargetConfig } from "./config/targets.js";
import { sshExec, type ExecOptions, type ExecResult } from "./ssh/pool.js";
import { mockExec } from "./ssh/mock.js";
import { argvToAgentOperation } from "./agent/operations.js";
import { dispatchAgentOperation } from "./agent/gateway.js";
import { OpsError } from "./lib/errors.js";

export interface Transport {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
}

async function agentExec(t: TargetConfig, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
  if (!t.deviceId) throw new OpsError("SSH_UNAVAILABLE", `target "${t.id}" não possui deviceId Agent Mesh`);
  let op;
  try { op = argvToAgentOperation(argv); }
  catch {
    throw new OpsError("REMOTE_COMMAND_FAILED", `operação não suportada pelo Agent Mesh para target "${t.id}"`);
  }
  try { return await dispatchAgentOperation(t.deviceId, op, opts); }
  catch (e) {
    const msg=e instanceof Error?e.message:String(e);
    throw new OpsError("SSH_UNAVAILABLE", `Agent Mesh indisponível para target "${t.id}": ${msg}`);
  }
}

export function getTransport(t: TargetConfig): Transport {
  if (GLOBAL_MOCK || t.transport === "mock") return { exec: (argv, opts) => mockExec(t, argv, opts) };
  if (t.transport === "agent") return { exec: (argv, opts) => agentExec(t, argv, opts) };
  return { exec: (argv, opts) => sshExec(t, argv, opts) };
}