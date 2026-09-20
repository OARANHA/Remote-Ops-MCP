#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface DeviceState {
  control_plane: string;
  device_id: string;
  device_token: string;
  paired_at: string;
}

const controlPlane = (process.env.WANDORA_CONTROL_PLANE ?? "https://mcp.wandora.com.br").replace(/\/+$/, "");
const stateFile = process.env.WANDORA_AGENT_STATE ?? "/var/lib/wandora-ops-agent/device.json";
const version = "2.0.0-dev";

function machineFingerprint(): string {
  let seed = os.hostname();
  try { seed += ":" + fs.readFileSync("/etc/machine-id", "utf8").trim(); } catch {}
  return "sha256:" + crypto.createHash("sha256").update(seed).digest("hex");
}
function ensureStateDir(): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
}
function saveState(s: DeviceState): void {
  ensureStateDir();
  const tmp = stateFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
  try { fs.chmodSync(stateFile, 0o600); } catch {}
}
function loadState(): DeviceState {
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as DeviceState;
}
async function jsonFetch(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  let body: any = {};
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
async function pair(): Promise<void> {
  const start = await jsonFetch(controlPlane + "/agent/pair/start", {
    method: "POST",
    body: JSON.stringify({ hostname: os.hostname(), os: os.platform() + " " + os.release(), agent_version: version, fingerprint: machineFingerprint() }),
  });
  if (start.status !== 201) throw new Error("pair start failed: HTTP " + start.status);
  const { pairing_id, pairing_code, poll_token, verification_uri, expires_at } = start.body;
  if (!pairing_id || !pairing_code || !poll_token) throw new Error("pair start returned incomplete data");
  process.stdout.write("\nWandora Ops Agent pairing\n\n");
  process.stdout.write("Pairing code: " + pairing_code + "\n");
  process.stdout.write("Approve at:   " + verification_uri + "\n");
  process.stdout.write("Expires at:   " + expires_at + "\n\n");
  process.stdout.write("Waiting for approval");
  const deadline = Date.parse(expires_at);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const claim = await jsonFetch(controlPlane + "/agent/pair/claim", { method: "POST", body: JSON.stringify({ pairing_id, poll_token }) });
    if (claim.status === 202) { process.stdout.write("."); continue; }
    if (claim.status === 201) {
      const { device_id, device_token } = claim.body;
      if (!device_id || !device_token) throw new Error("claim returned incomplete credential");
      saveState({ control_plane: controlPlane, device_id, device_token, paired_at: new Date().toISOString() });
      process.stdout.write("\nPAIRING=GREEN\ndevice_id=" + device_id + "\n");
      return;
    }
    if (claim.status === 410) throw new Error("pairing expired");
    throw new Error("pair claim failed: HTTP " + claim.status);
  }
  throw new Error("pairing expired");
}
async function heartbeatOnce(): Promise<void> {
  const s = loadState();
  const r = await jsonFetch(s.control_plane + "/agent/heartbeat", {
    method: "POST",
    headers: { authorization: "Bearer " + s.device_token },
    body: JSON.stringify({ agent_version: version, capabilities: ["host.status", "disk.usage", "memory.status", "uptime", "fs.read"] }),
  });
  if (r.status !== 200) throw new Error("heartbeat failed: HTTP " + r.status);
  process.stdout.write("HEARTBEAT=GREEN device_id=" + s.device_id + "\n");
}
async function run(): Promise<void> {
  const s = loadState();
  process.stdout.write("WANDORA_AGENT=STARTED device_id=" + s.device_id + "\n");
  for (;;) {
    try { await heartbeatOnce(); }
    catch (e) { process.stderr.write("heartbeat error: " + (e instanceof Error ? e.message : String(e)) + "\n"); }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
async function status(): Promise<void> {
  const s = loadState();
  process.stdout.write(JSON.stringify({ paired: true, device_id: s.device_id, control_plane: s.control_plane, paired_at: s.paired_at }, null, 2) + "\n");
}

const cmd = process.argv[2] ?? "status";
try {
  if (cmd === "pair") await pair();
  else if (cmd === "heartbeat-once") await heartbeatOnce();
  else if (cmd === "run") await run();
  else if (cmd === "status") await status();
  else { process.stderr.write("usage: wandora-ops-agent <pair|status|heartbeat-once|run>\n"); process.exitCode = 2; }
} catch (e) {
  process.stderr.write("ERROR: " + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exitCode = 1;
}