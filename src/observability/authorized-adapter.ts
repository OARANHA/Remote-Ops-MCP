import type {Observation, ObservedMetric} from "./contracts.js";
import {parseObservation} from "./contracts.js";
import {normalizeMemoryFreeB,normalizeDiskDfHP} from "./normalize-linux.js";
export type AuthorizedRead=(logicalTargetId:string,operation:"host.memory"|"host.disk_usage")=>Promise<string>;
export async function buildObservationFromAuthorizedReads(input:{
  targetId:string;source:"ssh"|"agent";capturedAt:string;
  authorize:(logicalTargetId:string)=>Promise<boolean>;
  read:AuthorizedRead;
}):Promise<Observation>{
  // This mock-only contract is NOT connected to live MCP authorization.
  if(!/^[a-z0-9][a-z0-9-]{1,39}$/.test(input.targetId))throw new TypeError("INVALID_TARGET");
  let allowed=false;
  try{allowed=await input.authorize(input.targetId);}catch{throw new Error("ACCESS_DENIED");}
  if(!allowed)throw new Error("ACCESS_DENIED");
  const ops=[
    {op:"host.memory" as const,normalize:normalizeMemoryFreeB},
    {op:"host.disk_usage" as const,normalize:normalizeDiskDfHP},
  ];
  const metrics:ObservedMetric[]=[];
  let success=0;
  for(const {op,normalize} of ops){
    try{
      const text=await input.read(input.targetId,op);
      const part=normalize(text,input.capturedAt);
      metrics.push(...part);
      if(part.some(m=>m.status!=="unknown"))success++;
    }catch{
      metrics.push(...(op==="host.memory"?normalizeMemoryFreeB("",input.capturedAt):normalizeDiskDfHP("",input.capturedAt)));
    }
  }
  const completeness=success===ops.length?"complete":success===0?"unavailable":"partial";
  return parseObservation({targetId:input.targetId,source:input.source,capturedAt:input.capturedAt,metrics,completeness});
}
