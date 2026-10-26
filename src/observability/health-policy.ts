/**
 * Offline-only, pure health evaluation primitives.
 * Not exposed as MCP tools and no remote execution/network/filesystem calls.
 * Never infer host status from missing measurements.
 */
export type HealthSignal = "cpu" | "memory" | "disk" | "swap" | "network";
export type HealthLevel = "ok" | "warn" | "crit" | "unknown";
export type Measurement = Readonly<{
  targetId: string;
  signal: HealthSignal;
  percentage: number | null;
  observedAt: string;
}>;
export type Threshold = Readonly<{ warn: number; crit: number }>;
export type HealthFinding = Readonly<{
  targetId: string;
  signal: HealthSignal;
  level: HealthLevel;
  percentage: number | null;
  observedAt: string;
  reason: "measured" | "invalid" | "stale" | "missing";
}>;

export const DEFAULT_THRESHOLDS: Readonly<Record<HealthSignal, Threshold>> = Object.freeze({
  cpu: { warn: 80, crit: 95 },
  memory: { warn: 80, crit: 95 },
  disk: { warn: 80, crit: 90 },
  swap: { warn: 60, crit: 85 },
  network: { warn: 80, crit: 95 },
});

export function validateThresholds(thresholds: Readonly<Record<HealthSignal, Threshold>>): void {
  for (const signal of Object.keys(DEFAULT_THRESHOLDS) as HealthSignal[]) {
    const t = thresholds[signal];
    if (!t || !Number.isFinite(t.warn) || !Number.isFinite(t.crit) ||
      t.warn < 0 || t.crit > 100 || t.warn >= t.crit) {
      throw new TypeError(`Invalid health threshold for ${signal}`);
    }
  }
}

export function evaluateMeasurement(
  sample: Measurement,
  options: {
    now?: number;
    maxAgeMs?: number;
    thresholds?: Readonly<Record<HealthSignal, Threshold>>;
  } = {},
): HealthFinding {
  const { now = Date.now(), maxAgeMs = 5 * 60_000, thresholds = DEFAULT_THRESHOLDS } = options;
  validateThresholds(thresholds);
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError("Invalid freshness settings");
  }
  const base = { targetId: sample.targetId, signal: sample.signal, observedAt: sample.observedAt };
  const timestamp = Date.parse(sample.observedAt);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs) {
    return { ...base, level: "unknown", percentage: null, reason: "stale" };
  }
  if (sample.percentage === null) {
    return { ...base, level: "unknown", percentage: null, reason: "missing" };
  }
  if (!Number.isFinite(sample.percentage) || sample.percentage < 0 || sample.percentage > 100) {
    return { ...base, level: "unknown", percentage: null, reason: "invalid" };
  }
  const t = thresholds[sample.signal];
  if (!t) {
    return { ...base, level: "unknown", percentage: null, reason: "invalid" };
  }
  const level: HealthLevel = sample.percentage >= t.crit ? "crit" :
    sample.percentage >= t.warn ? "warn" : "ok";
  return { ...base, level, percentage: sample.percentage, reason: "measured" };
}

export function summarizeHealth(findings: readonly HealthFinding[]) {
  const counts = { ok: 0, warn: 0, crit: 0, unknown: 0 };
  for (const finding of findings) counts[finding.level]++;
  const level: HealthLevel = counts.crit ? "crit" : counts.warn ? "warn" :
    counts.unknown ? "unknown" : counts.ok ? "ok" : "unknown";
  return { level, counts, observedSignals: findings.length };
}
