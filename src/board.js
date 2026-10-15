import { HEIGHT, PAPER, WIDTH, floodFill } from './canvas.js';

const MAX_PIXELS_WIDE = 2000;
/** Ignore pointer moves smaller than this, in sheet units, to keep strokes light. */
const MIN_STEP = 2;

/**
 * The visible sheet: draws the shared canvas model onto a <canvas> at the
 * screen's resolution, and turns pointer input into strokes and fills.
 * `api` is the session (beginStroke, extendStroke, fill) plus getCanvas().
 */
export function createBoard({ paper, sheet, element, cursor, api }) {
  const context = element.getContext('2d', { willReadFrequently: true });
  let scale = 1;
  let enabled = false;
  let tool = { kind: 'pen', color: '#000000', size: 9 };
  let active = null;

  function toSheet(event) {
    const rect = element.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * WIDTH);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * HEIGHT);
    return [Math.min(WIDTH - 1, Math.max(0, x)), Math.min(HEIGHT - 1, Math.max(0, y))];
  }

  function drawStroke(op, start = 0) {
    const points = op.points;
    const count = points.length / 2;
    if (!count) return;
    context.save();
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.strokeStyle = op.color;
    context.fillStyle = op.color;
    context.lineWidth = op.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (count === 1) {
      context.beginPath();
      context.arc(points[0], points[1], op.width / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      const from = Math.max(0, start - 1);
      context.beginPath();
      context.moveTo(points[from * 2], points[from * 2 + 1]);
      for (let i = from + 1; i < count; i += 1) context.lineTo(points[i * 2], points[i * 2 + 1]);
      if (from + 1 >= count) context.lineTo(points[from * 2] + 0.01, points[from * 2 + 1]);
      context.stroke();
    }
    context.restore();
  }

  function drawFill(op) {
    const image = context.getImageData(0, 0, element.width, element.height);
    if (floodFill(image, op.x * scale, op.y * scale, op.color)) context.putImageData(image, 0, 0);
  }

  function redraw() {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = PAPER;
    context.fillRect(0, 0, element.width, element.height);
    for (const op of api.getCanvas().ops) {
      if (op.kind === 'fill') drawFill(op);
      else drawStroke(op);
    }
  }

  /** Size the sheet to the largest 4:3 box that fits, then repaint at that resolution. */
  function fit() {
    const box = sheet.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const width = Math.max(120, Math.floor(Math.min(box.width, (box.height * WIDTH) / HEIGHT)));
    const height = Math.round((width * HEIGHT) / WIDTH);
    paper.style.width = `${width}px`;
    paper.style.height = `${height}px`;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
    const pixels = Math.min(MAX_PIXELS_WIDE, Math.round(width * ratio));
    if (element.width !== pixels) {
      element.width = pixels;
      element.height = Math.round((pixels * HEIGHT) / WIDTH);
      scale = element.width / WIDTH;
      redraw();
    }
    updateCursorSize();
  }

  function apply(change) {
    if (!change) return;
    if (change.type === 'redraw') redraw();
    else if (change.type === 'stroke') drawStroke(change.op, change.start);
    else if (change.type === 'fill') drawFill(change.op);
  }

  // ---- input ----

  function updateCursorSize() {
    const rect = element.getBoundingClientRect();
    const size = Math.max(4, (tool.size * rect.width) / WIDTH);
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
    cursor.classList.toggle('fill', tool.kind === 'fill');
  }

  function moveCursor(event) {
    if (!enabled || event.pointerType === 'touch') {
      cursor.hidden = true;
      return;
    }
    const rect = paper.getBoundingClientRect();
    cursor.hidden = false;
    cursor.style.left = `${event.clientX - rect.left}px`;
    cursor.style.top = `${event.clientY - rect.top}px`;
  }

  function strokeColor() {
    return tool.kind === 'eraser' ? PAPER : tool.color;
  }

  function finish() {
    if (active && element.hasPointerCapture?.(active.pointer)) element.releasePointerCapture(active.pointer);
    active = null;
  }

  element.addEventListener('pointerdown', (event) => {
    if (!enabled || active || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const [x, y] = toSheet(event);
    if (tool.kind === 'fill') {
      api.fill(x, y, tool.color);
      return;
    }
    const id = api.beginStroke(strokeColor(), tool.size, x, y);
    if (!id) return;
    active = { id, pointer: event.pointerId, last: [x, y] };
    element.setPointerCapture?.(event.pointerId);
  });

  element.addEventListener('pointermove', (event) => {
    moveCursor(event);
    if (!active || event.pointerId !== active.pointer) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    const points = [];
    for (const sample of samples.length ? samples : [event]) {
      const [x, y] = toSheet(sample);
      if (Math.hypot(x - active.last[0], y - active.last[1]) < MIN_STEP) continue;
      points.push(x, y);
      active.last = [x, y];
    }
    if (points.length && !api.extendStroke(active.id, points)) finish();
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.addEventListener(type, (event) => {
      if (active && event.pointerId === active.pointer) finish();
    });
  }
  element.addEventListener('pointerleave', () => { cursor.hidden = true; });
  element.addEventListener('contextmenu', (event) => event.preventDefault());

  const observer = new ResizeObserver(() => fit());
  observer.observe(sheet);

  return {
    apply,
    fit,
    redraw,
    setEnabled(on) {
      enabled = on;
      paper.classList.toggle('can-draw', on);
      if (!on) {
        finish();
        cursor.hidden = true;
      }
    },
    setTool(next) {
      tool = { ...tool, ...next };
      updateCursorSize();
    },
    get tool() { return { ...tool }; },
    destroy() { observer.disconnect(); },
  };
}
