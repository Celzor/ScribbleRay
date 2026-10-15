// Optional responsive browser checks. Reuses the same Playwright configuration
// as browser-check.mjs; captures actual app frames without the preview chrome.
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, 'artifacts', 'layout');
const baseUrl = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
let modulePath = process.env.PLAYWRIGHT_MODULE;
if (modulePath) {
  modulePath = resolve(modulePath);
  if ((await stat(modulePath)).isDirectory()) modulePath = join(modulePath, 'index.mjs');
}
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
await mkdir(artifacts, { recursive: true });
const report = [];
const errors = [];
const sizes = [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small', width: 320, height: 568 },
  { name: 'tablet', width: 768, height: 600 },
];

async function capture(page, view, name) {
  await page.waitForTimeout(950);
  const metrics = await view.locator('body').evaluate(() => {
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const visible = (node) => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const regions = {};
    for (const selector of ['.topbar', '.layout', '#lobby', '#sheet', '#paper', '#toolbar', '#board-bar', '#board-lobby', '#chat-form', '#timer', '#sound', '#fullscreen', '#skip-turn', '#end-game']) {
      const node = document.querySelector(selector);
      if (visible(node)) regions[selector] = { ...rect(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    }
    const unlabeled = [...document.querySelectorAll('button, input, select, textarea')]
      .filter(visible)
      .filter((node) => !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby') && !node.title
        && !node.labels?.length && !node.textContent.trim())
      .map((node) => node.id || node.outerHTML.slice(0, 100));
    const swatch = document.querySelector('.swatch');
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight, regions, unlabeled,
      swatchSize: visible(swatch) ? rect(swatch) : null };
  });
  const issues = [];
  if (metrics.documentWidth > metrics.width + 1) issues.push('document overflows horizontally');
  if (metrics.documentHeight > metrics.height + 1) issues.push('document overflows vertically');
  for (const [selector, box] of Object.entries(metrics.regions)) {
    if (box.x < -1 || box.right > metrics.width + 1) issues.push(`${selector} escapes viewport horizontally`);
    if (box.y < -1 || box.bottom > metrics.height + 1) issues.push(`${selector} escapes viewport vertically`);
    if (box.scrollWidth > box.clientWidth + 1) issues.push(`${selector} has horizontal content overflow`);
  }
  const paper = metrics.regions['#paper'];
  const sheet = metrics.regions['#sheet'];
  if (paper && sheet && (paper.y < sheet.y - 1 || paper.bottom > sheet.bottom + 1)) issues.push('paper escapes sheet vertically');
  if (metrics.unlabeled.length) issues.push(`unlabeled controls: ${metrics.unlabeled.join(', ')}`);
  report.push({ name, ...metrics, issues });
  await page.screenshot({ path: join(artifacts, `${name}.png`) });
}

async function drawAndClear(page, view) {
  assert.equal(await view.locator('.canvas-invitation').isVisible(), true, 'blank board invites first mark');
  const box = await view.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 14 });
  await page.mouse.up();
  await view.locator('.canvas-invitation').waitFor({ state: 'hidden' });
  await view.locator('#clear').click();
  // The armed button pulses; a physical click need not wait for animation stability.
  await view.locator('#clear').click({ force: true });
  await view.locator('.canvas-invitation').waitFor({ state: 'visible' });
  const swatches = view.locator('#swatches .swatch');
  await swatches.first().focus();
  await swatches.first().press('ArrowRight');
  assert.equal(await swatches.nth(1).getAttribute('aria-checked'), 'true', 'arrow selects the next swatch');
  assert.equal(await swatches.nth(1).evaluate((node) => node === document.activeElement), true, 'swatch focus follows selection');
  const sizes = view.locator('#sizes .size');
  await sizes.first().focus();
  await sizes.first().press('End');
  assert.equal(await sizes.last().getAttribute('aria-checked'), 'true', 'End selects largest brush');
  await sizes.last().press('Home');
  assert.equal(await sizes.first().getAttribute('aria-checked'), 'true', 'Home selects smallest brush');
}

try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, colorScheme: 'light' });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl.href);
    await page.locator('#lobby').waitFor();
    await capture(page, page, `solo-${size.name}-lobby-light`);
    if (size.name === 'desktop') {
      await page.locator('html').evaluate((html) => html.dataset.theme = 'dark');
      await capture(page, page, 'solo-desktop-lobby-dark');
      await page.locator('html').evaluate((html) => html.dataset.theme = 'light');
    }
    await page.locator('#open-board').click();
    await page.locator('#canvas').waitFor({ state: 'visible' });
    await drawAndClear(page, page);
    await capture(page, page, `solo-${size.name}-board-light`);
    if (size.name === 'desktop') {
      await page.locator('html').evaluate((html) => html.dataset.theme = 'dark');
      await capture(page, page, 'solo-desktop-board-dark');
    }
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('tools/preview.html', baseUrl).href);
  const host = page.frameLocator('iframe[data-participant-id="1"]');
  await host.locator('#connection[data-state="connected"]').waitFor({ state: 'attached' });
  // Enlarge the existing host iframe, keeping the other protocol clients alive.
  await page.addStyleTag({ content: '.view[data-player="1"] { position: fixed; inset: 0; z-index: 50; border: 0; border-radius: 0; } .view[data-player="1"] .view-header { display: none; } .view[data-player="1"] .frame-container { height: 100%; }' });
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await capture(page, host, `room-${size.name}-lobby-dark`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await host.locator('#open-board').click();
  await host.locator('#canvas').waitFor({ state: 'visible' });
  await drawAndClear(page, host);
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await capture(page, host, `room-${size.name}-board-dark`);
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await host.locator('#board-lobby').click();
  await host.locator('select[name="endMode"]').selectOption('score');
  await host.locator('select[name="wordChoices"]').selectOption('1');
  await host.locator('select[name="wordSource"]').selectOption('custom');
  await host.locator('#word-list').fill('abcdefghijklmnopqrstuvwxyzabcdef');
  await host.locator('#word-list').blur();
  await host.locator('#start-game').click();
  await host.locator('body[data-phase="drawing"]').waitFor();
  assert.equal((await host.locator('#word').textContent()).length, 32, 'the full custom word reaches its drawer');
  assert.equal(await host.locator('#skip-turn').isVisible(), true, 'small-frame host can skip');
  assert.equal(await host.locator('#end-game').isVisible(), true, 'small-frame host can end');
  await capture(page, host, 'room-small-drawing-longword-dark');
  const hint = await host.locator('#word').evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX }));
  assert.ok(hint.width > 30 && hint.scroll > hint.width && ['auto', 'scroll'].includes(hint.overflow), 'long word has a usable internal scroll area');
  await page.close();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  for (const item of report) console.log(`${item.name}: ${item.issues.length ? item.issues.join('; ') : 'OK'}`);
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(report.filter((item) => item.issues.length).length, 0, 'all responsive layouts fit; inspect artifacts/layout/report.json');
  console.log(`Responsive checks and first-mark/clear checks passed. Screenshots: ${artifacts}`);
} finally {
  await browser.close();
}
