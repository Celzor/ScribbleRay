import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLL_SECONDS, TICK_SECONDS, createGameSound } from '../src/sound.js';

/** A Web Audio stand-in that records every note and noise it is asked to play. */
function fakeContext(clock, { state = 'running' } = {}) {
  const param = () => ({ value: 1, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = (extra) => ({ connect: (target) => target, ...extra });
  const context = {
    state, currentTime: 50, sampleRate: 4000, destination: node({}), tones: [], noises: [], resumes: 0,
    resume() {
      context.resumes += 1;
      context.state = 'running';
      return Promise.resolve();
    },
    suspend() { context.state = 'suspended'; return Promise.resolve(); },
    close() { context.state = 'closed'; return Promise.resolve(); },
    createGain: () => node({ gain: param() }),
    createOscillator() {
      const oscillator = node({
        type: 'sine', frequency: param(), stop() {},
        start(at) { context.tones.push({ at, frequency: oscillator.frequency.value, wave: oscillator.type, wall: clock.now }); },
      });
      return oscillator;
    },
    createBuffer: (channels, length) => ({ data: new Float32Array(length), getChannelData() { return this.data; } }),
    createBufferSource() {
      const source = node({ buffer: null, start(at) { context.noises.push({ at, length: source.buffer.data.length }); } });
      return source;
    },
  };
  return context;
}

function harness(options = {}) {
  const clock = { now: 1_000_000 };
  const contexts = [];
  const played = [];
  let hidden = false;
  const sound = createGameSound({
    createContext() {
      const context = fakeContext(clock, options);
      contexts.push(context);
      return context;
    },
    isHidden: () => hidden,
    now: () => clock.now,
    onCue: (cue, detail) => played.push(detail === undefined ? cue : `${cue}:${detail}`),
    ...options,
  });
  return {
    sound, clock, contexts, played,
    get context() { return contexts[0]; },
    hide(value) { hidden = value; },
    show(view, extra = {}) { sound.update({ view, selfId: 1, ...extra }); },
  };
}

const view = (overrides = {}) => ({ phase: 'lobby', turn: 0, drawer: null, result: null, winners: [], ...overrides });

test('what is already happening when a copy arrives stays silent; what happens next is heard', () => {
  const h = harness();
  h.show(view({ phase: 'reveal', turn: 4, result: { reason: 'time' } }));
  h.show(view({ phase: 'reveal', turn: 4, result: { reason: 'time' } }));
  assert.deepEqual(h.played, []);
  assert.equal(h.contexts.length, 1, 'the context is ready before the first sound is due');
  h.show(view({ phase: 'choosing', turn: 5, drawer: 2 }));
  h.show(view({ phase: 'drawing', turn: 5, drawer: 2 }));
  h.show(view({ phase: 'reveal', turn: 5, result: { reason: 'time' } }));
  h.show(view({ phase: 'reveal', turn: 5, result: { reason: 'time' } }));
  assert.deepEqual(h.played, ['timeUp']);
});

test('your turn chimes once, whether you pick a word or draw straight away', () => {
  const h = harness();
  h.show(view());
  h.show(view({ phase: 'choosing', turn: 1, drawer: 1 }));
  h.show(view({ phase: 'choosing', turn: 1, drawer: 1 }));
  h.show(view({ phase: 'drawing', turn: 1, drawer: 1 }));
  h.show(view({ phase: 'reveal', turn: 1, result: { reason: 'all' } }));
  h.show(view({ phase: 'choosing', turn: 2, drawer: 2 }));
  // With one word choice, a turn starts already drawing.
  h.show(view({ phase: 'drawing', turn: 3, drawer: 1 }));
  assert.deepEqual(h.played, ['turn', 'turn']);
});

test('a turn that ends any way but the clock makes no time-up sound', () => {
  const h = harness();
  h.show(view());
  for (const [turn, reason] of [[1, 'all'], [2, 'skip'], [3, 'left'], [4, 'host']]) {
    h.show(view({ phase: 'drawing', turn, drawer: 2 }));
    h.show(view({ phase: 'reveal', turn, result: { reason } }));
  }
  assert.deepEqual(h.played, []);
});

test('the last ten seconds tick once each, exactly on the second, and the last three harder', () => {
  const h = harness();
  const ends = h.clock.now + 13_000;
  const drawing = view({ phase: 'drawing', turn: 7, drawer: 2 });
  h.show(view());
  // The page's clock runs every 200 ms, sometimes late; and the host's updates nudge the deadline.
  let step = 0;
  while (h.clock.now < ends + 1000) {
    h.show(drawing, { timerEndsAt: ends + (step % 7 === 3 ? 12 : 0) });
    step += 1;
    h.clock.now += step % 11 === 5 ? 290 : 200;
  }
  assert.deepEqual(h.played, Array.from({ length: TICK_SECONDS }, (_, index) => `tick:${TICK_SECONDS - index}`));
  const ticks = h.context.tones.filter((tone) => tone.frequency !== 740);
  assert.equal(ticks.length, TICK_SECONDS);
  ticks.forEach((tone, index) => {
    const second = TICK_SECONDS - index;
    // When the tick sounds, in page time: when it was booked plus how far ahead on the audio clock.
    const sounds = tone.wall + (tone.at - h.context.currentTime) * 1000;
    assert.ok(Math.abs(sounds - (ends - second * 1000)) <= 12, `tick ${second} lands on the second`);
  });
  assert.deepEqual(ticks.slice(0, 7).map((tone) => tone.frequency), [1200, 900, 1200, 900, 1200, 900, 1200], 'tick, tock');
  assert.deepEqual(ticks.slice(7).map((tone) => tone.frequency), [1480, 1480, 1480]);

  // Arriving late in a turn ticks only what is left; a new turn ticks afresh.
  const late = harness();
  const lateEnds = late.clock.now + 2200;
  late.show(view({ phase: 'drawing', turn: 7, drawer: 2 }), { timerEndsAt: lateEnds });
  late.clock.now += 1000;
  late.show(view({ phase: 'drawing', turn: 7, drawer: 2 }), { timerEndsAt: lateEnds });
  late.clock.now += 1500;
  late.show(view({ phase: 'drawing', turn: 7, drawer: 2 }), { timerEndsAt: lateEnds });
  late.show(view({ phase: 'drawing', turn: 8, drawer: 2 }), { timerEndsAt: late.clock.now + 1100 });
  assert.deepEqual(late.played, ['tick:2', 'tick:1', 'tick:1']);
});

test('no ticks outside drawing, or without a clock', () => {
  const h = harness();
  h.show(view({ phase: 'choosing', turn: 1, drawer: 2 }), { timerEndsAt: h.clock.now + 4000 });
  h.show(view({ phase: 'reveal', turn: 1, result: { reason: 'all' } }), { timerEndsAt: h.clock.now + 4000 });
  h.show(view({ phase: 'drawing', turn: 2, drawer: 2 }), { timerEndsAt: null });
  assert.deepEqual(h.played, []);
});

test('guesses: a flourish for yours, a soft ding for others, and a private “close” for near misses', () => {
  const h = harness();
  h.show(view());
  h.sound.heard({ kind: 'correct', from: 1, points: 300 }, 1);
  h.sound.heard({ kind: 'correct', from: 2, points: 250 }, 1);
  h.sound.heard({ kind: 'close', text: 'elephent' }, 1);
  h.sound.heard({ kind: 'chat', from: 2, text: 'hello' }, 1);
  h.sound.heard({ kind: 'turn', from: 2 }, 1);
  assert.deepEqual(h.played, ['correct', 'guessed', 'close']);
});

test('the results get a drum roll, then a fanfare on the reveal, with a sparkle for the winner', () => {
  const finale = (winners) => {
    const h = harness();
    h.show(view({ phase: 'reveal', turn: 9, result: { reason: 'all' } }));
    h.show(view({ phase: 'results', turn: 9, winners }));
    h.show(view({ phase: 'results', turn: 9, winners }));
    return h;
  };
  const won = finale([1]);
  const lost = finale([2]);
  assert.deepEqual(won.played, ['fanfare:true']);
  assert.deepEqual(lost.played, ['fanfare:false']);
  const start = won.context.currentTime;
  assert.equal(won.context.noises[0].at, start, 'the roll starts at once');
  assert.equal(won.context.noises[0].length, Math.ceil(ROLL_SECONDS * won.context.sampleRate));
  assert.equal(Math.min(...won.context.tones.map((tone) => tone.at)), start + ROLL_SECONDS, 'the tune waits for the roll');
  assert.ok(won.context.tones.length > lost.context.tones.length);
  assert.ok(Math.max(...won.context.tones.map((tone) => tone.frequency)) > Math.max(...lost.context.tones.map((tone) => tone.frequency)));

  // Playing again, the next game's results sound again.
  const again = finale([1]);
  again.show(view({ phase: 'choosing', turn: 10, drawer: 2 }));
  again.show(view({ phase: 'results', turn: 14, winners: [2] }));
  assert.deepEqual(again.played, ['fanfare:true', 'fanfare:false']);
});

test('muted or hidden: nothing plays, nothing is created, and nothing piles up for later', () => {
  const h = harness({ enabled: false });
  h.show(view());
  h.show(view({ phase: 'choosing', turn: 1, drawer: 1 }));
  h.sound.heard({ kind: 'correct', from: 2 }, 1);
  h.show(view({ phase: 'drawing', turn: 1, drawer: 1 }), { timerEndsAt: h.clock.now + 900 });
  assert.equal(h.contexts.length, 0, 'no audio is set up while muted');
  h.sound.setEnabled(true);
  h.show(view({ phase: 'drawing', turn: 1, drawer: 1 }), { timerEndsAt: h.clock.now + 900 });
  h.show(view({ phase: 'reveal', turn: 1, result: { reason: 'time' } }));
  assert.deepEqual(h.played, ['timeUp'], 'only what happens after unmuting');

  h.hide(true);
  h.show(view({ phase: 'choosing', turn: 2, drawer: 1 }));
  h.sound.heard({ kind: 'close', text: 'nearly' }, 1);
  h.hide(false);
  h.show(view({ phase: 'choosing', turn: 2, drawer: 1 }));
  assert.deepEqual(h.played, ['timeUp']);

  h.sound.setEnabled(false);
  assert.equal(h.context.state, 'suspended', 'muting quiets anything still ringing');
  h.sound.unlock();
  assert.equal(h.context.state, 'suspended', 'a click does not unmute');
});

test('a context that starts quickly plays; one that starts late drops the sound', async () => {
  const quick = harness({ state: 'suspended' });
  quick.show(view());
  quick.show(view({ phase: 'choosing', turn: 1, drawer: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(quick.played, ['turn']);

  const slow = harness({ state: 'suspended' });
  slow.show(view());
  slow.context.resume = () => new Promise((resolve) => setTimeout(() => {
    slow.clock.now += 2000;
    slow.context.state = 'running';
    resolve();
  }, 0));
  slow.show(view({ phase: 'choosing', turn: 1, drawer: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(slow.played, [], 'a late sound is dropped, not queued');
  slow.sound.heard({ kind: 'close', text: 'nearly' }, 1);
  assert.deepEqual(slow.played, ['close'], 'once running, sounds play straight away');
});

test('a touch wakes a held-back context; a new session starts quiet', () => {
  const h = harness({ state: 'suspended' });
  h.show(view());
  h.sound.unlock();
  assert.equal(h.context.state, 'running');
  h.sound.reset();
  h.show(view({ phase: 'results', turn: 3, winners: [1] }));
  assert.deepEqual(h.played, []);
  h.sound.destroy();
  assert.equal(h.context.state, 'closed');
  h.sound.heard({ kind: 'close', text: 'nearly' }, 1);
  assert.deepEqual(h.played, []);
});

test('without Web Audio, or when it fails, the game carries on in silence', () => {
  for (const createContext of [() => null, () => { throw new Error('no audio here'); }]) {
    const sound = createGameSound({ createContext, isHidden: () => false });
    sound.update({ view: view(), selfId: 1 });
    sound.update({ view: view({ phase: 'choosing', turn: 1, drawer: 1 }), selfId: 1 });
    sound.heard({ kind: 'correct', from: 1 }, 1);
    sound.unlock();
    sound.setEnabled(false);
    sound.destroy();
  }
  // The whiteboard needs no sound, so it sets none up.
  const h = harness();
  h.show(view({ phase: 'board' }));
  assert.equal(h.contexts.length, 0);
});
