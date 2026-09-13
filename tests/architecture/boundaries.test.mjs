import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const policy = JSON.parse(await readFile(join(root, 'architecture-boundaries.json'), 'utf8'));

async function workspaceManifests(group) {
  const base = join(root, group);
  const entries = await readdir(base, { withFileTypes: true });
  return Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const path = join(base, entry.name, 'package.json');
      return { path, json: JSON.parse(await readFile(path, 'utf8')) };
    }),
  );
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) found.push(path);
  }
  return found;
}

function dependencies(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  });
}

describe('monorepo architecture boundaries', () => {
  it('has one uniquely named package in every declared workspace directory', async () => {
    const manifests = (await Promise.all(
      ['apps', 'services', 'packages', 'domains'].map(workspaceManifests),
    )).flat();
    const names = manifests.map(({ json }) => json.name);
    assert.ok(names.includes('@atlas/nexus'));
    assert.ok(names.includes('@atlas/broker'));
    assert.ok(names.includes('@atlas/contracts'));
    assert.equal(new Set(names).size, names.length);
  });

  it('keeps Nexus dependency-light and separate from execution', async () => {
    const nexus = JSON.parse(await readFile(join(root, 'services/nexus/package.json'), 'utf8'));
    assert.deepEqual(dependencies(nexus).sort(), policy.layers.nexus.toSorted());
    for (const forbidden of policy.rules.nexusForbiddenDependencies) {
      assert.ok(!dependencies(nexus).includes(forbidden), `Nexus depends on forbidden ${forbidden}`);
    }

    const broker = JSON.parse(await readFile(join(root, 'services/broker/package.json'), 'utf8'));
    assert.ok(!dependencies(broker).includes('@atlas/nexus'), 'broker must consume intents, not Nexus internals');
  });

  it('allows domain modules to depend only on contracts and plugin SDK', async () => {
    for (const { path, json } of await workspaceManifests('domains')) {
      const unexpected = dependencies(json).filter(
        (name) => !policy.rules.domainAllowedDependencies.includes(name),
      );
      assert.deepEqual(unexpected, [], `${relative(root, path)} has forbidden dependencies`);
    }
  });

  it('finds no forbidden implementation imports in Nexus or domain source', async () => {
    for (const [directory, forbidden] of [
      [join(root, 'services/nexus'), policy.rules.nexusForbiddenImportFragments],
      [join(root, 'domains'), policy.rules.domainForbiddenImportFragments],
    ]) {
      for (const file of await sourceFiles(directory)) {
        const source = (await readFile(file, 'utf8')).toLowerCase();
        for (const fragment of forbidden) {
          assert.ok(
            !source.includes(fragment.toLowerCase()),
            `${relative(root, file)} contains forbidden boundary fragment ${fragment}`,
          );
        }
      }
    }
  });
});
