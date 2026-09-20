import net from "node:net";

export interface BrokerRequest {
  op: string;
  args?: Record<string, unknown>;
}

export interface BrokerResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const SOCKET_PATH = process.env.WANDORA_EXEC_BROKER_SOCKET ?? "/run/wandora-ops-exec/exec.sock";

export async function callExecBroker(req: BrokerRequest, timeoutMs = 15_000): Promise<BrokerResponse> {
  return await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET_PATH });
    let data = "";
    let settled = false;
    const finish = (err?: Error, response?: BrokerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(response ?? { ok: false, error: { code: "BROKER_EMPTY", message: "empty broker response" } });
    };
    const timer = setTimeout(() => finish(new Error("exec_broker_timeout")), Math.min(Math.max(timeoutMs, 1000), 120_000));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(req) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) return finish(new Error("exec_broker_response_too_large"));
      const nl = data.indexOf("\n");
      if (nl < 0) return;
      try { finish(undefined, JSON.parse(data.slice(0, nl)) as BrokerResponse); }
      catch { finish(new Error("exec_broker_invalid_json")); }
    });
    socket.on("error", (err) => finish(err));
    socket.on("end", () => { if (!settled) finish(new Error("exec_broker_disconnected")); });
  });
}
