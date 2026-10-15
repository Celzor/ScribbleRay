/** The dependency-free activity side of Refract's public postMessage protocol. */
export const ACTIVITY_PROTOCOL = 'refract-activity/1';
export const MAX_MESSAGE_BYTES = 16 * 1024;
// Refract answers a numbered broadcast with a result; forget any it never answers.
const RESULT_TIMEOUT_MS = 30000;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isUser = (value) => isRecord(value) && isId(value.id) && typeof value.name === 'string' && (value.avatarUrl === null || typeof value.avatarUrl === 'string');
export const isRoster = (value) => Array.isArray(value) && value.every(isUser) && new Set(value.map((person) => person.id)).size === value.length;

export function connectActivity({ onInit, onParticipants, onMessage, onFullscreen, scope = window, now = () => Date.now() }) {
  const host = scope.parent;
  let origin = null;
  let active = true;
  let initialized = false;
  let lastId = 0;
  const pending = new Map();
  const post = (message) => {
    if (active && host !== scope) host.postMessage({ protocol: ACTIVITY_PROTOCOL, ...message }, origin ?? '*');
  };
  const listener = (event) => {
    if (!active || host === scope || event.source !== host || (origin !== null && event.origin !== origin)) return;
    const message = event.data;
    if (!isRecord(message) || message.protocol !== ACTIVITY_PROTOCOL) return;
    if (message.type === 'init') {
      if (typeof message.sessionId !== 'string' || !message.sessionId || !isId(message.channelId) || !isUser(message.self) || !isRoster(message.participants) || !message.participants.some((person) => person.id === message.self.id) || !['dark', 'light'].includes(message.theme)) return;
      // Only a valid initialization from the framing window establishes trust.
      // Refract's host has a normal origin, never an opaque sandbox origin.
      if (!event.origin || event.origin === 'null') return;
      origin = event.origin;
      initialized = true;
      onInit(message);
    } else if (initialized && message.type === 'participants' && isRoster(message.participants)) {
      onParticipants(message.participants);
    } else if (initialized && message.type === 'message' && isId(message.from) && 'data' in message) {
      onMessage(message.from, message.data);
    } else if (initialized && message.type === 'result' && Number.isSafeInteger(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry?.callback(typeof message.error === 'string' ? message.error : null);
    } else if (initialized && message.type === 'fullscreen' && typeof message.on === 'boolean') {
      onFullscreen?.(message.on);
    }
  };
  scope.addEventListener('message', listener);
  post({ type: 'ready' });
  return {
    ready: () => post({ type: 'ready' }),
    /** With `onResult`, Refract reports whether it relayed the message: null, or why it refused. */
    broadcast(data, to, onResult) {
      if (!active || !initialized) return;
      const encoded = JSON.stringify(data);
      if (encoded === undefined || new TextEncoder().encode(encoded).length > MAX_MESSAGE_BYTES) throw new Error('Activity messages must be JSON of at most 16 KiB.');
      if (to !== undefined && (!Array.isArray(to) || !to.every(isId))) throw new Error('Recipients must be Refract user IDs.');
      let id;
      if (typeof onResult === 'function') {
        const stale = now() - RESULT_TIMEOUT_MS;
        for (const [key, entry] of pending) if (entry.at < stale) pending.delete(key);
        lastId += 1;
        id = lastId;
        pending.set(id, { callback: onResult, at: now() });
      }
      post({ type: 'broadcast', data, ...(to === undefined ? {} : { to }), ...(id === undefined ? {} : { id }) });
    },
    setFullscreen: (on) => post({ type: 'fullscreen', on: !!on }),
    close: () => post({ type: 'close' }),
    destroy() {
      active = false;
      pending.clear();
      scope.removeEventListener('message', listener);
    },
  };
}
