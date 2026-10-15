import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORDS, MAX_CUSTOM_WORDS, MAX_WORDS_BYTES, cleanWord, editDistance, guessKey, hintLimit, isCloseGuess,
  isValidWordList, letterPositions, maskWord, matchesMask, parseWordList, pickWords, wordPool,
} from '../src/words.js';
import { seeded } from './helpers.js';

test('the built-in list is clean, distinct, and big enough for long games', () => {
  assert.ok(DEFAULT_WORDS.length >= 300);
  const keys = DEFAULT_WORDS.map(guessKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const word of DEFAULT_WORDS) assert.equal(cleanWord(word), word, word);
});

test('guesses ignore case, accents, spaces, and punctuation', () => {
  assert.equal(guessKey('  Ice-Cream! '), 'icecream');
  assert.equal(guessKey('ice cream'), guessKey('IceCream'));
  assert.equal(guessKey('Crème Brûlée'), 'cremebrulee');
  assert.equal(guessKey('???'), '');
  assert.equal(guessKey(42), '');
});

test('custom lists accept lines or commas, drop junk and duplicates, and stay within one message', () => {
  const { words, skipped } = parseWordList('Cat, dog\n\n  hot   dog ;CAT\n---\n' + 'x'.repeat(40) + '\nlast one');
  assert.deepEqual(words, ['Cat', 'dog', 'hot dog', 'last one']);
  assert.equal(skipped, 3);

  const many = Array.from({ length: 600 }, (_, i) => `word number ${i}`).join('\n');
  const capped = parseWordList(many);
  assert.equal(capped.words.length, MAX_CUSTOM_WORDS);
  assert.ok(isValidWordList(capped.words));

  const long = Array.from({ length: 400 }, (_, i) => `${'ü'.repeat(28)}${i}`).join('\n');
  const fitted = parseWordList(long);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted.words)).length <= MAX_WORDS_BYTES);
  assert.ok(fitted.truncated > 0);
});

test('untrusted word lists are checked word by word', () => {
  assert.ok(isValidWordList([]));
  assert.ok(isValidWordList(['cat', 'hot dog']));
  for (const bad of [null, 'cat', [' cat'], ['cat', 'CAT'], ['a\u0000b'], [''], [42], ['!!!']]) assert.equal(isValidWordList(bad), false, JSON.stringify(bad));
});

test('close guesses are one letter off, or two in long words', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('abc', 'abcdefgh', 2), 3);
  assert.ok(isCloseGuess('elephent', 'elephant'));
  assert.ok(isCloseGuess('pinapple', 'pineapple'));
  assert.ok(isCloseGuess('pinaple', 'pineapple'));
  assert.ok(!isCloseGuess('pineapple', 'pineapple'), 'an exact guess is correct, not close');
  assert.ok(!isCloseGuess('cot', 'cat'), 'short words never give hints');
  assert.ok(isCloseGuess('horse', 'house'));
  assert.ok(!isCloseGuess('banana', 'pineapple'));
});

test('masks hide letters and digits but show spaces and punctuation', () => {
  assert.deepEqual(letterPositions('yo-yo 2'), [0, 1, 3, 4, 6]);
  assert.deepEqual(maskWord('yo-yo', []), [null, null, '-', null, null]);
  assert.deepEqual(maskWord('hot dog', [4]), [null, null, null, ' ', 'd', null, null]);
  assert.ok(matchesMask('hot dog', maskWord('hot dog', [4])));
  assert.ok(!matchesMask('hot cat', maskWord('hot dog', [4])));
  assert.ok(!matchesMask('hotdog', maskWord('hot dog', [])));
  assert.equal(hintLimit('cat', 4), 1);
  assert.equal(hintLimit('ox', 4), 0);
  assert.equal(hintLimit('pineapple', 2), 2);
  assert.equal(hintLimit('pineapple', 9), 4);
});

test('word choices are distinct and avoid recent words until the pool runs dry', () => {
  const random = seeded(3);
  const pool = ['a1', 'b2', 'c3', 'd4', 'e5'];
  const first = pickWords(pool, 3, [], random);
  assert.equal(new Set(first.words).size, 3);
  const second = pickWords(pool, 2, first.used, random);
  assert.ok(second.words.every((word) => !first.words.includes(word)));
  const third = pickWords(pool, 3, second.used, random);
  assert.equal(third.words.length, 3, 'a dry pool starts over');
  assert.deepEqual(pickWords(['only'], 3, [], random).words, ['only']);
});

test('the pool follows the word source', () => {
  assert.equal(wordPool('default', ['zebra crossing']).length, DEFAULT_WORDS.length);
  assert.deepEqual(wordPool('custom', ['one', 'two']), ['one', 'two']);
  assert.equal(wordPool('custom', []).length, DEFAULT_WORDS.length, 'an empty custom list never leaves nothing to draw');
  const mixed = wordPool('mixed', ['Cat', 'zebra crossing']);
  assert.equal(mixed.length, DEFAULT_WORDS.length + 1, 'custom words that repeat built-ins count once');
});
