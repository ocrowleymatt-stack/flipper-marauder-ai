#!/usr/bin/env node
/**
 * Staging browser journey for visible conversation output.
 * Requires Playwright. Does not print secrets.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8788';
const LOGIN = process.env.ATLAS_OWNER_LOGIN;
const PASSWORD = process.env.ATLAS_OWNER_PASSWORD;
const OUT = process.env.ATLAS_SCREENSHOT_DIR || '/tmp/atlas-visible-output';
if (!LOGIN || !PASSWORD) {
  console.error('missing login env');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function journey(name, viewport) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByLabel('Login').fill(LOGIN);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByRole('button', { name: 'New conversation' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Ask Atlas').fill('Reply with exactly: ATLAS OUTPUT VISIBLE');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Generating…').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  await page.locator('[data-testid="assistant-output"]').filter({ hasText: 'ATLAS OUTPUT VISIBLE' }).waitFor({ timeout: 120000 });
  const visible = await page.locator('[data-testid="conversation-thread"]').innerText();
  if (!visible.includes('ATLAS OUTPUT VISIBLE')) throw new Error(`${name}: output missing after send`);
  await page.screenshot({ path: `${OUT}/${name}-completed.png`, fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-testid="assistant-output"]').filter({ hasText: 'ATLAS OUTPUT VISIBLE' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Ask Atlas').fill('Reply with exactly: ATLAS FOLLOW UP');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('[data-testid="assistant-output"]').filter({ hasText: 'ATLAS FOLLOW UP' }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Website' }).click();
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await page.locator('[data-testid="assistant-output"]').filter({ hasText: 'ATLAS OUTPUT VISIBLE' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Run details' }).click();
  await page.getByRole('heading', { name: 'Run details' }).waitFor();
  await page.getByTestId('diagnostics-close').click();
  await page.screenshot({ path: `${OUT}/${name}-conversation.png`, fullPage: true });
  results.push({ name, ok: true });
  await context.close();
}

try {
  await journey('desktop', { width: 1440, height: 900 });
  await journey('narrow', { width: 390, height: 844 });
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ ok: true, results }, null, 2));
  console.log(JSON.stringify({ ok: true, results, out: OUT }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await browser.close();
}
