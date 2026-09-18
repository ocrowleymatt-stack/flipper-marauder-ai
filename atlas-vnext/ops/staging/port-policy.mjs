#!/usr/bin/env node
/**
 * Staging port occupancy policy.
 * Distinguishes a free port (install), the managed atlas-vnext-staging
 * listener (update), and an unrelated occupant (abort).
 * Never consults or mutates original Atlas ports 80/443/43101/43105.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STAGING_PORT = 8788;
export const MANAGED_CONTAINER = 'atlas-vnext-staging';

/**
 * @typedef {{ portBound: boolean, managedPublishesPort: boolean }} Occupancy
 * @typedef {{ action: 'install' | 'update' | 'abort', reason: string }} Decision
 */

/** @param {Occupancy} occupancy */
export function decideStagingPort(occupancy) {
  if (!occupancy.portBound) {
    return { action: 'install', reason: 'staging port is free' };
  }
  if (occupancy.managedPublishesPort) {
    return {
      action: 'update',
      reason: 'managed atlas-vnext-staging already publishes the staging port',
    };
  }
  return {
    action: 'abort',
    reason:
      'host port 8788 is already in use by an unrelated listener; pick a free port via ATLAS_STAGING_BIND/compose override rather than colliding',
  };
}

/** @param {string | undefined} localAddress @param {number} port */
export function localAddressBindsPort(localAddress, port) {
  if (!localAddress) return false;
  return new RegExp(`:${port}$`).test(localAddress);
}

/** @param {string} ssOutput @param {number} port */
export function ssOutputBindsPort(ssOutput, port) {
  for (const line of ssOutput.split('\n')) {
    if (!/listen/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (localAddressBindsPort(cols[3], port)) return true;
  }
  return false;
}

/**
 * True when the inspected container is running and currently publishes `hostPort`
 * via live NetworkSettings.Ports. HostConfig.PortBindings is configured intent,
 * not occupancy, so it is ignored. Stopped containers do not occupy the host port.
 * @param {unknown} inspect
 * @param {number} hostPort
 */
export function dockerInspectPublishesHostPort(inspect, hostPort) {
  const docs = Array.isArray(inspect) ? inspect : inspect ? [inspect] : [];
  const wanted = String(hostPort);
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const state = /** @type {{ State?: { Running?: boolean } }} */ (doc).State;
    if (state && state.Running === false) continue;
    const record = /** @type {{ NetworkSettings?: { Ports?: unknown } }} */ (doc);
    const map = record.NetworkSettings?.Ports;
    if (!map || typeof map !== 'object') continue;
    for (const entries of Object.values(/** @type {Record<string, unknown>} */ (map))) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (String(/** @type {{ HostPort?: unknown }} */ (entry).HostPort ?? '') === wanted) {
          return true;
        }
      }
    }
  }
  return false;
}

export function defaultReadSs() {
  return execFileSync('ss', ['-lnt'], { encoding: 'utf8' });
}

/** @param {string} name */
export function defaultInspectContainer(name) {
  try {
    return JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

export function probeOccupancy({
  port = STAGING_PORT,
  containerName = MANAGED_CONTAINER,
  readSs = defaultReadSs,
  inspectContainer = defaultInspectContainer,
} = {}) {
  const ssOutput = readSs();
  const inspect = inspectContainer(containerName);
  return {
    portBound: ssOutputBindsPort(ssOutput, port),
    managedPublishesPort: dockerInspectPublishesHostPort(inspect, port),
  };
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let occupancy;
  try {
    occupancy = probeOccupancy();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`atlas-vnext-staging: occupancy probe failed: ${message}`);
    process.exit(1);
  }
  const decision = decideStagingPort(occupancy);
  if (decision.action === 'abort') {
    console.error(`atlas-vnext-staging: ${decision.reason}`);
    process.exit(1);
  }
  console.log(`atlas-vnext-staging: ${decision.action}: ${decision.reason}`);
}
