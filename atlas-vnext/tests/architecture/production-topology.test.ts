import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SINGLE_INSTANCE_TOPOLOGY } from '../../apps/host/src/production-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('production topology honesty', () => {
  it('cannot claim HA, distributed rate limits, shared SSE, or an OTEL exporter', () => {
    expect(SINGLE_INSTANCE_TOPOLOGY).toEqual({
      topology: 'single-instance',
      ha: false,
      rateLimiterScope: 'in-process',
      sseFanout: 'in-process',
      runpodScheduler: 'local-file',
      tracingExporter: 'none',
    });

    const limiter = readFileSync(join(root, 'apps/host/src/limits.ts'), 'utf8');
    expect(limiter).toMatch(/Per-process/);
    expect(limiter).not.toMatch(/redis|ioredis|postgres|memcached/i);

    const runpodStore = readFileSync(join(root, 'platform/execution/src/runtime/store.ts'), 'utf8');
    expect(runpodStore).toMatch(/writeFile\(this\.path/);
    expect(runpodStore).not.toMatch(/flock|redlock|lease|SELECT FOR UPDATE/i);

    const observability = readFileSync(join(root, 'platform/observability/src/index.ts'), 'utf8');
    expect(observability).not.toMatch(/@opentelemetry|OpenTelemetry/);
    const metrics = readFileSync(join(root, 'platform/observability/package.json'), 'utf8');
    expect(metrics).not.toMatch(/opentelemetry/);

    const server = readFileSync(join(root, 'apps/host/src/server.ts'), 'utf8');
    expect(server).toMatch(/SINGLE_INSTANCE_TOPOLOGY/);
    expect(server).not.toMatch(/ha:\s*true/);
    expect(server).not.toMatch(/from 'redis'|from "ioredis"|EventEmitter.*fanout/i);
  });
});
