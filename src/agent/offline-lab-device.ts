/**
 * Agent Mesh lab device mode: an explicit, fail-closed opt-in.
 *
 * This is a configuration/advertisement gate, NOT proof of host isolation.
 * The local Docker proxy must independently require an image sha256 pin.
 */
export const OFFLINE_LAB_DEVICE_ENV = "VIGIAFAST_DSH_OFFLINE_DEVICE_MODE";
export const REQUIRED_OFFLINE_PROXY = "tcp://127.0.0.1:23751";

export function isOfflineLabDeviceMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[OFFLINE_LAB_DEVICE_ENV] === "1"
    && environment.DOCKER_HOST === REQUIRED_OFFLINE_PROXY;
}
