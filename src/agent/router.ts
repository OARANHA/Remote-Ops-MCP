import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { env } from "../lib/env.js";
import {
  claimPairing,
  createPairing,
  authenticateDeviceToken,
  touchDeviceHeartbeat,
} from "../state/store.js";

const StartSchema = z.object({
  hostname: z.string().min(1).max(120),
  os: z.string().min(1).max(160).optional(),
  agent_version: z.string().min(1).max(40).optional(),
  fingerprint: z.string().min(8).max(200).optional(),
});

const ClaimSchema = z.object({
  pairing_id: z.string().uuid(),
  poll_token: z.string().min(20).max(200),
});

const HeartbeatSchema = z.object({
  agent_version: z.string().min(1).max(40).optional(),
  capabilities: z.array(z.string().min(1).max(80)).max(64).optional(),
});

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function deviceBearer(req: Request): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

function requireDevice(req: Request, res: Response, next: NextFunction): void {
  const raw = deviceBearer(req);
  const device = raw ? authenticateDeviceToken(raw) : undefined;
  if (!device) {
    res.status(401).json({ error: "invalid_device_credential" });
    return;
  }
  (req as Request & { deviceId?: string }).deviceId = device.device_id;
  next();
}

export function agentRouter(): Router {
  const r = Router();
  r.use((_req, res, next) => { noStore(res); next(); });

  r.post("/pair/start", (req, res) => {
    const parsed = StartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let pairing;
    try { pairing = createPairing(parsed.data); }
    catch (err) {
      const msg = err instanceof Error ? err.message : "pairing_capacity";
      if (msg === "AGENT_PAIRING_CAPACITY") { res.status(429).json({ error: "pairing_capacity" }); return; }
      if (msg === "AGENT_MAX_DEVICES_REACHED") { res.status(503).json({ error: "device_capacity" }); return; }
      throw err;
    }
    res.status(201).json({
      pairing_id: pairing.pairing_id,
      pairing_code: pairing.code,
      poll_token: pairing.poll_token,
      expires_at: new Date(pairing.expires_at).toISOString(),
      expires_in: Math.max(0, Math.floor((pairing.expires_at - Date.now()) / 1000)),
      verification_uri: `${env.PUBLIC_BASE_URL}/admin`,
    });
  });

  r.post("/pair/claim", (req, res) => {
    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = claimPairing(parsed.data.pairing_id, parsed.data.poll_token);
    if (result.status !== "paired") {
      if (result.status === "pending") res.status(202).json({ status: "pending" });
      else if (result.status === "expired") res.status(410).json({ error: "pairing_expired" });
      else res.status(401).json({ error: "invalid_pairing" });
      return;
    }
    res.status(201).json({
      status: "paired",
      device_id: result.device.device_id,
      device_token: result.device_token,
      control_plane: env.PUBLIC_BASE_URL,
      heartbeat_path: "/agent/heartbeat",
    });
  });

  r.post("/heartbeat", requireDevice, (req, res) => {
    const parsed = HeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const deviceId = (req as Request & { deviceId: string }).deviceId;
    const ok = touchDeviceHeartbeat(deviceId, parsed.data);
    if (!ok) {
      res.status(401).json({ error: "device_revoked" });
      return;
    }
    res.json({
      status: "ok",
      device_id: deviceId,
      server_time: new Date().toISOString(),
      heartbeat_interval_seconds: Math.max(15, Math.min(60, Math.floor(env.AGENT_HEARTBEAT_STALE_SECONDS / 3))),
    });
  });

  return r;
}