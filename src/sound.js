/**
 * Game sounds, synthesized with Web Audio as they play: nothing to download,
 * and the closing seconds tick exactly on the second. Sounds follow the game
 * as it happens. Whatever a copy only catches up on (a reload, a new session)
 * stays silent, and nothing queues up while sound is off or the page is hidden.
 */

/** The last seconds of a turn tick; the last few tick harder. */
export const TICK_SECONDS = 10;
const URGENT_SECONDS = 3;
/** The drum roll before the winner is revealed. The results card waits just as long. */
export const ROLL_SECONDS = 1.2;
// Ticks are booked a little ahead on the audio clock, so a late page timer still lands them on the second.
const TICK_AHEAD_MS = 350;
const TICK_LATE_MS = 150;
// A context still starting after this long drops the sound rather than play it late.
const START_GRACE_MS = 300;
// Quiet enough to sit under voices on the call.
const VOLUME = 0.5;
const REMEMBERED = 48;

const C4 = 261.63, E4 = 329.63, G4 = 392, C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99;
const A5 = 880, C6 = 1046.5, E6 = 1318.51, G6 = 1567.98, C7 = 2093;

/** Each cue writes its notes onto a voice, at offsets in seconds. */
const CUES = {
  tick(voice, second) {
    if (second <= URGENT_SECONDS) {
      voice.tone(0, 1480, 0.07, { volume: 0.2, wave: 'triangle' });
      voice.tone(0, 740, 0.07, { volume: 0.1 });
    } else {
      // Tick, tock.
      voice.tone(0, second % 2 ? 900 : 1200, 0.035, { volume: 0.13, wave: 'triangle' });
    }
  },
  // Up, but not quite home.
  close(voice) {
    voice.tone(0, D5, 0.1, { volume: 0.16, wave: 'triangle' });
    voice.tone(0.09, F5, 0.2, { volume: 0.16, wave: 'triangle', glide: F5 * 1.03 });
  },
  correct(voice) {
    [C5, E5, G5].forEach((note, index) => voice.tone(index * 0.07, note, 0.16, { volume: 0.17, wave: 'triangle' }));
    voice.tone(0.21, C6, 0.5, { volume: 0.2 });
    voice.tone(0.21, G5, 0.5, { volume: 0.08 });
  },
  // Someone else got it: a softer ding.
  guessed(voice) {
    voice.tone(0, G5, 0.14, { volume: 0.1 });
    voice.tone(0.08, C6, 0.3, { volume: 0.1 });
  },
  turn(voice) {
    voice.tone(0, E5, 0.22, { volume: 0.17 });
    voice.tone(0.14, A5, 0.5, { volume: 0.17 });
    voice.tone(0.14, E6, 0.35, { volume: 0.04 });
  },
  timeUp(voice) {
    voice.tone(0, G4, 0.15, { volume: 0.17, wave: 'triangle' });
    voice.tone(0.17, E4, 0.15, { volume: 0.17, wave: 'triangle' });
    voice.tone(0.34, C4, 0.55, { volume: 0.17, wave: 'triangle', glide: 233 });
  },
  // A drum roll, then the winner: ta-da-da-DAA, with a sparkle if it's you.
  fanfare(voice, winner) {
    const hit = ROLL_SECONDS;
    voice.noise(0, 'roll', 0.22);
    [C5, E5, G5].forEach((note, index) => voice.tone(hit + index * 0.12, note, 0.1, { volume: 0.16, wave: 'triangle' }));
    for (const note of [C5, E5, G5, C6]) voice.tone(hit + 0.36, note, 1.1, { volume: note === C6 ? 0.16 : 0.09, wave: 'triangle' });
    voice.noise(hit + 0.36, 'crash', 0.1);
    if (winner) [C6, E6, G6, C7].forEach((note, index) => voice.tone(hit + 0.9 + index * 0.07, note, 0.35, { volume: 0.07 }));
  },
};

/** Noise for the drums: a roll that builds into the reveal, and a cymbal that rings out. */
function noiseBuffer(context, kind) {
  const seconds = kind === 'roll' ? ROLL_SECONDS : 1.4;
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(seconds * rate), rate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const t = i / rate;
    const white = Math.random() * 2 - 1;
    const envelope = kind === 'roll'
      ? (0.25 + 0.75 * (t / seconds) ** 2) * (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * 20 * t)) ** 3)
      : Math.exp(-3.5 * t);
    // The difference between samples tilts the noise toward a snare's hiss.
    data[i] = (white - last) * 0.5 * envelope;
    last = white;
  }
  return buffer;
}

function voiceAt(context, output, buffers, start) {
  return {
    tone(at, frequency, length, { volume = 0.15, wave = 'sine', glide = null } = {}) {
      const begin = start + at;
      const end = begin + length;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(frequency, begin);
      if (glide) oscillator.frequency.exponentialRampToValueAtTime(glide, end);
      gain.gain.setValueAtTime(0, begin);
      gain.gain.linearRampToValueAtTime(volume, begin + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(output);
      oscillator.start(begin);
      oscillator.stop(end + 0.02);
    },
    noise(at, kind, volume) {
      buffers[kind] ??= noiseBuffer(context, kind);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffers[kind];
      gain.gain.setValueAtTime(volume, start + at);
      source.connect(gain).connect(output);
      source.start(start + at);
    },
  };
}

function browserContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context({ latencyHint: 'interactive' }) : null;
}

/**
 * Sounds for one person's copy of the game. Feed it each change with
 * `update` (often: it also books the closing ticks) and each new chat line
 * with `heard`.
 */
export function createGameSound({
  enabled = true,
  createContext = browserContext,
  isHidden = () => globalThis.document?.hidden === true,
  now = () => Date.now(),
  onCue = () => {},
} = {}) {
  let context = null;
  let output = null;
  let buffers = {};
  let destroyed = false;
  let hydrated = false;
  const seen = new Set();
  const ticked = new Set();
  let tickTurn = null;

  function audio() {
    if (!context && enabled && !destroyed) {
      try {
        context = createContext();
        if (context) {
          output = context.createGain();
          output.gain.value = VOLUME;
          output.connect(context.destination);
          buffers = {};
        }
      } catch {
        context = null;
      }
    }
    return context;
  }

  function schedule(cue, detail, delayMs) {
    try {
      CUES[cue](voiceAt(context, output, buffers, context.currentTime + delayMs / 1000), detail);
      onCue(cue, detail);
    } catch { /* A sound must never interrupt the game. */ }
  }

  function play(cue, { detail, delayMs = 0 } = {}) {
    if (destroyed || !enabled || isHidden() || !CUES[cue] || !audio()) return;
    const target = context;
    if (target.state === 'running') {
      schedule(cue, detail, delayMs);
      return;
    }
    // A context starts (or wakes) asynchronously. A sound that would come late is dropped, never queued.
    const asked = now();
    Promise.resolve(target.resume?.()).then(() => {
      const late = now() - asked;
      if (late <= START_GRACE_MS && context === target && target.state === 'running' && enabled && !destroyed) {
        schedule(cue, detail, Math.max(0, delayMs - late));
      }
    }).catch(() => {});
  }

  /** Whether `key` is new; remembers it either way. */
  function fresh(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    for (const old of seen) {
      if (seen.size <= REMEMBERED) break;
      seen.delete(old);
    }
    return true;
  }

  function unlock() {
    if (enabled && audio()?.state === 'suspended') Promise.resolve(context.resume?.()).catch(() => {});
  }

  function bookTicks(view, timerEndsAt) {
    if (view.turn !== tickTurn) {
      tickTurn = view.turn;
      ticked.clear();
    }
    if (view.phase !== 'drawing' || !Number.isFinite(timerEndsAt)) return;
    const remaining = timerEndsAt - now();
    for (let second = TICK_SECONDS; second >= 1; second -= 1) {
      const wait = remaining - second * 1000;
      if (wait >= TICK_AHEAD_MS) break;
      if (wait < -TICK_LATE_MS || ticked.has(second)) continue;
      ticked.add(second);
      play('tick', { detail: second, delayMs: Math.max(0, wait) });
    }
  }

  return {
    /** Follow the game: `view` as this person sees it, and when its timer runs out. */
    update({ view, selfId, timerEndsAt = null }) {
      if (destroyed || !view) return;
      if (view.phase !== 'board') audio();
      const due = [];
      if ((view.phase === 'choosing' || view.phase === 'drawing') && view.drawer === selfId) due.push([`turn:${view.turn}`, 'turn']);
      if (view.phase === 'reveal' && view.result?.reason === 'time') due.push([`reveal:${view.turn}`, 'timeUp']);
      if (view.phase === 'results') due.push([`results:${view.turn}`, 'fanfare', view.winners.includes(selfId)]);
      for (const [key, cue, detail] of due) {
        if (fresh(key) && hydrated) play(cue, { detail });
      }
      hydrated = true;
      bookTicks(view, timerEndsAt);
    },
    /** A chat line that just arrived. */
    heard(line, selfId) {
      if (line?.kind === 'correct') play(line.from === selfId ? 'correct' : 'guessed');
      else if (line?.kind === 'close') play('close');
    },
    play: (cue) => play(cue),
    /** Browsers may hold sound back until the person touches the page. */
    unlock,
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) unlock();
      else Promise.resolve(context?.suspend?.()).catch(() => {});
    },
    /** A new session: what it shows first is history, not news. */
    reset() {
      hydrated = false;
      seen.clear();
      ticked.clear();
      tickTurn = null;
    },
    destroy() {
      destroyed = true;
      Promise.resolve(context?.close?.()).catch(() => {});
      context = null;
    },
  };
}
