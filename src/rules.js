/**
 * The game, as pure functions of a table. The host's copy owns the table:
 * it alone knows the word being drawn. Everyone else sees a view made for
 * them by viewFor(), which hides the word until they guess it.
 *
 * Phases: lobby → choosing → drawing → reveal → (next turn …) → results.
 * The whiteboard is a phase of its own ('board') that the host opens from
 * the lobby. Every function takes `ctx` = { now, random, hostId } and returns
 * a new table, or the same table when nothing changed.
 */
import {
  MAX_CUSTOM_WORDS, cleanWord, guessKey, hintLimit, isCloseGuess, isValidWordList, letterPositions,
  maskWord, matchesMask, pickWords, wordPool,
} from './words.js';

export const MIN_PLAYERS = 2;
export const CHOOSE_MS = 15000;
export const REVEAL_MS = 6000;
/** When playing to a score, the game still ends after this many rounds. */
export const MAX_ROUNDS = 20;
const MAX_PHASE_MS = 300000;

export const SETTING_OPTIONS = Object.freeze({
  endMode: ['rounds', 'score'],
  rounds: [1, 2, 3, 4, 5, 6, 8, 10],
  targetScore: [1000, 1500, 2000, 3000, 5000],
  drawTime: [30, 45, 60, 80, 100, 120, 150, 180, 240],
  wordChoices: [1, 2, 3, 4, 5],
  hints: [0, 1, 2, 3, 4],
  wordSource: ['default', 'mixed', 'custom'],
  boardAccess: ['everyone', 'host'],
});

export const DEFAULT_SETTINGS = Object.freeze({
  endMode: 'rounds',
  rounds: 3,
  targetScore: 2000,
  drawTime: 80,
  wordChoices: 3,
  hints: 2,
  wordSource: 'default',
  boardAccess: 'everyone',
});

export const PHASES = Object.freeze(['lobby', 'choosing', 'drawing', 'reveal', 'results', 'board']);
/** Why a turn ended. */
export const TURN_ENDINGS = Object.freeze(['all', 'time', 'left', 'skip', 'host']);
const GAME_PHASES = new Set(['choosing', 'drawing', 'reveal']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const uniqueIds = (list) => Array.isArray(list) && list.every(isId) && new Set(list).size === list.length;
const roundTo5 = (value) => Math.round(value / 5) * 5;

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function isValidSettings(settings) {
  if (!isRecord(settings)) return false;
  const keys = Object.keys(SETTING_OPTIONS);
  return Object.keys(settings).length === keys.length && keys.every((key) => SETTING_OPTIONS[key].includes(settings[key]));
}

/** Only the valid entries of an untrusted partial settings object. */
function validChanges(changes) {
  if (!isRecord(changes)) return {};
  const out = {};
  for (const [key, options] of Object.entries(SETTING_OPTIONS)) {
    if (Object.hasOwn(changes, key) && options.includes(changes[key])) out[key] = changes[key];
  }
  return out;
}

export function createTable({ settings, customWords = [], wordsRev = 0 } = {}) {
  return {
    phase: 'lobby',
    revision: 0,
    settings: { ...DEFAULT_SETTINGS, ...validChanges(settings) },
    customWords: isValidWordList(customWords) ? [...customWords] : [],
    wordsRev,
    players: [],
    round: 0,
    queue: [],
    drawer: null,
    turn: 0,
    choices: [],
    word: null,
    hintOrder: [],
    revealed: [],
    guessed: [],
    startedAt: 0,
    duration: 0,
    deadline: 0,
    result: null,
    winners: [],
    pens: [],
    used: [],
    stopped: null,
  };
}

const bump = (table, changes) => ({ ...table, ...changes, revision: table.revision + 1 });
const idle = { drawer: null, choices: [], word: null, hintOrder: [], revealed: [], guessed: [], startedAt: 0, duration: 0, deadline: 0 };

/** Points for a correct guess: more for guessing fast, and a bonus for the first few. */
export function guessPoints(remainingMs, durationMs, order) {
  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, remainingMs / durationMs)) : 0;
  return 50 + roundTo5(fraction * 250) + Math.max(0, 50 - order * 10);
}

/** The drawer earns the average of what the guessers earned, counting misses as zero. */
export function drawerPoints(guessed, guessers) {
  if (!guessed.length || guessers < 1) return 0;
  return roundTo5(guessed.reduce((sum, entry) => sum + entry.points, 0) / guessers);
}

const guesserCount = (table) => table.players.filter((player) => player.id !== table.drawer).length;
const everyoneGuessed = (table) => table.guessed.length >= guesserCount(table) && guesserCount(table) > 0;

function toLobby(table, stopped = null) {
  return bump(table, { ...idle, phase: 'lobby', round: 0, queue: [], turn: table.turn + 1, result: null, winners: [], stopped });
}

function finish(table) {
  const best = Math.max(0, ...table.players.map((player) => player.score));
  const winners = table.players.filter((player) => player.score === best).map((player) => player.id);
  return bump(table, { ...idle, phase: 'results', queue: [], winners });
}

function isGameOver(table) {
  if (table.settings.endMode === 'score' && table.players.some((player) => player.score >= table.settings.targetScore)) return true;
  if (table.queue.length) return false;
  return table.round >= (table.settings.endMode === 'score' ? MAX_ROUNDS : table.settings.rounds);
}

function startDrawing(table, word, ctx) {
  const order = shuffle(letterPositions(word), ctx.random).slice(0, hintLimit(word, table.settings.hints));
  const duration = table.settings.drawTime * 1000;
  return bump(table, {
    phase: 'drawing', word, choices: [], hintOrder: order, revealed: [], guessed: [],
    startedAt: ctx.now, duration, deadline: ctx.now + duration,
  });
}

/** The next person in line draws; a new round starts when everyone has had a go. */
function beginTurn(table, ctx) {
  let { round, queue } = table;
  if (!queue.length) {
    round += 1;
    queue = table.players.map((player) => player.id);
  }
  const [drawer, ...rest] = queue;
  const pool = wordPool(table.settings.wordSource, table.customWords);
  const { words, used } = pickWords(pool, table.settings.wordChoices, table.used, ctx.random);
  const next = bump(table, {
    ...idle, round, queue: rest, drawer, turn: table.turn + 1, choices: words, used, result: null,
    phase: 'choosing', startedAt: ctx.now, duration: CHOOSE_MS, deadline: ctx.now + CHOOSE_MS,
  });
  return words.length === 1 ? startDrawing(next, words[0], ctx) : next;
}

function endTurn(table, reason, ctx) {
  const earned = table.phase === 'drawing' ? drawerPoints(table.guessed, guesserCount(table)) : 0;
  const drawerPresent = table.players.some((player) => player.id === table.drawer);
  const players = table.players.map((player) => (player.id === table.drawer ? { ...player, score: player.score + earned } : player));
  const points = [...table.guessed.map((entry) => ({ ...entry })), ...(drawerPresent ? [{ id: table.drawer, points: earned }] : [])];
  return bump(table, {
    players, phase: 'reveal', choices: [], hintOrder: [], word: null,
    result: { word: table.word, reason, drawer: table.drawer, points },
    startedAt: ctx.now, duration: REVEAL_MS, deadline: ctx.now + REVEAL_MS,
  });
}

function advance(table, ctx) {
  return isGameOver(table) ? finish(table) : beginTurn(table, ctx);
}

export function startGame(table, ctx) {
  if ((table.phase !== 'lobby' && table.phase !== 'results') || table.players.length < MIN_PLAYERS) return table;
  if (table.settings.wordSource === 'custom' && !table.customWords.length) return table;
  const players = table.players.map((player) => ({ id: player.id, score: 0 }));
  return beginTurn({ ...table, players, round: 0, queue: [], winners: [], result: null, stopped: null }, ctx);
}

/** Bring the table in line with who has the activity open. */
export function applyRoster(table, memberIds, ctx) {
  const present = new Set(memberIds);
  const kept = table.players.filter((player) => present.has(player.id));
  const known = new Set(kept.map((player) => player.id));
  const added = memberIds.filter((id) => !known.has(id));
  const players = [...kept, ...added.map((id) => ({ id, score: 0 }))];
  const inGame = GAME_PHASES.has(table.phase);
  // Latecomers get a turn this round too.
  const queue = [...table.queue.filter((id) => present.has(id)), ...(inGame ? added : [])];
  const pens = table.pens.filter((id) => present.has(id));
  const guessed = table.guessed.filter((entry) => present.has(entry.id));
  if (JSON.stringify([players, queue, pens, guessed]) === JSON.stringify([table.players, table.queue, table.pens, table.guessed])) return table;
  const next = bump(table, { players, queue, pens, guessed });
  if (inGame && players.length < MIN_PLAYERS) return toLobby(next, 'players');
  if ((next.phase === 'choosing' || next.phase === 'drawing') && !present.has(next.drawer)) return endTurn(next, 'left', ctx);
  if (next.phase === 'drawing' && everyoneGuessed(next)) return endTurn(next, 'all', ctx);
  return next;
}

/**
 * A chat message from `from`, checked against the word. The verdict says how
 * to deliver it: 'chat' (to everyone), 'close' (to everyone, plus a private
 * nudge), 'secret' (only to the drawer and those who already guessed), or
 * 'correct' (never shown; the table records the guess).
 */
export function guess(table, from, text, ctx) {
  if (table.phase !== 'drawing' || !table.players.some((player) => player.id === from)) return { table, verdict: 'chat' };
  if (from === table.drawer || table.guessed.some((entry) => entry.id === from)) return { table, verdict: 'secret' };
  if (guessKey(text) && guessKey(text) === guessKey(table.word)) {
    const points = guessPoints(Math.max(0, table.deadline - ctx.now), table.duration, table.guessed.length);
    let next = bump(table, {
      players: table.players.map((player) => (player.id === from ? { ...player, score: player.score + points } : player)),
      guessed: [...table.guessed, { id: from, points }],
    });
    if (everyoneGuessed(next)) next = endTurn(next, 'all', ctx);
    return { table: next, verdict: 'correct', points };
  }
  return { table, verdict: isCloseGuess(text, table.word) ? 'close' : 'chat' };
}

function hintsDue(table, now) {
  const total = table.hintOrder.length;
  let due = 0;
  for (let k = 1; k <= total; k += 1) {
    if (now >= table.startedAt + (table.duration * k) / (total + 1)) due = k;
  }
  return due;
}

/** Whatever the clock says should have happened by now. */
export function tick(table, ctx) {
  if (table.phase === 'choosing' && ctx.now >= table.deadline) {
    return startDrawing(table, table.choices[Math.floor(ctx.random() * table.choices.length)], ctx);
  }
  if (table.phase === 'drawing') {
    if (ctx.now >= table.deadline) return endTurn(table, 'time', ctx);
    const due = hintsDue(table, ctx.now);
    if (due > table.revealed.length) return bump(table, { revealed: table.hintOrder.slice(0, due) });
  }
  if (table.phase === 'reveal' && ctx.now >= table.deadline) return advance(table, ctx);
  return table;
}

/** When tick() next has something to do, or null. */
export function nextWake(table) {
  if (table.phase === 'choosing' || table.phase === 'reveal') return table.deadline;
  if (table.phase !== 'drawing') return null;
  const total = table.hintOrder.length;
  const next = table.revealed.length + 1;
  const hintAt = next <= total ? table.startedAt + Math.ceil((table.duration * next) / (total + 1)) : Infinity;
  return Math.min(table.deadline, hintAt);
}

/** An action from `from`; host-only actions are refused from anyone else. */
export function applyAction(table, from, action, ctx) {
  if (!isRecord(action) || typeof action.type !== 'string') return table;
  const host = from === ctx.hostId;
  const between = !GAME_PHASES.has(table.phase);
  switch (action.type) {
    case 'settings': {
      if (!host || !between) return table;
      const changes = validChanges(action.settings);
      const settings = { ...table.settings, ...changes };
      return JSON.stringify(settings) === JSON.stringify(table.settings) ? table : bump(table, { settings });
    }
    case 'words':
      if (!host || !between || !isValidWordList(action.words)) return table;
      return bump(table, { customWords: [...action.words], wordsRev: table.wordsRev + 1, used: [] });
    case 'start':
      return host ? startGame(table, ctx) : table;
    case 'choose':
      if (table.phase !== 'choosing' || from !== table.drawer || !Number.isInteger(action.index) || !table.choices[action.index]) return table;
      return startDrawing(table, table.choices[action.index], ctx);
    case 'board':
      if (!host || (table.phase !== 'lobby' && table.phase !== 'results')) return table;
      return bump(table, { ...idle, phase: 'board', round: 0, queue: [], turn: table.turn + 1, result: null, winners: [], stopped: null });
    case 'lobby':
      return host && table.phase !== 'lobby' ? toLobby(table) : table;
    case 'pen': {
      if (!host || table.phase !== 'board' || !isId(action.id) || action.id === from || typeof action.on !== 'boolean' ||
          !table.players.some((player) => player.id === action.id)) return table;
      const pens = action.on ? [...new Set([...table.pens, action.id])] : table.pens.filter((id) => id !== action.id);
      return pens.length === table.pens.length ? table : bump(table, { pens });
    }
    case 'skip':
      return host && (table.phase === 'choosing' || table.phase === 'drawing') ? endTurn(table, 'skip', ctx) : table;
    default:
      return table;
  }
}

/** What `id` may see. The word only reaches the drawer and those who guessed it. */
export function viewFor(table, id, now) {
  const knows = table.phase === 'drawing' && (id === table.drawer || table.guessed.some((entry) => entry.id === id));
  return {
    phase: table.phase,
    revision: table.revision,
    settings: { ...table.settings },
    wordsRev: table.wordsRev,
    wordCount: table.customWords.length,
    players: table.players.map((player) => ({ ...player })),
    round: table.round,
    queue: [...table.queue],
    drawer: table.drawer,
    turn: table.turn,
    choices: table.phase === 'choosing' && id === table.drawer ? [...table.choices] : [],
    hint: table.phase === 'drawing' ? maskWord(table.word, table.revealed) : null,
    word: knows ? table.word : null,
    revealed: [...table.revealed],
    guessed: table.guessed.map((entry) => ({ ...entry })),
    result: table.result && { ...table.result, points: table.result.points.map((entry) => ({ ...entry })) },
    winners: [...table.winners],
    pens: [...table.pens],
    stopped: table.stopped,
    remainingMs: table.deadline ? Math.max(0, Math.min(MAX_PHASE_MS, table.deadline - now)) : null,
    duration: table.duration,
  };
}

function isValidPoints(list, ids = null) {
  return Array.isArray(list) && list.every((entry) => isRecord(entry) && isId(entry.id) && (!ids || ids.has(entry.id)) && isCount(entry.points) && entry.points <= 1000) &&
    new Set(list.map((entry) => entry.id)).size === list.length;
}

/** Network state is untrusted: check every field a view may carry. */
export function isValidView(view, memberIds = null) {
  if (!isRecord(view) || !PHASES.includes(view.phase) || !isCount(view.revision) || !isValidSettings(view.settings) ||
      !isCount(view.wordsRev) || !isCount(view.wordCount) || view.wordCount > MAX_CUSTOM_WORDS) return false;
  if (!Array.isArray(view.players) || !view.players.every((player) => isRecord(player) && isId(player.id) && isCount(player.score)) ||
      !uniqueIds(view.players.map((player) => player.id))) return false;
  const ids = new Set(view.players.map((player) => player.id));
  if (memberIds && (view.players.length !== memberIds.length || !memberIds.every((id) => ids.has(id)))) return false;
  if (!isCount(view.round) || view.round > MAX_ROUNDS || !uniqueIds(view.queue) || !view.queue.every((id) => ids.has(id)) || !isCount(view.turn)) return false;
  const drawing = view.phase === 'choosing' || view.phase === 'drawing';
  if (drawing ? !ids.has(view.drawer) : view.drawer !== null && !isId(view.drawer)) return false;
  if (!Array.isArray(view.choices) || view.choices.length > SETTING_OPTIONS.wordChoices.at(-1) || !view.choices.every((word) => cleanWord(word) === word)) return false;
  if (view.phase === 'drawing') {
    if (!Array.isArray(view.hint) || !view.hint.length || !view.hint.every((char) => char === null || (typeof char === 'string' && Array.from(char).length === 1))) return false;
    if (view.word !== null && (cleanWord(view.word) !== view.word || !matchesMask(view.word, view.hint))) return false;
  } else if (view.hint !== null || view.word !== null) return false;
  if (!Array.isArray(view.revealed) || !view.revealed.every(isCount) || !isValidPoints(view.guessed, ids)) return false;
  if (view.result !== null) {
    const { result } = view;
    if (!isRecord(result) || !TURN_ENDINGS.includes(result.reason) || (result.word !== null && cleanWord(result.word) !== result.word) ||
        (result.drawer !== null && !isId(result.drawer)) || !isValidPoints(result.points)) return false;
  }
  if (!uniqueIds(view.winners) || !uniqueIds(view.pens) || !view.pens.every((id) => ids.has(id))) return false;
  if (view.stopped !== null && view.stopped !== 'players') return false;
  if (view.remainingMs !== null && (!isCount(view.remainingMs) || view.remainingMs > MAX_PHASE_MS)) return false;
  return isCount(view.duration) && view.duration <= MAX_PHASE_MS;
}

/** A table saved by the host is trusted no more than one from the network. */
export function isValidTable(table) {
  if (!isRecord(table) || !isCount(table.startedAt) || !isCount(table.deadline) || !Array.isArray(table.hintOrder) ||
      !table.hintOrder.every(isCount) || !Array.isArray(table.used) || !table.used.every((word) => typeof word === 'string') ||
      !isValidWordList(table.customWords) || !Array.isArray(table.choices) || !table.choices.every((word) => cleanWord(word) === word)) return false;
  if (table.phase === 'drawing' && (cleanWord(table.word) !== table.word)) return false;
  if (table.phase !== 'drawing' && table.word !== null) return false;
  try {
    const view = viewFor(table, table.drawer ?? 1, table.startedAt);
    return isValidView({ ...view, choices: [...table.choices], remainingMs: null });
  } catch {
    return false;
  }
}

/**
 * A new host has the latest view, not the table. Rebuild it: a turn in
 * progress carries on if the word is known (the drawer can vouch for it),
 * and otherwise ends without points.
 */
export function tableFromView(view, { word = null, customWords = [], wordsRev = view.wordsRev, memberIds = null } = {}, ctx) {
  const base = {
    ...createTable({ settings: view.settings, customWords, wordsRev }),
    phase: view.phase,
    revision: view.revision + 1,
    players: view.players.map((player) => ({ ...player })),
    round: view.round,
    queue: [...view.queue],
    drawer: view.drawer,
    turn: view.turn,
    revealed: [...view.revealed],
    guessed: view.guessed.map((entry) => ({ ...entry })),
    result: view.result && { ...view.result, points: view.result.points.map((entry) => ({ ...entry })) },
    winners: [...view.winners],
    pens: [...view.pens],
    stopped: view.stopped,
    duration: view.duration,
  };
  const remaining = view.remainingMs ?? 0;
  if ((view.phase === 'choosing' || view.phase === 'drawing') && memberIds && !memberIds.includes(view.drawer)) {
    return endTurn({ ...base, word: view.phase === 'drawing' ? word : null }, 'left', ctx);
  }
  if (view.phase === 'choosing') {
    const pool = wordPool(base.settings.wordSource, base.customWords);
    const { words, used } = pickWords(pool, base.settings.wordChoices, [], ctx.random);
    return { ...base, choices: words, used, startedAt: ctx.now, duration: CHOOSE_MS, deadline: ctx.now + CHOOSE_MS };
  }
  if (view.phase === 'drawing') {
    if (!word || !matchesMask(word, view.hint)) return endTurn({ ...base, word: null }, 'host', ctx);
    const hidden = letterPositions(word).filter((index) => !view.revealed.includes(index));
    const limit = Math.max(view.revealed.length, hintLimit(word, base.settings.hints));
    const hintOrder = [...view.revealed, ...shuffle(hidden, ctx.random)].slice(0, limit);
    return { ...base, word, hintOrder, startedAt: Math.max(0, ctx.now - (view.duration - remaining)), deadline: ctx.now + remaining };
  }
  if (view.phase === 'reveal') {
    return { ...base, startedAt: ctx.now, duration: REVEAL_MS, deadline: ctx.now + Math.min(remaining, REVEAL_MS) };
  }
  return { ...base, duration: 0 };
}

/** Who may draw right now. */
export function canDraw(view, id, hostId) {
  if (!view) return false;
  if (view.phase === 'drawing') return id === view.drawer;
  if (view.phase === 'board') return view.settings.boardAccess === 'everyone' || id === hostId || view.pens.includes(id);
  return false;
}

/** Who may wipe the whole sheet: the drawer, or the host on the whiteboard. */
export function canClear(view, id, hostId) {
  if (!view) return false;
  if (view.phase === 'drawing') return id === view.drawer;
  return view.phase === 'board' && id === hostId;
}
