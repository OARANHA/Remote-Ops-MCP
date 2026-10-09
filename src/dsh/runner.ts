#!/usr/bin/env node
/**
 * Opt-in local worker for a DEDICATED Linux execution broker/target.
 * Not an MCP tool; does not configure a VPS, broker, target, or credentials.
 * Wire protocol: one JSON task line on stdin; sanitized JSONL events on stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { CANONICAL_PATHS, canonicalTaskPrompt, parseTaskRequest, safeDshEvent } from "./protocol.js";

const ROOT = "/opt/vigiafast-agent/worktree/CRISE";
const DSH_BIN = "/usr/local/bin/dsh";
const PATCH = "/etc/vigiafast-dsh/chutes-headless.patch.yml";
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2000;
const TIMEOUT_MS = 12 * 60_000;

function emit(value: object): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function fail(code: string): never {
  emit({ type: "failure", code });
  process.exit(1);
}
function verifyCheckout(expectedSha: string, isResume: boolean): void {
  if (process.platform !== "linux") throw new Error("linux_required");
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(ROOT)) throw new Error("invalid_workspace");
  const root = fs.realpathSync(ROOT);
  for (const name of CANONICAL_PATHS) {
    const target = fs.realpathSync(path.join(ROOT, name));
    if (!target.startsWith(root + path.sep)) throw new Error("canonical_path_escape");
    if (!fs.statSync(target).isFile() || fs.statSync(target).size === 0) throw new Error("canonical_file_missing");
  }
  const adrDir = fs.realpathSync(path.join(ROOT, "docs/decisions"));
  if (!adrDir.startsWith(root + path.sep) || !fs.statSync(adrDir).isDirectory()) throw new Error("adrs_missing");
  const sha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: ROOT, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (sha !== expectedSha) throw new Error("sha_mismatch");
  // A fresh task must start from a clean, dedicated checkout. On resume,
  // the session may legitimately have uncommitted edits of its own.
  if (!isResume) {
    const dirty = execFileSync("/usr/bin/git", ["status", "--porcelain=v1"], {
      cwd: ROOT, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    });
    if (dirty.trim()) throw new Error("checkout_dirty");
  }
  if (!fs.statSync(DSH_BIN).isFile() && !fs.statSync(DSH_BIN).isSymbolicLink()) throw new Error("dsh_missing");
  if (!fs.statSync(PATCH).isFile()) throw new Error("patch_missing");
}

function readRequest(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;
    const settle = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", receive);
      process.stdin.off("end", ended);
      error ? reject(error) : resolve(value);
    };
    const ended = () => settle(new Error("input_closed"));
    const receive = (chunk: Buffer | string) => {
      data += chunk.toString();
      if (Buffer.byteLength(data, "utf8") > 12_288) return settle(new Error("input_too_large"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try { settle(undefined, JSON.parse(data.slice(0, end))); }
      catch { settle(new Error("invalid_json")); }
    };
    const timer = setTimeout(() => settle(new Error("input_timeout")), 30_000);
    process.stdin.on("data", receive);
    process.stdin.once("end", ended);
    process.stdin.resume();
  });
}

async function run(): Promise<void> {
  let raw: unknown;
  try { raw = await readRequest(); }
  catch { fail("invalid_task_input"); }
  let request;
  try { request = parseTaskRequest(raw); }
  catch { fail("task_denied"); }
  try { verifyCheckout(request.expected_sha, !!request.session_id); }
  catch { fail("checkout_gate_denied"); }

  const argv = ["--profile", "headless", "--patch", PATCH, "--json"];
  if (request.session_id) argv.push("--session-id", request.session_id);
  argv.push("-");

  emit({ type: "started", request_id: request.request_id, expected_sha: request.expected_sha });
  const child = spawn(DSH_BIN, argv, {
    cwd: ROOT, shell: false, detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/var/lib/vigiafast-dsh",
      LANG: "C.UTF-8",
      TERM: "dumb",
      // Auth is loaded by Harness from the dedicated account's credential store.
      // No secret values, env override, arbitrary command, or caller-supplied path.
    },
  });
  child.stdin.on("error", () => { /* child may reject stdin on startup failure */ });
  child.stdin.end(canonicalTaskPrompt(request));

  let bytes = 0;
  let eventCount = 0;
  let lineBuffer = "";
  let sawFinal = false;
  let abortCode: string | null = null;
  let completed = false;

  function terminateGroup(signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch {} }
  }
  const abort = (reason: string) => {
    if (abortCode) return;
    abortCode = reason;
    terminateGroup("SIGTERM");
    setTimeout(() => terminateGroup("SIGKILL"), 2000).unref();
  };
  const timer = setTimeout(() => abort("run_timeout"), TIMEOUT_MS);
  const onSignal = () => { abort("cancelled"); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  child.stderr.resume(); // NEVER forward or persist raw model reasoning or tool payloads.

  child.stdout.on("data", (data: Buffer) => {
    if (abortCode) return;
    bytes += data.length;
    if (bytes > MAX_STDOUT_BYTES) return abort("event_stream_limit");
    lineBuffer += data.toString("utf8");
    if (Buffer.byteLength(lineBuffer, "utf8") > 131_072) return abort("event_line_limit");
    let newline: number;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (++eventCount > MAX_EVENTS) { abort("event_count_limit"); return; }
      let obj: unknown;
      try { obj = JSON.parse(line); }
      catch { abort("invalid_dsh_json"); return; }
      const safe = safeDshEvent(obj);
      if (!safe) continue;
      if (safe.type === "final") sawFinal = true;
      emit(safe);
    }
  });

  await new Promise<void>((resolve) => {
    child.once("error", () => { abortCode ??= "dsh_spawn_failed"; });
    child.once("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      const ok = !abortCode && code === 0 && sawFinal && lineBuffer.trim().length === 0;
      emit({ type: "complete", ok, exit_code: typeof code === "number" ? code : null, ...(abortCode ? { error: abortCode } : {}) });
      if (!ok) process.exitCode = 1;
      resolve();
    });
  });
}

run().catch(() => fail("executor_failure"));
