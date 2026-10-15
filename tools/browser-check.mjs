// Optional browser verification; the app itself has no Playwright dependency.
// Set PLAYWRIGHT_MODULE to an existing Playwright (or playwright-core) package or module file.
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use an already installed Chromium-based browser.
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, 'artifacts');
const baseUrl = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';

async function loadPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE;
  if (!configured) {
    try {
      return await import('playwright');
    } catch {
      throw new Error('Browser checks need an existing Playwright install. Set PLAYWRIGHT_MODULE to its package directory or index.mjs.');
    }
  }
  let path = resolve(configured);
  if ((await stat(path)).isDirectory()) path = join(path, 'index.mjs');
  return import(pathToFileURL(path).href);
}

async function eventually(description, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${description}`);
}

const frame = (page, id) => page.frameLocator(`iframe[data-participant-id="${id}"]`);

/** How much of the sheet is not plain paper, from 0 to 1. */
const inked = (view) => view.locator('#canvas').evaluate((canvas) => {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let marked = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) marked += 1;
  return marked / (data.length / 16);
});

async function scribble(page, canvas, shape = 'zigzag') {
  const box = await canvas.boundingBox();
  assert.ok(box, 'the sheet is visible');
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(0.2, 0.3));
  await page.mouse.down();
  for (let i = 1; i <= 40; i += 1) {
    const fx = 0.2 + i * 0.015;
    const fy = shape === 'zigzag' ? 0.3 + (i % 8 < 4 ? i % 4 : 4 - (i % 4)) * 0.06 : 0.5 + Math.sin(i / 4) * 0.15;
    await page.mouse.move(...at(fx, fy), { steps: 2 });
  }
  await page.mouse.up();
}

const lines = (view) => view.locator('#chat-log li').allTextContents();

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  };

  try {
    // ---- On its own: a solo sketchbook ----
    const solo = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    watch(solo);
    await solo.goto(baseUrl.href);
    await solo.locator('#lobby').waitFor();
    assert.equal(await solo.locator('#start-game').isDisabled(), true, 'one person cannot start a game');
    assert.equal(await solo.locator('#solo-note').isVisible(), true);
    await solo.locator('#open-board').click();
    await solo.locator('#canvas').waitFor({ state: 'visible' });
    await scribble(solo, solo.locator('#canvas'));
    await solo.locator('.swatch[data-color="#ef130b"]').click();
    await solo.locator('[data-tool="fill"]').click();
    const box = await solo.locator('#canvas').boundingBox();
    await solo.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await eventually('the solo sheet shows ink and fill', async () => (await inked(solo)) > 0.3);
    await solo.screenshot({ path: join(artifacts, 'solo-whiteboard.png') });
    await solo.reload();
    await solo.locator('#canvas').waitFor({ state: 'visible' });
    await eventually('the sketch survives a reload', async () => (await inked(solo)) > 0.3);
    await solo.setViewportSize({ width: 390, height: 760 });
    await delay(300);
    await solo.screenshot({ path: join(artifacts, 'solo-mobile.png') });
    await solo.close();

    // ---- Together: the multiplayer preview ----
    const page = await browser.newPage({ viewport: { width: 1600, height: 1500 } });
    watch(page);
    await page.goto(new URL('tools/preview.html', baseUrl).href);
    const alex = frame(page, 1);
    const sam = frame(page, 2);
    const taylor = frame(page, 3);
    for (const view of [alex, sam, taylor]) await eventually('every frame connects', async () => (await view.locator('#connection').getAttribute('data-state')) === 'connected');
    assert.equal(await sam.locator('#start-game').isDisabled(), true, 'guests cannot start');
    assert.equal(await sam.locator('select[name="rounds"]').isDisabled(), true, 'guests cannot change settings');

    await alex.locator('select[name="wordSource"]').selectOption('custom');
    await alex.locator('select[name="wordChoices"]').selectOption('2');
    await alex.locator('select[name="hints"]').selectOption('0');
    await alex.locator('select[name="rounds"]').selectOption('1');
    await alex.locator('#word-list').fill('Giraffe\nRocket ship, giraffe\nLighthouse');
    await alex.locator('#word-list').blur();
    await eventually('custom words reach the guests', async () => (await sam.locator('#word-count').textContent()).startsWith('3 WORDS'));
    await eventually('settings reach the guests', async () => (await taylor.locator('select[name="wordSource"]').inputValue()) === 'custom');
    await page.screenshot({ path: join(artifacts, 'preview-lobby.png') });
    await alex.locator('#start-game').click();

    /** One turn: the drawer picks a word and draws; each guesser misses once, then gets it. */
    async function playTurn(drawer, guessers, { shots = false } = {}) {
      await eventually('the drawer is offered words', async () => (await drawer.locator('#overlay .choices button').count()) === 2);
      const earlier = (await lines(guessers[1])).length;
      if (shots) {
        await delay(400);
        await page.screenshot({ path: join(artifacts, 'preview-choosing.png') });
      }
      const word = await drawer.locator('#overlay .choices button').first().textContent();
      await drawer.locator('#overlay .choices button').first().click();
      await eventually('the drawer sees the word', async () => (await drawer.locator('#word').textContent()) === word);
      const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
      for (const guesser of guessers) {
        await eventually('guessers see blanks', async () => (await guesser.locator('#word .slot').count()) === letters);
        assert.equal((await guesser.locator('#word').textContent()).trim(), '', 'no letters are shown to guessers');
        assert.equal(await guesser.locator('#toolbar').isHidden(), true, 'guessers have no tools');
      }
      await scribble(page, drawer.locator('#canvas'), 'wave');
      for (const guesser of guessers) await eventually('the drawing reaches every guesser', async () => (await inked(guesser)) > 0.003);

      const [first, second] = guessers;
      await first.locator('#chat-input').fill('a zebra?');
      await first.locator('#chat-input').press('Enter');
      await eventually('a wrong guess is public', async () => (await lines(second)).some((line) => line.includes('a zebra?')));
      await first.locator('#chat-input').fill(word.toLowerCase());
      await first.locator('#chat-input').press('Enter');
      await eventually('the first guesser gets it', async () => (await first.locator('#word').textContent()) === word);
      await eventually('the other guesser hears about it', async () => (await lines(second)).some((line) => line.includes('guessed the word!')));
      const thisTurn = (await lines(second)).slice(earlier);
      assert.ok(!thisTurn.some((line) => line.toLowerCase().includes(word.toLowerCase())), 'the answer is never shown to those still guessing');
      assert.equal((await second.locator('#word').textContent()).trim(), '');
      if (shots) await page.screenshot({ path: join(artifacts, 'preview-drawing.png') });

      await second.locator('#chat-input').fill(word.toUpperCase());
      await second.locator('#chat-input').press('Enter');
      await eventually('everyone sees the reveal', async () => (await second.locator('#overlay .big-word').textContent().catch(() => '')) === word);
      if (shots) {
        await delay(400);
        await page.screenshot({ path: join(artifacts, 'preview-reveal.png') });
      }
    }

    await playTurn(alex, [sam, taylor], { shots: true });
    await playTurn(sam, [alex, taylor]);
    await playTurn(taylor, [alex, sam]);
    await eventually('one round ends the game', async () => (await sam.locator('#overlay .trophy').count()) === 1, 15000);
    await delay(400);
    await page.screenshot({ path: join(artifacts, 'preview-results.png') });
    assert.equal(await sam.locator('#overlay .overlay-actions').count(), 0, 'only the host restarts');
    await alex.locator('#overlay button:has-text("Back to lobby")').click();
    await eventually('back to the lobby', async () => !(await sam.locator('#lobby').isHidden()));

    // ---- The whiteboard, a latecomer, and a host who leaves ----
    await alex.locator('#open-board').click();
    await eventually('Sam has the whiteboard', async () => !(await sam.locator('#toolbar').isHidden()));
    await scribble(page, sam.locator('#canvas'), 'zigzag');
    await scribble(page, alex.locator('#canvas'), 'wave');
    await eventually('both drawings reach Taylor', async () => (await inked(taylor)) > 0.006);
    await page.locator('#toggle-extra').click();
    const jordan = frame(page, 4);
    await eventually('Jordan connects', async () => (await jordan.locator('#connection').getAttribute('data-state').catch(() => null)) === 'connected');
    const target = await inked(taylor);
    await eventually('Jordan catches up on the picture', async () => Math.abs((await inked(jordan)) - target) < target * 0.25);

    await alex.locator('select[name="boardAccess"]').selectOption('host');
    await eventually('pens are taken away', async () => (await sam.locator('#toolbar').getAttribute('class')).includes('disabled'));
    await alex.locator('.person:has-text("Sam") .pen-toggle').click();
    await eventually('Sam gets a pen back', async () => !(await sam.locator('#toolbar').getAttribute('class')).includes('disabled'));
    await page.screenshot({ path: join(artifacts, 'preview-whiteboard.png') });
    await page.locator('#activity-theme').selectOption('light');
    await eventually('the light theme applies', async () => (await sam.locator('html').getAttribute('data-theme')) === 'light');
    await delay(300);
    await page.screenshot({ path: join(artifacts, 'preview-light.png') });

    await alex.locator('#leave').click();
    await eventually('Sam takes over as host', async () => (await sam.locator('#connection-label').textContent()) === 'Hosting');
    await eventually('the whiteboard stays open', async () => (await taylor.locator('#connection').getAttribute('data-state')) === 'connected' && !(await taylor.locator('#sheet').isHidden()));
    assert.ok((await inked(jordan)) > 0.003, 'the picture survives the hand-over');

    const relevant = errors.filter((message) => !/favicon/i.test(message));
    assert.deepEqual(relevant, [], 'no page errors');
    console.log(`Browser checks passed. Screenshots are in ${artifacts}.`);
  } catch (error) {
    for (const [index, open] of browser.contexts().flatMap((context) => context.pages()).entries()) {
      await open.screenshot({ path: join(artifacts, `failure-${index}.png`) }).catch(() => {});
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
