/**
 * One in-process owner for the on-disk DeepHarness grant/receipt store.
 * MCP tools and the authenticated admin console MUST use the same instance:
 * separate instances would risk stale writes and invalid revocation checks.
 */
import {createPersistentDshGrantStore} from "./persistent-grant-store.mjs";

let store;

export function getDshGrantStore() {
  store ??= createPersistentDshGrantStore({
    file:"/app/data/deepharness-grants.json",
    audit:event=>console.log(JSON.stringify({
      ts:new Date().toISOString(),level:"info",source:"dsh-grant-store",...event
    })),
  });
  return store;
}
