import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Architecture Boundary Test: monorepo packages adhere strictly to clean-room dependency rules', () => {
  const packagesDir = path.resolve('packages');
  const packages = fs.readdirSync(packagesDir);

  assert.ok(packages.includes('core-contracts'));
  assert.ok(packages.includes('nexus-router'));
  assert.ok(packages.includes('execution-broker'));
  assert.ok(packages.includes('storage-cas'));
  assert.ok(packages.includes('policy-provenance'));
  assert.ok(packages.includes('dungeon-creative'));
  assert.ok(packages.includes('dungeon-osint'));
  assert.ok(packages.includes('dungeon-knowledge'));

  // 1. Verify core-contracts has 0 package dependencies
  const corePkg = JSON.parse(fs.readFileSync(path.join(packagesDir, 'core-contracts', 'package.json'), 'utf-8'));
  assert.deepEqual(corePkg.dependencies || {}, {});

  // 2. Verify nexus-router does not depend on execution-broker
  const routerPkg = JSON.parse(fs.readFileSync(path.join(packagesDir, 'nexus-router', 'package.json'), 'utf-8'));
  assert.equal(routerPkg.dependencies?.['@atlas/execution-broker'], undefined);

  // 3. Verify dungeons do not cross-import each other
  const dungeons = ['dungeon-creative', 'dungeon-osint', 'dungeon-knowledge'];
  for (const d of dungeons) {
    const pkg = JSON.parse(fs.readFileSync(path.join(packagesDir, d, 'package.json'), 'utf-8'));
    for (const other of dungeons) {
      if (d === other) continue;
      assert.equal(pkg.dependencies?.[`@atlas/${other}`], undefined, `${d} must not import ${other}`);
    }
  }
});
