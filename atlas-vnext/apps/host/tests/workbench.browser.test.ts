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

async function startWorkbenchUi() {
  if (!existsSync(join(webDist, 'index.html'))) {
    execSync('npm run build -w @atlas-vnext/web', { cwd: repoRoot, stdio: 'pipe' });
  }
  mkdirSync(shotDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'atlas-workbench-ui-'));
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
    privacy: spine.privacy,
    websiteStudio: spine.websiteStudio,
    doctor: spine.doctor,
    tenantId: spine.tenantId,
    principalId: spine.principalId,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
  });
  servers.push(server);
  return listen(server, 0, '127.0.0.1');
}

describe.skipIf(!enabled)('Workbench visible output', { timeout: 180_000 }, () => {
  it('shows the assistant answer in the conversation, keeps it after refresh, and continues the thread', async () => {
    const playwright = await import('playwright').catch(() => null);
    if (!playwright) throw new Error('playwright is required when ATLAS_BROWSER_TEST=1');
    const { url } = await startWorkbenchUi();
    const launchOptions: { headless: boolean; args: string[]; executablePath?: string } = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    };
    if (existsSync(chrome)) launchOptions.executablePath = chrome;
    const browser = await playwright.chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const marker = 'ATLAS OUTPUT VISIBLE';

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });

      await page.getByTestId('new-project-name').fill('Everyday notes');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').fill(`Reply with exactly: ${marker}`);
      await page.getByTestId('composer-send').click();

      await page.getByTestId('run-status').getByText(/Generating/i).waitFor({ timeout: 10_000 });
      const assistant = page.getByTestId('message-assistant').last();
      await assistant.waitFor({ timeout: 30_000 });
      await page.waitForFunction(
        (expected: string) => {
          const nodes = [...document.querySelectorAll('[data-testid="assistant-output"]')];
          return nodes.some((node) => (node.textContent ?? '').includes(expected));
        },
        marker,
        { timeout: 45_000 },
      );
      await page.getByTestId('run-status').getByText(/Completed|Ready/i).waitFor({ timeout: 30_000 });
      const thread = await page.getByTestId('conversation-thread').innerText();
      expect(thread).toContain(marker);
      expect(thread.toLowerCase()).toContain('you');
      expect(thread.toLowerCase()).toContain('atlas');

      const inspector = page.getByRole('heading', { name: 'Run inspection' });
      expect(await inspector.count()).toBe(0);

      const messagesBox = await page.getByTestId('conversation-thread').boundingBox();
      expect(messagesBox?.height ?? 0).toBeGreaterThan(280);
      const composerBox = await page.getByTestId('composer').boundingBox();
      expect(composerBox?.y ?? 0).toBeGreaterThan(120);
      await page.screenshot({ path: join(shotDir, '01-desktop-conversation.png'), fullPage: true });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('assistant-output').filter({ hasText: marker }).waitFor({ timeout: 20_000 });
      const afterReload = await page.getByTestId('conversation-thread').innerText();
      expect(afterReload).toContain(marker);
      await page.screenshot({ path: join(shotDir, '02-after-refresh.png'), fullPage: true });

      await page.getByTestId('composer-draft').fill('Reply with exactly: ATLAS FOLLOW UP');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: 'ATLAS FOLLOW UP' }).waitFor({ timeout: 45_000 });
      const continued = await page.getByTestId('conversation-thread').innerText();
      expect(continued).toContain(marker);
      expect(continued).toContain('ATLAS FOLLOW UP');

      await page.getByTestId('surface-files').click();
      await page.getByTestId('file-path').fill('brief.md');
      await page.getByTestId('file-text').fill('The kettle is copper.');
      await page.getByTestId('upload-file').click();
      await page.getByRole('button', { name: 'Use in conversation' }).first().click();
      await page.getByTestId('back-to-conversation').click();
      await page.getByTestId('conversation-thread').waitFor();

      await page.getByTestId('surface-writing').click();
      await page.getByTestId('caspa-panel').waitFor({ timeout: 15_000 });
      await page.getByTestId('doc-title').fill('Kettle notes');
      await page.getByTestId('create-document').click();
      await page.getByRole('button', { name: /Kettle notes/ }).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: join(shotDir, '03-writing.png'), fullPage: true });
      await page.getByTestId('back-to-conversation').click();
      expect(await page.getByTestId('conversation-thread').innerText()).toContain(marker);

      await page.getByRole('button', { name: 'Website' }).click();
      await page.getByRole('heading', { name: 'Website' }).waitFor();
      await page.getByTestId('back-to-conversation').click();
      expect(await page.getByTestId('conversation-thread').innerText()).toContain(marker);

      await page.getByTestId('diagnostics-toggle').click();
      await page.getByRole('heading', { name: 'Run details' }).waitFor();
      await page.screenshot({ path: join(shotDir, '06-run-details.png'), fullPage: true });
      await page.getByTestId('diagnostics-close').click();
      expect(await page.getByRole('heading', { name: 'Run details' }).count()).toBe(0);
      expect(await page.getByTestId('conversation-thread').innerText()).toContain(marker);

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').fill('Start a second task: say SECOND THREAD READY');
      await page.getByTestId('composer-send').click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-testid="assistant-output"]')].some((node) => (node.textContent ?? '').includes('SECOND THREAD READY')),
        undefined,
        { timeout: 45_000 },
      );
      const secondThread = await page.getByTestId('conversation-thread').innerText();
      expect(secondThread).toContain('SECOND THREAD READY');
      expect(secondThread).not.toContain(marker);
      await page.screenshot({ path: join(shotDir, '04-second-conversation.png'), fullPage: true });

      const longTitle = page.locator('.conversation-list .conv-title').first();
      const meta = page.locator('.conversation-list .conv-meta').first();
      if ((await longTitle.count()) && (await meta.count())) {
        const titleBox = await longTitle.boundingBox();
        const metaBox = await meta.boundingBox();
        if (titleBox && metaBox) {
          expect(metaBox.y + 1).toBeGreaterThanOrEqual(titleBox.y);
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileMessages = await page.getByTestId('conversation-thread').boundingBox();
      const mobileComposer = await page.getByTestId('composer').boundingBox();
      expect(mobileMessages?.height ?? 0).toBeGreaterThan(180);
      expect(mobileComposer?.y ?? 0).toBeGreaterThan(120);
      await page.screenshot({ path: join(shotDir, '05-mobile.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
