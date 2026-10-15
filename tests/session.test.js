import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CANVAS_POINTS } from '../src/canvas.js';
import { REVEAL_MS } from '../src/rules.js';
import { GAME_PROTOCOL, cleanText } from '../src/session.js';
import { network } from './helpers.js';

const opsOf = (net, id) => net.session(id).canvas.ops.map((op) => JSON.stringify(op)).sort();
const phaseOf = (net, id) => net.view(id).view?.phase;
const scoreOf = (net, viewer, id) => net.view(viewer).view.players.find((player) => player.id === id)?.score;

/** Received by `id` from someone else, whether addressed to them or to everyone. */
const deliveredTo = (net, id, since = 0) => net.sent.slice(since).filter((message) => message.from !== id && (!message.to || message.to.includes(id)));

function settings(net, changes) {
  net.session(1).act({ type: 'settings', settings: changes });
  net.run(50);
}

/** Start a game and have the drawer pick their first choice; returns the word. */
function startTurn(net) {
  net.session(1).act({ type: 'start' });
  net.run(50);
  const drawer = net.view(1).view.drawer;
  if (net.view(drawer).view.phase === 'choosing') {
    net.session(drawer).act({ type: 'choose', index: 0 });
    net.run(50);
  }
  assert.equal(phaseOf(net, 1), 'drawing');
  return { drawer, word: net.view(drawer).view.word };
}

/** Draw like a person: a point every 16 ms, a few strokes. */
function scribble(net, id, { strokes = 3, points = 40, x = 100, y = 100, color = '#000000' } = {}) {
  for (let s = 0; s < strokes; s += 1) {
    const stroke = net.session(id).beginStroke(color, 9, x + s * 30, y);
    if (!stroke) return false;
    for (let p = 1; p < points; p += 1) {
      net.session(id).extendStroke(stroke, [x + s * 30 + p * 3, y + Math.round(20 * Math.sin(p / 4))]);
      net.run(16);
    }
  }
  net.run(300);
  return true;
}

test('participants connect, and only the host changes the settings', () => {
  const net = network([1, 2, 3]);
  for (const id of [1, 2, 3]) {
    assert.equal(net.view(id).connected, true);
    assert.equal(net.view(id).hostId, 1);
    assert.equal(phaseOf(net, id), 'lobby');
  }
  net.session(2).act({ type: 'settings', settings: { rounds: 8 } });
  net.run(50);
  assert.equal(net.view(3).view.settings.rounds, 3);
  settings(net, { rounds: 8, drawTime: 120 });
  assert.equal(net.view(3).view.settings.rounds, 8);
  assert.equal(net.view(2).view.settings.drawTime, 120);
  assert.equal(net.sent.every((message) => message.data.protocol === GAME_PROTOCOL), true);
});

test('custom words reach everyone, including late arrivals', () => {
  const net = network([1, 2]);
  net.session(1).act({ type: 'words', words: ['giant robot', 'haunted house'] });
  net.run(50);
  assert.deepEqual(net.view(2).customWords, ['giant robot', 'haunted house']);
  assert.equal(net.view(2).view.wordCount, 2);
  net.join(3);
  assert.deepEqual(net.view(3).customWords, ['giant robot', 'haunted house']);
});

test('the word never reaches a guesser before they guess it, and correct guesses are never shown', () => {
  const net = network([1, 2, 3]);
  const since = net.sent.length;
  const { drawer, word } = startTurn(net);
  assert.equal(drawer, 1);
  const quoted = JSON.stringify(word);
  const leaks = (id) => deliveredTo(net, id, since).filter((message) => JSON.stringify(message.data).includes(quoted));
  assert.equal(net.view(2).view.word, null);
  assert.deepEqual(leaks(2), []);

  net.session(2).say('a cat?');
  net.run(200);
  assert.ok(net.clients.get(3).lines.some((line) => line.kind === 'chat' && line.text === 'a cat?' && line.from === 2));
  assert.ok(net.clients.get(1).lines.some((line) => line.kind === 'chat' && line.text === 'a cat?'), 'the host sees chat too');

  net.session(2).say(word.toUpperCase());
  net.run(200);
  assert.equal(net.view(2).view.word, word, 'a correct guesser learns the word');
  assert.ok(scoreOf(net, 3, 2) > 0);
  for (const id of [1, 3]) assert.ok(net.clients.get(id).lines.some((line) => line.kind === 'correct' && line.from === 2 && line.points > 0));
  assert.ok(!net.clients.get(3).lines.some((line) => line.text?.toLowerCase() === word.toLowerCase()), 'the guess itself is never shown');
  assert.deepEqual(leaks(3), [], 'player 3 still has not seen the word');

  net.session(2).say('that was easy');
  net.run(200);
  assert.ok(net.clients.get(1).lines.some((line) => line.kind === 'secret' && line.text === 'that was easy'), 'the drawer reads guessers’ chat');
  assert.ok(!net.clients.get(3).lines.some((line) => line.text === 'that was easy'), 'those still guessing do not');

  net.session(3).say(word);
  net.run(200);
  assert.equal(phaseOf(net, 3), 'reveal');
  assert.equal(net.view(3).view.result.word, word);
  assert.ok(net.clients.get(3).lines.some((line) => line.kind === 'reveal' && line.word === word));
  assert.deepEqual(net.refused, []);
});

test('a near miss gets a private nudge', () => {
  const net = network([1, 2, 3]);
  const { word } = startTurn(net);
  const near = word.length >= 4 ? `${word.slice(0, -1)}${word.at(-1) === 'z' ? 'y' : 'z'}` : null;
  if (!near) return;
  net.session(2).say(near);
  net.run(200);
  assert.ok(net.clients.get(2).lines.some((line) => line.kind === 'close' && line.text === near));
  assert.ok(!net.clients.get(3).lines.some((line) => line.kind === 'close'));
});

test('drawing streams to everyone in batches and every copy ends up identical', () => {
  const net = network([1, 2, 3]);
  const since = net.sent.length;
  startTurn(net);
  assert.equal(net.view(1).canDraw, true);
  assert.equal(net.view(2).canDraw, false);
  assert.equal(net.session(2).beginStroke('#000000', 9, 10, 10), null, 'guessers cannot draw');
  assert.ok(scribble(net, 1, { strokes: 4, points: 60 }));
  net.session(1).fill(500, 500, '#ef130b');
  net.run(200);
  assert.equal(net.session(1).canvas.ops.length, 5);
  assert.deepEqual(opsOf(net, 2), opsOf(net, 1));
  assert.deepEqual(opsOf(net, 3), opsOf(net, 1));
  const inks = net.sent.slice(since).filter((message) => message.data.kind === 'ink');
  assert.ok(inks.length < 4 * 60 / 2, `points are batched (${inks.length} messages)`);
  assert.ok(net.clients.get(2).inks > 0, 'guessers draw incrementally');

  net.session(1).undo();
  net.run(200);
  assert.equal(net.session(3).canvas.ops.length, 4);
  net.session(1).clear();
  net.run(200);
  assert.equal(net.session(2).canvas.ops.length, 0);
  assert.equal(net.session(2).clear(), false, 'only the drawer clears');
  assert.deepEqual(net.refused, []);
});

test('a latecomer receives the whole picture, even one needing many messages', () => {
  const net = network([1, 2]);
  net.session(1).act({ type: 'board' });
  net.run(50);
  for (let i = 0; i < 12; i += 1) scribble(net, i % 2 ? 2 : 1, { strokes: 4, points: 120, x: 20 + i * 10, y: 30 + i * 40 });
  assert.ok(net.session(1).canvas.points > 5000);
  const since = net.sent.length;
  net.join(3);
  net.run(3000);
  const parts = net.sent.slice(since).filter((message) => message.data.kind === 'canvas');
  assert.ok(parts.length > 1, `the picture took ${parts.length} messages`);
  assert.deepEqual(opsOf(net, 3), opsOf(net, 1));
  assert.deepEqual(opsOf(net, 2), opsOf(net, 1));
  assert.deepEqual(net.refused, []);
});

test('drawing in flight while a latecomer catches up still lands', () => {
  const net = network([1, 2]);
  net.session(1).act({ type: 'board' });
  net.run(50);
  scribble(net, 2, { strokes: 6, points: 100 });
  net.join(3);
  scribble(net, 2, { strokes: 2, points: 30, y: 400 });
  net.run(3000);
  assert.deepEqual(opsOf(net, 3), opsOf(net, 2));
});

test('whiteboard: everyone draws at once and copies converge; the host can limit pens', () => {
  const net = network([1, 2, 3]);
  net.session(1).act({ type: 'board' });
  net.run(50);
  const strokes = [1, 2, 3].map((id) => net.session(id).beginStroke('#00b2ff', 18, 100 * id, 100));
  for (let p = 1; p < 50; p += 1) {
    [1, 2, 3].forEach((id, i) => net.session(id).extendStroke(strokes[i], [100 * id + p, 100 + p * 2]));
    net.run(16);
  }
  net.run(300);
  assert.equal(net.session(1).canvas.ops.length, 3);
  assert.deepEqual(opsOf(net, 2), opsOf(net, 1));
  assert.deepEqual(opsOf(net, 3), opsOf(net, 1));
  assert.equal(net.session(2).clear(), false, 'only the host wipes the whiteboard');

  settings(net, { boardAccess: 'host' });
  assert.equal(net.view(2).canDraw, false);
  assert.equal(net.session(2).beginStroke('#000000', 9, 1, 1), null);
  net.session(1).act({ type: 'pen', id: 2, on: true });
  net.run(50);
  assert.equal(net.view(2).canDraw, true);
  assert.equal(net.view(3).canDraw, false);

  assert.equal(net.session(1).clear(), true);
  net.run(100);
  for (const id of [1, 2, 3]) assert.equal(net.session(id).canvas.ops.length, 0);
  assert.deepEqual(net.refused, []);
});

test('long, fast drawing with chat never trips Refract’s rate limit', () => {
  const net = network([1, 2, 3, 4]);
  net.session(1).act({ type: 'board' });
  net.run(50);
  for (let s = 0; s < 40; s += 1) {
    const ids = [1, 2, 3].map((id) => net.session(id).beginStroke('#000000', 4, 50 + s * 20, 50 + id * 100));
    for (let p = 1; p < 60; p += 1) {
      ids.forEach((stroke, i) => net.session(i + 1).extendStroke(stroke, [50 + s * 20 + (p % 30), 50 + (i + 1) * 100 + p]));
      if (p % 10 === 0) net.session(4).say(`look at that ${s}.${p}`);
      net.run(8);
    }
  }
  net.run(5000);
  assert.deepEqual(net.refused, []);
  assert.deepEqual(opsOf(net, 4), opsOf(net, 1));
  assert.ok(net.session(1).canvas.points < MAX_CANVAS_POINTS);
});

test('the host drops chat floods', () => {
  const net = network([1, 2]);
  for (let i = 0; i < 12; i += 1) net.session(2).say(`spam ${i}`);
  net.run(200);
  const chat = net.clients.get(1).lines.filter((line) => line.kind === 'chat');
  assert.equal(chat.length, 8, 'two lines a second, in bursts of eight');
  net.run(4100);
  net.session(2).say('back again');
  net.run(200);
  assert.ok(net.clients.get(1).lines.some((line) => line.text === 'back again'));
  assert.equal(cleanText('  hi\u0000 \n there  '), 'hi there');
  assert.equal(Array.from(cleanText('x'.repeat(500))).length, 100);
});

test('everyone counts down to the same moment', () => {
  const net = network([1, 2, 3]);
  startTurn(net);
  const ends = [1, 2, 3].map((id) => net.view(id).timerEndsAt);
  assert.ok(Math.max(...ends) - Math.min(...ends) < 100);
  assert.equal(net.view(2).timerDuration, 80000);
});

test('when the host leaves mid-turn, the drawer vouches for the word and the turn goes on', () => {
  const net = network([1, 2, 3]);
  startTurn(net);
  net.session(1).act({ type: 'skip' });
  net.run(REVEAL_MS + 100);
  assert.equal(net.view(1).view.drawer, 2);
  if (net.view(2).view.phase === 'choosing') net.session(2).act({ type: 'choose', index: 0 });
  net.run(100);
  const word = net.view(2).view.word;
  scribble(net, 2, { strokes: 2 });
  const before = net.view(3).view;
  net.leave(1);
  net.run(3000);
  assert.equal(net.view(3).hostId, 2);
  assert.equal(net.view(3).connected, true);
  assert.equal(phaseOf(net, 3), 'drawing');
  assert.equal(net.view(3).view.round, before.round);
  assert.ok(Math.abs(net.view(3).timerEndsAt - net.view(2).timerEndsAt) < 100);
  net.session(3).say(word);
  net.run(200);
  assert.equal(phaseOf(net, 3), 'reveal', 'the last guesser got it under the new host');
  assert.ok(scoreOf(net, 3, 3) > 0);
  assert.deepEqual(opsOf(net, 3), opsOf(net, 2));
});

test('when the host was drawing and leaves, the turn ends and the game carries on', () => {
  const net = network([1, 2, 3]);
  startTurn(net);
  scribble(net, 1, { strokes: 1 });
  net.leave(1);
  net.run(3000);
  assert.equal(net.view(2).isHost, true);
  assert.equal(phaseOf(net, 3), 'reveal');
  assert.equal(net.view(3).view.result.reason, 'left');
  net.run(REVEAL_MS + 100);
  assert.ok(['choosing', 'drawing'].includes(phaseOf(net, 3)));
  assert.ok([2, 3].includes(net.view(3).view.drawer));
});

test('a host reload resumes from storage: same turn, same word, same picture', () => {
  const net = network([1, 2]);
  const { word } = startTurn(net);
  scribble(net, 1, { strokes: 2 });
  net.session(1).flush();
  const ops = opsOf(net, 1);
  net.reload(1);
  net.run(200);
  assert.equal(net.view(1).isHost, true);
  assert.equal(phaseOf(net, 1), 'drawing');
  assert.equal(net.view(1).view.word, word);
  assert.deepEqual(opsOf(net, 1), ops);
  net.session(2).say(word);
  net.run(200);
  assert.equal(phaseOf(net, 2), 'reveal');
});

test('a host reload without storage rebuilds from the others, picture included', () => {
  const net = network([1, 2, 3], { persistence: false });
  net.session(1).act({ type: 'board' });
  net.run(50);
  scribble(net, 2, { strokes: 3 });
  const ops = opsOf(net, 2);
  net.reload(1);
  net.run(3000);
  assert.equal(phaseOf(net, 1), 'board');
  assert.deepEqual(opsOf(net, 1), ops);
  net.join(4);
  net.run(2000);
  assert.deepEqual(opsOf(net, 4), ops, 'and serves it to the next latecomer');
});

test('a guest reload catches up on state, words, and picture', () => {
  const net = network([1, 2]);
  net.session(1).act({ type: 'words', words: ['moon base'] });
  net.run(50);
  const { word } = startTurn(net);
  scribble(net, 1, { strokes: 2 });
  net.reload(2);
  net.run(2000);
  assert.equal(phaseOf(net, 2), 'drawing');
  assert.deepEqual(net.view(2).customWords, ['moon base']);
  assert.deepEqual(opsOf(net, 2), opsOf(net, 1));
  net.session(2).say(word);
  net.run(200);
  assert.equal(phaseOf(net, 1), 'reveal');
});

test('messages from other sessions, strangers, or forged hosts are ignored', () => {
  const net = network([1, 2]);
  const guest = net.session(2);
  const view = net.view(2).view;
  guest.receive(1, { protocol: GAME_PROTOCOL, sessionId: 'other', hostId: 1, kind: 'state', view: { ...view, phase: 'board' }, members: [1, 2] });
  guest.receive(9, { protocol: GAME_PROTOCOL, sessionId: 'test-session', hostId: 1, kind: 'lines', lines: [{ kind: 'chat', from: 9, text: 'hi' }] });
  net.session(1).receive(2, { protocol: GAME_PROTOCOL, sessionId: 'test-session', hostId: 2, kind: 'act', action: { type: 'board' } });
  net.session(1).receive(2, { protocol: GAME_PROTOCOL, sessionId: 'test-session', hostId: 1, kind: 'act', action: { type: 'board' } });
  net.run(50);
  assert.equal(phaseOf(net, 2), 'lobby');
  assert.equal(phaseOf(net, 1), 'lobby');
  net.session(1).act({ type: 'board' });
  net.run(50);
  // Someone drawing as somebody else is dropped.
  net.session(1).receive(2, { protocol: GAME_PROTOCOL, sessionId: 'test-session', hostId: 1, kind: 'ink', turn: net.view(1).view.turn, ev: [['s', '1.5', 0, '#000000', 9, 0, [1, 1]]] });
  assert.equal(net.session(1).canvas.ops.length, 0);
});

test('a new session starts a fresh game', () => {
  const net = network([1, 2]);
  startTurn(net);
  net.newSession();
  assert.equal(phaseOf(net, 1), 'lobby');
  assert.equal(phaseOf(net, 2), 'lobby');
  assert.equal(net.session(2).canvas.ops.length, 0);
});
