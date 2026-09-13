import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture Boundary Linter
 * Enforces clean-room dependency rules across Atlas vNext monorepo:
 * 1. core-contracts has ZERO internal dependencies.
 * 2. nexus-router CANNOT import execution-broker or dungeon internals.
 * 3. storage-cas CANNOT import nexus-router or execution-broker.
 * 4. dungeons CANNOT import each other (isolated domain modules).
 * 5. dungeons CANNOT import router or broker directly.
 */

const packagesDir = path.resolve('packages');
const packages = fs.readdirSync(packagesDir);

const violations = [];

const rules = [
  {
    package: 'core-contracts',
    forbiddenDependencies: ['@atlas/nexus-router', '@atlas/execution-broker', '@atlas/storage-cas', '@atlas/policy-provenance', '@atlas/dungeon-creative', '@atlas/dungeon-osint', '@atlas/dungeon-knowledge'],
    description: 'core-contracts must not depend on any concrete Atlas package',
  },
  {
    package: 'nexus-router',
    forbiddenDependencies: ['@atlas/execution-broker', '@atlas/dungeon-creative', '@atlas/dungeon-osint', '@atlas/dungeon-knowledge'],
    description: 'nexus-router is stateless and must not couple to execution-broker or dungeon internals',
  },
  {
    package: 'storage-cas',
    forbiddenDependencies: ['@atlas/nexus-router', '@atlas/execution-broker', '@atlas/dungeon-creative', '@atlas/dungeon-osint', '@atlas/dungeon-knowledge'],
    description: 'storage-cas is a low-level primitive and must not import higher-level components',
  },
  {
    package: 'dungeon-creative',
    forbiddenDependencies: ['@atlas/nexus-router', '@atlas/execution-broker', '@atlas/dungeon-osint', '@atlas/dungeon-knowledge'],
    description: 'dungeon-creative must be completely isolated from other dungeons and orchestration runtimes',
  },
  {
    package: 'dungeon-osint',
    forbiddenDependencies: ['@atlas/nexus-router', '@atlas/execution-broker', '@atlas/dungeon-creative', '@atlas/dungeon-knowledge'],
    description: 'dungeon-osint must be completely isolated from other dungeons and orchestration runtimes',
  },
  {
    package: 'dungeon-knowledge',
    forbiddenDependencies: ['@atlas/nexus-router', '@atlas/execution-broker', '@atlas/dungeon-creative', '@atlas/dungeon-osint'],
    description: 'dungeon-knowledge must be completely isolated from other dungeons and orchestration runtimes',
  },
];

for (const rule of rules) {
  const pkgJsonPath = path.join(packagesDir, rule.package, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) continue;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const allDeps = {
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {}),
  };

  for (const forbidden of rule.forbiddenDependencies) {
    if (allDeps[forbidden]) {
      violations.push(`[RULE VIOLATION] ${rule.package} depends on ${forbidden}: ${rule.description}`);
    }
  }

  // Also check source code imports
  const srcDir = path.join(packagesDir, rule.package, 'src');
  if (fs.existsSync(srcDir)) {
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
      for (const forbidden of rule.forbiddenDependencies) {
        if (content.includes(forbidden)) {
          violations.push(`[CODE IMPORT VIOLATION] ${rule.package}/src/${file} imports ${forbidden}`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('❌ Architecture boundary violations found:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
} else {
  console.log('✅ All architecture boundaries respected cleanly.');
}
