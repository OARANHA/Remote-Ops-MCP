import { OpsError } from "./errors.js";

/**
 * Construção de comandos remotos — SEM interpolação de shell.
 * Todo argumento é single-quoted no estilo POSIX, tornando inofensivos
 * caracteres como ; | $ ` " ' \\ espaços etc.
 *
 * Ex.: buildRemoteCommand(["docker", "logs", "--tail", "100", "wandora-web"])
 *  ->  'docker' 'logs' '--tail' '100' 'wandora-web'
 */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map(shq).join(" ");
}

/**
 * Valida identificadores vindos do modelo (nomes de serviço/contêiner/unidade).
 * Permite [A-Za-z0-9] seguido de [A-Za-z0-9_.@+-], sem espaços, sem slashes,
 * sem $, ;, `, aspas — em dupla camada com o quoting do buildRemoteCommand.
 */
export function assertIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,99}$/.test(value)) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      `valor inválido para ${label}`,
      `use um nome válido (letras, números, ponto, hífen, underline); recebido: ${JSON.stringify(value.slice(0, 40))}`
    );
  }
  return value;
}
