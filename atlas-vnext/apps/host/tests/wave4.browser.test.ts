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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave4-ui-'));
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

describe.skipIf(!enabled)('Wave 4 Caspa writing recovery', { timeout: 300_000 }, () => {
  it('A/B/D/F/G/I: conversation writing, story bible, revision, library, refresh', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url);
    try {
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      await page.getByTestId('new-project-name').fill('Harbour novel');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();

      await page.getByTestId('surface-writing').click();
      await page.getByTestId('caspa-panel').waitFor();
      await page.getByTestId('story-bible').fill('Mara has a scar over her left eye and refuses to enter churches.');
      await page.getByTestId('save-story-bible').click();
      await page.getByTestId('back-to-conversation').click();
      await page.getByTestId('conversation-thread').waitFor();

      await page.getByTestId('composer-draft').fill('Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-writing').waitFor({ timeout: 90_000 });
      expect(await page.getByTestId('result-card-writing').innerText()).toMatch(/Revision/);
      expect(await page.getByTestId('open-manuscript').innerText()).toMatch(/Open manuscript/i);

      await page.getByTestId('open-manuscript').click();
      await page.getByTestId('caspa-panel').waitFor();
      expect(await page.locator('#doc-body').inputValue()).toMatch(/scar over her left eye|lighthouse keeper|voice from the fog/i);
      await page.getByTestId('back-to-conversation').click();

      await page.getByTestId('composer-draft').fill('Make the final paragraph more restrained.');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('result-card-writing').nth(1).waitFor({ timeout: 90_000 });
      expect(await page.getByTestId('result-card-writing').nth(1).innerText()).toMatch(/Revision 2/);

      await page.getByTestId('surface-files').click();
      await page.getByRole('button', { name: 'Open' }).first().waitFor({ timeout: 15_000 });
      await page.getByTestId('open-file').first().click();
      await page.getByTestId('caspa-panel').waitFor({ timeout: 15_000 });
      await page.getByTestId('back-to-conversation').click();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page
        .getByTestId('assistant-output')
        .filter({ hasText: /Writing:|Manuscript:/ })
        .first()
        .waitFor({ timeout: 30_000 });
      await page.getByTestId('result-card-writing').first().waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('empty-conversation').count()).toBe(0);
      expect(await page.getByTestId('nav-dungeons').innerText()).toMatch(/Caspa/);
      await page.screenshot({ path: join(shotDir, '10-wave4-desktop.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });

  it('I: 390 viewport keeps Caspa as a skill under Ask Atlas', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url, { width: 390, height: 844 });
    try {
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('nav-dungeons').waitFor();
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      await page.getByTestId('new-project-name').fill('Mobile harbour');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('surface-writing').click();
      await page.getByTestId('caspa-panel').waitFor();
      await page.getByTestId('back-to-conversation').click();
      expect(await page.getByTestId('conversation-thread').count()).toBe(1);
      await page.screenshot({ path: join(shotDir, '11-wave4-mobile.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
