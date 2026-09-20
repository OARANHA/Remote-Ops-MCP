/**
 * Modelo de erros estruturado — nunca expõe stack traces ao modelo.
 * Todos os códigos seguem a filosofia FAIL CLOSED.
 */
export type ErrorCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_DISABLED"
  | "CAPABILITY_DENIED"
  | "PATH_DENIED"
  | "SECRET_PATH_DENIED"
  | "CONTAINER_NOT_ALLOWED"
  | "SERVICE_NOT_ALLOWED"
  | "REPO_NOT_ALLOWED"
  | "DOCKER_ACCESS_DENIED"
  | "JOURNAL_ACCESS_DENIED"
  | "SSH_UNAVAILABLE"
  | "HOST_KEY_MISMATCH"
  | "COMMAND_TIMEOUT"
  | "REMOTE_COMMAND_FAILED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "INVALID_ARGUMENT"
  | "INTERNAL";

export class OpsError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "OpsError";
  }
}

export interface ToolErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
  };
}

/** Monta o payload JSON de erro retornado ao modelo. */
export function toolErrorPayload(err: unknown): { payload: ToolErrorPayload; denied: boolean } {
  if (err instanceof OpsError) {
    return {
      payload: { error: { code: err.code, message: err.message, hint: err.hint } },
      denied: err.code.endsWith("_DENIED") || err.code === "TARGET_NOT_FOUND" || err.code === "TARGET_DISABLED",
    };
  }
  const message = err instanceof Error ? err.message : "erro desconhecido";
  return {
    payload: { error: { code: "INTERNAL", message: "erro interno inesperado" } },
    denied: false,
  };
}

/** Formata erros não-Ops para logs do servidor (sem vazar ao modelo). */
export function loggableError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
