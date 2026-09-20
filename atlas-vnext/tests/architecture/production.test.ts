import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '../../platform/persistence/src/postgres/migrate.ts';
import { FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS } from '../../apps/host/src/production-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('production-readiness architecture freeze', () => {
  it('does not add a schema version beyond freeze v9', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    const files = readdirSync(join(root, 'platform/persistence/migrations')).filter((name) => name.endsWith('.sql'));
    expect(files.some((name) => name.startsWith('010_'))).toBe(false);
  });

  it('keeps ACE-Step and Music GPU off the LLM host', () => {
    const files = [
      'apps/host/src/production-config.ts',
      'apps/host/src/main.ts',
      'apps/host/src/compose.ts',
      'dungeons/music/src/index.ts',
      'scripts/cutover-preflight.ts',
      'scripts/backup-atlas.ts',
      'scripts/restore-atlas.ts',
    ].map((rel) => readFileSync(join(root, rel), 'utf8'));
    const blob = files.join('\n');
    expect(blob).not.toMatch(/docker pull|helm install|apt-get install/);
    expect(blob).toMatch(/Production forbids Music GPU \/ ACE-Step/);
    expect(FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS).toContain('ATLAS_ACE_STEP');
    expect(blob).toMatch(/score-first|MusicScore|deterministic/i);
  });

  it('does not leak provider failover-after-visible into production scripts', () => {
    const preflight = readFileSync(join(root, 'scripts/cutover-preflight.ts'), 'utf8');
    expect(preflight).not.toMatch(/visibleOutputAlready:\s*true/);
    expect(preflight).toMatch(/llm-only/);
    expect(preflight).toMatch(/readDeployedSchemaVersion/);
    const backup = readFileSync(join(root, 'scripts/backup-atlas.ts'), 'utf8');
    expect(backup).toMatch(/pg_export_snapshot/);
    expect(backup).toMatch(/verifyCasObjects/);
    const restore = readFileSync(join(root, 'scripts/restore-atlas.ts'), 'utf8');
    expect(restore).toMatch(/verifyCasObjects/);
  });
});
