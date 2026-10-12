import test from "node:test";import assert from "node:assert/strict";
import {normalizeMemoryFreeB,normalizeDiskDfHP} from "./dist/observability/normalize-linux.js";
const at="2026-10-12T03:00:00Z";
test("memory accounts for available and totals",()=>{
 const x=normalizeMemoryFreeB("total used free shared buff/cache available\nMem: 1000 700 200 0 100 300\nSwap: 0 0 0",at);
 assert.equal(x.find(m=>m.name==="memory.used").value,700);
 assert.equal(x.find(m=>m.name==="memory.total").value,1000);
});
test("invalid and zero memory never green",()=>{for(const x of ["","Mem: 0 0 0 0 0 0","Mem: 100 0 0 0 0 500"]){assert.equal(normalizeMemoryFreeB(x,at)[0].status,"unknown");}});
test("df ignores tmpfs and returns highest genuine mount",()=>{
 const v=normalizeDiskDfHP("Filesystem Size Used Avail Use% Mounted on\n/dev/vda1 20G 11G 9G 55% /\ntmpfs 1G 999M 1M 99% /run\n/dev/vdb1 10G 9G 1G 90% /data",at);
 assert.equal(v[0].value,90);
});
test("duplicate mount path is invalid",()=>assert.equal(normalizeDiskDfHP("Filesystem Size Used Avail Use% Mounted on\n/dev/vda1 1G 1G 0 98% /\n/dev/vdb1 1G 1G 0 99% /",at)[0].status,"unknown"));
