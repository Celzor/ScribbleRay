import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANVAS_POINTS, MAX_STROKE_POINTS, applyEvent, chunkEvents, createCanvas, decodePoints, encodePoints, floodFill,
  hasGap, isValidEvent, lastOpBy, restoreCanvas, serializeCanvas, snapshotEvents,
} from '../src/canvas.js';

const stroke = (id, from, points, epoch = 0, color = '#000000', width = 9) => ['s', id, epoch, color, width, from, encodePoints(points)];
const pointsOf = (canvas, id) => canvas.byId.get(id)?.points;

test('points travel as deltas and come back exactly', () => {
  const points = [10, 20, 13, 24, 13, 24, 999, 749, 0, 0];
  const encoded = encodePoints(points);
  assert.deepEqual(encoded, [10, 20, 3, 4, 0, 0, 986, 725, -999, -749]);
  assert.deepEqual(decodePoints(encoded), points);
  assert.deepEqual(encodePoints(points, 2, 4), [13, 24, 986, 725]);
  for (const bad of [[], [1], [1, 2, 3], [1.5, 2], ['1', 2], [5000, 5], [0, 0, 0, 9999], null]) assert.equal(decodePoints(bad), null, JSON.stringify(bad));
});

test('events are validated before anything touches the drawing', () => {
  assert.ok(isValidEvent(stroke('3.1', 0, [1, 2])));
  assert.ok(isValidEvent(['f', '3.2', 0, '#ff0000', 5, 5]));
  assert.ok(isValidEvent(['u', '3.2']));
  assert.ok(isValidEvent(['x', 1]));
  for (const bad of [
    ['s', '3', 0, '#000000', 9, 0, [1, 2]], ['s', '0.1', 0, '#000000', 9, 0, [1, 2]], ['s', '3.1', -1, '#000000', 9, 0, [1, 2]],
    ['s', '3.1', 0, 'red', 9, 0, [1, 2]], ['s', '3.1', 0, '#000000', 0, 0, [1, 2]], ['s', '3.1', 0, '#000000', 9, -1, [1, 2]],
    ['f', '3.1', 0, '#000000', 1000, 5], ['u'], ['x', -1], ['z', 1], 'x', null,
  ]) assert.equal(isValidEvent(bad), false, JSON.stringify(bad));
});

test('stroke pieces merge by index: repeats and overlaps are harmless', () => {
  const canvas = createCanvas(4);
  assert.deepEqual(applyEvent(canvas, stroke('1.1', 0, [0, 0, 1, 1])).start, 0);
  const second = applyEvent(canvas, stroke('1.1', 2, [2, 2, 3, 3]));
  assert.equal(second.start, 2);
  assert.equal(applyEvent(canvas, stroke('1.1', 0, [0, 0, 1, 1])), null, 'a repeat adds nothing');
  const overlap = applyEvent(canvas, stroke('1.1', 3, [3, 3, 4, 4, 5, 5]));
  assert.equal(overlap.start, 4);
  assert.deepEqual(pointsOf(canvas, '1.1'), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(canvas.points, 6);
  assert.ok(hasGap(canvas, stroke('1.1', 9, [9, 9])));
  assert.ok(!hasGap(canvas, stroke('1.1', 6, [9, 9])));
  assert.ok(hasGap(canvas, stroke('2.1', 3, [9, 9])), 'the start of a stranger’s stroke was missed');
});

test('undo removes an operation for good; clears drop everything older', () => {
  const canvas = createCanvas(1);
  applyEvent(canvas, stroke('1.1', 0, [0, 0]));
  applyEvent(canvas, ['f', '2.1', 0, '#ff0000', 5, 5]);
  applyEvent(canvas, stroke('1.2', 0, [7, 7]));
  assert.equal(lastOpBy(canvas, 1).id, '1.2');
  assert.deepEqual(applyEvent(canvas, ['u', '1.2']), { type: 'redraw' });
  assert.equal(lastOpBy(canvas, 1).id, '1.1');
  assert.equal(applyEvent(canvas, stroke('1.2', 1, [8, 8])), null, 'late pieces of an undone stroke stay gone');
  assert.equal(canvas.points, 1);

  assert.deepEqual(applyEvent(canvas, ['x', 1]), { type: 'redraw' });
  assert.equal(canvas.ops.length, 0);
  assert.equal(applyEvent(canvas, ['x', 1]), null);
  assert.equal(applyEvent(canvas, stroke('1.3', 0, [1, 1], 0)), null, 'strokes begun before the clear are dropped');
  assert.deepEqual(applyEvent(canvas, stroke('2.5', 0, [1, 1], 3)), { type: 'redraw' }, 'a missed clear is caught up');
  assert.equal(canvas.epoch, 3);
  assert.equal(canvas.ops.length, 1);
});

test('strokes and the whole drawing are capped', () => {
  const canvas = createCanvas(1);
  const long = Array.from({ length: MAX_STROKE_POINTS * 2 }, (_, i) => i % 500);
  applyEvent(canvas, stroke('1.1', 0, long.slice(0, 2000)));
  for (let from = 1000; from < MAX_STROKE_POINTS + 500; from += 1000) applyEvent(canvas, stroke('1.1', from, long.slice(0, 2000)));
  assert.equal(pointsOf(canvas, '1.1').length / 2, MAX_STROKE_POINTS);
  let id = 2;
  while (canvas.points < MAX_CANVAS_POINTS) {
    applyEvent(canvas, stroke(`1.${id}`, 0, long.slice(0, 2000)));
    id += 1;
  }
  assert.equal(canvas.points, MAX_CANVAS_POINTS);
  assert.equal(applyEvent(canvas, stroke(`1.${id}`, 0, [1, 1])), null);
});

test('a snapshot fits in messages and rebuilds the same drawing', () => {
  const canvas = createCanvas(7);
  applyEvent(canvas, ['x', 2]);
  const wiggle = Array.from({ length: 2400 }, (_, i) => (i % 2 ? 300 + Math.round(200 * Math.sin(i / 30)) : 100 + (i % 700)));
  applyEvent(canvas, stroke('4.1', 0, wiggle.slice(0, 1200), 2, '#ef130b', 18));
  applyEvent(canvas, stroke('4.1', 600, wiggle.slice(1200), 2, '#ef130b', 18));
  applyEvent(canvas, ['f', '5.1', 2, '#00cc00', 500, 400]);
  for (let i = 0; i < 40; i += 1) applyEvent(canvas, stroke(`5.${i + 2}`, 0, wiggle.slice(i * 20, i * 20 + 400), 2));

  const events = snapshotEvents(canvas);
  const chunks = chunkEvents(events, 12000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length <= 12000);

  const copy = createCanvas(7);
  copy.epoch = 2;
  for (const chunk of chunks) for (const event of chunk) applyEvent(copy, event);
  assert.deepEqual(copy.ops, canvas.ops);
  assert.equal(copy.points, canvas.points);

  const restored = restoreCanvas(JSON.parse(JSON.stringify(serializeCanvas(canvas))));
  assert.deepEqual(restored.ops, canvas.ops);
  assert.equal(restoreCanvas({ turn: 1, epoch: 0, events: [['x', 3]] }), null);
  assert.equal(restoreCanvas(null), null);
});

test('bucket fill stops at lines and covers their soft edges', () => {
  const width = 20;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x, y, value) => data.set([value, value, value, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y += 1) {
    paint(10, y, 0);
    paint(9, y, 180); // anti-aliased fringe
  }
  const image = { data, width, height };
  assert.ok(floodFill(image, 2, 2, '#ff0000'));
  const at = (x, y) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(8, 9), [255, 0, 0, 255]);
  assert.deepEqual(at(9, 5), [255, 0, 0, 255], 'the fringe beside the fill is covered');
  assert.deepEqual(at(10, 5), [0, 0, 0, 255], 'the line itself stays');
  assert.deepEqual(at(15, 5), [255, 255, 255, 255], 'the other side is untouched');
  assert.equal(floodFill(image, 2, 2, '#ff0000'), false, 'filling with the same colour does nothing');
  assert.equal(floodFill(image, -1, 2, '#ff0000'), false);
});
