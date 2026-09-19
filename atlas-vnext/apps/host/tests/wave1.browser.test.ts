import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { composeSpine, createHost, grantSideEffects, listen, type Spine } from '../src/index.ts';

const enabled = process.env.ATLAS_BROWSER_TEST === '1';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const webDist = resolve(here, '../../web/dist');
const shotDir = resolve(repoRoot, 'docs/release/workbench-ux');
const chrome =
  process.env.PLAYWRIGHT_CHROME ||
  '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

const servers: Server[] = [];
const spines: Spine[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((err) => (err ? reject(err) : resolveClose()));
        }),
    ),
  );
  await Promise.all(spines.splice(0).map((spine) => spine.close()));
});

function memoryConfig(tenantId: string): PersistenceConfig {
  return {
    mode: 'memory',
    production: false,
    databaseUrl: null,
    poolMax: 4,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    filePath: null,
    defaultTenantId: tenantId,
  };
}

async function startUi() {
  if (!existsSync(join(webDist, 'index.html'))) {
    execSync('npm run build -w @atlas-vnext/web', { cwd: repoRoot, stdio: 'pipe' });
  }
  mkdirSync(shotDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave1-ui-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
  });
  grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
  spines.push(spine);
  const server = createHost({
    runtime: spine.runtime,
    staticDir: webDist,
    auth: spine.auth,
    login: spine.login,
    tools: spine.tools,
    projects: spine.projects,
    files: spine.files,
    context: spine.context,
    persistence: spine.persistence,
    writing: spine.writing,
    research: spine.research,
    privacy: spine.privacy,
    doctor: spine.doctor,
    tenantId: spine.tenantId,
    principalId: spine.principalId,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
  });
  servers.push(server);
  return listen(server, 0, '127.0.0.1');
}

describe.skipIf(!enabled)('Wave 1 Atlas-first UI', { timeout: 240_000 }, () => {
  it('shows Atlas chrome and remembers ORPHEUS-731 after refresh', async () => {
    const playwright = await import('playwright').catch(() => null);
    if (!playwright) throw new Error('playwright is required when ATLAS_BROWSER_TEST=1');
    const { url } = await startUi();
    const launchOptions: { headless: boolean; args: string[]; executablePath?: string } = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    };
    if (existsSync(chrome)) launchOptions.executablePath = chrome;
    const browser = await playwright.chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('nav-chats').waitFor();
      await page.getByTestId('nav-projects').waitFor();
      await page.getByTestId('nav-library').waitFor();
      await page.getByTestId('nav-dungeons').waitFor();
      await page.getByRole('button', { name: 'New Chat' }).waitFor();
      expect(await page.getByRole('heading', { name: 'Tools' }).count()).toBe(0);

      await page.getByTestId('new-project-name').fill('Wave1');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').fill("My dog's name is ORPHEUS-731.");
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').first().waitFor({ timeout: 45_000 });
      await page.getByTestId('composer-draft').fill("What did I say my dog's name was?");
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: 'ORPHEUS-731' }).waitFor({ timeout: 45_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('assistant-output').filter({ hasText: 'ORPHEUS-731' }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(shotDir, '07-wave1-memory.png'), fullPage: true });

      await page.getByTestId('composer-draft').fill(
        'Research the early history of the World Wide Web using multiple independent sources. Identify the strongest established facts, any material disagreement between sources, and remaining uncertainty.',
      );
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /Researching:|Sources inspected/i }).waitFor({
        timeout: 90_000,
      });
      await page.getByTestId('composer-draft').fill('Which of those findings has the strongest evidence?');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /strongest/i }).waitFor({ timeout: 45_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('composer-draft').fill('What were we researching?');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /World Wide Web/i }).waitFor({ timeout: 45_000 });
      await page.getByTestId('diagnostics-toggle').click();
      await page.getByRole('heading', { name: 'Run details' }).waitFor();
      await page.screenshot({ path: join(shotDir, '08-wave1-run-details.png'), fullPage: true });
      await page.getByTestId('diagnostics-close').click();
      expect(await page.getByRole('heading', { name: 'Run details' }).count()).toBe(0);
      expect(await page.getByTestId('conversation-thread').innerText()).toMatch(/ORPHEUS-731/);
    } finally {
      await browser.close();
    }
  });
});
