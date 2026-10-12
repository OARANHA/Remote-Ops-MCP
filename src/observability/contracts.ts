import { z } from "zod";

export const metricIds = ["memory.used","memory.total","disk.used","disk.total","disk.usage","cpu.usage","network.rx_rate","network.tx_rate"] as const;
export const MetricId = z.enum(metricIds);
export const HealthLevel = z.enum(["ok","warn","crit","unknown"]);
export const MetricUnit = z.enum(["percent","bytes","bytes_per_second","count"]);
export const UnknownReason = z.enum(["measured","missing","invalid","stale","future","unsupported"]);
export const ObservedMetricSchema = z.object({
  name: MetricId,
  value: z.number().finite().nonnegative().nullable(),
  unit: MetricUnit,
  status: HealthLevel,
  reason: UnknownReason.optional(),
}).strict().superRefine((m,ctx) => {
  const units: Record<(typeof metricIds)[number],z.infer<typeof MetricUnit>> = {
    "memory.used":"bytes","memory.total":"bytes","disk.used":"bytes","disk.total":"bytes",
    "disk.usage":"percent","cpu.usage":"percent",
    "network.rx_rate":"bytes_per_second","network.tx_rate":"bytes_per_second"
  };
  if (m.unit !== units[m.name] || (m.unit==="percent" && m.value!==null && m.value>100)) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"invalid metric unit or range"});
  }
  if ((m.value === null || m.status==="unknown") && !(m.status==="unknown" && m.reason && m.reason!=="measured")) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"unknown metric requires a non-measured reason"});
  }
  if (m.value!==null && m.status!=="unknown" && m.reason && m.reason!=="measured") {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"measured metric cannot have an unknown reason"});
  }
});
export const ObservationSchema = z.object({
  targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  capturedAt: z.string().datetime({offset:true}),
  source: z.enum(["agent","ssh","provider"]),
  metrics: z.array(ObservedMetricSchema).max(32),
  completeness: z.enum(["complete","partial","unavailable"]),
}).strict().superRefine((o,ctx)=>{
  const ids = new Set<string>();
  for (const m of o.metrics) {
    if (ids.has(m.name)) ctx.addIssue({code:z.ZodIssueCode.custom,message:"duplicate metric",path:["metrics"]});
    ids.add(m.name);
  }
  if (o.completeness==="unavailable" && o.metrics.some(m=>m.status!=="unknown")) {
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"unavailable cannot include healthy readings"});
  }
});
export type ObservedMetric = z.infer<typeof ObservedMetricSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type HealthLevelType = z.infer<typeof HealthLevel>;
export function parseObservation(input: unknown): Observation {
  const result = ObservationSchema.safeParse(input);
  if (!result.success) throw new TypeError("INVALID_OBSERVATION");
  return result.data;
}
