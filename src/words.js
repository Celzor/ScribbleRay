/** Words to draw: the built-in list, custom lists, and how guesses are compared. */
export const MAX_WORD_LENGTH = 32;
export const MAX_CUSTOM_WORDS = 400;
// A custom list travels to every participant in one message, beside the protocol envelope.
export const MAX_WORDS_BYTES = 12000;
export const MAX_GUESS_LENGTH = 100;

export const DEFAULT_WORDS = Object.freeze([
  // Food
  'apple', 'banana', 'cherry', 'grapes', 'lemon', 'orange', 'pear', 'pineapple', 'strawberry', 'watermelon',
  'carrot', 'broccoli', 'corn', 'mushroom', 'potato', 'tomato', 'pumpkin', 'onion', 'cucumber', 'avocado',
  'bread', 'cheese', 'pizza', 'hamburger', 'hot dog', 'sandwich', 'taco', 'sushi', 'cookie', 'cake',
  'cupcake', 'donut', 'ice cream', 'popcorn', 'pancake', 'waffle', 'egg', 'bacon', 'spaghetti', 'soup',
  'salad', 'candy', 'chocolate', 'lollipop', 'coffee', 'milkshake', 'honey', 'french fries', 'pretzel', 'birthday cake',
  // Animals
  'cat', 'dog', 'horse', 'cow', 'pig', 'sheep', 'goat', 'chicken', 'duck', 'rabbit',
  'mouse', 'hamster', 'frog', 'turtle', 'snake', 'lizard', 'crocodile', 'dinosaur', 'dragon', 'lion',
  'tiger', 'bear', 'panda', 'koala', 'kangaroo', 'monkey', 'gorilla', 'giraffe', 'elephant', 'zebra',
  'hippo', 'rhino', 'camel', 'deer', 'fox', 'wolf', 'squirrel', 'hedgehog', 'bat', 'owl',
  'eagle', 'parrot', 'penguin', 'flamingo', 'peacock', 'swan', 'fish', 'shark', 'whale', 'dolphin',
  'octopus', 'jellyfish', 'crab', 'lobster', 'starfish', 'seahorse', 'snail', 'spider', 'bee', 'butterfly',
  'ant', 'ladybug', 'mosquito', 'worm', 'unicorn', 'sloth', 'raccoon', 'skunk', 'beaver', 'polar bear',
  // Things around the house
  'chair', 'table', 'bed', 'sofa', 'lamp', 'clock', 'mirror', 'door', 'window', 'key',
  'lock', 'book', 'pencil', 'scissors', 'ruler', 'backpack', 'umbrella', 'glasses', 'hat', 'crown',
  'shoe', 'boot', 'sock', 'shirt', 'dress', 'jacket', 'scarf', 'glove', 'ring', 'necklace',
  'watch', 'wallet', 'phone', 'laptop', 'keyboard', 'camera', 'television', 'radio', 'headphones', 'remote control',
  'toothbrush', 'soap', 'towel', 'bathtub', 'toilet', 'fridge', 'oven', 'toaster', 'kettle', 'mug',
  'plate', 'bowl', 'fork', 'knife', 'spoon', 'bottle', 'jar', 'basket', 'box', 'envelope',
  'candle', 'bell', 'broom', 'bucket', 'ladder', 'hammer', 'saw', 'screwdriver', 'magnet', 'battery',
  'light bulb', 'plug', 'teddy bear', 'pillow', 'blanket', 'vacuum cleaner', 'washing machine', 'paintbrush', 'paper clip', 'trash can',
  // Toys, music, and play
  'guitar', 'piano', 'drum', 'trumpet', 'violin', 'microphone', 'balloon', 'kite', 'ball', 'gift',
  'dice', 'puzzle', 'doll', 'yo-yo', 'skateboard', 'trophy', 'medal', 'chess', 'video game', 'playing cards',
  'swing', 'slide', 'seesaw', 'trampoline', 'sandcastle', 'snowman', 'rollercoaster', 'ferris wheel', 'carousel', 'bowling',
  // Getting around
  'bicycle', 'scooter', 'car', 'bus', 'truck', 'train', 'tractor', 'ambulance', 'fire truck', 'police car',
  'taxi', 'motorcycle', 'helicopter', 'airplane', 'boat', 'sailboat', 'submarine', 'ship', 'canoe', 'parachute',
  'hot air balloon', 'rocket', 'satellite', 'ufo', 'traffic light', 'anchor', 'map', 'compass', 'suitcase', 'ticket',
  // Places and nature
  'house', 'castle', 'igloo', 'tent', 'barn', 'lighthouse', 'bridge', 'tower', 'pyramid', 'windmill',
  'school', 'hospital', 'island', 'volcano', 'mountain', 'desert', 'beach', 'forest', 'river', 'waterfall',
  'cave', 'cloud', 'rain', 'snow', 'rainbow', 'sun', 'moon', 'star', 'planet', 'comet',
  'lightning', 'tornado', 'wave', 'tree', 'palm tree', 'cactus', 'flower', 'rose', 'sunflower', 'leaf',
  'campfire', 'fireworks', 'treehouse', 'fountain', 'skyscraper', 'farm', 'zoo', 'garden', 'swimming pool', 'playground',
  // People and characters
  'pirate', 'ninja', 'wizard', 'witch', 'ghost', 'zombie', 'vampire', 'mermaid', 'fairy', 'alien',
  'astronaut', 'knight', 'king', 'queen', 'princess', 'clown', 'chef', 'doctor', 'firefighter', 'farmer',
  'cowboy', 'superhero', 'angel', 'robot', 'mummy', 'scarecrow', 'detective', 'baby', 'grandma', 'teacher',
  // Doing things
  'swimming', 'running', 'jumping', 'dancing', 'sleeping', 'reading', 'cooking', 'fishing', 'painting', 'singing',
  'skiing', 'surfing', 'juggling', 'climbing', 'crying', 'laughing', 'sneezing', 'yawning', 'waving', 'skating',
  'camping', 'gardening', 'hugging', 'diving', 'kicking', 'flying', 'shopping', 'snoring', 'whistling', 'fighting',
  // The body
  'eye', 'ear', 'nose', 'mouth', 'tooth', 'hand', 'foot', 'heart', 'brain', 'skeleton',
  'skull', 'beard', 'mustache', 'tongue', 'muscle', 'fingerprint', 'footprint', 'bone', 'lips', 'eyebrow',
  // Everything else
  'fire', 'smoke', 'bomb', 'money', 'diamond', 'treasure', 'calendar', 'newspaper', 'mask', 'wheel',
  'chain', 'net', 'spider web', 'nest', 'feather', 'shadow', 'music', 'wedding', 'party', 'christmas tree',
  'sword', 'shield', 'bow and arrow', 'cannon', 'telescope', 'microscope', 'magnifying glass', 'flashlight', 'hourglass', 'thermometer',
  'globe', 'tooth fairy', 'pinata', 'piggy bank', 'snow globe', 'bubble', 'zipper', 'button', 'mailbox', 'birdhouse',
]);

/** A word as shown: trimmed, single-spaced, printable, and short enough to draw. */
export function cleanWord(raw) {
  if (typeof raw !== 'string') return null;
  const word = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!word || Array.from(word).length > MAX_WORD_LENGTH || !/[\p{L}\p{N}]/u.test(word)) return null;
  return word;
}

/**
 * What a guess must match: case, accents, spaces and punctuation don't count,
 * so "Ice-Cream" and "icecream" both get "ice cream".
 */
export function guessKey(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const wordsBytes = (words) => new TextEncoder().encode(JSON.stringify(words)).length;

/** Words from anything typed or pasted: one per line, or separated by commas. */
export function parseWordList(text) {
  const words = [];
  const seen = new Set();
  let skipped = 0;
  for (const part of String(text ?? '').split(/[\n,;]+/)) {
    if (!part.trim()) continue;
    const word = cleanWord(part);
    const key = word && guessKey(word);
    if (!word || !key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    words.push(word);
  }
  const fitted = fitWordList(words);
  return { words: fitted, skipped, truncated: words.length - fitted.length };
}

/** Keep a list within the count and size that can travel in one message. */
export function fitWordList(words) {
  const fitted = words.slice(0, MAX_CUSTOM_WORDS);
  while (fitted.length && wordsBytes(fitted) > MAX_WORDS_BYTES) fitted.pop();
  return fitted;
}

/** An untrusted list: valid only if every word is clean, distinct, and the list fits. */
export function isValidWordList(words) {
  if (!Array.isArray(words) || words.length > MAX_CUSTOM_WORDS) return false;
  const seen = new Set();
  for (const word of words) {
    if (cleanWord(word) !== word) return false;
    const key = guessKey(word);
    if (!key || seen.has(key)) return false;
    seen.add(key);
  }
  return wordsBytes(words) <= MAX_WORDS_BYTES;
}

/** Levenshtein distance, giving up once it exceeds `limit`. */
export function editDistance(a, b, limit = Infinity) {
  const left = Array.from(a);
  const right = Array.from(b);
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

/** Nearly right: one letter off, or two in a long word. */
export function isCloseGuess(guess, word) {
  const a = guessKey(guess);
  const b = guessKey(word);
  if (!a || !b || a === b || Array.from(b).length < 4) return false;
  const allowed = Array.from(b).length >= 8 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed;
}

/** Positions in the word that are hidden until guessed: its letters and digits. */
export function letterPositions(word) {
  const positions = [];
  Array.from(word).forEach((char, index) => {
    if (/[\p{L}\p{N}]/u.test(char)) positions.push(index);
  });
  return positions;
}

/** How many letters a hint may give away: always less than half the word. */
export function hintLimit(word, requested) {
  return Math.max(0, Math.min(requested, Math.floor((letterPositions(word).length - 1) / 2)));
}

/** The word as a guesser sees it: null for each hidden letter, everything else as is. */
export function maskWord(word, revealed = []) {
  const shown = new Set(revealed);
  const hidden = new Set(letterPositions(word));
  return Array.from(word).map((char, index) => (hidden.has(index) && !shown.has(index) ? null : char));
}

/** Whether `word` could be the word behind a guesser's mask. */
export function matchesMask(word, mask) {
  if (typeof word !== 'string' || !Array.isArray(mask)) return false;
  const chars = Array.from(word);
  const hidden = new Set(letterPositions(word));
  return chars.length === mask.length && chars.every((char, index) => (mask[index] === null ? hidden.has(index) : mask[index] === char));
}

/** The pool a game draws from. */
export function wordPool(source, customWords = []) {
  if (source === 'custom' && customWords.length) return [...customWords];
  if (source === 'mixed') {
    const seen = new Set(customWords.map(guessKey));
    return [...customWords, ...DEFAULT_WORDS.filter((word) => !seen.has(guessKey(word)))];
  }
  return [...DEFAULT_WORDS];
}

/**
 * `count` different words, avoiding `used` ones until the pool runs dry.
 * Returns the words and the updated used list.
 */
export function pickWords(pool, count, used, random = Math.random) {
  const usedKeys = new Set(used.map(guessKey));
  let fresh = pool.filter((word) => !usedKeys.has(guessKey(word)));
  let nextUsed = [...used];
  if (fresh.length < count) {
    fresh = [...pool];
    nextUsed = [];
  }
  const picked = [];
  const options = [...fresh];
  while (picked.length < count && options.length) {
    const index = Math.floor(random() * options.length);
    picked.push(options.splice(index, 1)[0]);
  }
  return { words: picked, used: [...nextUsed, ...picked].slice(-600) };
}
