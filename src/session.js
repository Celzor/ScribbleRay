import {
  MAX_CANVAS_POINTS, MAX_OPS, applyEvent, canvasSummary, chunkEvents, createCanvas, encodePoints, eventAuthor,
  hasGap, isBrush, isColor, isValidEvent, lastOpBy, opAuthor, restoreCanvas, serializeCanvas, snapshotEvents,
} from './canvas.js';
import { createOutbox } from './outbox.js';
import {
  applyAction, applyRoster, canClear, canDraw, createTable, guess, isValidTable, isValidView, nextWake,
  tableFromView, tick, viewFor,
} from './rules.js';
import { MAX_GUESS_LENGTH, isValidWordList } from './words.js';

export const GAME_PROTOCOL = 'scribbleray/1';
export const RECOVERY_WINDOW_MS = 2500;
export const RECOVERY_RETRY_MS = 900;
export const INK_INTERVAL_MS = 50;
/** Room for drawing events in one message, leaving space for the envelope under 16 KiB. */
export const CHUNK_BYTES = 12000;
const SEGMENT_POINTS = 600;
const MAX_LINES = 120;
const SAVED_LINES = 60;
// Two lines a second, the pace the page sends at; anything faster is a flood.
const CHAT_BURST = 8;
const CHAT_WINDOW_MS = 4000;
const LINE_BATCH_MS = 60;
const RECENT_INK_MS = 4000;
const FUTURE_INK_LIMIT = 300;
const CANVAS_REQUEST_GAP_MS = 3000;
const PERSIST_DELAY_MS = 1500;
const MAX_TIMER_MS = 300000;
const MAX_PARTS = 400;
const WIRE_LINES = new Set(['chat', 'secret', 'close', 'correct']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const token = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const validToken = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Chat text as it may be sent: printable, single-spaced, and not too long. */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, MAX_GUESS_LENGTH).join('').trim();
}

function validLine(line) {
  if (!isRecord(line) || !WIRE_LINES.has(line.kind)) return false;
  if (line.kind !== 'close' && !validId(line.from)) return false;
  if (line.kind === 'correct') return line.points === undefined || (Number.isSafeInteger(line.points) && line.points >= 0 && line.points <= 1000);
  return typeof line.text === 'string' && cleanText(line.text) === line.text && line.text.length > 0;
}

function normalizePeople(people) {
  if (!Array.isArray(people)) return null;
  const seen = new Set();
  const result = [];
  for (const person of people) {
    if (!person || !validId(person.id) || seen.has(person.id)) return null;
    seen.add(person.id);
    result.push({
      id: person.id,
      name: typeof person.name === 'string' && person.name.trim() ? person.name : `Player ${person.id}`,
      avatarUrl: typeof person.avatarUrl === 'string' ? person.avatarUrl : null,
    });
  }
  return result;
}

function browserStorage() {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/**
 * The shared game for one Refract activity session. The first participant
 * hosts: it alone holds the table (and so the word), checks every guess, runs
 * the clock, and sends each participant only what they may see. Drawing
 * travels directly from whoever draws to everyone; the host also keeps the
 * whole picture so latecomers can catch up.
 */
export function createSession({
  send, onChange, onInk = () => {}, onLine = () => {}, storage = browserStorage(),
  random = Math.random, now = () => Date.now(), timers = globalThis,
}) {
  let table = null;
  let view = null;
  let self = null;
  let participants = [];
  let earlyParticipants = null;
  let sessionId = null;
  let hostId = null;
  let connected = false;
  let notice = '';
  let destroyed = false;
  let acceptedHostId = null;
  let pendingSync = null;
  let recovery = null;
  let timerEndsAt = null;
  let timerDuration = 0;
  let customWords = [];
  let wordsRev = 0;
  let canvas = createCanvas(0);
  let lines = [];
  let lineSeq = 0;
  let wakeHandle = null;
  let inkHandle = null;
  let lineHandle = null;
  let persistHandle = null;
  let strokeSeq = now() % 1e9;
  let incoming = null;
  let dumpFrom = null;
  let lastCanvasRequest = -Infinity;
  const inkQueue = [];
  let futureInk = [];
  let recentInk = [];
  const lineBatches = new Map();
  const chatTimes = new Map();

  const outbox = createOutbox({ post: send, now, timers });
  const ids = () => participants.map((person) => person.id);
  const isHost = () => self !== null && self.id === hostId;
  const isMember = (id) => participants.some((person) => person.id === id);
  const others = () => ids().filter((id) => id !== self?.id);
  const nameOf = (id) => participants.find((person) => person.id === id)?.name ?? `Player ${id}`;
  const storageKey = (part) => `${GAME_PROTOCOL}:${JSON.stringify([sessionId, self?.id])}:${part}`;
  const ctx = () => ({ now: now(), random, hostId });
  const hosting = () => !destroyed && isHost() && table !== null && !recovery;

  // ---- persistence ----

  function save(part, value) {
    if (!storage || !sessionId || !self) return;
    try { storage.setItem(storageKey(part), JSON.stringify(value)); } catch { /* Storage is a convenience, never a requirement. */ }
  }

  function load(part, limit) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey(part));
      return raw && raw.length <= limit ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function persistNow() {
    if (persistHandle !== null) timers.clearTimeout(persistHandle);
    persistHandle = null;
    if (destroyed || !sessionId) return;
    save('lines', lines.slice(-SAVED_LINES));
    if (isHost() && table && !recovery) save('canvas', serializeCanvas(canvas));
  }

  function persistSoon() {
    if (persistHandle === null && !destroyed) persistHandle = timers.setTimeout(persistNow, PERSIST_DELAY_MS);
  }

  function persistTable() {
    if (isHost() && table && !recovery) save('table', { table, hostId, members: ids() });
  }

  // ---- what the page sees ----

  function restingNotice() {
    if (!self || !isMember(self.id)) return 'You are no longer in this activity.';
    if (recovery) return 'Picking up where the last host left off…';
    if (!connected) return 'Synchronizing…';
    return '';
  }

  // Not tied to `connected`: a roster change mid-stroke must not cut the drawer off.
  function mayDraw() {
    return !!view && !!self && isMember(self.id) && canDraw(view, self.id, hostId) && canvas.turn === view.turn;
  }

  function emit() {
    if (destroyed) return;
    persistTable();
    onChange({
      view: clone(view),
      self: self && { ...self },
      participants: participants.map((person) => ({ ...person })),
      hostId,
      isHost: isHost(),
      connected,
      recovering: recovery !== null,
      notice,
      timerEndsAt,
      timerDuration,
      customWords: [...customWords],
      wordsRev,
      canDraw: mayDraw(),
      canClear: connected && !!view && !!self && canClear(view, self.id, hostId),
      canvasFull: canvas.points >= MAX_CANVAS_POINTS || canvas.ops.length >= MAX_OPS,
    });
  }

  function addLine(line) {
    lineSeq += 1;
    const entry = { ...line, n: lineSeq };
    lines.push(entry);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    onLine(entry);
    persistSoon();
  }

  function transmit(kind, data = {}, to, options) {
    if (destroyed || !sessionId || !self || !isMember(self.id)) return;
    const envelope = { protocol: GAME_PROTOCOL, sessionId, hostId, kind };
    outbox.send(typeof data === 'function' ? () => ({ ...envelope, ...data() }) : { ...envelope, ...data }, to, options);
  }

  // ---- the canvas ----

  function inkChanged(change) {
    if (!change) return;
    onInk(change);
    persistSoon();
  }

  function resetCanvas(turn) {
    canvas = createCanvas(turn);
    incoming = null;
    inkQueue.length = 0;
    recentInk = recentInk.filter((entry) => entry.turn === turn);
    onInk({ type: 'redraw' });
    persistSoon();
  }

  /** Apply someone's drawing events, checking each is theirs to make. */
  function applyInk(from, events, turn) {
    let redraw = false;
    const changes = [];
    const at = now();
    for (const event of events) {
      if (!isValidEvent(event) || !inkAllowed(from, event)) continue;
      if (hasGap(canvas, event)) requestCanvas();
      recentInk.push({ at, turn, event });
      const change = applyEvent(canvas, event);
      if (change?.type === 'redraw') redraw = true;
      else if (change) changes.push(change);
    }
    recentInk = recentInk.filter((entry) => at - entry.at <= RECENT_INK_MS);
    if (redraw) inkChanged({ type: 'redraw' });
    else changes.forEach(inkChanged);
  }

  function inkAllowed(from, event) {
    if (!view) return false;
    if (event[0] === 'x') return canClear(view, from, hostId) || (view.phase === 'reveal' && from === view.drawer);
    if (eventAuthor(event) !== from) return false;
    if (event[0] === 'u') return true;
    if (view.phase === 'drawing' || view.phase === 'reveal') return from === view.drawer;
    // On the whiteboard, pens are enforced by each person's own page.
    return view.phase === 'board';
  }

  function receiveInk(from, data) {
    if (!Number.isSafeInteger(data.turn) || data.turn < 0 || !Array.isArray(data.ev) || data.ev.length > 4000) return;
    if (!view || data.turn > canvas.turn) {
      // Drawing for a turn this copy hasn't heard about yet: the state is on its way.
      futureInk.push({ from, turn: data.turn, ev: data.ev });
      if (futureInk.length > FUTURE_INK_LIMIT) futureInk.shift();
      return;
    }
    if (data.turn === canvas.turn) applyInk(from, data.ev, data.turn);
  }

  function requestCanvas() {
    if (isHost() || !view || incoming || now() - lastCanvasRequest < CANVAS_REQUEST_GAP_MS) return;
    lastCanvasRequest = now();
    sync(true);
  }

  /** Send the whole picture, in pieces that each fit one message. */
  function sendCanvas(to, snap) {
    const chunks = chunkEvents(snapshotEvents(canvas), CHUNK_BYTES).slice(0, MAX_PARTS);
    const { turn, epoch } = canvas;
    chunks.forEach((ev, part) => transmit('canvas', { turn, epoch, snap, part, parts: chunks.length, ev }, to));
  }

  function receiveCanvas(from, data) {
    const trusted = isHost() ? from === dumpFrom : from === hostId;
    if (!trusted || !view || data.turn !== view.turn || !Number.isSafeInteger(data.epoch) || data.epoch < 0 || !validToken(data.snap) ||
        !Number.isSafeInteger(data.parts) || data.parts < 1 || data.parts > MAX_PARTS ||
        !Number.isSafeInteger(data.part) || data.part < 0 || data.part >= data.parts || !Array.isArray(data.ev)) return;
    if (data.part === 0) {
      incoming = { snap: data.snap, next: 0, parts: data.parts };
      canvas = createCanvas(data.turn);
      canvas.epoch = data.epoch;
    } else if (incoming?.snap !== data.snap) return;
    if (data.part !== incoming.next) {
      // A piece went missing: start over.
      incoming = null;
      requestCanvas();
      return;
    }
    incoming.next += 1;
    for (const event of data.ev) {
      if (isValidEvent(event) && event[0] !== 'u' && event[0] !== 'x' && event[2] === data.epoch) applyEvent(canvas, event);
    }
    if (incoming.next < incoming.parts) return;
    incoming = null;
    if (isHost()) dumpFrom = null;
    // Drawing that crossed the snapshot in flight merges back in.
    for (const entry of recentInk) if (entry.turn === canvas.turn) applyEvent(canvas, entry.event);
    for (const op of canvas.ops) {
      if (opAuthor(op.id) === self.id) strokeSeq = Math.max(strokeSeq, Number(op.id.slice(op.id.indexOf('.') + 1)));
    }
    onInk({ type: 'redraw' });
    emit();
    persistSoon();
  }

  function adoptView(next) {
    const previous = view;
    view = next;
    if (canvas.turn !== view.turn) {
      resetCanvas(view.turn);
      const ready = futureInk.filter((entry) => entry.turn === view.turn);
      futureInk = futureInk.filter((entry) => entry.turn > view.turn);
      for (const entry of ready) applyInk(entry.from, entry.ev, entry.turn);
    }
    narrate(previous, view);
  }

  /** Lines in the chat for what just happened in the game. */
  function narrate(previous, next) {
    if (!previous) return;
    if (next.phase === 'drawing' && (previous.phase !== 'drawing' || previous.turn !== next.turn)) {
      addLine({ kind: 'turn', from: next.drawer });
    } else if (next.phase === 'reveal' && previous.phase !== 'reveal' && next.result) {
      addLine({ kind: 'reveal', word: next.result.word, reason: next.result.reason, from: next.result.drawer });
    } else if (next.phase === 'board' && previous.phase !== 'board') {
      addLine({ kind: 'board' });
    } else if (next.phase === 'results' && previous.phase !== 'results') {
      addLine({ kind: 'results', winners: [...next.winners] });
    }
  }

  // ---- drawing from this copy ----

  function scheduleInk() {
    if (inkHandle === null && !destroyed) inkHandle = timers.setTimeout(flushInk, INK_INTERVAL_MS);
  }

  function queueSegment(id, epoch, color, width, from, points) {
    const last = inkQueue.at(-1);
    if (last?.seg && last.seg.id === id && last.seg.epoch === epoch && last.seg.from + last.seg.points.length / 2 === from) {
      last.seg.points.push(...points);
    } else {
      inkQueue.push({ seg: { id, epoch, color, width, from, points: [...points] } });
    }
    scheduleInk();
  }

  function queueEvent(event) {
    inkQueue.push({ event });
    scheduleInk();
  }

  /** Send what has been drawn so far as one message, waiting while the allowance is spent. */
  function flushInk() {
    inkHandle = null;
    if (!inkQueue.length || destroyed) return;
    if (!self || !isMember(self.id) || !sessionId) {
      inkQueue.length = 0;
      return;
    }
    if (outbox.available() < 1) {
      scheduleInk();
      return;
    }
    const events = [];
    let size = 2;
    while (inkQueue.length) {
      const item = inkQueue[0];
      let event = item.event;
      let rest = null;
      if (item.seg) {
        const seg = item.seg;
        const count = seg.points.length / 2;
        const take = Math.min(count, SEGMENT_POINTS);
        event = ['s', seg.id, seg.epoch, seg.color, seg.width, seg.from, encodePoints(seg.points, 0, take)];
        if (take < count) rest = { ...seg, from: seg.from + take, points: seg.points.slice(take * 2) };
      }
      const bytes = byteSize(event) + 1;
      if (events.length && size + bytes > CHUNK_BYTES) break;
      events.push(event);
      size += bytes;
      if (rest) item.seg = rest;
      else inkQueue.shift();
    }
    transmit('ink', { turn: canvas.turn, ev: events });
    if (inkQueue.length) scheduleInk();
  }

  function addPoints(id, color, width, points) {
    const op = canvas.byId.get(id);
    const from = op ? op.points.length / 2 : 0;
    const change = applyEvent(canvas, ['s', id, canvas.epoch, color, width, from, encodePoints(points)]);
    if (change?.type !== 'stroke') return false;
    queueSegment(id, canvas.epoch, color, width, change.start, change.op.points.slice(change.start * 2));
    inkChanged(change);
    if (canvas.points >= MAX_CANVAS_POINTS) emit();
    return true;
  }

  const validPoints = (points) => Array.isArray(points) && points.length >= 2 && points.length % 2 === 0 && points.every(Number.isInteger);

  function nextOpId() {
    strokeSeq = (strokeSeq + 1) % 1e9;
    return `${self.id}.${strokeSeq}`;
  }

  // ---- hosting ----

  /** Each distinct view goes out once, addressed to everyone who should see it. */
  function publish(targets = others(), replyTo) {
    if (!hosting()) return;
    const members = ids();
    const time = now();
    const groups = new Map();
    for (const id of targets) {
      if (id === self.id || !isMember(id)) continue;
      const personal = viewFor(table, id, time);
      const key = JSON.stringify(personal);
      if (groups.has(key)) groups.get(key).to.push(id);
      else groups.set(key, { view: personal, to: [id] });
    }
    const deadline = table.deadline;
    for (const { view: personal, to } of groups.values()) {
      const payload = () => ({
        view: { ...personal, remainingMs: deadline ? Math.max(0, Math.min(MAX_TIMER_MS, deadline - now())) : null },
        members,
        ...(replyTo ? { replyTo } : {}),
      });
      transmit('state', payload, to, replyTo ? undefined : { key: `state:${to.join(',')}` });
    }
  }

  function setTimer(remainingMs, duration) {
    timerEndsAt = remainingMs === null ? null : now() + Math.min(remainingMs, MAX_TIMER_MS);
    timerDuration = duration;
  }

  function commit(next) {
    if (!next || next === table || destroyed || !isHost()) return false;
    const wordsChanged = !table || next.wordsRev !== table.wordsRev;
    table = next;
    customWords = [...table.customWords];
    wordsRev = table.wordsRev;
    const personal = viewFor(table, self.id, now());
    adoptView(personal);
    setTimer(personal.remainingMs, personal.duration);
    connected = true;
    acceptedHostId = hostId;
    notice = restingNotice();
    emit();
    if (wordsChanged && others().length) transmit('words', { rev: wordsRev, words: customWords }, others());
    publish();
    scheduleWake();
    return true;
  }

  function scheduleWake(minimum = 0) {
    if (wakeHandle !== null) timers.clearTimeout(wakeHandle);
    wakeHandle = null;
    if (!hosting()) return;
    const at = nextWake(table);
    if (at === null) return;
    wakeHandle = timers.setTimeout(() => {
      wakeHandle = null;
      if (hosting() && !commit(tick(table, ctx()))) scheduleWake(20);
    }, Math.max(minimum, at - now()));
  }

  function deliverLine(line, recipients = null) {
    if (recipients === null || recipients.includes(self.id)) addLine(line);
    const targets = (recipients ?? others()).filter((id) => id !== self.id && isMember(id));
    if (!targets.length) return;
    const key = recipients === null ? '*' : [...new Set(targets)].sort((a, b) => a - b).join(',');
    if (!lineBatches.has(key)) lineBatches.set(key, { to: recipients === null ? undefined : [...new Set(targets)], lines: [] });
    lineBatches.get(key).lines.push(line);
    if (lineHandle === null) lineHandle = timers.setTimeout(flushLines, LINE_BATCH_MS);
  }

  function flushLines() {
    if (lineHandle !== null) timers.clearTimeout(lineHandle);
    lineHandle = null;
    for (const { to, lines: batch } of lineBatches.values()) {
      for (let i = 0; i < batch.length; i += 20) transmit('lines', { lines: batch.slice(i, i + 20) }, to);
    }
    lineBatches.clear();
  }

  /** The host checks every chat message: it may be a guess. */
  function hear(from, text) {
    if (!hosting()) return;
    const time = now();
    const recent = (chatTimes.get(from) ?? []).filter((at) => time - at < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_BURST) return;
    recent.push(time);
    chatTimes.set(from, recent);
    const { table: next, verdict, points } = guess(table, from, text, ctx());
    if (verdict === 'correct') {
      deliverLine({ kind: 'correct', from, points });
      flushLines();
      commit(next);
    } else if (verdict === 'secret') {
      deliverLine({ kind: 'secret', from, text }, [table.drawer, ...table.guessed.map((entry) => entry.id)]);
    } else {
      deliverLine({ kind: 'chat', from, text });
      if (verdict === 'close') deliverLine({ kind: 'close', text }, [from]);
    }
  }

  function stopHosting() {
    table = null;
    if (wakeHandle !== null) timers.clearTimeout(wakeHandle);
    wakeHandle = null;
    if (lineHandle !== null) timers.clearTimeout(lineHandle);
    lineHandle = null;
    lineBatches.clear();
    if (recovery) recovery.handles.forEach((handle) => timers.clearTimeout(handle));
    recovery = null;
    dumpFrom = null;
  }

  /**
   * A new host has views, not the table. It asks everyone for theirs (the
   * drawer's includes the word), adopts the newest, and carries on.
   */
  function beginRecovery() {
    if (recovery) recovery.handles.forEach((handle) => timers.clearTimeout(handle));
    const requestId = token();
    recovery = { requestId, reports: new Map(), handles: [] };
    connected = false;
    notice = restingNotice();
    emit();
    if (!others().length) {
      finishRecovery();
      return;
    }
    transmit('recover', { requestId }, others());
    recovery.handles.push(timers.setTimeout(() => {
      if (recovery?.requestId !== requestId) return;
      // Peers that had not yet seen the roster change ignored the first request.
      const missing = others().filter((id) => !recovery.reports.has(id));
      if (missing.length) transmit('recover', { requestId }, missing);
    }, RECOVERY_RETRY_MS));
    recovery.handles.push(timers.setTimeout(() => {
      if (recovery?.requestId === requestId) finishRecovery();
    }, RECOVERY_WINDOW_MS));
  }

  function maybeFinishRecovery() {
    if (recovery && others().every((id) => recovery.reports.has(id))) finishRecovery();
  }

  function finishRecovery() {
    if (!recovery || destroyed) return;
    const { reports, handles } = recovery;
    handles.forEach((handle) => timers.clearTimeout(handle));
    recovery = null;
    const candidates = [];
    if (view && isValidView(view)) candidates.push({ id: self.id, view, word: view.word });
    for (const [id, report] of reports) if (report) candidates.push({ id, ...report });
    let best = null;
    for (const candidate of candidates) {
      if (!best || candidate.view.revision > best.view.revision) best = candidate;
    }
    let next;
    if (best) {
      // The drawer can vouch for the word; anyone who guessed it can too.
      const knowing = candidates.filter((candidate) => candidate.view.turn === best.view.turn && candidate.word);
      const word = (knowing.find((candidate) => candidate.id === best.view.drawer) ?? knowing[0])?.word ?? null;
      const rev = wordsRev === best.view.wordsRev ? wordsRev : Math.max(wordsRev, best.view.wordsRev) + 1;
      next = tableFromView(best.view, { word, customWords, wordsRev: rev, memberIds: ids() }, ctx());
      if (!isValidTable(next)) next = createTable({ settings: best.view.settings, customWords, wordsRev: rev });
    } else {
      next = createTable({ customWords, wordsRev });
    }
    const lostPicture = canvas.turn !== next.turn && next.phase !== 'lobby';
    commit(applyRoster(next, ids(), ctx()));
    // A host that lost its own copy of the picture (a reload without storage) borrows one.
    if (lostPicture && hosting() && table.turn === next.turn) {
      const peer = isMember(table.drawer) && table.drawer !== self.id ? table.drawer : others()[0];
      if (peer) {
        dumpFrom = peer;
        transmit('dump', { requestId: token(), turn: table.turn }, [peer]);
      }
    }
  }

  // ---- membership ----

  function updateRoster(people) {
    const next = normalizePeople(people);
    if (!next || destroyed) return;
    if (!self) {
      earlyParticipants = next;
      return;
    }
    const oldHost = hostId;
    const oldPeople = participants;
    participants = next;
    hostId = participants[0]?.id ?? null;
    const changed = JSON.stringify(oldPeople.map((person) => person.id)) !== JSON.stringify(ids());
    const leadershipChanged = oldHost !== hostId;
    for (const person of next) if (!oldPeople.some((old) => old.id === person.id)) addLine({ kind: 'join', from: person.id, name: person.name });
    for (const person of oldPeople) if (!isMember(person.id)) addLine({ kind: 'leave', from: person.id, name: person.name });
    if (leadershipChanged && hostId !== null && isMember(self.id)) addLine({ kind: 'host', from: hostId, name: nameOf(hostId) });
    if (!isMember(self.id)) {
      stopHosting();
      connected = false;
      notice = restingNotice();
      emit();
      return;
    }

    if (isHost()) {
      if (leadershipChanged) beginRecovery();
      else if (recovery) {
        emit();
        maybeFinishRecovery();
      } else if (table) {
        if (!commit(applyRoster(table, ids(), ctx()))) {
          emit();
          if (changed) publish();
        }
      }
      return;
    }

    if (leadershipChanged) stopHosting();
    if (leadershipChanged || (view && !isValidView(view, ids()))) {
      connected = false;
      acceptedHostId = null;
    }
    notice = restingNotice();
    emit();
    if (changed) sync();
  }

  function init(message) {
    if (destroyed || !message || typeof message.sessionId !== 'string' || !message.sessionId ||
        !message.self || !validId(message.self.id)) return;
    const nextParticipants = normalizePeople(message.participants);
    if (!nextParticipants || !nextParticipants.some((person) => person.id === message.self.id)) return;
    if (sessionId === message.sessionId && self?.id === message.self.id) {
      self = normalizePeople([message.self])[0];
      updateRoster(message.participants);
      sync();
      return;
    }
    stopHosting();
    sessionId = message.sessionId;
    pendingSync = null;
    self = normalizePeople([message.self])[0];
    participants = nextParticipants;
    hostId = participants[0].id;
    view = null;
    connected = false;
    acceptedHostId = null;
    timerEndsAt = null;
    customWords = [];
    wordsRev = 0;
    futureInk = [];
    recentInk = [];
    canvas = createCanvas(0);
    const savedLines = load('lines', 60000);
    lines = Array.isArray(savedLines) ? savedLines.filter(isRecord).slice(-SAVED_LINES) : [];
    lineSeq = lines.reduce((max, line) => (Number.isSafeInteger(line.n) ? Math.max(max, line.n) : max), 0);
    onLine(null);
    if (isHost()) {
      const saved = load('table', 200000);
      if (saved?.hostId === self.id && isValidTable(saved.table)) {
        const picture = restoreCanvas(load('canvas', 2000000));
        if (picture?.turn === saved.table.turn) canvas = picture;
        commit(applyRoster(saved.table, ids(), ctx()));
        onInk({ type: 'redraw' });
      } else beginRecovery();
    } else {
      notice = restingNotice();
      emit();
    }
    if (earlyParticipants) {
      const pending = earlyParticipants;
      earlyParticipants = null;
      updateRoster(pending);
    }
    sync(true);
  }

  /** Ask the host for the current state; `full` asks for the picture and word list too. */
  function sync(full = false) {
    if (destroyed || !self || !isMember(self.id)) return;
    if (isHost()) publish();
    else {
      pendingSync = token();
      transmit('sync', { requestId: pendingSync, full, canvas: canvasSummary(canvas), wordsRev }, hostId === null ? undefined : [hostId]);
    }
  }

  function receiveState(from, data) {
    if (isHost() || from !== hostId || !Array.isArray(data.members) ||
        JSON.stringify(data.members) !== JSON.stringify(ids()) || !isValidView(data.view, ids())) return;
    const requested = pendingSync !== null && data.replyTo === pendingSync;
    if (acceptedHostId === hostId && !requested && view && data.view.revision < view.revision) {
      // A fresh request tells a reloaded host apart from delayed old packets.
      sync();
      return;
    }
    adoptView(clone(data.view));
    setTimer(data.view.remainingMs, data.view.duration);
    pendingSync = null;
    acceptedHostId = hostId;
    connected = true;
    notice = restingNotice();
    emit();
  }

  function receiveSync(from, data) {
    if (!hosting() || !validToken(data.requestId)) return;
    publish([from], data.requestId);
    if (data.wordsRev !== wordsRev) transmit('words', { rev: wordsRev, words: customWords }, [from]);
    const theirs = isRecord(data.canvas) ? data.canvas : {};
    const ours = canvasSummary(canvas);
    if (data.full === true && Object.keys(ours).some((key) => theirs[key] !== ours[key])) sendCanvas([from], data.requestId);
  }

  function receive(from, data) {
    if (destroyed || !self || !isMember(self.id) || !isMember(from) || !isRecord(data) ||
        data.protocol !== GAME_PROTOCOL || data.sessionId !== sessionId) return;
    // Drawing goes straight from the artist to everyone, whoever is hosting.
    if (data.kind === 'ink') {
      receiveInk(from, data);
      return;
    }
    if (data.hostId !== hostId) return;
    switch (data.kind) {
      case 'state':
        receiveState(from, data);
        break;
      case 'sync':
        receiveSync(from, data);
        break;
      case 'act':
        if (hosting() && !commit(applyAction(table, from, data.action, ctx()))) publish([from]);
        break;
      case 'say': {
        const text = cleanText(data.text);
        if (text && text === data.text) hear(from, text);
        break;
      }
      case 'lines':
        if (isHost() || from !== hostId || !Array.isArray(data.lines) || data.lines.length > 20) return;
        for (const line of data.lines) if (validLine(line)) addLine(clone(line));
        break;
      case 'words':
        if (isHost() || from !== hostId || !Number.isSafeInteger(data.rev) || data.rev < 0 || !isValidWordList(data.words)) return;
        customWords = [...data.words];
        wordsRev = data.rev;
        emit();
        break;
      case 'canvas':
        receiveCanvas(from, data);
        break;
      case 'recover':
        if (isHost() || from !== hostId || !validToken(data.requestId)) return;
        transmit('report', { requestId: data.requestId, view: view && isValidView(view) ? view : null, word: view?.word ?? null }, [hostId]);
        break;
      case 'report': {
        if (!isHost() || !recovery || data.requestId !== recovery.requestId) return;
        const valid = data.view !== null && isValidView(data.view) && (data.word === null || typeof data.word === 'string');
        recovery.reports.set(from, valid ? { view: clone(data.view), word: data.word } : null);
        maybeFinishRecovery();
        break;
      }
      case 'dump':
        if (isHost() || from !== hostId || !validToken(data.requestId) || data.turn !== canvas.turn) return;
        sendCanvas([hostId], data.requestId);
        break;
      default:
        break;
    }
  }

  function act(action) {
    if (destroyed || !self || !connected || !isMember(self.id) || !isRecord(action)) return;
    if (isHost()) {
      if (hosting() && !commit(applyAction(table, self.id, action, ctx()))) emit();
    } else {
      transmit('act', { action }, [hostId]);
    }
  }

  function say(raw) {
    const text = cleanText(raw);
    if (!text || destroyed || !self || !connected || !isMember(self.id)) return false;
    if (isHost()) hear(self.id, text);
    else transmit('say', { text }, [hostId]);
    return true;
  }

  return {
    init,
    setParticipants: updateRoster,
    receive,
    act,
    say,
    sync,
    get canvas() { return canvas; },
    get lines() { return lines; },
    /** Start a stroke at (x, y); returns its id, or null if this person can't draw now. */
    beginStroke(color, width, x, y) {
      if (!mayDraw() || !isColor(color) || !isBrush(width) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
      const id = nextOpId();
      return addPoints(id, color, width, [x, y]) ? id : null;
    },
    extendStroke(id, points) {
      const op = canvas.byId.get(id);
      if (!mayDraw() || !op || op.kind !== 'stroke' || opAuthor(id) !== self.id || !validPoints(points)) return false;
      return addPoints(id, op.color, op.width, points);
    },
    fill(x, y, color) {
      if (!mayDraw() || !isColor(color) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
      const event = ['f', nextOpId(), canvas.epoch, color, x, y];
      const change = applyEvent(canvas, event);
      if (!change) return false;
      queueEvent(event);
      inkChanged(change);
      return true;
    },
    undo() {
      if (!mayDraw()) return false;
      const op = lastOpBy(canvas, self.id);
      if (!op) return false;
      const event = ['u', op.id];
      applyEvent(canvas, event);
      queueEvent(event);
      inkChanged({ type: 'redraw' });
      emit();
      return true;
    },
    clear() {
      if (!connected || !view || !canClear(view, self.id, hostId) || canvas.turn !== view.turn) return false;
      const event = ['x', canvas.epoch + 1];
      applyEvent(canvas, event);
      for (let i = inkQueue.length - 1; i >= 0; i -= 1) if (inkQueue[i].seg) inkQueue.splice(i, 1);
      queueEvent(event);
      inkChanged({ type: 'redraw' });
      emit();
      return true;
    },
    /** Write anything pending to storage now, as the page goes away. */
    flush: persistNow,
    destroy() {
      persistNow();
      destroyed = true;
      stopHosting();
      outbox.close();
      for (const handle of [inkHandle, lineHandle, persistHandle]) if (handle !== null) timers.clearTimeout(handle);
    },
  };
}
