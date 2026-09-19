import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
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

function octocatInspect(): SourceInspectPort {
  return {
    async inspect(input: { url: string }): Promise<InspectedSource> {
      const url = input.url;
      if (/127\.0\.0\.1|localhost|10\.|192\.168\.|169\.254\./i.test(url)) {
        throw new Error('Private or reserved network addresses are not permitted.');
      }
      let status = 404;
      let text = 'page not found';
      if (url.includes('github.com/octocat')) {
        status = 200;
        text = 'The Octocat GitHub profile repositories';
      } else if (url.includes('example.com')) {
        status = 200;
        text = 'Example Domain This domain is for use in illustrative examples in documents.';
      } else if (url.includes('web.archive.org')) {
        status = 200;
        text = '[["urlkey","timestamp"],["com,example)/","20200101000000"]]';
      }
      return {
        requestedUrl: url,
        finalUrl: url,
        status,
        ok: status >= 200 && status < 300,
        contentType: 'text/html',
        text,
        contentHash: createHash('sha256').update(text).digest('hex'),
        fetchedAt: '2026-09-19T23:00:00.000Z',
        truncated: false,
      };
    },
  };
}

async function startUi() {
  if (!existsSync(join(webDist, 'index.html'))) {
    execSync('npm run build -w @atlas-vnext/web', { cwd: repoRoot, stdio: 'pipe' });
  }
  mkdirSync(shotDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave3-ui-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    streamDelayMs: 0,
    osintInspect: octocatInspect(),
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

describe.skipIf(!enabled)('Wave 3 Atlas experience', { timeout: 300_000 }, () => {
  it('A/D/E/F/G/H: Atlas home, project, library, skill, persistence, advanced, narrower viewport', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url);
    try {
      await page.getByTestId('nav-chats').waitFor();
      await page.getByTestId('nav-projects').waitFor();
      await page.getByTestId('nav-library').waitFor();
      await page.getByTestId('nav-dungeons').waitFor();
      await page.getByTestId('nav-settings').waitFor();
      await page.getByRole('button', { name: 'New Chat' }).waitFor();
      expect(await page.getByRole('heading', { name: 'Tools' }).count()).toBe(0);
      expect(await page.getByRole('heading', { name: 'Skills' }).count()).toBeGreaterThan(0);
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      expect(await page.getByTestId('composer-draft').count()).toBe(1);

      await page.getByTestId('new-project-name').fill('Wave3 workspace');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Wave3 workspace' }).first().waitFor();

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').fill('Reply with exactly: WAVE3 CHAT MARKER');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: 'WAVE3 CHAT MARKER' }).waitFor({ timeout: 45_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
      await page.getByTestId('assistant-output').filter({ hasText: 'WAVE3 CHAT MARKER' }).waitFor({ timeout: 20_000 });

      await page.getByTestId('surface-files').click();
      await page.getByTestId('file-path').waitFor();
      await page.getByTestId('file-path').fill('brief.md');
      await page.getByTestId('file-text').fill('Copper kettle notes.');
      await page.getByTestId('upload-file').click();
      await page.getByRole('button', { name: 'Open' }).first().waitFor({ timeout: 15_000 });
      await page.getByTestId('open-file').first().click();
      await page.getByTestId('file-details').waitFor();
      expect(await page.getByTestId('file-details').innerText()).toMatch(/Wave3 workspace/);
      expect(await page.getByTestId('file-details').innerText()).not.toMatch(/contentHash|cas:/i);
      await page.getByTestId('panel-back-to-chat').click();
      await page.getByTestId('conversation-thread').waitFor();
      expect(await page.getByTestId('conversation-thread').innerText()).toContain('WAVE3 CHAT MARKER');

      await page.getByTestId('surface-writing').click();
      await page.getByTestId('caspa-panel').waitFor({ timeout: 15_000 });
      await page.getByTestId('doc-title').fill('Wave3 notes');
      await page.getByTestId('create-document').click();
      await page.getByRole('button', { name: /Wave3 notes/ }).waitFor({ timeout: 15_000 });
      await page.getByTestId('back-to-conversation').click();
      expect(await page.getByTestId('conversation-thread').innerText()).toContain('WAVE3 CHAT MARKER');

      await page.getByTestId('surface-advanced').click();
      await page.getByRole('heading', { name: 'Run details' }).waitFor();
      expect(await page.getByTestId('conversation-thread').innerText()).toContain('WAVE3 CHAT MARKER');
      await page.getByTestId('diagnostics-close').click();
      expect(await page.getByRole('heading', { name: 'Run details' }).count()).toBe(0);
      await page.screenshot({ path: join(shotDir, '09-wave3-desktop.png'), fullPage: true });

      await page.getByTestId('surface-settings').click();
      await page.getByTestId('settings-surface').waitFor();
      await page.getByTestId('open-help-repair').click();
      await page.getByRole('heading', { name: 'System Doctor' }).waitFor();
      await page.getByTestId('back-to-conversation').click();
      await page.getByTestId('surface-settings').click();
      await page.getByRole('button', { name: 'Sign out' }).last().click();
      await page.getByRole('heading', { name: 'Atlas' }).waitFor();
    } finally {
      await browser.close();
    }
  });

  it('B/C: research and OSINT return into chat with sources, findings, and follow-ups', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url);
    try {
      await page.getByTestId('new-project-name').fill('Wave3 intel');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('new-conversation').click();

      await page.getByTestId('composer-draft').fill(
        'Research the early history of the World Wide Web using multiple independent sources. Identify the strongest established facts, any material disagreement between sources, and remaining uncertainty.',
      );
      await page.getByTestId('composer-send').click();
      await page
        .getByTestId('assistant-output')
        .filter({ hasText: /Researching:|Sources inspected/i })
        .last()
        .waitFor({ timeout: 90_000 });
      await page.getByTestId('result-card-research').waitFor({ timeout: 15_000 });
      await page.getByTestId('open-sources').click();
      await page.getByTestId('source-list').waitFor();
      await page.getByTestId('panel-back-to-chat').click();
      expect(await page.getByTestId('context-panel').count()).toBe(0);
      await page.getByTestId('composer-draft').fill('Which of those findings has the strongest evidence?');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /strongest/i }).last().waitFor({ timeout: 45_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').fill('Run OSINT on octocat');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /OSINT username scan/i }).last().waitFor({ timeout: 90_000 });
      await page.getByTestId('result-card-osint').waitFor({ timeout: 15_000 });
      await page.getByTestId('open-finding').first().click();
      await page.getByTestId('finding-details').waitFor();
      expect(await page.getByTestId('finding-details').innerText()).toMatch(/GitHub|confirmed|observation/i);
      await page.getByTestId('panel-back-to-chat').click();
      await page.getByTestId('composer-draft').fill('Which of those findings is strongest?');
      await page.getByTestId('composer-send').click();
      await page.getByTestId('assistant-output').filter({ hasText: /strongest|GitHub/i }).last().waitFor({ timeout: 45_000 });

      await page.setViewportSize({ width: 390, height: 844 });
      const composer = await page.getByTestId('composer').boundingBox();
      expect(composer?.y ?? 0).toBeGreaterThan(80);
      await page.screenshot({ path: join(shotDir, '10-wave3-osint-mobile.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
