import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOX_BURST, OUTBOX_RATE, createOutbox } from '../src/outbox.js';
import { fakeTimers } from './helpers.js';

function harness(options = {}) {
  const timers = fakeTimers(0);
  const posted = [];
  const results = [];
  const outbox = createOutbox({
    now: timers.now,
    timers,
    post(data, to, onResult) {
      posted.push({ data, to, at: timers.now() });
      results.push(onResult);
      if (options.refuse?.(data)) onResult('The activity is sending too fast.');
    },
  });
  return { timers, posted, outbox, results };
}

test('sends a burst at once, then paces the rest under Refract’s limit', () => {
  const { timers, posted, outbox } = harness();
  for (let i = 0; i < 100; i += 1) outbox.send({ n: i });
  assert.equal(posted.length, OUTBOX_BURST);
  timers.advance(1000);
  assert.ok(posted.length >= OUTBOX_BURST + OUTBOX_RATE - 1 && posted.length <= OUTBOX_BURST + OUTBOX_RATE);
  timers.advance(10000);
  assert.equal(posted.length, 100);
  assert.deepEqual(posted.map((item) => item.data.n), [...Array(100).keys()], 'order is kept');
  // Over any one-second window after the burst, no more than the rate goes out.
  const later = posted.slice(OUTBOX_BURST);
  for (let i = 0; i + OUTBOX_RATE < later.length; i += 1) assert.ok(later[i + OUTBOX_RATE].at - later[i].at >= 1000 - 60);
});

test('a keyed message replaces its queued predecessor in place', () => {
  const { timers, posted, outbox } = harness();
  for (let i = 0; i < OUTBOX_BURST; i += 1) outbox.send({ n: i });
  outbox.send({ state: 1 }, [2], { key: 'state:2' });
  outbox.send({ chat: 'hi' });
  outbox.send({ state: 2 }, [2], { key: 'state:2' });
  outbox.send({ state: 3 }, [2], { key: 'state:2' });
  assert.equal(outbox.backlog, 2);
  timers.advance(1000);
  assert.deepEqual(posted.slice(OUTBOX_BURST).map((item) => item.data), [{ state: 3 }, { chat: 'hi' }]);
});

test('payload functions run as the message leaves', () => {
  const { timers, posted, outbox } = harness();
  for (let i = 0; i < OUTBOX_BURST; i += 1) outbox.send({ n: i });
  outbox.send(() => ({ sentAt: timers.now() }));
  timers.advance(2000);
  assert.ok(posted.at(-1).data.sentAt > 0);
});

test('a refusal backs off and resends the same message first', () => {
  let refusals = 1;
  const { timers, posted, outbox } = harness({ refuse: (data) => data.n === 1 && refusals-- > 0 });
  outbox.send({ n: 1 });
  outbox.send({ n: 2 });
  assert.deepEqual(posted.map((item) => item.data.n), [1]);
  timers.advance(500);
  assert.deepEqual(posted.map((item) => item.data.n), [1, 1, 2]);
  assert.equal(outbox.available(), Math.floor(outbox.available()));
});

test('unsendable messages are dropped without blocking the queue, and close stops everything', () => {
  const timers = fakeTimers(0);
  const posted = [];
  const outbox = createOutbox({ now: timers.now, timers, post(data) { if (data.bad) throw new Error('too big'); posted.push(data); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    outbox.send({ bad: true });
    outbox.send({ good: true });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(posted, [{ good: true }]);
  outbox.close();
  outbox.send({ late: true });
  timers.advance(1000);
  assert.deepEqual(posted, [{ good: true }]);
});
