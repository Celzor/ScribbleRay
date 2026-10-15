import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';

/** Small deterministic generator so failures replay exactly. */
export function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Controllable setTimeout/clearTimeout/now. */
export function fakeTimers(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    /** Run every task due within `ms`, in time order, calling `between` after each. */
    advance(ms, between = () => {}) {
      const end = now + ms;
      for (let guard = 0; guard < 200000; guard += 1) {
        let next = null;
        for (const [id, task] of tasks) {
          if (task.at <= end && (!next || task.at < next.task.at || (task.at === next.task.at && id < next.id))) next = { id, task };
        }
        if (!next) break;
        tasks.delete(next.id);
        now = next.task.at;
        next.task.fn();
        between();
      }
      now = end;
      between();
    },
    get pending() { return tasks.size; },
  };
}

export const person = (id) => ({ id, name: `Player ${id}`, avatarUrl: null });

export const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};

/**
 * Refract in memory: relays broadcasts to the others in the session and
 * enforces the server's real rules: JSON under 16 KiB, and a bucket of 40
 * messages refilling at 20 a second for each sender.
 */
export function network(initialIds = [1, 2], { persistence = true, timers = fakeTimers() } = {}) {
  const clients = new Map();
  const queue = [];
  const sent = [];
  const stores = new Map();
  const buckets = new Map();
  const refused = [];
  let memberIds = [...initialIds];
  let sessionId = 'test-session';

  function admit(id) {
    const bucket = buckets.get(id) ?? { tokens: 40, at: timers.now() };
    bucket.tokens = Math.min(40, bucket.tokens + ((timers.now() - bucket.at) / 1000) * 20);
    bucket.at = timers.now();
    buckets.set(id, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function add(id) {
    if (!stores.has(id)) stores.set(id, memoryStorage());
    const client = { view: null, inks: 0, redraws: 0, lines: [] };
    client.session = createSession({
      storage: persistence ? stores.get(id) : null,
      random: seeded(id * 7919),
      now: timers.now,
      timers,
      send(data, to, onResult) {
        const json = JSON.stringify(data);
        assert.ok(new TextEncoder().encode(json).length <= 16 * 1024, `message from ${id} exceeds 16 KiB`);
        if (!admit(id)) {
          refused.push({ from: id, kind: data.kind });
          onResult?.('The activity is sending too fast.');
          return;
        }
        const message = { from: id, data: JSON.parse(json), to };
        queue.push(message);
        sent.push(message);
        onResult?.(null);
      },
      onChange(view) { client.view = view; },
      onInk(change) {
        if (change?.type === 'redraw') client.redraws += 1;
        else client.inks += 1;
      },
      onLine(line) {
        if (line === null) client.lines = [...client.session.lines];
        else client.lines.push(line);
      },
    });
    clients.set(id, client);
    return client;
  }

  function init(id) {
    clients.get(id).session.init({ sessionId, self: person(id), participants: memberIds.map(person) });
  }

  /** Deliver everything queued, including what deliveries cause. */
  function deliver() {
    let count = 0;
    while (queue.length) {
      assert.ok(count < 20000, 'message exchange must settle');
      count += 1;
      const { from, data, to } = queue.shift();
      for (const [id, client] of clients) {
        if (id !== from && (!to || to.includes(id)) && memberIds.includes(id)) client.session.receive(from, structuredClone(data));
      }
    }
  }

  /** Let `ms` pass, delivering messages as they are sent. */
  function run(ms = 0) {
    deliver();
    timers.advance(ms, deliver);
  }

  for (const id of initialIds) add(id);
  for (const id of initialIds) init(id);
  run(10);

  return {
    clients, sent, refused, timers, run, deliver, init,
    get members() { return memberIds; },
    view: (id) => clients.get(id).view,
    session: (id) => clients.get(id).session,
    join(id) {
      memberIds = [...memberIds, id];
      for (const client of clients.values()) client.session.setParticipants(memberIds.map(person));
      add(id);
      init(id);
      run(10);
    },
    leave(id) {
      clients.get(id).session.destroy();
      clients.delete(id);
      memberIds = memberIds.filter((member) => member !== id);
      for (const client of clients.values()) client.session.setParticipants(memberIds.map(person));
      run(10);
    },
    reload(id) {
      clients.get(id).session.destroy();
      add(id);
      init(id);
      run(10);
    },
    store: (id) => stores.get(id),
    newSession(id = 'second-session') {
      sessionId = id;
      for (const member of memberIds) init(member);
      run(10);
    },
  };
}
