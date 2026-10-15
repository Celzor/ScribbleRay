import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SETTING_OPTIONS } from '../src/rules.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const selects = [...html.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)];

test('every setting has exactly one control, and every control is a setting', () => {
  const names = selects.map((match) => match[1]).sort();
  assert.deepEqual(names, Object.keys(SETTING_OPTIONS).sort());
});

test('setting menus offer exactly the values the game accepts', () => {
  for (const [, name, body] of selects) {
    const values = [...body.matchAll(/<option value="([^"]*)"/g)].map((match) => (/^\d+$/.test(match[1]) ? Number(match[1]) : match[1]));
    assert.deepEqual([...values].sort(), [...SETTING_OPTIONS[name]].sort(), `${name} options`);
  }
});

test('every element the app looks up by id exists in the page, once', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  assert.ok(used.size > 40);
  for (const id of used) assert.ok(ids.includes(id), `#${id} is missing from index.html`);
});

test('the page stays inside Refract’s frame and loads nothing from elsewhere', () => {
  assert.ok(!/<(script|link|img)[^>]+(src|href)="https?:/i.test(html));
  assert.match(html, /<script type="module" src="\.\/src\/app\.js"><\/script>/);
});
