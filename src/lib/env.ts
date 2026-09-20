import { z } from "zod";

/**
 * Configuração de ambiente — validada em fail-fast no boot.
 * Nenhum segredo fica no código: tudo vem do ambiente seguro (env/Portainer).
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  AUTH_MODE: z.enum(["oauth", "noauth"]).default("oauth"),
  MCP_PASSWORD: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .default("https://mcp.wandora.com.br"),
  TZ: z.string().default("America/Sao_Paulo"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MOCK_MODE: z.string().optional(),

  MAX_OUTPUT_BYTES: z.coerce.number().int().min(4096).max(4_194_304).default(262_144),
  MAX_LOG_LINES: z.coerce.number().int().min(10).max(1000).default(500),
  READ_FILE_MAX_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(10_000).default(120),
  PER_TARGET_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(15_000),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  AUDIT_FILE: z.string().default("data/audit.jsonl"),
  STATE_FILE: z.string().default("data/state.json"),
  TARGETS_FILE: z.string().default("config/targets.json"),
});

export const env = EnvSchema.parse(process.env);

export const GLOBAL_MOCK: boolean =
  env.MOCK_MODE === "1" || (env.MOCK_MODE ?? "").toLowerCase() === "true";

export function validateAuthEnv(): void {
  if (env.AUTH_MODE === "oauth") {
    if (!env.MCP_PASSWORD || env.MCP_PASSWORD.length < 8) {
      throw new Error("AUTH_MODE=oauth exige MCP_PASSWORD com pelo menos 8 caracteres");
    }
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
      throw new Error("AUTH_MODE=oauth exige AUTH_SECRET com pelo menos 32 caracteres (openssl rand -hex 32)");
    }
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
      throw new Error("AUTH_MODE=oauth exige ADMIN_PASSWORD com pelo menos 12 caracteres para o console administrativo");
    }
    if (env.MCP_PASSWORD === env.ADMIN_PASSWORD) {
      throw new Error("MCP_PASSWORD e ADMIN_PASSWORD devem ser diferentes");
    }
    if (env.MCP_PASSWORD.length < 12) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "MCP_PASSWORD é curta (<12). Recomenda-se uma senha forte.",
        })
      );
    }
  } else {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "AUTH_MODE=noauth: o endpoint /mcp está SEM autenticação. Use apenas em teste local. NUNCA exponha publicamente.",
      })
    );
  }
}
