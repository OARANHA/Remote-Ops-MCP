import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMeasurement, summarizeHealth, DEFAULT_THRESHOLDS } from "./dist/observability/health-policy.js";

const now = Date.parse("2026-10-12T03:00:00.000Z");
const sample = (percentage, signal = "disk", observedAt = new Date(now).toISOString()) => ({
  targetId: "safe-lab", signal, percentage, observedAt
});
test("boundary threshold and ordering", () => {
  assert.equal(evaluateMeasurement(sample(79), { now }).level, "ok");
  assert.equal(evaluateMeasurement(sample(80), { now }).level, "warn");
  assert.equal(evaluateMeasurement(sample(90), { now }).level, "crit");
  assert.equal(DEFAULT_THRESHOLDS.disk.crit, 90);
});
test("missing, invalid, and stale are UNKNOWN, never healthy", () => {
  for (const value of [null, -1, 101, Number.NaN, Infinity]) {
    assert.equal(evaluateMeasurement(sample(value), { now }).level, "unknown");
  }
  assert.equal(evaluateMeasurement(sample(50, "cpu", "2026-10-11T00:00:00Z"), { now }).reason, "stale");
  assert.equal(evaluateMeasurement(sample(50, "cpu", "2026-10-13T00:00:00Z"), { now }).level, "unknown");
});
test("aggregate never hides missing data", () => {
  const findings = [evaluateMeasurement(sample(20), { now }),
    evaluateMeasurement(sample(null, "memory"), { now })];
  assert.deepEqual(summarizeHealth(findings).counts, { ok: 1, warn: 0, crit: 0, unknown: 1 });
  assert.equal(summarizeHealth(findings).level, "unknown");
  assert.equal(summarizeHealth([]).level, "unknown");
});
test("bad thresholds fail closed", () => {
  const thresholds = { ...DEFAULT_THRESHOLDS, disk: { warn: 95, crit: 80 } };
  assert.throws(() => evaluateMeasurement(sample(50), { now, thresholds }), TypeError);
});
