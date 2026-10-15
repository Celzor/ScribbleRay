/**
 * Refract relays about 20 messages a second per person, in bursts of up to
 * 40, and refuses the rest. The outbox paces everything this copy sends with
 * a slightly stricter bucket of its own, so live drawing, chat, and game
 * state share the allowance without anything being refused.
 *
 * A message sent with a `key` replaces any queued message with the same key,
 * so a burst of state changes leaves only the latest waiting. `data` may be a
 * function, called when the message is actually sent.
 */
export const OUTBOX_RATE = 17;
export const OUTBOX_BURST = 30;
const MAX_RETRIES = 3;
const MAX_QUEUE = 400;

export function createOutbox({ post, now = () => Date.now(), timers = globalThis, rate = OUTBOX_RATE, burst = OUTBOX_BURST }) {
  let tokens = burst;
  let at = now();
  let timer = null;
  let closed = false;
  const queue = [];

  function refill() {
    const time = now();
    tokens = Math.min(burst, tokens + ((time - at) / 1000) * rate);
    at = time;
  }

  function schedule() {
    if (timer !== null || closed || !queue.length) return;
    const wait = Math.max(0, Math.ceil(((1 - tokens) / rate) * 1000));
    timer = timers.setTimeout(pump, wait);
  }

  function dispatch(item) {
    try {
      // A function is evaluated as the message leaves, so time-sensitive fields stay current.
      post(typeof item.data === 'function' ? item.data() : item.data, item.to, (error) => {
        if (closed || !error || !/too fast/i.test(error) || item.tries >= MAX_RETRIES) return;
        // Refract's count and ours drifted apart: back off, then resend this first.
        item.tries += 1;
        refill();
        tokens = Math.min(tokens, 0);
        queue.unshift(item);
        schedule();
      });
    } catch (error) {
      // Too large or otherwise unsendable: drop it rather than block everything behind it.
      console.warn('ScribbleRay could not send a message.', error);
    }
  }

  function pump() {
    timer = null;
    if (closed) return;
    refill();
    while (queue.length && tokens >= 1) {
      tokens -= 1;
      dispatch(queue.shift());
    }
    schedule();
  }

  return {
    send(data, to, { key } = {}) {
      if (closed) return;
      if (key !== undefined) {
        const queued = queue.find((item) => item.key === key);
        if (queued) {
          queued.data = data;
          queued.to = to;
          return;
        }
      }
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push({ data, to, key, tries: 0 });
      if (timer === null) pump();
    },
    /** Messages that could go right now without waiting. */
    available() {
      refill();
      return Math.floor(tokens) - queue.length;
    },
    get backlog() { return queue.length; },
    close() {
      closed = true;
      queue.length = 0;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
