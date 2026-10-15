import { createBoard } from './board.js';
import { connectActivity } from './bridge.js';
import { createCelebrations } from './celebrations.js';
import { BRUSH_SIZES, PALETTE } from './canvas.js';
import { MIN_PLAYERS } from './rules.js';
import { createSession } from './session.js';
import { ROLL_SECONDS, createGameSound } from './sound.js';
import { MAX_CUSTOM_WORDS, MAX_WORD_LENGTH, isValidWordList, parseWordList } from './words.js';

const $ = (id) => document.getElementById(id);
const embedded = window.parent !== window || new URLSearchParams(location.search).get('embedded') === '1';
const GAME_PHASES = new Set(['choosing', 'drawing', 'reveal']);
const SAY_GAP_MS = 500;
const NUDGE_MS = 3500;
const SAVED_WORDS_KEY = 'scribbleray:custom-words';
const SOUND_KEY = 'scribbleray:sound';
const ENDINGS = {
  all: () => 'Everyone got it!',
  time: () => 'Time’s up!',
  left: (name) => `${name ?? 'The drawer'} left the game.`,
  skip: () => 'The host skipped this turn.',
  host: () => 'The host changed, so this turn ended early.',
};

let live = null;
let bridge = null;
let board = null;
let fullscreen = false;
let handshakeTimer = null;
let retryTimer = null;
let wordsTimer = null;
let lastSay = 0;
let overlayKey = '';
let lastFocusTurn = null;
let clearArmed = null;
let connectionNotice = '';
let wordsRestored = false;
let nudgeTimer = null;
let soundSession = null;
let soundOn = readSoundPreference();
let tool = { kind: 'pen', color: PALETTE[0], size: BRUSH_SIZES[1] };
const avatars = new Map();
const gameSound = createGameSound({ enabled: soundOn });

document.body.classList.toggle('embedded', embedded);
$('solo-note').hidden = embedded;
$('refract-tools').hidden = !embedded;
$('fullscreen').hidden = !embedded;
// The sketchbook on its own makes no sounds, so it needs no switch for them.
$('sound').hidden = !embedded;
$('overlay').style.setProperty('--reveal', `${ROLL_SECONDS}s`);

function readSoundPreference() {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

// ---- small helpers ----

const phase = () => live?.view?.phase ?? 'lobby';
const me = () => live?.self?.id ?? null;
const personOf = (id) => live?.participants.find((person) => person.id === id) ?? null;
const nameOf = (id) => (id === me() ? 'You' : personOf(id)?.name ?? 'Someone');
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const seconds = (ms) => Math.max(0, Math.ceil(ms / 1000));
const clockText = (ms) => {
  const total = seconds(ms);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function element(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function avatarFor(person) {
  const key = `${person.id}:${person.avatarUrl ?? ''}:${person.name}`;
  if (avatars.has(key)) return avatars.get(key);
  const node = element('span', { className: 'avatar', attrs: { 'data-initial': Array.from(person.name.trim())[0]?.toUpperCase() ?? '?', 'aria-hidden': 'true' } });
  try {
    const url = person.avatarUrl && new URL(person.avatarUrl);
    if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
      const image = element('img', { attrs: { src: url.href, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' } });
      image.addEventListener('error', () => image.remove());
      node.append(image);
    }
  } catch { /* A malformed picture address just shows the initial. */ }
  avatars.set(key, node);
  return node;
}

const celebrations = createCelebrations({
  paper: $('paper'), people: $('people'), card: $('overlay-card'), nameOf, rollSeconds: ROLL_SECONDS,
});

// ---- the session ----

const session = createSession({
  send: (data, to, onResult) => bridge?.broadcast(data, to, onResult),
  onChange(next) {
    live = next;
    render();
  },
  onInk(change) {
    board?.apply(change);
    renderCanvasInvitation();
  },
  onLine(line) {
    if (line === null) renderAllLines();
    else {
      appendLine(line);
      heard(line);
    }
  },
});

board = createBoard({
  paper: $('paper'),
  sheet: $('sheet'),
  element: $('canvas'),
  cursor: $('brush-cursor'),
  api: {
    getCanvas: () => session.canvas,
    beginStroke: (...args) => session.beginStroke(...args),
    extendStroke: (...args) => session.extendStroke(...args),
    fill: (...args) => session.fill(...args),
  },
});

// ---- rendering ----

function render() {
  const view = live?.view ?? null;
  const moments = celebrations.observe({ view, connected: !!live?.connected, selfId: me() });
  const current = phase();
  const hosting = !!live?.isHost;
  const drawer = view?.drawer ?? null;
  document.body.dataset.phase = current;

  $('lobby').hidden = current !== 'lobby';
  $('sheet').hidden = current === 'lobby';
  const drawingHere = current === 'board' || (GAME_PHASES.has(current) && drawer === me());
  $('toolbar').hidden = !drawingHere;
  $('toolbar').classList.toggle('disabled', !live?.canDraw);
  $('undo').disabled = !live?.canDraw;
  $('clear').disabled = !live?.canClear;
  $('board-bar').hidden = current !== 'board';
  $('host-tools').hidden = !hosting || !GAME_PHASES.has(current);
  $('skip-turn').hidden = current === 'reveal';
  board.setEnabled(!!live?.canDraw);
  if (!$('sheet').hidden) board.fit();

  renderConnection();
  renderHeadline(view);
  renderPeople(view);
  renderOverlay(view, moments);
  renderLobby(view);
  renderBoardBar(view);
  renderChatMode(view);
  renderNotice();
  tickClock();
  focusGuess(view);
  restoreSavedWords();
  renderCanvasInvitation();
  celebrations.play(moments, { view, selfId: me() });
}

function renderCanvasInvitation() {
  const invitation = document.querySelector('.canvas-invitation');
  if (!invitation) return;
  invitation.hidden = phase() !== 'board' || !live?.canDraw
    || session.canvas.ops.some((op) => !session.canvas.removed.has(op.id));
}

function renderConnection() {
  const connection = $('connection');
  if (!embedded) {
    connection.dataset.state = 'local';
    $('connection-label').textContent = 'Sketching solo';
  } else if (live?.connected) {
    connection.dataset.state = 'connected';
    $('connection-label').textContent = live.isHost ? 'Hosting' : 'Connected';
  } else {
    connection.dataset.state = 'waiting';
    $('connection-label').textContent = live?.recovering ? 'Taking over' : live ? 'Syncing' : 'Connecting';
  }
  // Narrow frames show only the dot.
  connection.title = $('connection-label').textContent;
}

function letterCounts(hint) {
  const counts = [];
  let count = 0;
  for (const char of hint) {
    if (char === ' ') {
      if (count) counts.push(count);
      count = 0;
    } else if (char === null || /[\p{L}\p{N}]/u.test(char)) count += 1;
  }
  if (count) counts.push(count);
  return counts;
}

function renderHeadline(view) {
  const current = phase();
  const word = $('word');
  const label = $('word-label');
  let round = 'Lobby';
  if (current === 'board') round = 'Whiteboard';
  else if (current === 'results') round = 'Game over';
  else if (view && GAME_PHASES.has(current)) {
    round = view.settings.endMode === 'score'
      ? `Round ${view.round} · first to ${view.settings.targetScore.toLocaleString()}`
      : `Round ${view.round} of ${view.settings.rounds}`;
  }
  $('round-label').textContent = round;
  word.replaceChildren();
  word.classList.remove('known');
  word.removeAttribute('aria-label');
  label.textContent = '';
  word.parentElement.classList.toggle('label-first', current === 'reveal');
  if (!view) return;
  if (current === 'drawing') {
    if (view.word) {
      word.classList.add('known');
      word.textContent = view.word;
      label.textContent = view.drawer === me() ? 'Draw this!' : 'You got it!';
    } else {
      for (const char of view.hint) {
        if (char === null) word.append(element('span', { className: 'slot' }));
        else if (char === ' ') word.append(element('span', { className: 'gap' }));
        else if (/[\p{L}\p{N}]/u.test(char)) word.append(element('span', { className: 'slot shown', text: char }));
        else word.append(element('span', { className: 'mark', text: char }));
      }
      word.setAttribute('aria-label', `Hint: ${view.hint.map((char) => char ?? 'blank').join(' ')}`);
      label.textContent = `${letterCounts(view.hint).join(' + ')} letters`;
    }
  } else if (current === 'choosing') {
    label.textContent = view.drawer === me() ? 'Your turn to draw' : `${nameOf(view.drawer)} is choosing…`;
  } else if (current === 'reveal' && view.result?.word) {
    label.textContent = 'The word was';
    word.classList.add('known');
    word.textContent = view.result.word;
  }
}

function standings(view) {
  const people = live?.participants ?? [];
  const scores = new Map((view?.players ?? []).map((player) => [player.id, player.score]));
  const scored = GAME_PHASES.has(phase()) || phase() === 'results';
  const list = people.map((person, order) => ({ person, order, score: scores.get(person.id) ?? 0 }));
  if (scored) list.sort((a, b) => b.score - a.score || a.order - b.order);
  let rank = 0;
  let previous = null;
  for (const [index, entry] of list.entries()) {
    if (entry.score !== previous) rank = index + 1;
    previous = entry.score;
    entry.rank = rank;
  }
  return { list, scored };
}

function renderPeople(view) {
  const { list, scored } = standings(view);
  const current = phase();
  const guessed = new Set((view?.guessed ?? []).map((entry) => entry.id));
  const pensVisible = current === 'board' && view?.settings.boardAccess === 'host';
  const items = list.map(({ person, score, rank }) => {
    const host = person.id === live?.hostId;
    const drawing = (current === 'choosing' || current === 'drawing') && view?.drawer === person.id;
    const item = element('li', { className: 'person' });
    item.dataset.person = String(person.id);
    item.classList.toggle('me', person.id === me());
    item.classList.toggle('drawing', drawing);
    item.classList.toggle('guessed', current === 'drawing' && guessed.has(person.id));
    item.append(element('span', { className: 'rank', text: scored ? `#${rank}` : '' }));
    item.append(avatarFor(person));
    const detail = scored ? `${score.toLocaleString()} pts${host ? ' · host' : ''}` : host ? 'Host' : current === 'board' ? 'Sketching' : 'Ready';
    item.append(element('span', { className: 'who' }, [
      element('strong', { text: person.id === me() && embedded ? `${person.name} (you)` : person.name }),
      element('small', { text: detail }),
    ]));
    if (drawing) item.append(element('span', { className: 'badge', text: '✎', attrs: { title: 'Drawing', 'aria-label': 'Drawing' } }));
    else if (current === 'drawing' && guessed.has(person.id)) item.append(element('span', { className: 'badge', text: '✓', attrs: { title: 'Guessed it', 'aria-label': 'Guessed it' } }));
    if (pensVisible) item.append(penToggle(person, view));
    return item;
  });
  $('people').replaceChildren(...items);
  $('people-count').textContent = String(list.length);
}

function penToggle(person, view) {
  const host = person.id === live?.hostId;
  const holding = host || view.pens.includes(person.id);
  const button = element('button', {
    className: 'pen-toggle',
    attrs: {
      type: 'button',
      'aria-pressed': String(holding),
      'aria-label': host ? `${person.name} hosts and can always draw` : `${holding ? 'Take the pen from' : 'Hand a pen to'} ${person.name}`,
      title: host ? 'The host can always draw' : holding ? 'Can draw — click to take the pen back' : 'Click to let them draw',
    },
  });
  button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17l1-4L14 3l3 3L7 16l-4 1ZM12 5l3 3"/></svg>';
  button.disabled = host || !live?.isHost;
  button.addEventListener('click', () => session.act({ type: 'pen', id: person.id, on: !holding }));
  return button;
}

function tally(entries, view, { drawer = null } = {}) {
  const sorted = [...entries].sort((a, b) => b.points - a.points);
  return element('ol', { className: 'tally' }, sorted.map((entry, index) => {
    const label = `${nameOf(entry.id)}${entry.id === drawer ? ' (drew)' : ''}`;
    const item = element('li', {}, [element('span', { text: label }), element('b', { text: `${entry.prefix ?? '+'}${entry.points.toLocaleString()}` })]);
    item.style.setProperty('--place', index);
    item.classList.toggle('zero', entry.points === 0);
    item.classList.toggle('first', index === 0 && entry.points > 0 && view.phase === 'results');
    return item;
  }));
}

function countdown(prefix) {
  return element('p', {}, [document.createTextNode(prefix), element('span', { attrs: { 'data-countdown': '' } })]);
}

function renderOverlay(view, moments) {
  const current = phase();
  const key = JSON.stringify([current, view?.turn, view?.revision, me(), live?.isHost, live?.participants.length]);
  if (key === overlayKey) return;
  overlayKey = key;
  const overlay = $('overlay');
  const card = $('overlay-card');
  const parts = [];
  let celebrating = false;
  if (view && current === 'choosing') {
    if (view.drawer === me()) {
      parts.push(element('p', { className: 'overlay-kicker', text: 'The pen is yours' }), element('h2', { text: 'What’s your masterpiece?' }));
      const choices = element('div', { className: 'choices' });
      view.choices.forEach((word, index) => {
        const button = element('button', { className: 'button primary', attrs: { type: 'button' } }, [
          element('span', { className: 'choice-number', attrs: { 'data-choice': String(index + 1), 'aria-hidden': 'true' } }),
          document.createTextNode(word),
        ]);
        button.addEventListener('click', () => session.act({ type: 'choose', index }));
        choices.append(button);
      });
      parts.push(choices, countdown('One gets picked for you in '));
    } else {
      parts.push(element('p', { className: 'overlay-kicker', text: 'A masterpiece is brewing' }),
        element('h2', { text: `${nameOf(view.drawer)} is picking a word` }), element('p', { text: 'Sharp eyes. Fast fingers. You’ve got this.' }));
    }
  } else if (view && current === 'reveal' && view.result) {
    const { result } = view;
    if (result.word) parts.push(element('p', { className: 'overlay-kicker', text: result.reason === 'all' ? 'A work of art. Everyone got it.' : 'The big reveal' }), element('div', { className: 'big-word', text: result.word }));
    else parts.push(element('h2', { text: 'Turn over' }));
    parts.push(element('p', { text: ENDINGS[result.reason](result.drawer ? nameOf(result.drawer) : null) }));
    if (result.points.length) parts.push(tally(result.points, view, { drawer: result.drawer }));
    parts.push(countdown('Next up in '));
  } else if (view && current === 'results') {
    const winners = view.winners.filter((id) => view.players.some((player) => player.id === id));
    const players = view.players.map((player) => ({ id: player.id, points: player.score, prefix: '' }));
    celebrating = winners.length > 0;
    if (celebrating) parts.push(element('p', { className: 'drumroll', text: winners.length === 1 ? 'And the winner is…' : 'And the winners are…' }));
    const trophy = element('div', { className: 'trophy', attrs: { 'aria-hidden': 'true' } });
    trophy.innerHTML = '<svg viewBox="0 0 100 112" fill="none"><path d="m32 62-9 45 25-13 23 13-5-45" fill="#f45237" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path class="rosette-rays" d="m50 3 9 9 13-3 4 13 13 4-3 13 10 10-10 9 3 13-13 4-4 13-13-3-9 10-10-10-13 3-4-13-13-4 3-13-10-9 10-10-3-13 13-4 4-13 13 3Z" fill="#f6cb49" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><circle cx="49" cy="48" r="25" fill="#fff7dc" stroke="currentColor" stroke-width="2"/><path d="m49 30 5 11 12 2-9 8 2 12-10-6-10 6 2-12-9-8 12-2Z" fill="#f45237" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    parts.push(trophy);
    if (!winners.length) parts.push(element('h2', { text: 'Game over' }));
    else if (winners.length === 1) parts.push(element('h2', { text: winners[0] === me() ? 'You win!' : `${nameOf(winners[0])} wins!` }));
    else parts.push(element('h2', { text: `It’s a tie between ${winners.map(nameOf).join(' and ')}!` }));
    if (winners.length) parts.push(element('p', { className: 'result-note', text: 'Certified scribble royalty.' }));
    parts.push(tally(players, view));
    if (live?.isHost) {
      const again = element('button', { className: 'button primary', text: 'Play again', attrs: { type: 'button' } });
      again.addEventListener('click', () => session.act({ type: 'start' }));
      const back = element('button', { className: 'button', text: 'Back to lobby', attrs: { type: 'button' } });
      back.addEventListener('click', () => session.act({ type: 'lobby' }));
      parts.push(element('div', { className: 'overlay-actions' }, [again, back]));
    } else {
      parts.push(element('p', { text: `Waiting for ${nameOf(live?.hostId)} to play again…` }));
    }
  }
  // Only a live transition earns the fanfare; restored results appear immediately.
  card.replaceChildren(...parts);
  card.classList.toggle('celebrate', celebrating && !!moments?.finale && !document.hidden);
  overlay.dataset.kind = current;
  overlay.hidden = parts.length === 0;
}

function renderLobby(view) {
  const hosting = !!live?.isHost;
  const ready = !!live?.connected;
  const settings = view?.settings;
  for (const select of $('settings').querySelectorAll('select')) {
    if (settings && document.activeElement !== select) select.value = String(settings[select.name]);
    select.disabled = !hosting || !ready;
  }
  $('rounds-setting').hidden = settings?.endMode === 'score';
  $('score-setting').hidden = settings?.endMode !== 'score';
  const hostName = live?.hostId ? personOf(live.hostId)?.name ?? 'The host' : 'The host';
  $('settings-owner').textContent = hosting ? 'YOU’RE THE HOST' : `${hostName}’s call`;
  if (embedded && live) {
    $('lobby-lead').textContent = hosting
      ? 'Get your people together. Pick the rules. Make a beautiful mess.'
      : `${hostName} is setting things up. Bring your best bad drawings.`;
  }

  const words = live?.customWords ?? [];
  const list = $('word-list');
  $('custom-words').hidden = !hosting && !words.length;
  list.hidden = !hosting;
  list.disabled = !ready;
  $('word-count').textContent = plural(words.length, 'word').toUpperCase();
  if (hosting && document.activeElement !== list && JSON.stringify(parseWordList(list.value).words) !== JSON.stringify(words)) {
    list.value = words.join('\n');
  }
  if (!hosting) {
    $('word-help').textContent = words.length ? `${hostName} added ${plural(words.length, 'custom word')}. No peeking.` : '';
  } else if (document.activeElement !== list) {
    $('word-help').textContent = `Up to ${MAX_CUSTOM_WORDS} words, each up to ${MAX_WORD_LENGTH} characters.`;
  }

  const players = live?.participants.length ?? 0;
  const needsWords = settings?.wordSource === 'custom' && !words.length;
  $('start-game').disabled = !hosting || !ready || players < MIN_PLAYERS || needsWords;
  $('open-board').disabled = !hosting || !ready;
  let note = '';
  if (!ready) note = embedded ? 'Connecting to your call…' : '';
  else if (!hosting) note = `Waiting for ${hostName} to start.`;
  else if (players < MIN_PLAYERS) note = embedded ? 'A game needs at least two players. Invite someone from the call, or open the whiteboard.' : 'A game needs at least two players. Open ScribbleRay from a Refract call to play together.';
  else if (needsWords) note = 'Add some custom words first, or switch the word list.';
  else if (view?.stopped === 'players') note = 'The last game stopped when too few players were left.';
  $('start-note').textContent = note;
}

function renderBoardBar(view) {
  if (phase() !== 'board' || !view) return;
  const access = $('board-access');
  if (document.activeElement !== access) access.value = view.settings.boardAccess;
  access.disabled = !live?.isHost;
  $('board-lobby').hidden = !live?.isHost;
  let hint;
  if (view.settings.boardAccess === 'everyone') hint = live?.isHost ? 'Everyone can draw. Only you can clear the sheet.' : 'Everyone can draw. Only the host can clear the sheet.';
  else if (live?.isHost) hint = 'Click the pen beside someone to let them draw.';
  else hint = live?.canDraw ? 'The host handed you a pen.' : 'The host is presenting. Ask for a pen to join in.';
  $('board-hint').textContent = hint;
}

function renderChatMode(view) {
  const current = phase();
  const form = $('chat-form');
  const input = $('chat-input');
  let mode = 'CHAT';
  let placeholder = 'Say something…';
  const guessing = current === 'drawing' && view && view.drawer !== me() && !view.word;
  if (current === 'lobby') mode = 'LOBBY';
  else if (current === 'board') mode = 'WHITEBOARD';
  else if (guessing) {
    mode = 'GUESSING';
    placeholder = 'Type your guess…';
  } else if (current === 'drawing') {
    mode = 'QUIET';
    placeholder = view.drawer === me() ? 'Only those who guessed will see this…' : 'Only fellow guessers will see this…';
  }
  form.classList.toggle('guessing', !!guessing);
  if (!guessing) hideNudge();
  $('chat-mode').textContent = mode;
  input.placeholder = placeholder;
  input.disabled = !live?.connected;
  $('chat-send').disabled = !live?.connected;
}

function renderNotice() {
  const text = connectionNotice || live?.notice || (live?.canDraw && live?.canvasFull ? 'This sheet is full. Clear it to keep drawing.' : '');
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

/** A guesser's keyboard should be ready to guess as soon as a turn starts. */
function focusGuess(view) {
  if (phase() !== 'drawing' || !view || view.drawer === me() || view.turn === lastFocusTurn) return;
  lastFocusTurn = view.turn;
  const active = document.activeElement;
  if (matchMedia('(pointer: fine)').matches && (!active || active === document.body || active.closest('.overlay'))) $('chat-input').focus();
}

// ---- the clock ----

function tickClock() {
  const current = phase();
  const ends = live?.timerEndsAt ?? null;
  const remaining = ends === null ? 0 : Math.max(0, ends - Date.now());
  const timed = ends !== null && GAME_PHASES.has(current);
  $('timer').hidden = !(timed && current !== 'reveal');
  $('timer-text').textContent = clockText(remaining);
  const urgent = current === 'drawing' && remaining <= 10000;
  $('timer').classList.toggle('urgent', urgent);
  const bar = $('timer-bar');
  bar.classList.toggle('urgent', urgent);
  const fraction = timed && live?.timerDuration ? Math.min(1, remaining / live.timerDuration) : 0;
  bar.style.transform = `scaleX(${fraction})`;
  for (const node of document.querySelectorAll('[data-countdown]')) node.textContent = `${seconds(remaining)} s`;
  // Every change and every beat of the clock: the closing ticks are booked a moment ahead.
  if (embedded) gameSound.update({ view: live?.view ?? null, selfId: me(), timerEndsAt: live?.timerEndsAt ?? null });
}

// ---- chat ----

function lineNode(line) {
  const item = element('li');
  const who = () => element('b', { text: nameOf(line.from) });
  switch (line.kind) {
    case 'chat':
      item.append(who(), document.createTextNode(`: ${line.text}`));
      break;
    case 'secret':
      item.className = 'secret';
      item.title = 'Only the drawer and those who guessed see this';
      item.append(who(), document.createTextNode(`: ${line.text}`));
      break;
    case 'close':
      item.className = 'close';
      item.textContent = `“${line.text}” is close!`;
      break;
    case 'correct':
      item.className = 'correct';
      item.textContent = `${line.from === me() ? 'You' : nameOf(line.from)} guessed the word!${line.points ? ` +${line.points}` : ''}`;
      break;
    case 'turn':
      item.className = 'event turn';
      item.textContent = line.from === me() ? 'Your turn to draw!' : `${nameOf(line.from)} is drawing now.`;
      break;
    case 'reveal':
      item.className = 'event reveal';
      if (line.word) item.append(document.createTextNode('The word was '), element('em', { text: line.word }), document.createTextNode('.'));
      else item.textContent = 'The turn ended.';
      break;
    case 'board':
      item.className = 'event';
      item.textContent = 'The whiteboard is open. Draw away!';
      break;
    case 'results': {
      item.className = 'event turn';
      const names = (line.winners ?? []).map(nameOf);
      item.textContent = names.length ? `${names.join(' and ')} won the game!` : 'Game over.';
      break;
    }
    case 'join':
      item.className = 'event';
      item.textContent = `${line.name ?? nameOf(line.from)} joined.`;
      break;
    case 'leave':
      item.className = 'event';
      item.textContent = `${line.name ?? 'Someone'} left.`;
      break;
    case 'host':
      item.className = 'event';
      item.textContent = line.from === me() ? 'You’re the host now.' : `${line.name ?? nameOf(line.from)} is now the host.`;
      break;
    default:
      return null;
  }
  return item;
}

function appendLine(line) {
  const log = $('chat-log');
  const node = lineNode(line);
  if (!node) return;
  if (!document.hidden) node.classList.add('fresh-line');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(node);
  while (log.children.length > 150) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderAllLines() {
  const log = $('chat-log');
  log.replaceChildren(...session.lines.map(lineNode).filter(Boolean));
  log.scrollTop = log.scrollHeight;
}

/** A line that just arrived: it may call for a sound, and a near miss for a nudge. */
function heard(line) {
  if (embedded) gameSound.heard(line, me());
  if (line.kind === 'close') showNudge(line.text);
}

// Only the person who guessed ever receives a 'close' line, so the nudge is theirs alone.
function showNudge(text) {
  const nudge = $('nudge');
  const form = $('chat-form');
  nudge.replaceChildren(element('strong', { text: 'So close!' }), document.createTextNode(` “${text}” is nearly it.`));
  // Start the entrance again, even when one near miss follows another.
  nudge.hidden = true;
  form.classList.remove('near');
  void nudge.offsetWidth;
  nudge.hidden = false;
  form.classList.add('near');
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(hideNudge, NUDGE_MS);
}

function hideNudge() {
  clearTimeout(nudgeTimer);
  nudgeTimer = null;
  $('nudge').hidden = true;
  $('chat-form').classList.remove('near');
}

// Messages leave at most every SAY_GAP_MS, the pace the host accepts, so quick guesses queue rather than vanish.
const sayQueue = [];
function drainSays() {
  const wait = lastSay + SAY_GAP_MS - Date.now();
  if (wait > 0) {
    setTimeout(drainSays, wait);
    return;
  }
  const text = sayQueue.shift();
  if (text === undefined) return;
  if (session.say(text)) lastSay = Date.now();
  if (sayQueue.length) setTimeout(drainSays, SAY_GAP_MS);
}

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('chat-input');
  if (!input.value.trim() || !live?.connected || sayQueue.length >= 5) return;
  sayQueue.push(input.value);
  input.value = '';
  if (sayQueue.length === 1) drainSays();
});

// ---- tools ----

function selectTool(changes) {
  tool = { ...tool, ...changes };
  board.setTool({ kind: tool.kind, color: tool.color, size: tool.kind === 'eraser' ? Math.max(tool.size, BRUSH_SIZES[2]) : tool.size });
  for (const swatch of $('swatches').children) swatch.setAttribute('aria-checked', String(swatch.dataset.color === tool.color));
  for (const size of $('sizes').children) size.setAttribute('aria-checked', String(Number(size.dataset.size) === tool.size));
  for (const button of document.querySelectorAll('[data-tool]')) button.setAttribute('aria-checked', String(button.dataset.tool === tool.kind));
  for (const group of $('toolbar').querySelectorAll('[role="radiogroup"]')) {
    for (const button of group.querySelectorAll('[role="radio"]')) button.tabIndex = button.getAttribute('aria-checked') === 'true' ? 0 : -1;
  }
}

for (const color of PALETTE) {
  const swatch = element('button', { className: 'swatch', attrs: { type: 'button', role: 'radio', 'aria-label': `Colour ${color}`, 'data-color': color, title: color } });
  swatch.style.background = color;
  swatch.addEventListener('click', () => selectTool({ color, kind: tool.kind === 'fill' ? 'fill' : 'pen' }));
  $('swatches').append(swatch);
}
for (const size of BRUSH_SIZES) {
  const button = element('button', { className: 'size', attrs: { type: 'button', role: 'radio', 'aria-label': `Brush size ${size}`, 'data-size': String(size) } });
  const dot = element('span');
  dot.style.width = dot.style.height = `${Math.round(3 + Math.sqrt(size) * 3)}px`;
  button.append(dot);
  button.addEventListener('click', () => selectTool({ size, kind: tool.kind === 'fill' ? 'pen' : tool.kind }));
  $('sizes').append(button);
}
for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => selectTool({ kind: button.dataset.tool }));
selectTool({});

// Each tool group is one Tab stop; arrows select within the group.
for (const group of $('toolbar').querySelectorAll('[role="radiogroup"]')) {
  group.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!direction && !['Home', 'End'].includes(event.key)) return;
    const buttons = [...group.querySelectorAll('[role="radio"]')].filter((button) => !button.disabled);
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  });
}

$('undo').addEventListener('click', () => session.undo());
// Sandboxed frames can't show confirm(); a second click within a moment confirms instead.
$('clear').addEventListener('click', () => {
  const button = $('clear');
  const disarm = () => {
    clearTimeout(clearArmed);
    clearArmed = null;
    button.classList.remove('armed');
    button.title = 'Clear the sheet';
    button.setAttribute('aria-label', 'Clear the sheet');
  };
  if (clearArmed) {
    disarm();
    session.clear();
    return;
  }
  button.classList.add('armed');
  button.title = 'Click again to clear everything';
  button.setAttribute('aria-label', 'Click again to clear everything');
  clearArmed = setTimeout(disarm, 2500);
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (!live?.canDraw) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    session.undo();
  } else if (event.ctrlKey || event.metaKey || event.altKey) {
    // Leave other shortcuts alone.
  } else if (key === 'b') selectTool({ kind: 'pen' });
  else if (key === 'e') selectTool({ kind: 'eraser' });
  else if (key === 'f') selectTool({ kind: 'fill' });
  else if (key === '[' || key === ']') {
    const index = Math.max(0, BRUSH_SIZES.indexOf(tool.size) + (key === ']' ? 1 : -1));
    selectTool({ size: BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, index)] });
  }
});

// ---- host controls ----

for (const form of [$('settings'), $('board-bar')]) {
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.name) return;
    const value = /^\d+$/.test(select.value) ? Number(select.value) : select.value;
    session.act({ type: 'settings', settings: { [select.name]: value } });
  });
}

function saveWords() {
  clearTimeout(wordsTimer);
  wordsTimer = null;
  const { words, skipped, truncated } = parseWordList($('word-list').value);
  const notes = [];
  if (skipped) notes.push(`${skipped} ${skipped === 1 ? 'entry' : 'entries'} skipped (too long, no letters, or repeated)`);
  if (truncated) notes.push(`${truncated} over the limit left out`);
  $('word-help').textContent = notes.length ? `${notes.join('; ')}.` : `${plural(words.length, 'word')} ready.`;
  if (JSON.stringify(words) === JSON.stringify(live?.customWords ?? [])) return;
  session.act({ type: 'words', words });
  try { localStorage.setItem(SAVED_WORDS_KEY, JSON.stringify(words)); } catch { /* Remembering the list is a convenience. */ }
}

/** A host's last custom list comes back in their next game, on this device. */
function restoreSavedWords() {
  if (wordsRestored || !live?.isHost || !live.connected || phase() !== 'lobby') return;
  wordsRestored = true;
  if (live.customWords.length) return;
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_WORDS_KEY) ?? '[]');
    if (Array.isArray(saved) && saved.length && isValidWordList(saved)) session.act({ type: 'words', words: saved });
  } catch { /* Nothing usable was saved. */ }
}
$('word-list').addEventListener('input', () => {
  clearTimeout(wordsTimer);
  wordsTimer = setTimeout(saveWords, 700);
});
$('word-list').addEventListener('blur', saveWords);

$('start-game').addEventListener('click', () => {
  if (wordsTimer) saveWords();
  session.act({ type: 'start' });
});
$('open-board').addEventListener('click', () => session.act({ type: 'board' }));
$('board-lobby').addEventListener('click', () => session.act({ type: 'lobby' }));
$('skip-turn').addEventListener('click', () => session.act({ type: 'skip' }));
$('end-game').addEventListener('click', () => session.act({ type: 'lobby' }));
$('resync').addEventListener('click', () => {
  bridge?.ready();
  session.sync(true);
});
$('leave').addEventListener('click', () => bridge?.close());
$('fullscreen').addEventListener('click', () => bridge?.setFullscreen(!fullscreen));

function renderSound() {
  $('sound').setAttribute('aria-pressed', String(soundOn));
  $('sound').title = soundOn ? 'Sound effects on' : 'Sound effects off';
}
$('sound').addEventListener('click', () => {
  soundOn = !soundOn;
  gameSound.setEnabled(soundOn);
  try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* Remembering it is a convenience. */ }
  renderSound();
  // A soft ding says sound is back, and that this browser can play it.
  if (soundOn) gameSound.play('guessed');
});
renderSound();

// ---- connecting ----

if (embedded) {
  bridge = connectActivity({
    onInit(message) {
      clearTimeout(handshakeTimer);
      connectionNotice = '';
      document.documentElement.dataset.theme = message.theme;
      // A different session's game is news to nobody here: start its sounds from silence.
      const key = JSON.stringify([message.sessionId, message.self?.id]);
      if (key !== soundSession) {
        gameSound.reset();
        celebrations.reset();
        soundSession = key;
      }
      session.init(message);
    },
    onParticipants: (people) => session.setParticipants(people),
    onMessage: (from, data) => session.receive(from, data),
    onFullscreen(on) {
      fullscreen = on;
      $('fullscreen').setAttribute('aria-pressed', String(on));
    },
  });
  handshakeTimer = setTimeout(() => {
    if (!live) {
      connectionNotice = 'No Refract connection yet. Open ScribbleRay from a call, or use Resync to try again.';
      render();
    }
  }, 8000);
  // Refract lets activities play sound, but a browser may still wait for a touch inside the frame.
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => gameSound.unlock(), { capture: true, passive: true });
  // Refract keeps no history: a periodic sync recovers anything missed.
  retryTimer = setInterval(() => {
    if (!live?.view) bridge.ready();
    else session.sync();
  }, 5000);
} else {
  // On its own, the page is a one-person sketchbook that survives a reload.
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const you = { id: 1, name: 'You', avatarUrl: null };
  session.init({ sessionId: 'local-sketchbook', self: you, participants: [you] });
}

setInterval(tickClock, 200);
window.addEventListener('pagehide', () => {
  clearTimeout(handshakeTimer);
  clearInterval(retryTimer);
  session.destroy();
  gameSound.destroy();
  celebrations.destroy();
  bridge?.destroy();
  board.destroy();
});
// A back/forward-cache restore needs fresh listeners and a fresh handshake.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
render();
