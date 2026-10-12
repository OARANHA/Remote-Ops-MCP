import type { Observation } from "./contracts.js";
import { parseObservation } from "./contracts.js";
export type TargetHealthSummary = {
  targetId:string; level:"ok"|"warn"|"crit"|"unknown";
  completeness:"complete"|"partial"|"unavailable";
  counts:{ok:number;warn:number;crit:number;unknown:number};
};
export function summarizeTargetObservations(observations:readonly Observation[]):TargetHealthSummary[]{
  const byTarget=new Map<string,Observation>();
  for(const entry of observations){
    const obs=parseObservation(entry);
    if(byTarget.has(obs.targetId))throw new TypeError("DUPLICATE_OBSERVATION");
    byTarget.set(obs.targetId,obs);
  }
  return [...byTarget.values()].sort((a,b)=>a.targetId.localeCompare(b.targetId)).map(o=>{
    const counts={ok:0,warn:0,crit:0,unknown:0};
    for(const m of o.metrics)counts[m.status]++;
    const completeness=o.completeness==="complete"&&counts.unknown>0?"partial":o.completeness;
    const level=counts.crit?"crit":counts.warn?"warn":counts.unknown?"unknown":counts.ok?"ok":"unknown";
    return {targetId:o.targetId,level,completeness,counts};
  });
}
