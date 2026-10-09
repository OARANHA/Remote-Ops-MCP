// Attestation fixture for a single Docker Compose offline laboratory run.
// Not the DeepSeek Harness; no model/API key, shell, network, dynamic code,
// real project, GitHub token or host workspace is used by this program.
import fs from "node:fs";
import path from "node:path";

function procFlag(name) {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const line = status.split("\n").find(s => s.startsWith(name + ":"));
  return line?.split(":")[1]?.trim() ?? "";
}

const checks = {
  linux: process.platform === "linux",
  unprivileged_uid: typeof process.getuid === "function" && process.getuid() === 10001,
  no_linux_caps: /^0+$/.test(procFlag("CapEff")),
  no_new_privileges: procFlag("NoNewPrivs") === "1",
  loopback_only: (() => {
    const interfaces = fs.readdirSync("/sys/class/net");
    return interfaces.length === 1 && interfaces[0] === "lo";
  })(),
  no_docker_socket: !fs.existsSync("/var/run/docker.sock") && !fs.existsSync("/run/docker.sock"),
  no_provider_secret: !Object.keys(process.env).some(k => /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(k)),
  dedicated_home: process.env.HOME === "/tmp",
  telemetry_disabled: process.env.DSH_TELEMETRY_DISABLED === "1",
  read_only_root: (() => {
    const probePath = "/etc/vigiafast-dsh-lab-probe";
    try {
      fs.writeFileSync(probePath, "should-fail", { flag: "wx" });
      try { fs.unlinkSync(probePath); } catch {}
      return false;
    } catch (error) {
      return ["EROFS", "EACCES", "EPERM"].includes(error?.code);
    }
  })(),
  writable_ephemeral_tmpfs: (() => {
    const probePath = path.join("/tmp", "vigiafast-dsh-offline-" + process.pid);
    try {
      fs.writeFileSync(probePath, "ephemeral", { flag: "wx", mode: 0o600 });
      const ok = fs.readFileSync(probePath, "utf8") === "ephemeral";
      fs.unlinkSync(probePath);
      return ok;
    } catch { return false; }
  })(),
};

const ok = Object.values(checks).every(Boolean);
process.stdout.write(JSON.stringify({ type: "offline_lab_attestation", ok, checks }) + "\n");
if (!ok) process.exitCode = 1;
