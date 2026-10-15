import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOOSE_MS, DEFAULT_SETTINGS, MAX_ROUNDS, REVEAL_MS, SETTING_OPTIONS, applyAction, applyRoster, canClear, canDraw,
  createTable, drawerPoints, guess, guessPoints, isValidTable, isValidView, nextWake, tableFromView, tick, viewFor,
} from '../src/rules.js';
import { guessKey, letterPositions } from '../src/words.js';
import { seeded } from './helpers.js';

const HOST = 1;

function clock(seed = 1) {
  let now = 10_000;
  const random = seeded(seed);
  return {
    get now() { return now; },
    ctx: () => ({ now, random, hostId: HOST }),
    advance(ms) { now += ms; },
  };
}

function lobby(ids = [1, 2, 3], settings = {}) {
  const time = clock();
  let table = applyRoster(createTable({ settings }), ids, time.ctx());
  return { time, get table() { return table; }, set table(next) { table = next; } };
}

const act = (game, from, action) => { game.table = applyAction(game.table, from, action, game.time.ctx()); return game.table; };
const say = (game, from, text) => { const result = guess(game.table, from, text, game.time.ctx()); game.table = result.table; return result; };
const wait = (game, ms) => { game.time.advance(ms); game.table = tick(game.table, game.time.ctx()); return game.table; };
const scoreOf = (table, id) => table.players.find((player) => player.id === id).score;

function startDrawing(game) {
  act(game, HOST, { type: 'start' });
  assert.equal(game.table.phase, 'choosing');
  act(game, game.table.drawer, { type: 'choose', index: 0 });
  assert.equal(game.table.phase, 'drawing');
  return game.table.word;
}

test('only the host changes settings and words, and only to values the game offers', () => {
  const game = lobby();
  assert.equal(act(game, 2, { type: 'settings', settings: { rounds: 5 } }).settings.rounds, DEFAULT_SETTINGS.rounds);
  act(game, HOST, { type: 'settings', settings: { rounds: 5, drawTime: 7, hints: 1, bogus: true } });
  assert.deepEqual(game.table.settings, { ...DEFAULT_SETTINGS, rounds: 5, hints: 1 });
  for (const [key, options] of Object.entries(SETTING_OPTIONS)) assert.ok(options.includes(DEFAULT_SETTINGS[key]), key);

  assert.equal(act(game, 2, { type: 'words', words: ['cat'] }).customWords.length, 0);
  act(game, HOST, { type: 'words', words: ['cat', 'CAT'] });
  assert.equal(game.table.customWords.length, 0, 'invalid lists are refused whole');
  act(game, HOST, { type: 'words', words: ['cat', 'giant robot'] });
  assert.deepEqual(game.table.customWords, ['cat', 'giant robot']);
  assert.equal(game.table.wordsRev, 1);
});

test('a game needs two players, and custom-only needs custom words', () => {
  const alone = lobby([1]);
  assert.equal(act(alone, HOST, { type: 'start' }).phase, 'lobby');
  const game = lobby([1, 2], { wordSource: 'custom' });
  assert.equal(act(game, HOST, { type: 'start' }).phase, 'lobby');
  act(game, HOST, { type: 'words', words: ['lighthouse keeper'] });
  assert.equal(act(game, 2, { type: 'start' }).phase, 'lobby', 'only the host starts');
  act(game, HOST, { type: 'start' });
  assert.equal(game.table.phase, 'drawing', 'one possible word skips choosing');
  assert.equal(game.table.word, 'lighthouse keeper');
});

test('the drawer chooses a word that only they can see', () => {
  const game = lobby();
  act(game, HOST, { type: 'start' });
  const { drawer, choices, turn } = game.table;
  assert.equal(drawer, 1);
  assert.equal(choices.length, 3);
  assert.equal(viewFor(game.table, drawer, game.time.now).choices.length, 3);
  assert.deepEqual(viewFor(game.table, 2, game.time.now).choices, []);
  assert.equal(act(game, 2, { type: 'choose', index: 0 }).phase, 'choosing');
  assert.equal(act(game, drawer, { type: 'choose', index: 7 }).phase, 'choosing');
  act(game, drawer, { type: 'choose', index: 2 });
  assert.equal(game.table.word, choices[2]);
  assert.equal(game.table.turn, turn);

  const drawerView = viewFor(game.table, drawer, game.time.now);
  const guesserView = viewFor(game.table, 2, game.time.now);
  assert.equal(drawerView.word, choices[2]);
  assert.equal(guesserView.word, null);
  assert.equal(guesserView.hint.length, Array.from(choices[2]).length);
  assert.ok(!JSON.stringify(guesserView).toLowerCase().includes(`"${choices[2].toLowerCase()}"`), 'the word appears nowhere in a guesser’s view');
  assert.ok(isValidView(guesserView, [1, 2, 3]));
  assert.ok(isValidView(drawerView, [1, 2, 3]));
});

test('an undecided drawer gets a word picked for them', () => {
  const game = lobby();
  act(game, HOST, { type: 'start' });
  assert.equal(nextWake(game.table), game.time.now + CHOOSE_MS);
  wait(game, CHOOSE_MS - 1);
  assert.equal(game.table.phase, 'choosing');
  wait(game, 1);
  assert.equal(game.table.phase, 'drawing');
  assert.equal(game.table.duration, DEFAULT_SETTINGS.drawTime * 1000);
});

test('guesses: right, close, wrong, and the drawer’s own chat', () => {
  const game = lobby([1, 2, 3, 4], { hints: 0 });
  act(game, HOST, { type: 'start' });
  game.table = { ...game.table, choices: ['elephant'] };
  act(game, 1, { type: 'choose', index: 0 });

  assert.equal(say(game, 2, 'is it a dog?').verdict, 'chat');
  assert.equal(say(game, 2, 'elephent').verdict, 'close');
  assert.equal(say(game, 1, 'nearly!').verdict, 'secret');

  game.time.advance(8000);
  const first = say(game, 2, '  ElePHANT ');
  assert.equal(first.verdict, 'correct');
  assert.equal(first.points, guessPoints(72000, 80000, 0));
  assert.equal(scoreOf(game.table, 2), first.points);
  assert.equal(viewFor(game.table, 2, game.time.now).word, 'elephant', 'guessers learn the word');
  assert.equal(viewFor(game.table, 3, game.time.now).word, null);
  assert.equal(say(game, 2, 'elephant').verdict, 'secret', 'a second correct guess is just chat for those who know');

  game.time.advance(40000);
  const second = say(game, 3, 'elephant');
  assert.ok(second.points < first.points, 'later guesses earn less');
  assert.equal(game.table.phase, 'drawing');
  const last = say(game, 4, 'elephant');
  assert.equal(game.table.phase, 'reveal', 'the turn ends once everyone has it');
  const expected = drawerPoints([{ points: first.points }, { points: second.points }, { points: last.points }], 3);
  assert.equal(scoreOf(game.table, 1), expected);
  assert.equal(game.table.result.reason, 'all');
  assert.equal(game.table.result.word, 'elephant');
  assert.equal(viewFor(game.table, 3, game.time.now).result.word, 'elephant', 'everyone sees the word once the turn ends');
});

test('scoring rewards speed and order, and the drawer earns the average', () => {
  assert.equal(guessPoints(80000, 80000, 0), 350);
  assert.equal(guessPoints(0, 80000, 0), 100);
  assert.equal(guessPoints(0, 80000, 9), 50);
  assert.equal(guessPoints(40000, 80000, 1), 215);
  assert.equal(drawerPoints([], 3), 0);
  assert.equal(drawerPoints([{ points: 300 }], 3), 100);
});

test('hints reveal letters on a schedule, never half the word', () => {
  const game = lobby([1, 2], { hints: 3, drawTime: 80 });
  act(game, HOST, { type: 'start' });
  game.table = { ...game.table, choices: ['pineapple'] };
  act(game, 1, { type: 'choose', index: 0 });
  assert.equal(game.table.hintOrder.length, 3);
  const hint = () => viewFor(game.table, 2, game.time.now).hint;
  assert.equal(hint().filter(Boolean).length, 0);
  assert.equal(nextWake(game.table), game.time.now + 20000);
  wait(game, 20000);
  assert.equal(hint().filter(Boolean).length, 1);
  wait(game, 40000);
  assert.equal(hint().filter(Boolean).length, 3);
  for (const [index, char] of hint().entries()) if (char) assert.equal(char, 'pineapple'[index]);
  assert.equal(nextWake(game.table), game.table.deadline);
  wait(game, 20000);
  assert.equal(game.table.phase, 'reveal');
  assert.equal(game.table.result.reason, 'time');
  assert.equal(scoreOf(game.table, 1), 0, 'no guesses, no points for the drawer');
});

test('every player draws once per round; the game ends after the set rounds', () => {
  const game = lobby([1, 2, 3], { rounds: 2, wordChoices: 1 });
  act(game, HOST, { type: 'start' });
  const drawers = [];
  while (game.table.phase !== 'results') {
    assert.equal(game.table.phase, 'drawing');
    drawers.push([game.table.round, game.table.drawer]);
    act(game, HOST, { type: 'skip' });
    assert.equal(game.table.result.reason, 'skip');
    wait(game, REVEAL_MS);
  }
  assert.deepEqual(drawers, [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]);
  assert.deepEqual(game.table.winners, [1, 2, 3], 'a scoreless game is a tie');
  act(game, HOST, { type: 'start' });
  assert.equal(game.table.round, 1, 'play again starts over');
});

test('playing to a score ends as soon as someone reaches it', () => {
  const game = lobby([1, 2], { endMode: 'score', targetScore: 1000, wordChoices: 1, hints: 0 });
  act(game, HOST, { type: 'start' });
  let turns = 0;
  while (game.table.phase !== 'results') {
    turns += 1;
    const guesser = game.table.drawer === 1 ? 2 : 1;
    say(game, guesser, game.table.word);
    wait(game, REVEAL_MS);
  }
  assert.ok(turns >= 3 && turns <= 6);
  assert.ok(game.table.players.some((player) => player.score >= 1000));
  const best = Math.max(...game.table.players.map((player) => player.score));
  assert.deepEqual(game.table.winners, game.table.players.filter((player) => player.score === best).map((player) => player.id), 'ties share the win');

  const endless = lobby([1, 2], { endMode: 'score', targetScore: 5000, wordChoices: 1 });
  act(endless, HOST, { type: 'start' });
  while (endless.table.phase !== 'results') {
    act(endless, HOST, { type: 'skip' });
    wait(endless, REVEAL_MS);
  }
  assert.equal(endless.table.round, MAX_ROUNDS, 'nobody scoring still ends eventually');
});

test('people joining and leaving mid-game', () => {
  const game = lobby([1, 2, 3], { wordChoices: 1 });
  act(game, HOST, { type: 'start' });
  game.table = applyRoster(game.table, [1, 2, 3, 4], game.time.ctx());
  assert.deepEqual(game.table.queue, [2, 3, 4], 'a latecomer draws this round');
  assert.equal(scoreOf(game.table, 4), 0);

  say(game, 2, game.table.word);
  say(game, 3, game.table.word);
  game.table = applyRoster(game.table, [1, 2, 3], game.time.ctx());
  assert.equal(game.table.phase, 'reveal', 'the last one still guessing left: the turn is over');
  assert.equal(game.table.result.reason, 'all');

  wait(game, REVEAL_MS);
  assert.equal(game.table.drawer, 2);
  game.table = applyRoster(game.table, [1, 3], game.time.ctx());
  assert.equal(game.table.phase, 'reveal');
  assert.equal(game.table.result.reason, 'left');
  assert.ok(isValidView(viewFor(game.table, 1, game.time.now), [1, 3]), 'a result can name someone who left');

  game.table = applyRoster(game.table, [1], game.time.ctx());
  assert.equal(game.table.phase, 'lobby');
  assert.equal(game.table.stopped, 'players');
});

test('the whiteboard: open to everyone, or the host plus anyone handed a pen', () => {
  const game = lobby([1, 2, 3]);
  const turn = game.table.turn;
  assert.equal(act(game, 2, { type: 'board' }).phase, 'lobby');
  act(game, HOST, { type: 'board' });
  assert.equal(game.table.phase, 'board');
  assert.equal(game.table.turn, turn + 1, 'a fresh sheet');
  const view = () => viewFor(game.table, 2, game.time.now);
  assert.ok([1, 2, 3].every((id) => canDraw(view(), id, HOST)));
  assert.ok(canClear(view(), 1, HOST) && !canClear(view(), 2, HOST));

  act(game, HOST, { type: 'settings', settings: { boardAccess: 'host' } });
  assert.ok(canDraw(view(), 1, HOST));
  assert.ok(!canDraw(view(), 2, HOST));
  act(game, HOST, { type: 'pen', id: 2, on: true });
  assert.ok(canDraw(view(), 2, HOST) && !canDraw(view(), 3, HOST));
  assert.equal(act(game, 2, { type: 'pen', id: 3, on: true }).pens.length, 1, 'only the host hands out pens');
  assert.equal(act(game, HOST, { type: 'pen', id: 9, on: true }).pens.length, 1);
  game.table = applyRoster(game.table, [1, 3], game.time.ctx());
  assert.deepEqual(game.table.pens, []);
  act(game, HOST, { type: 'lobby' });
  assert.equal(game.table.phase, 'lobby');
  assert.ok(!canDraw(viewFor(game.table, 1, game.time.now), 1, HOST), 'nobody draws in the lobby');
});

test('a new host carries on with the word the drawer vouches for, or ends the turn', () => {
  const game = lobby([1, 2, 3], { hints: 2 });
  act(game, HOST, { type: 'start' });
  game.table = { ...game.table, choices: ['sandcastle'] };
  act(game, 1, { type: 'choose', index: 0 });
  wait(game, 30000);
  say(game, 3, 'sandcastle');
  const seen = viewFor(game.table, 2, game.time.now);
  const ctx = { now: game.time.now + 500, random: seeded(9), hostId: 2 };

  const resumed = tableFromView(seen, { word: 'sandcastle' }, ctx);
  assert.equal(resumed.phase, 'drawing');
  assert.equal(resumed.word, 'sandcastle');
  assert.equal(resumed.deadline, ctx.now + seen.remainingMs);
  assert.deepEqual(resumed.hintOrder.slice(0, seen.revealed.length), seen.revealed);
  assert.ok(isValidTable(resumed));
  assert.equal(guess(resumed, 2, 'sandcastle', ctx).verdict, 'correct');

  for (const word of [null, 'sandwiches', 'castle']) {
    const ended = tableFromView(seen, { word }, ctx);
    assert.equal(ended.phase, 'reveal');
    assert.equal(ended.result.reason, 'host');
    assert.equal(ended.result.word, null);
    assert.ok(isValidTable(ended));
  }
});

test('tampered views are rejected', () => {
  const game = lobby([1, 2, 3]);
  startDrawing(game);
  const view = viewFor(game.table, 2, game.time.now);
  assert.ok(isValidView(view, [1, 2, 3]));
  const bad = [
    { ...view, phase: 'party' },
    { ...view, word: 'not the word at all' },
    { ...view, hint: null },
    { ...view, players: [...view.players, { id: 9, score: 0 }] },
    { ...view, drawer: 9 },
    { ...view, settings: { ...view.settings, rounds: 99 } },
    { ...view, remainingMs: -1 },
    { ...view, guessed: [{ id: 2, points: 5000 }] },
    { ...view, pens: [9] },
    null,
  ];
  for (const candidate of bad) assert.equal(isValidView(candidate, [1, 2, 3]), false, JSON.stringify(candidate)?.slice(0, 80));
  assert.equal(isValidView(view, [1, 2]), false, 'membership must match');
  assert.ok(isValidTable(game.table));
  assert.equal(isValidTable({ ...game.table, word: null }), false);
  assert.equal(isValidTable({ ...game.table, players: 'everyone' }), false);
});

test('a randomized run of whole games keeps every view valid and every word secret', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = seeded(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    let members = [1, 2, 3, 4].slice(0, 2 + Math.floor(random() * 3));
    const settings = Object.fromEntries(Object.entries(SETTING_OPTIONS).map(([key, options]) => [key, pick(options)]));
    settings.wordSource = 'default';
    if (settings.endMode === 'score') settings.targetScore = 1000;
    const game = lobby(members, settings);
    act(game, HOST, { type: 'start' });
    let next = 10;
    for (let step = 0; step < 600 && game.table.phase !== 'results' && game.table.phase !== 'lobby'; step += 1) {
      const roll = random();
      const { table } = game;
      if (roll < 0.05 && members.length < 6) {
        members = [...members, next];
        next += 1;
        game.table = applyRoster(table, members, game.time.ctx());
      } else if (roll < 0.08 && members.length > 2) {
        members = members.filter((id) => id !== pick(members.filter((id) => id !== HOST)));
        game.table = applyRoster(table, members, game.time.ctx());
      } else if (roll < 0.25 && table.phase === 'choosing') {
        act(game, table.drawer, { type: 'choose', index: Math.floor(random() * table.choices.length) });
      } else if (roll < 0.6 && table.phase === 'drawing') {
        const from = pick(members);
        say(game, from, random() < 0.4 ? table.word : pick(['cat', 'hmm', table.word.slice(1)]));
      } else {
        wait(game, Math.floor(random() * 20000));
      }
      assert.ok(isValidTable(game.table), `seed ${seed} step ${step}: table`);
      for (const id of members) {
        const view = viewFor(game.table, id, game.time.now);
        assert.ok(isValidView(view, members), `seed ${seed} step ${step}: view for ${id}`);
        if (game.table.phase === 'drawing') {
          const knows = id === game.table.drawer || game.table.guessed.some((entry) => entry.id === id);
          assert.equal(view.word !== null, knows);
          if (!knows) assert.equal(view.hint.filter(Boolean).length < letterPositions(game.table.word).length, true);
          if (!knows && guessKey(game.table.word).length > 3) {
            assert.ok(!JSON.stringify(view.choices).includes(game.table.word));
          }
        }
      }
    }
    assert.ok(['results', 'lobby'].includes(game.table.phase), `seed ${seed} finishes`);
  }
});
