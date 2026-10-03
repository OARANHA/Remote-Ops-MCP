import { readFile } from "node:fs/promises";
import { env } from "../lib/env.js";
import { OpsError } from "../lib/errors.js";
import { redactObject, redactText } from "../security/redact.js";

type JsonObject = Record<string, unknown>;
type EnvVar = { name: string; value: string };

const cachedApiKeys = new Map<string, string>();

function resolvedApiKeyFile(customFile?: string): string {
  if (customFile === undefined) return env.PORTAINER_API_KEY_FILE;
  const file = customFile.trim();
  if (
    !file.startsWith("/app/secrets/") ||
    file.includes("..") ||
    /[\r\n\0]/.test(file)
  ) {
    throw new OpsError("CAPABILITY_DENIED", "arquivo de credencial Portainer inválido");
  }
  return file;
}

async function apiKey(customFile?: string): Promise<string> {
  const file = resolvedApiKeyFile(customFile);
  const cached = cachedApiKeys.get(file);
  if (cached) return cached;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new OpsError(
      "CAPABILITY_DENIED",
      "Portainer API não configurada",
      `grave o access token somente no secret file autorizado ${file}`,
    );
  }
  const token = raw.trim();
  if (!token || token.length < 16 || /\s/.test(token)) {
    throw new OpsError("CAPABILITY_DENIED", "token do Portainer ausente ou inválido");
  }
  cachedApiKeys.set(file, token);
  return token;
}

function apiUrl(path: string, customBaseUrl?: string): string {
  const rawBase = (customBaseUrl ?? env.PORTAINER_URL).trim();
  if (customBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(rawBase);
    } catch {
      throw new OpsError("CAPABILITY_DENIED", "origem Portainer inválida");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new OpsError("CAPABILITY_DENIED", "origem Portainer inválida");
    }
  }
  const base = rawBase.replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}/api${normalized}`;
}

function portainerDockerPath(endpointId: number, dockerPath: string): string {
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    throw new OpsError("INVALID_ARGUMENT", "Portainer endpoint inválido");
  }
  if (!dockerPath.startsWith("/") || dockerPath.startsWith("//") || /[\r\n\0]/.test(dockerPath)) {
    throw new OpsError("INVALID_ARGUMENT", "Docker API path inválido");
  }
  return `/endpoints/${endpointId}/docker${dockerPath}`;
}

export async function portainerDockerRequest(input: {
  endpointId: number;
  method: string;
  path: string;
  body?: Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  baseUrl?: string;
  apiKeyFile?: string;
}): Promise<{ status: number; body: Buffer }> {
  const credentialFile = resolvedApiKeyFile(input.apiKeyFile);
  const token = await apiKey(credentialFile);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? env.PORTAINER_TIMEOUT_MS, 1000), 180_000);
  const maxBytes = Math.min(Math.max(input.maxBytes ?? 2 * 1024 * 1024, 64 * 1024), 8 * 1024 * 1024);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(portainerDockerPath(input.endpointId, input.path), input.baseUrl), {
      method: input.method,
      headers: {
        Accept: "*/*",
        "X-API-Key": token,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
      },
      body: input.body,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) cachedApiKeys.delete(credentialFile);

    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel();
          throw new OpsError("REMOTE_COMMAND_FAILED", "resposta Docker via Portainer excedeu o limite");
        }
        chunks.push(chunk);
      }
    }
    return { status: response.status, body: Buffer.concat(chunks) };
  } catch (error) {
    if (error instanceof OpsError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpsError("COMMAND_TIMEOUT", "timeout no Docker API via Portainer");
    }
    throw new OpsError(
      "REMOTE_COMMAND_FAILED",
      "falha no Docker API via Portainer",
      error instanceof Error ? redactText(error.message) : undefined,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await apiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PORTAINER_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": token,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = redactText(text.slice(0, 1000));
      }
    }

    if (!response.ok) {
      const detail =
        payload && typeof payload === "object"
          ? JSON.stringify(redactObject(payload)).slice(0, 800)
          : String(payload ?? "").slice(0, 800);
      if (response.status === 401 || response.status === 403) {
        cachedApiKeys.delete(env.PORTAINER_API_KEY_FILE);
        throw new OpsError(
          "CAPABILITY_DENIED",
          `Portainer recusou a credencial (HTTP ${response.status})`,
          "gere um novo Access Token em My Account → Access tokens",
        );
      }
      throw new OpsError(
        "REMOTE_COMMAND_FAILED",
        `Portainer API retornou HTTP ${response.status}`,
        detail || undefined,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof OpsError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpsError("COMMAND_TIMEOUT", "timeout ao acessar Portainer API");
    }
    throw new OpsError(
      "REMOTE_COMMAND_FAILED",
      "falha ao acessar Portainer API",
      error instanceof Error ? redactText(error.message) : undefined,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function envArray(value: unknown): EnvVar[] {
  if (!Array.isArray(value)) return [];
  const result: EnvVar[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as JsonObject;
    if (typeof row.name !== "string") continue;
    result.push({
      name: row.name,
      value: typeof row.value === "string" ? row.value : String(row.value ?? ""),
    });
  }
  return result;
}

function safeStack(stack: JsonObject): JsonObject {
  const git = stack.GitConfig;
  const gitSafe =
    git && typeof git === "object"
      ? {
          URL: (git as JsonObject).URL ?? null,
          ReferenceName: (git as JsonObject).ReferenceName ?? null,
          ConfigFilePath: (git as JsonObject).ConfigFilePath ?? null,
          ConfigHash: (git as JsonObject).ConfigHash ?? null,
        }
      : null;

  return {
    Id: stack.Id ?? null,
    Name: stack.Name ?? null,
    Type: stack.Type ?? null,
    Status: stack.Status ?? null,
    EndpointId: stack.EndpointId ?? null,
    EntryPoint: stack.EntryPoint ?? null,
    CreatedBy: stack.CreatedBy ?? null,
    UpdatedBy: stack.UpdatedBy ?? null,
    GitConfig: gitSafe,
    Env: envArray(stack.Env).map(({ name, value }) => ({
      name,
      configured: value.length > 0,
      value: "[REDACTED]",
    })),
  };
}

async function rawStack(id: number): Promise<JsonObject> {
  return requestJson<JsonObject>(`/stacks/${id}`);
}

function stackEndpointId(stack: JsonObject): number {
  const id = Number(stack.EndpointId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new OpsError("REMOTE_COMMAND_FAILED", "stack sem EndpointId válido");
  }
  return id;
}

function stackName(stack: JsonObject): string {
  const name = String(stack.Name ?? "");
  if (!name) throw new OpsError("REMOTE_COMMAND_FAILED", "stack sem nome válido");
  return name;
}

export async function portainerStatus(): Promise<unknown> {
  const status = await requestJson<JsonObject>("/system/status");
  return redactObject({
    configuredUrl: env.PORTAINER_URL,
    status,
  });
}

export async function portainerEndpoints(): Promise<unknown> {
  const items = await requestJson<unknown[]>("/endpoints");
  return {
    endpoints: (Array.isArray(items) ? items : []).map((value) => {
      const item = (value ?? {}) as JsonObject;
      return {
        Id: item.Id ?? null,
        Name: item.Name ?? null,
        Type: item.Type ?? null,
        Status: item.Status ?? null,
        GroupId: item.GroupId ?? null,
      };
    }),
  };
}

export async function portainerStacks(): Promise<unknown> {
  const items = await requestJson<unknown[]>("/stacks");
  return {
    stacks: (Array.isArray(items) ? items : []).map((item) =>
      safeStack((item ?? {}) as JsonObject),
    ),
  };
}

export async function portainerStack(id: number): Promise<unknown> {
  return safeStack(await rawStack(id));
}

export async function updatePortainerStackEnv(input: {
  stackId: number;
  confirmStackName: string;
  changes: EnvVar[];
  unsetNames: string[];
  replaceAll: boolean;
  pullImage: boolean;
  prune: boolean;
}): Promise<unknown> {
  const stack = await rawStack(input.stackId);
  const name = stackName(stack);
  if (input.confirmStackName !== name) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "confirmação do nome da stack não corresponde",
      `informe confirm_stack_name exatamente como "${name}"`,
    );
  }

  const current = envArray(stack.Env);
  const next = new Map<string, string>();
  if (!input.replaceAll) {
    for (const row of current) next.set(row.name, row.value);
  }
  for (const nameToUnset of input.unsetNames) next.delete(nameToUnset);
  for (const change of input.changes) next.set(change.name, change.value);
  const merged = [...next.entries()].map(([envName, value]) => ({
    name: envName,
    value,
  }));

  const endpointId = stackEndpointId(stack);
  const isGit = Boolean(stack.GitConfig);

  if (isGit) {
    await requestJson(
      `/stacks/${input.stackId}/git/redeploy?endpointId=${endpointId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          env: merged,
          pullImage: input.pullImage,
          prune: input.prune,
        }),
      },
    );
  } else {
    const file = await requestJson<JsonObject>(
      `/stacks/${input.stackId}/file`,
    );
    const stackFileContent = String(file.StackFileContent ?? "");
    if (!stackFileContent) {
      throw new OpsError(
        "REMOTE_COMMAND_FAILED",
        "Portainer não retornou StackFileContent",
      );
    }
    await requestJson(
      `/stacks/${input.stackId}?endpointId=${endpointId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          stackFileContent,
          env: merged,
          pullImage: input.pullImage,
          prune: input.prune,
        }),
      },
    );
  }

  return {
    stackId: input.stackId,
    stackName: name,
    source: isGit ? "git" : "compose",
    updatedVariables: input.changes.map((item) => item.name),
    removedVariables: input.unsetNames,
    totalVariables: merged.length,
    redeployed: true,
  };
}

export async function redeployPortainerGitStack(input: {
  stackId: number;
  confirmStackName: string;
  pullImage: boolean;
  prune: boolean;
}): Promise<unknown> {
  const stack = await rawStack(input.stackId);
  const name = stackName(stack);
  if (input.confirmStackName !== name) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "confirmação do nome da stack não corresponde",
      `informe confirm_stack_name exatamente como "${name}"`,
    );
  }
  if (!stack.GitConfig) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "esta stack não foi criada a partir de Git",
    );
  }
  const endpointId = stackEndpointId(stack);
  const currentEnv = envArray(stack.Env);
  await requestJson(
    `/stacks/${input.stackId}/git/redeploy?endpointId=${endpointId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        env: currentEnv,
        pullImage: input.pullImage,
        prune: input.prune,
      }),
    },
  );
  return {
    stackId: input.stackId,
    stackName: name,
    redeployed: true,
    pullImage: input.pullImage,
    prune: input.prune,
  };
}


export async function startPortainerStack(input: {
  stackId: number;
  confirmStackName: string;
}): Promise<unknown> {
  const stack = await rawStack(input.stackId);
  const name = stackName(stack);
  if (input.confirmStackName !== name) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "confirmação do nome da stack não corresponde",
      `informe confirm_stack_name exatamente como "${name}"`,
    );
  }

  const endpointId = stackEndpointId(stack);
  const started = await requestJson<JsonObject>(
    `/stacks/${input.stackId}/start?endpointId=${endpointId}`,
    { method: "POST" },
  );

  return {
    stackId: input.stackId,
    stackName: name,
    started: true,
    stack: safeStack(started),
  };
}

export async function stopPortainerStack(input: {
  stackId: number;
  confirmStackName: string;
}): Promise<unknown> {
  const stack = await rawStack(input.stackId);
  const name = stackName(stack);
  if (input.confirmStackName !== name) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "confirmação do nome da stack não corresponde",
      `informe confirm_stack_name exatamente como "${name}"`,
    );
  }

  const endpointId = stackEndpointId(stack);
  const stopped = await requestJson<JsonObject>(
    `/stacks/${input.stackId}/stop?endpointId=${endpointId}`,
    { method: "POST" },
  );

  return {
    stackId: input.stackId,
    stackName: name,
    stopped: true,
    stack: safeStack(stopped),
  };
}

export async function deletePortainerStack(input: {
  stackId: number;
  confirmStackName: string;
  removeVolumes: boolean;
}): Promise<unknown> {
  const stack = await rawStack(input.stackId);
  const name = stackName(stack);
  if (input.confirmStackName !== name) {
    throw new OpsError(
      "INVALID_ARGUMENT",
      "confirmação do nome da stack não corresponde",
      `informe confirm_stack_name exatamente como "${name}"`,
    );
  }

  const endpointId = stackEndpointId(stack);
  const removeVolumes = input.removeVolumes === true;
  await requestJson(
    `/stacks/${input.stackId}?endpointId=${endpointId}&removeVolumes=${removeVolumes}`,
    { method: "DELETE" },
  );

  return {
    stackId: input.stackId,
    stackName: name,
    deleted: true,
    removeVolumes,
  };
}

export async function createPortainerGitStack(input: {
  endpointId: number;
  name: string;
  repositoryUrl: string;
  referenceName: string;
  composeFile: string;
  env: EnvVar[];
}): Promise<unknown> {
  const created = await requestJson<JsonObject>(
    `/stacks/create/standalone/repository?endpointId=${input.endpointId}`,
    {
      method: "POST",
      body: JSON.stringify({
        Name: input.name,
        RepositoryURL: input.repositoryUrl,
        RepositoryReferenceName: input.referenceName,
        ComposeFile: input.composeFile,
        RepositoryAuthentication: false,
        Env: input.env,
      }),
    },
  );
  return safeStack(created);
}
