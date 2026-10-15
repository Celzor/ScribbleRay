import test from 'node:test';
import assert from 'node:assert/strict';
import { createMomentTracker } from '../src/celebrations.js';

const state = (changes = {}) => ({
  connected: true, selfId: 2,
  view: { phase: 'drawing', turn: 7, drawer: 1, guessed: [], players: [{ id: 1, score: 0 }, { id: 2, score: 0 }], ...changes },
});

test('joining and restoring a game establish a silent baseline, including final results', () => {
  const tracker = createMomentTracker();
  assert.equal(tracker.observe(state({ phase: 'results', winners: [2] })), null);
  const sync = tracker.observe(state({ phase: 'results', winners: [2] }));
  assert.equal(sync.finale, false);
  tracker.reset();
  assert.equal(tracker.observe(state({ guessed: [{ id: 2, points: 300 }] })), null);
});

test('a new correct guess and score gain celebrate once, even when the next sync repeats them', () => {
  const tracker = createMomentTracker();
  tracker.observe(state());
  const guessed = state({ guessed: [{ id: 2, points: 300 }], players: [{ id: 1, score: 0 }, { id: 2, score: 300 }] });
  const first = tracker.observe(guessed);
  assert.deepEqual(first.correct, [{ id: 2, points: 300 }]);
  assert.deepEqual(first.scores, [{ id: 2, points: 300 }]);
  const sync = tracker.observe(guessed);
  assert.deepEqual(sync.correct, []);
  assert.deepEqual(sync.scores, []);
});

test('the last correct guess survives a direct transition from drawing to reveal', () => {
  const tracker = createMomentTracker();
  tracker.observe(state());
  const reveal = tracker.observe(state({ phase: 'reveal', guessed: [{ id: 2, points: 250 }], result: { reason: 'all' } }));
  assert.equal(reveal.reveal, true);
  assert.equal(reveal.perfect, true);
  assert.deepEqual(reveal.correct, [{ id: 2, points: 250 }]);
});

test('new games and turns do not mistake previous scores or guesses for new wins', () => {
  const tracker = createMomentTracker();
  tracker.observe(state({ phase: 'results', winners: [2], players: [{ id: 2, score: 1200 }] }));
  const next = tracker.observe(state({ phase: 'choosing', turn: 8, drawer: 2 }));
  assert.equal(next.turn, true);
  assert.deepEqual(next.scores, []);
  const drawing = tracker.observe(state({ phase: 'drawing', turn: 8, drawer: 2 }));
  assert.equal(drawing.drawing, true);
  assert.equal(drawing.turn, false);
});

test('hidden-tab results are consumed silently and do not replay when the tab returns', () => {
  const tracker = createMomentTracker();
  tracker.observe(state({ phase: 'reveal' }));
  const results = state({ phase: 'results', winners: [2] });
  assert.equal(tracker.observe({ ...results, hidden: true }), null);
  assert.equal(tracker.observe(results).finale, false);
});

test('disconnects and session changes reset the baseline before accepting new events', () => {
  const tracker = createMomentTracker();
  tracker.observe(state());
  assert.equal(tracker.observe({ ...state(), connected: false }), null);
  assert.equal(tracker.observe(state({ phase: 'results', winners: [2] })), null);
  tracker.reset();
  assert.equal(tracker.observe(state({ phase: 'choosing', drawer: 2 })), null);
});

test('a live finale plays exactly once', () => {
  const tracker = createMomentTracker();
  tracker.observe(state({ phase: 'reveal' }));
  assert.equal(tracker.observe(state({ phase: 'results', winners: [2] })).finale, true);
  assert.equal(tracker.observe(state({ phase: 'results', winners: [2], revision: 22 })).finale, false);
});
