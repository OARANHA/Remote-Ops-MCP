import fs from "node:fs";
import { z } from "zod";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";

const TargetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "id deve ser kebab-case (ex.: wandora-prod)"),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default("ops-mcp"),
  credentialRef: z.string().optional(),
  keyFile: z.string().optional(),
  deviceId: z.string().regex(/^dev_[A-Za-z0-9_-]{8,80}$/).optional(),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/=-]+$/).optional(),
  hostKey: z.string().optional(),
  environment: z.enum(["production", "staging", "development"]).default("production"),
  capabilityProfile: z.enum(["read-only", "prod-read-mostly", "operator"]).default("prod-read-mostly"),
  allowedPaths: z.array(z.string()).default([]),
  allowedDockerContainers: z.array(z.string()).default([]),
  allowedDockerExecContainers: z.array(z.string()).default([]),
  allowedDockerExecPrograms: z.array(z.string()).default([]),
  allowedDockerActions: z.array(z.enum(["start", "stop", "restart"])).default([]),
  allowedDockerImageLoadRoots: z.array(z.string()).default([]),
  allowedDockerCandidateImagePrefixes: z.array(z.string()).default([]),
  allowedDockerCandidateNetworks: z.array(z.string()).default([]),
  allowedDockerCandidateNamePrefixes: z.array(z.string()).default([]),
  allowedDockerCandidateHostPorts: z.array(z.number().int().min(1024).max(65535)).default([]),
  allowedDockerCandidateContainerPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  allowedServices: z.array(z.string()).default([]),
  allowedServiceActions: z.array(z.enum(["start", "stop", "restart", "reload"])).default([]),
  allowedGitRepos: z.array(z.string()).default([]),
  allowedWritePaths: z.array(z.string()).default([]),
  allowedProcessCwds: z.array(z.string()).default([]),
  allowedProcessPrograms: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  transport: z.enum(["ssh", "mock", "agent"]).default("ssh"),
  commandTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  connectTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
});

const RegistrySchema = z.object({ targets: z.array(TargetSchema).min(1) });
export type TargetConfig = z.infer<typeof TargetSchema>;
interface Registry { targets: Map<string, TargetConfig>; }
let registry: Registry | null = null;

export function loadRegistry(): void {
  const file = env.TARGETS_FILE;
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`Target Registry não encontrado em "${file}". Copie config/targets.example.json para config/targets.json e edite.`); }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { throw new Error(`Target Registry inválido (JSON malformado) em "${file}": ${(e as Error).message}`); }
  const parsed = RegistrySchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Target Registry inválido em "${file}": ${detail}`);
  }
  const map = new Map<string, TargetConfig>();
  for (const t of parsed.data.targets) {
    if (t.transport === "agent" && !t.deviceId) throw new Error(`Target Registry inválido: target "${t.id}" usa transport agent sem deviceId`);
    if (map.has(t.id)) throw new Error(`Target Registry duplicado: id "${t.id}" aparece mais de uma vez`);
    map.set(t.id, t);
  }
  registry = { targets: map };
  console.log(JSON.stringify({ts:new Date().toISOString(),level:"info",msg:"target registry carregado",targets:[...map.keys()]}));
}
function ensure(): Registry { if (!registry) throw new OpsError("INTERNAL", "registry não carregado"); return registry; }
export function getTarget(id: string): TargetConfig | undefined { return ensure().targets.get(id); }
export function listTargets(): TargetConfig[] { return [...ensure().targets.values()]; }
export function targetIds(): string[] { return [...ensure().targets.keys()]; }
export function targetCount(): number { return ensure().targets.size; }
export function publicTarget(t: TargetConfig) {
  return {id:t.id,environment:t.environment,capabilityProfile:t.capabilityProfile,transport:t.transport,enabled:t.enabled,allowedPaths:t.allowedPaths,allowedDockerContainers:t.allowedDockerContainers,allowedDockerExecContainers:t.allowedDockerExecContainers,allowedDockerExecPrograms:t.allowedDockerExecPrograms,allowedDockerActions:t.allowedDockerActions,allowedDockerImageLoadRoots:t.allowedDockerImageLoadRoots,allowedDockerCandidateImagePrefixes:t.allowedDockerCandidateImagePrefixes,allowedDockerCandidateNetworks:t.allowedDockerCandidateNetworks,allowedDockerCandidateNamePrefixes:t.allowedDockerCandidateNamePrefixes,allowedDockerCandidateHostPorts:t.allowedDockerCandidateHostPorts,allowedDockerCandidateContainerPorts:t.allowedDockerCandidateContainerPorts,allowedServices:t.allowedServices,allowedServiceActions:t.allowedServiceActions,allowedGitRepos:t.allowedGitRepos,allowedWritePaths:t.allowedWritePaths,allowedProcessCwds:t.allowedProcessCwds,allowedProcessPrograms:t.allowedProcessPrograms};
}