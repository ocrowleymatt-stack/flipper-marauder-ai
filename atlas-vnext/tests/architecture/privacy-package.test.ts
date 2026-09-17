import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packagePath = join(root, 'dungeons/privacy/package.json');

const FORBIDDEN = new Set([
  '@atlas-vnext/nexus',
  '@atlas-vnext/execution',
  '@atlas-vnext/auth',
  '@atlas-vnext/secrets',
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  'undici',
  'axios',
  'node-fetch',
  'got',
]);

describe('privacy dungeon package boundary', () => {
  it('keeps the Privacy dungeon free of provider, transport and control-plane dependencies', () => {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    for (const name of Object.keys(deps)) {
      expect(FORBIDDEN.has(name), `privacy package depends on forbidden module ${name}`).toBe(false);
      expect(name.startsWith('@atlas-vnext/dungeon-'), `privacy package depends on another dungeon ${name}`).toBe(false);
    }
  });
});
