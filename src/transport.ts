import { GLOBAL_MOCK } from "./lib/env.js";
import type { TargetConfig } from "./config/targets.js";
import { sshExec, type ExecOptions, type ExecResult } from "./ssh/pool.js";
import { mockExec } from "./ssh/mock.js";

/**
 * Fábrica de transporte: "ssh" real ou "mock" (modo ensaio).
 * MOCK_MODE=1 no ambiente força TODOS os targets para mock — nenhum pacote
 * sai da máquina; útil para validar o ChatGPT ponta a ponta antes de ligar SSH.
 */
export interface Transport {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export function getTransport(t: TargetConfig): Transport {
  if (GLOBAL_MOCK || t.transport === "mock") {
    return { exec: (argv, opts) => mockExec(t, argv, opts) };
  }
  return { exec: (argv, opts) => sshExec(t, argv, opts) };
}
