import type { ObservedMetric } from "./contracts.js";

const MAX_INPUT=128*1024;
function unknown(name: ObservedMetric["name"],unit:ObservedMetric["unit"]):ObservedMetric {
  return {name,unit,value:null,status:"unknown",reason:"invalid"};
}
function numberCell(s:string):number|null {
  if (!/^[0-9]+$/.test(s))return null;
  const n=Number(s);
  return Number.isSafeInteger(n)?n:null;
}
export function normalizeMemoryFreeB(text:string,_capturedAt:string):ObservedMetric[] {
  const fallback=[unknown("memory.total","bytes"),unknown("memory.used","bytes")];
  if(typeof text!=="string"||text.length>MAX_INPUT) return fallback;
  const rows=text.split(/\r?\n/).map(s=>s.trim().split(/\s+/));
  const line=rows.find(x=>x[0]==="Mem:");
  if(!line||line.length<7)return fallback;
  const total=numberCell(line[1]),available=numberCell(line[6]);
  if(total===null||available===null||total===0||available>total)return fallback;
  const used=total-available;
  return [
    {name:"memory.total",value:total,unit:"bytes",status:"ok",reason:"measured"},
    {name:"memory.used",value:used,unit:"bytes",status:"ok",reason:"measured"},
  ];
}
export function normalizeDiskDfHP(text:string,_capturedAt:string):ObservedMetric[] {
  const fallback=[unknown("disk.usage","percent")];
  if(typeof text!=="string"||text.length>MAX_INPUT)return fallback;
  const lines=text.trim().split(/\r?\n/);
  if(lines.length<2||!/^Filesystem\s+/.test(lines[0]))return fallback;
  const items: number[]=[];
  const seen=new Set<string>();
  for(const line of lines.slice(1,512)){
    const match=line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(\S+)$/);
    if(!match)continue;
    const [,fs,,,,pct,mount]=match;
    if(!mount.startsWith("/") || fs==="tmpfs"||fs==="devtmpfs"||fs==="overlay"||fs==="squashfs"||
      mount.startsWith("/proc")||mount.startsWith("/sys")||mount.startsWith("/dev")||mount.startsWith("/run"))continue;
    if(seen.has(mount))return fallback;
    seen.add(mount);
    const n=Number(pct);
    if(n<0||n>100)return fallback;
    items.push(n);
  }
  if(!items.length)return fallback;
  return [{name:"disk.usage",unit:"percent",value:Math.max(...items),status:"ok",reason:"measured"}];
}
