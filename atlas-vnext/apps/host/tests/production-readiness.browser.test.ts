import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const OPERATOR_PASSWORD = 'correct-horse-battery-staple';

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
      let status = 404;
      let text = 'page not found';
      if (url.includes('github.com/octocat')) {
        status = 200;
        text = 'The Octocat GitHub profile repositories';
      } else if (url.includes('gitlab.com/octocat')) {
        status = 200;
        text = 'octocat GitLab profile';
      }
      return {
        requestedUrl: url,
        finalUrl: url,
        status,
        ok: status >= 200 && status < 300,
        contentType: 'text/html',
        text,
        contentHash: createHash('sha256').update(text).digest('hex'),
        fetchedAt: '2026-09-20T00:00:00.000Z',
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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-prod-ui-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    streamDelayMs: 0,
    osintInspect: octocatInspect(),
  });
  grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
  await spine.login.provision({
    principalId: spine.principalId,
    login: 'owner',
    password: OPERATOR_PASSWORD,
  });
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
    production: true,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
  });
  servers.push(server);
  return listen(server, 0, 'localhost');
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
  return { browser, page };
}

async function signIn(page: Awaited<ReturnType<typeof launchPage>>['page']) {
  await page.getByTestId('login-screen').waitFor({ timeout: 30_000 });
  await page.getByTestId('login-username').fill('owner');
  await page.getByTestId('login-password').fill(OPERATOR_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('workbench-shell').waitFor({ timeout: 30_000 });
}

async function sendPrompt(page: Awaited<ReturnType<typeof launchPage>>['page'], text: string) {
  await page.getByTestId('composer-draft').fill(text);
  await page.getByTestId('composer-send').click();
}

describe.skipIf(!enabled)('production-readiness browser acceptance', { timeout: 360_000 }, () => {
  it('native login then Conversation, Projects/Library, Research, OSINT, Writing, Website, Music', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url);
    try {
      await signIn(page);
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      await page.getByTestId('new-project-name').fill('Cutover harbour');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();

      await sendPrompt(page, "My dog's name is ORPHEUS-731.");
      await page.getByTestId('assistant-output').first().waitFor({ timeout: 90_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await sendPrompt(
        page,
        'Research the history of the World Wide Web using multiple independent sources. Tell me what is strongly established.',
      );
      await page.getByTestId('result-card-research').waitFor({ timeout: 90_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await sendPrompt(page, 'Run OSINT on octocat');
      await page.getByTestId('result-card-osint').waitFor({ timeout: 90_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await sendPrompt(page, 'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.');
      await page.getByTestId('result-card-writing').waitFor({ timeout: 90_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await sendPrompt(page, 'Build a website about a neighbourhood circus with tents, tickets, and cocoa.');
      await page.getByTestId('result-card-website').waitFor({ timeout: 90_000 });

      await page.getByTestId('new-conversation').click();
      await page.getByTestId('composer-draft').waitFor();
      await sendPrompt(page, 'Compose a 30-second piano piece in A minor, 90 BPM.');
      await page.getByTestId('result-card-music').waitFor({ timeout: 90_000 });
      await page.getByTestId('music-play').click();

      await page.getByTestId('surface-files').click();
      await page.getByTestId('open-file').first().waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('nav-dungeons').innerText()).toMatch(/Caspa|Music|Website|OSINT|Research/i);
      await page.screenshot({ path: join(shotDir, '16-production-desktop.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });

  it('390 viewport signs in and keeps Ask Atlas usable', async () => {
    const { url } = await startUi();
    const { browser, page } = await launchPage(url, { width: 390, height: 844 });
    try {
      await signIn(page);
      await page.getByTestId('nav-toggle').click();
      await page.getByTestId('nav-dungeons').waitFor();
      expect(await page.getByTestId('empty-conversation').innerText()).toMatch(/Ask Atlas/);
      await page.getByTestId('new-project-name').fill('Mobile cutover');
      await page.getByTestId('create-project').click();
      await page.getByTestId('composer-draft').waitFor({ timeout: 20_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);
      await page.screenshot({ path: join(shotDir, '17-production-mobile.png'), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
