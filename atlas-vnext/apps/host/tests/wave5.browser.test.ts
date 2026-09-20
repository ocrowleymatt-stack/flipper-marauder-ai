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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave5-ui-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    streamDelayMs: 0,
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
    osint: spine.osint,
    investigation: spine.investigation,
    research: spine.research,
    websiteStudio: spine.websiteStudio,
    music: spine.music,
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

async function launchPage(url: string, viewport = { width: 1440, height: 900 }) {
  const playwright = await import('playwright').catch(() => null);
  if (!playwright) throw new Error('playwright is required when ATLAS_BROWSER_TEST=1');
  const launchOptions: { headless: boolean; args: string[]; executablePath?: string } = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (existsSync(chrome)) launchOptions.executablePath = chrome;
  const browser = await playwright.chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
  return { browser, page };
}

describe.skipIf(!enabled)('Wave 5 Website Studio recovery', { timeout: 300_000 }, () => {
  it('A/B/C/D/I: Ask Atlas builds a site, card, preview, library, revision, research still routes', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url);
    try {
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      await page.getByTestId('new-project-name').fill('Harbour site');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();

      await page.getByTestId('composer-draft').fill('Build a website about a neighbourhood circus with tents, tickets, and cocoa.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-website').waitFor({ timeout: 90_000 });
      expect(await page.getByTestId('result-card-website').innerText()).toMatch(/Revision/);
      expect(await page.getByTestId('open-website-preview').innerText()).toMatch(/Open preview/i);

      await page.getByTestId('open-website-preview').click();
      await page.getByTestId('website-panel').waitFor();
      await page.getByTestId('site-preview').waitFor({ timeout: 20_000 });
      await page.getByTestId('back-to-conversation').click();
      await page.getByTestId('conversation-thread').waitFor();

      await page.getByTestId('composer-draft').fill('Make the hero shorter.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-website').nth(1).waitFor({ timeout: 90_000 });
      expect(await page.getByTestId('result-card-website').nth(1).innerText()).toMatch(/Revision 2/);

      await page.getByTestId('surface-files').click();
      await page.getByTestId('open-file').first().waitFor({ timeout: 15_000 });
      await page.getByTestId('open-file').first().click();
      await page.getByTestId('website-panel').waitFor({ timeout: 15_000 });
      await page.getByTestId('back-to-conversation').click();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('result-card-website').first().waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('empty-conversation').count()).toBe(0);

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await page.getByTestId('composer-draft').fill('Research the history of the World Wide Web using multiple independent sources.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-research').waitFor({ timeout: 90_000 });

      await page.screenshot({ path: join(shotDir, '12-wave5-desktop.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });

  it('J: 390 viewport keeps Website as a skill under Ask Atlas', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url, { width: 390, height: 844 });
    try {
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('nav-dungeons').waitFor();
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      expect(await page.getByTestId('nav-dungeons').innerText()).toMatch(/Website/i);
      await page.getByTestId('new-project-name').fill('Mobile circus');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('composer-draft').fill('Build a website about a neighbourhood circus with tents.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-website').waitFor({ timeout: 90_000 });
      await page.getByTestId('open-website-preview').click();
      await page.getByTestId('website-panel').waitFor();
      await page.getByTestId('back-to-conversation').click();
      expect(await page.getByTestId('conversation-thread').count()).toBe(1);
      expect(await page.getByTestId('composer-draft').count()).toBe(1);
      await page.screenshot({ path: join(shotDir, '13-wave5-mobile.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
