/**
 * The shared drawing: an ordered list of operations that every copy replays
 * the same way. Coordinates are integers on a fixed 1000 × 750 sheet, so a
 * drawing looks the same on every screen size.
 *
 * On the wire, operations travel as compact events:
 *   ['s', id, epoch, color, width, from, deltas]  stroke points, from point `from` on
 *   ['f', id, epoch, color, x, y]                 bucket fill
 *   ['u', id]                                     undo one operation
 *   ['x', epoch]                                  clear: everything before `epoch` is gone
 * An operation's id is "<author's user id>.<sequence>", so receivers can check
 * that people only add and remove their own work.
 */
export const WIDTH = 1000;
export const HEIGHT = 750;
export const PAPER = '#ffffff';
export const MAX_STROKE_POINTS = 3000;
export const MAX_CANVAS_POINTS = 40000;
export const MAX_OPS = 2500;
export const MIN_BRUSH = 1;
export const MAX_BRUSH = 80;
export const BRUSH_SIZES = Object.freeze([4, 9, 18, 36]);
export const PALETTE = Object.freeze([
  '#000000', '#4c4c4c', '#9a9a9a', '#ffffff', '#ef130b', '#ff7100', '#ffe400', '#00cc00',
  '#00b2ff', '#231fd3', '#a300ba', '#ff8fc7', '#a0522d', '#ffcc99', '#740b07', '#c23800',
  '#e8a200', '#005510', '#00569e', '#0e0865', '#550069', '#63300d',
]);
const MARGIN = 40;
const SEGMENT_POINTS = 400;
const COLOR = /^#[0-9a-f]{6}$/;
const OP_ID = /^[1-9]\d{0,15}\.\d{1,9}$/;
const MAX_EPOCH = 1e9;

export const isColor = (value) => typeof value === 'string' && COLOR.test(value);
export const isBrush = (value) => Number.isInteger(value) && value >= MIN_BRUSH && value <= MAX_BRUSH;
export const isOpId = (value) => typeof value === 'string' && OP_ID.test(value);
export const opAuthor = (id) => Number(id.slice(0, id.indexOf('.')));
const isEpoch = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH;
const inRange = (value, max) => Number.isInteger(value) && value >= -MARGIN && value <= max + MARGIN;

export function createCanvas(turn = 0) {
  return { turn, epoch: 0, ops: [], byId: new Map(), points: 0, removed: new Set() };
}

function reset(canvas, epoch) {
  canvas.epoch = epoch;
  canvas.ops = [];
  canvas.byId.clear();
  canvas.removed.clear();
  canvas.points = 0;
}

/** Absolute flat points [x, y, x, y…] from `start` to `end` as [x, y, dx, dy…]. */
export function encodePoints(points, start = 0, end = points.length / 2) {
  const out = [];
  for (let i = start; i < end; i += 1) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (i === start) out.push(x, y);
    else out.push(x - points[i * 2 - 2], y - points[i * 2 - 1]);
  }
  return out;
}

/** The inverse of encodePoints; null for anything malformed or off the sheet. */
export function decodePoints(deltas) {
  if (!Array.isArray(deltas) || deltas.length < 2 || deltas.length % 2 || deltas.length > MAX_STROKE_POINTS * 2) return null;
  const out = new Array(deltas.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < deltas.length; i += 2) {
    const dx = deltas[i];
    const dy = deltas[i + 1];
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
    x = i === 0 ? dx : x + dx;
    y = i === 0 ? dy : y + dy;
    if (!inRange(x, WIDTH) || !inRange(y, HEIGHT)) return null;
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

/** Whether an event is well formed; authorship and permission are checked by the caller. */
export function isValidEvent(event) {
  if (!Array.isArray(event)) return false;
  switch (event[0]) {
    case 's':
      return event.length === 7 && isOpId(event[1]) && isEpoch(event[2]) && isColor(event[3]) && isBrush(event[4]) &&
        Number.isSafeInteger(event[5]) && event[5] >= 0 && event[5] < MAX_STROKE_POINTS && decodePoints(event[6]) !== null;
    case 'f':
      return event.length === 6 && isOpId(event[1]) && isEpoch(event[2]) && isColor(event[3]) &&
        Number.isInteger(event[4]) && event[4] >= 0 && event[4] < WIDTH && Number.isInteger(event[5]) && event[5] >= 0 && event[5] < HEIGHT;
    case 'u':
      return event.length === 2 && isOpId(event[1]);
    case 'x':
      return event.length === 2 && isEpoch(event[1]);
    default:
      return false;
  }
}

/** The author an event speaks for, or null for a clear (which belongs to nobody). */
export const eventAuthor = (event) => (event[0] === 'x' ? null : opAuthor(event[1]));

/**
 * Apply one event. Strokes merge by point index, so repeated or overlapping
 * pieces of a stroke are harmless. Returns what to draw: null (nothing),
 * { type: 'stroke', op, start } (points from `start` on are new),
 * { type: 'fill', op }, or { type: 'redraw' }.
 */
export function applyEvent(canvas, event) {
  if (!isValidEvent(event)) return null;
  const kind = event[0];
  if (kind === 'x') {
    if (event[1] <= canvas.epoch) return null;
    reset(canvas, event[1]);
    return { type: 'redraw' };
  }
  if (kind === 'u') {
    const op = canvas.byId.get(event[1]);
    canvas.removed.add(event[1]);
    if (!op) return null;
    canvas.byId.delete(op.id);
    canvas.ops.splice(canvas.ops.indexOf(op), 1);
    if (op.kind === 'stroke') canvas.points -= op.points.length / 2;
    return { type: 'redraw' };
  }
  const [, id, epoch] = event;
  if (epoch < canvas.epoch || canvas.removed.has(id)) return null;
  let cleared = false;
  if (epoch > canvas.epoch) {
    // A clear this copy missed: everything before it is gone everywhere else too.
    reset(canvas, epoch);
    cleared = true;
  }
  let op = canvas.byId.get(id);
  if (kind === 'f') {
    if (op || canvas.ops.length >= MAX_OPS) return cleared ? { type: 'redraw' } : null;
    op = { id, kind: 'fill', color: event[3], x: event[4], y: event[5] };
    canvas.ops.push(op);
    canvas.byId.set(id, op);
    return cleared ? { type: 'redraw' } : { type: 'fill', op };
  }
  const points = decodePoints(event[6]);
  const from = event[5];
  if (!op) {
    if (canvas.ops.length >= MAX_OPS || canvas.points >= MAX_CANVAS_POINTS) return cleared ? { type: 'redraw' } : null;
    op = { id, kind: 'stroke', color: event[3], width: event[4], points: [] };
    canvas.ops.push(op);
    canvas.byId.set(id, op);
  } else if (op.kind !== 'stroke') return cleared ? { type: 'redraw' } : null;
  const have = op.points.length / 2;
  // Skip what this copy already has; a gap (missed piece) is joined straight across.
  const skip = Math.max(0, have - from);
  const room = Math.min(MAX_STROKE_POINTS - have, MAX_CANVAS_POINTS - canvas.points);
  const fresh = points.slice(skip * 2, (skip + Math.max(0, room)) * 2);
  if (!fresh.length) return cleared ? { type: 'redraw' } : null;
  op.points.push(...fresh);
  canvas.points += fresh.length / 2;
  return cleared ? { type: 'redraw' } : { type: 'stroke', op, start: have };
}

/** Whether a stroke event has a gap before it: this copy missed part of the stroke. */
export function hasGap(canvas, event) {
  if (event[0] !== 's' || event[2] !== canvas.epoch) return false;
  const op = canvas.byId.get(event[1]);
  return (op ? op.points.length / 2 : 0) < event[5];
}

/** The whole drawing as events, long strokes split so each piece stays small. */
export function snapshotEvents(canvas) {
  const events = [];
  for (const op of canvas.ops) {
    if (op.kind === 'fill') {
      events.push(['f', op.id, canvas.epoch, op.color, op.x, op.y]);
      continue;
    }
    const count = op.points.length / 2;
    for (let from = 0; from < count; from += SEGMENT_POINTS) {
      events.push(['s', op.id, canvas.epoch, op.color, op.width, from, encodePoints(op.points, from, Math.min(count, from + SEGMENT_POINTS))]);
    }
  }
  return events;
}

/** Events packed into groups whose JSON stays within `maxBytes`. */
export function chunkEvents(events, maxBytes) {
  const chunks = [];
  let current = [];
  let size = 2;
  for (const event of events) {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length + 1;
    if (current.length && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

export const canvasSummary = (canvas) => ({ turn: canvas.turn, epoch: canvas.epoch, ops: canvas.ops.length, points: canvas.points });

/** The drawing as plain JSON, for sessionStorage. */
export const serializeCanvas = (canvas) => ({ turn: canvas.turn, epoch: canvas.epoch, events: snapshotEvents(canvas) });

export function restoreCanvas(saved) {
  if (!saved || !Number.isSafeInteger(saved.turn) || saved.turn < 0 || !isEpoch(saved.epoch) || !Array.isArray(saved.events)) return null;
  const canvas = createCanvas(saved.turn);
  canvas.epoch = saved.epoch;
  for (const event of saved.events) {
    if (!isValidEvent(event) || event[0] === 'u' || event[0] === 'x' || event[2] !== saved.epoch) return null;
    applyEvent(canvas, event);
  }
  return canvas;
}

/** The most recent operation by `authorId` that is still on the sheet. */
export function lastOpBy(canvas, authorId) {
  for (let i = canvas.ops.length - 1; i >= 0; i -= 1) {
    if (opAuthor(canvas.ops[i].id) === authorId) return canvas.ops[i];
  }
  return null;
}

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Bucket fill on RGBA pixels ({ data, width, height }), scanline by scanline.
 * Pixels within `tolerance` of the clicked colour on every channel are
 * filled, then the region grows by a pixel to cover anti-aliased edges.
 */
export function floodFill(image, startX, startY, color, tolerance = 48) {
  const { data, width, height } = image;
  const x0 = Math.floor(startX);
  const y0 = Math.floor(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return false;
  const start = (y0 * width + x0) * 4;
  const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
  const [r, g, b] = hexToRgb(color);
  if (Math.abs(target[0] - r) <= 2 && Math.abs(target[1] - g) <= 2 && Math.abs(target[2] - b) <= 2 && target[3] === 255) return false;
  const mask = new Uint8Array(width * height);
  const matches = (pixel) => {
    const i = pixel * 4;
    return Math.abs(data[i] - target[0]) <= tolerance && Math.abs(data[i + 1] - target[1]) <= tolerance &&
      Math.abs(data[i + 2] - target[2]) <= tolerance && Math.abs(data[i + 3] - target[3]) <= tolerance;
  };
  const stack = [x0, y0];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * width;
    if (mask[row + x] || !matches(row + x)) continue;
    let left = x;
    while (left > 0 && !mask[row + left - 1] && matches(row + left - 1)) left -= 1;
    let right = x;
    while (right < width - 1 && !mask[row + right + 1] && matches(row + right + 1)) right += 1;
    for (let i = left; i <= right; i += 1) mask[row + i] = 1;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (let i = left; i <= right; i += 1) {
        const open = !mask[nrow + i] && matches(nrow + i);
        if (open && !inRun) stack.push(i, ny);
        inRun = open;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + x;
      const grown = mask[pixel] === 1 || (x > 0 && mask[pixel - 1] === 1) || (x < width - 1 && mask[pixel + 1] === 1) ||
        (y > 0 && mask[pixel - width] === 1) || (y < height - 1 && mask[pixel + width] === 1);
      if (!grown) continue;
      const i = pixel * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return true;
}
