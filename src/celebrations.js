// A little theatre for new moments, never for a restored or resynchronised game.
const INKS = ['#f45237', '#f6cb49', '#83cbb4', '#f7f0dc', '#27251f'];

export function createMomentTracker() {
  let previous = null;
  return {
    reset() { previous = null; },
    observe({ view, connected, selfId, hidden = false }) {
      if (!view || !connected) {
        previous = null;
        return null;
      }
      const before = previous;
      previous = {
        phase: view.phase,
        turn: view.turn,
        guessed: new Set((view.guessed ?? []).map((entry) => entry.id)),
        scores: new Map((view.players ?? []).map((player) => [player.id, player.score])),
      };
      if (!before || hidden) return null;
      const changed = before.phase !== view.phase || before.turn !== view.turn;
      const sameTurn = before.turn === view.turn;
      const correct = sameTurn && ['drawing', 'reveal'].includes(view.phase)
        ? (view.guessed ?? []).filter((entry) => !before.guessed.has(entry.id)) : [];
      return {
        turn: changed && view.phase === 'choosing' && view.drawer === selfId,
        drawing: changed && view.phase === 'drawing',
        reveal: changed && view.phase === 'reveal',
        finale: changed && view.phase === 'results' && (view.winners?.length ?? 0) > 0,
        perfect: changed && view.phase === 'reveal' && view.result?.reason === 'all',
        correct,
        scores: sameTurn ? (view.players ?? []).flatMap((player) => {
          const prior = before.scores.get(player.id);
          return prior !== undefined && player.score > prior ? [{ id: player.id, points: player.score - prior }] : [];
        }) : [],
      };
    },
  };
}

export function createCelebrations({ paper, people, card, nameOf, rollSeconds = 1.2 }) {
  const tracker = createMomentTracker();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Set();
  const animations = new Set();
  const layer = document.createElement('div');
  layer.className = 'moment-layer';
  layer.setAttribute('aria-hidden', 'true');
  paper.append(layer);
  let toast = null;
  let currentTurn = null;

  function later(fn, delay) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer);
    return timer;
  }

  function animate(node, frames, options) {
    if (reduced.matches || document.hidden || !node?.animate) return;
    const animation = node.animate(frames, options);
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
  }

  function clear() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const animation of animations) animation.cancel();
    animations.clear();
    layer.replaceChildren();
    toast = null;
    people.querySelectorAll('.score-pop').forEach((node) => node.remove());
    card.classList.remove('celebrate', 'moment-enter');
  }

  function stamp(title, caption, kind = 'correct') {
    if (document.hidden) return;
    toast?.remove();
    toast = document.createElement('div');
    toast.className = `moment-stamp moment-${kind}`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = caption;
    toast.append(heading, detail);
    layer.append(toast);
    const current = toast;
    later(() => { current.remove(); if (toast === current) toast = null; }, 2400);
  }

  function burst({ full = false, origin = 50, delay = 0 } = {}) {
    if (reduced.matches || document.hidden) return;
    const pieces = document.createElement('div');
    pieces.className = `paper-burst${full ? ' paper-finale' : ''}`;
    const count = full ? 58 : 20;
    const width = Math.min(paper.clientWidth, full ? 760 : 360);
    for (let index = 0; index < count; index += 1) {
      const piece = document.createElement('i');
      piece.style.setProperty('--ink', INKS[index % INKS.length]);
      piece.style.setProperty('--origin', `${full ? 10 + Math.random() * 80 : origin}%`);
      piece.style.setProperty('--dx', `${(Math.random() - 0.5) * width}px`);
      piece.style.setProperty('--lift', `${-(40 + Math.random() * (full ? 170 : 100))}px`);
      piece.style.setProperty('--drop', `${Math.max(160, paper.clientHeight * (full ? 1.15 : 0.65))}px`);
      piece.style.setProperty('--spin', `${(Math.random() - 0.5) * 1100}deg`);
      piece.style.setProperty('--wait', `${delay + Math.random() * 0.18}s`);
      piece.style.setProperty('--flight', `${1.5 + Math.random() * 1.1}s`);
      pieces.append(piece);
    }
    layer.append(pieces);
    later(() => pieces.remove(), (delay + 3) * 1000);
  }

  function popScore({ id, points }) {
    const row = [...people.children].find((node) => node.dataset.person === String(id));
    if (!row) return;
    const pop = document.createElement('span');
    pop.className = 'score-pop';
    pop.setAttribute('aria-hidden', 'true');
    pop.textContent = `+${points.toLocaleString()}`;
    row.append(pop);
    later(() => pop.remove(), 1800);
    animate(row, [
      { backgroundColor: '#83cbb4', transform: 'translateX(-3px)' },
      { backgroundColor: 'transparent', transform: 'translateX(0)' },
    ], { duration: 850, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function onVisibility() { if (document.hidden) clear(); }
  function onMotion() { if (reduced.matches) clear(); }
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', onMotion);

  return {
    observe(state) {
      const turn = state.view?.turn ?? null;
      if ((currentTurn !== null && currentTurn !== turn) || !state.connected || !state.view || ['lobby', 'board'].includes(state.view.phase)) clear();
      currentTurn = turn;
      return tracker.observe({ ...state, hidden: document.hidden });
    },
    play(moments, { view, selfId }) {
      if (!moments || document.hidden) return;
      if (moments.turn || moments.reveal) {
        card.classList.add('moment-enter');
        later(() => card.classList.remove('moment-enter'), 650);
      }
      if (moments.drawing) {
        stamp(view.drawer === selfId ? 'Make your mark.' : 'Eyes on the drawing.',
          view.drawer === selfId ? 'Your time to shine.' : `${nameOf(view.drawer)} has the pen.`, 'turn');
      }
      for (const score of moments.scores) popScore(score);
      const own = moments.correct.find((entry) => entry.id === selfId);
      if (own) {
        stamp('Nailed it!', `+${own.points.toLocaleString()} points. Nice eye.`);
        burst();
      } else if (moments.correct.length) {
        // Keep the drawing clear for everyone still guessing.
        burst({ origin: 86 });
      }
      if (moments.perfect && !own) burst({ origin: 50 });
      if (moments.finale) burst({ full: true, delay: rollSeconds });
    },
    reset() { tracker.reset(); currentTurn = null; clear(); },
    destroy() {
      clear();
      layer.remove();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onMotion);
    },
  };
}
