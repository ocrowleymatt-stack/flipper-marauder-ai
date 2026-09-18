import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_CONTAINER,
  STAGING_PORT,
  decideStagingPort,
  dockerInspectPublishesHostPort,
  probeOccupancy,
  ssOutputBindsPort,
} from '../../ops/staging/port-policy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = readFileSync(join(root, 'ops/staging/install-alongside.sh'), 'utf8');
const compose = readFileSync(join(root, 'ops/staging/docker-compose.staging.yml'), 'utf8');

const SS_FREE = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0      4096       127.0.0.1:43101      0.0.0.0:*
LISTEN 0      4096       0.0.0.0:80           0.0.0.0:*
LISTEN 0      4096       0.0.0.0:443          0.0.0.0:*
`;

const SS_STAGING = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0      4096       127.0.0.1:8788       0.0.0.0:*
LISTEN 0      4096       127.0.0.1:43101      0.0.0.0:*
`;

function managedInspect(running = true) {
  return [
    {
      Name: `/${MANAGED_CONTAINER}`,
      State: { Running: running },
      HostConfig: {
        PortBindings: {
          '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: String(STAGING_PORT) }],
        },
      },
      NetworkSettings: {
        Ports: running
          ? { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: String(STAGING_PORT) }] }
          : { '8787/tcp': null },
      },
    },
  ];
}

describe('staging port policy', () => {
  it('allows first install when the staging port is free', () => {
    const occupancy = probeOccupancy({
      readSs: () => SS_FREE,
      inspectContainer: () => null,
    });
    expect(occupancy).toEqual({ portBound: false, managedPublishesPort: false });
    expect(decideStagingPort(occupancy)).toEqual({
      action: 'install',
      reason: 'staging port is free',
    });
  });

  it('allows rerun/update when the managed staging container publishes 8788', () => {
    const occupancy = probeOccupancy({
      readSs: () => SS_STAGING,
      inspectContainer: () => managedInspect(true),
    });
    expect(occupancy.portBound).toBe(true);
    expect(occupancy.managedPublishesPort).toBe(true);
    expect(decideStagingPort(occupancy).action).toBe('update');
  });

  it('rejects an unrelated listener on the staging port', () => {
    const occupancy = probeOccupancy({
      readSs: () => SS_STAGING,
      inspectContainer: () => null,
    });
    expect(occupancy).toEqual({ portBound: true, managedPublishesPort: false });
    const decision = decideStagingPort(occupancy);
    expect(decision.action).toBe('abort');
    expect(decision.reason).toMatch(/unrelated listener/);
  });

  it('does not treat a stopped managed container as occupying the port', () => {
    expect(dockerInspectPublishesHostPort(managedInspect(false), STAGING_PORT)).toBe(false);
    const occupancy = probeOccupancy({
      readSs: () => SS_STAGING,
      inspectContainer: () => managedInspect(false),
    });
    expect(decideStagingPort(occupancy).action).toBe('abort');
  });

  it('parses ss listen addresses including ipv6 without treating original Atlas ports as staging', () => {
    expect(ssOutputBindsPort(SS_FREE, 8788)).toBe(false);
    expect(ssOutputBindsPort(SS_FREE, 80)).toBe(true);
    expect(ssOutputBindsPort(SS_FREE, 43101)).toBe(true);
    expect(ssOutputBindsPort('LISTEN 0 4096 [::1]:8788 [::]:*\n', 8788)).toBe(true);
  });
});

describe('staging installer isolation', () => {
  it('invokes the port policy and never restarts original Atlas units or paths', () => {
    expect(installer).toContain('ops/staging/port-policy.mjs');
    expect(installer).toContain('node "$POLICY"');
    expect(installer).not.toMatch(/fail "host port 8788 is already in use; pick a free port/);
    expect(installer).toContain('/opt/atlas-mountain');
    expect(installer).toContain('/etc/atlas');
    expect(installer).toContain('43101');
    expect(installer).toContain('43105');
    expect(installer).not.toMatch(/systemctl restart/);
    expect(installer).toContain('original Atlas env was not copied');
    expect(compose).toContain('container_name: atlas-vnext-staging');
    expect(compose).toContain('name: atlas-vnext-staging');
    expect(compose).toContain('atlas_vnext_staging_session');
    expect(compose).toMatch(/127\.0\.0\.1\}:8788:8787/);
    expect(compose).not.toContain('43101:43101');
  });

  it('keeps the documented installer executable', () => {
    expect(statSync(join(root, 'ops/staging/install-alongside.sh')).mode & 0o111).toBeTruthy();
  });
});
