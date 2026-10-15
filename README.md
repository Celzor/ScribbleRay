# ScribbleRay

Draw it. Guess it. Laugh about it. ScribbleRay brings a Pictionary-style drawing game to your Refract call: take turns drawing a secret word while everyone races to guess it in the chat. Or open the **whiteboard** and sketch together: everyone draws, or the host presents and hands out pens.

**No game server. No account setup. No runtime dependencies.** Refract supplies identities and relays messages; this app supplies the game.

## Try it locally

With **Node.js 24 or later**:

```sh
npm run dev
```

No `npm install` is needed. Open:

- **[The app](http://127.0.0.1:4173/)**: on its own it is a one-person sketchbook (whiteboard mode) that survives a reload. A game needs at least two players.
- **[Shared activity preview](http://127.0.0.1:4173/tools/preview.html)**: three to four real app frames (Alex hosts; Sam, Taylor, and optionally Jordan join) connected through a local simulation of Refract’s host protocol, including its 16 KiB message limit and its 20-messages-a-second allowance. Play a full game, refresh someone mid-turn, add a latecomer, switch themes, or have the host leave.

For another port: `npm run dev -- --port 4200`. Opening `index.html` directly as a `file:` URL will not load browser modules; use the local server.

## Play in Refract

1. Publish the app at its own **HTTPS origin**, different from your Refract instance. GitHub Pages setup is below.
2. As an instance admin, open **Manage instance → Activities → Add an activity**:

   | Field | Value |
   | --- | --- |
   | Name | ScribbleRay |
   | URL | Your final hosted page URL, including its repository path if applicable |
   | Description | Draw, guess, and doodle together. A drawing-and-guessing game with custom words, plus a shared whiteboard. |

3. Reload Refract so its content security policy picks up the activity origin.
4. Join a voice channel or private call. Open **Activities** in the call panel and select **ScribbleRay**.
5. The first person to open it hosts: they pick the settings, add custom words, and start a game or open the whiteboard. Everyone else who opens it joins in.

For development, register `http://127.0.0.1:4173/` on a non-production Refract instance or one with developer mode enabled. A loopback URL points at the machine running each browser, so use HTTPS hosting to play with friends on other machines.

The URL must be its final origin; redirects to another domain break Refract’s origin checks. Hosting must allow framing by your Refract instance. If you configure `CSP_DIRECTIVES` manually in Refract, include the activity origin in `frame-src`.

## Publish on GitHub Pages

The included [workflow](.github/workflows/pages.yml) checks the JavaScript, runs the tests, builds a public-only `dist/`, and deploys it when changes reach `main`. Pull requests run checks without deploying.

1. Push this project to its GitHub repository.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run **Check and deploy Pages** from Actions, or push to `main` after enabling Pages.
4. Copy the deployed URL from the workflow and register it in Refract.

For a repository named `Celzor/ScribbleRay`, the default project URL would be `https://celzor.github.io/ScribbleRay/`. This is the expected address, not a claim that Pages has already been enabled or published. All asset URLs are relative, so repository subpaths work.

Alternatively, run `npm run build` and serve **only `dist/`** from any static HTTPS host. Never deploy the whole working directory. The build has an explicit public-file allowlist ([`tools/public-files.js`](tools/public-files.js)); tests, tooling scripts, and local configuration stay out of the output.

## How to play

### Guess the drawing

Each round, everyone takes a turn as the drawer. The drawer picks one of a few words (or gets one at random after 15 seconds) and draws it; nobody else sees the word. Everyone else types guesses in the chat:

- **Right:** you score, the chat announces that you got it (never the word itself), and the word appears in your header. Your chat now only reaches the drawer and others who have guessed it, so you can’t give it away.
- **Close** (one letter off, or two in a long word): a “So close!” bubble pops up over your guess box, for you alone. Everyone else sees the guess as ordinary chat, never that it was close.
- **Wrong:** everyone sees it, like normal chat.

Guesses ignore case, accents, spaces, and punctuation: “Ice-Cream” matches “ice cream”. A turn ends when everyone has guessed or time runs out; the word is revealed with the points for that turn, and the next drawer starts six seconds later. Players who join mid-game get a turn in the current round.

**Scoring.** A correct guess earns 50 to 350 points: more the faster you guess, plus a bonus for the first five to get it. The drawer earns the guessers’ average, counting anyone who missed as zero, so a drawing that everyone gets quickly is worth the most.

**Sound.** Short, quiet effects follow the game: a chime when it’s your turn to draw, a flourish when you guess the word (and a softer ding when someone else does), a private nudge for a near miss, a clock ticking through the last ten seconds, a falling tone when time runs out, and a drum roll and fanfare as the winner is revealed. They are synthesized in the browser, so there is nothing to download. The speaker button at the top mutes them, and each browser remembers its choice. Sound plays only while the activity is on screen, and never catches up on what happened while it was muted or hidden.

**Drawing tools:** 22 colours, four brush sizes, eraser, bucket fill, undo, and clear. Shortcuts: **B** brush, **E** eraser, **F** fill, **[** / **]** size, **Ctrl+Z** undo. Clear asks for a second click, since Refract’s sandbox has no confirmation dialogs.

**A little celebration.** Fresh turns get a stamped prompt; correct guesses get cut-paper confetti and score pops; the winner gets a rosette reveal timed to the fanfare. Reloads and resyncs do not replay celebrations. Reduced-motion preferences keep the feedback still, and hidden tabs do not accumulate effects. Drawing controls also support **Arrow keys**, **Home**, and **End** within each colour, brush-size, or tool group.

**Host settings** (in the lobby, or between games):

| Setting | Options | What it does |
| --- | --- | --- |
| Game ends | After rounds · First to a score | Play a fixed number of rounds, or until someone reaches a target. A score game still stops after 20 rounds. |
| Rounds | 1–10 (default 3) | Every player draws once per round. |
| Points to win | 1,000 · 1,500 · 2,000 · 3,000 · 5,000 | The target for a score game; the game ends as soon as a turn takes someone past it. |
| Drawing time | 30 s – 4 min (default 80 s) | The round timer for each turn. |
| Word choices | 1–5 (default 3) | Words the drawer picks from. With one, drawing starts straight away. |
| Hints | None, 1–4 letters (default 2) | Letters revealed at even intervals as time runs down. Hints never reveal half the word. |
| Words | Built-in · Built-in + custom · Custom only | The built-in list has over 400 drawable words. |
| Custom words | Up to 400 words, each up to 32 characters | One per line, or separated by commas. Duplicates are dropped. The host’s browser remembers its last list for next time. |

During a game, the host can **skip a turn** (say, for someone who stepped away) or **end the game**. When it ends, a drum roll and confetti reveal the winner with the final scores; the host can play again with the same settings or go back to the lobby.

### Whiteboard

The host opens a shared sheet from the lobby. **Who can draw** is the host’s call:

- **Everyone**: anyone can draw at once.
- **Host and chosen people**: the host draws and presents; a pen button beside each person in the list hands them a pen or takes it back.

Everyone can undo their own strokes; only the host clears the sheet. A latecomer receives the whole picture as soon as they open the activity.

## How the integration works

The wire contract is **`refract-activity/1`**, through the small, dependency-free [bridge](src/bridge.js) shared with [refract-tack-toe](https://github.com/Celzor/refract-tack-toe). The bridge also uses two parts of the protocol that tic-tac-toe doesn’t: numbered broadcasts (so Refract reports any message it refused) and full screen. Messages within the activity use `scribbleray/1`, the Refract session ID, and the elected host ID.

```text
Activity frame       Refract host         Other participants
      ready ────────────► │
            ◄──── init   │  self, participants, sessionId, theme
      broadcast ────────►│──── message ───────────►
            ◄── message │◄──── broadcast ─────────
```

A drawing game has a secret, and live drawing is chatty, so a few design points matter:

- **The first participant is the host.** Only the host’s copy holds the table, including the word. It runs the clock, picks words, and sends each participant a view made for them: the drawer’s includes the word and the choices, a correct guesser’s includes the word, and everyone else gets blanks and revealed hints. Guesses go to the host alone, never to the other players, so a correct answer is never relayed.
- **Drawing goes straight from the artist to everyone.** Strokes are integers on a fixed 1000 × 750 sheet, delta-encoded and batched about every 50 ms, so a stroke costs a few messages rather than hundreds. Each copy checks that a stroke is from the current drawer (or anyone, on the whiteboard) and that people only undo their own work. Strokes merge by point index, so a repeated or overlapping piece is harmless, and clears are numbered so a stroke begun before a clear can’t come back after it.
- **Staying under Refract’s limits.** Refract relays about 20 messages a second per person, in bursts of up to 40, and refuses the rest. Everything a copy sends goes through an [outbox](src/outbox.js) that paces itself slightly under that. State updates queued during a burst collapse into the latest one, drawing waits for a free slot (and simply carries more points when it gets one), and anything Refract still refuses is resent. The host batches chat lines, and limits anyone flooding the chat to two lines a second. Every message stays under 16 KiB.
- **Latecomers and reloads** ask the host for a snapshot. The host replies with their view, the custom word list if theirs is out of date, and the whole picture in as many messages as it needs, typically one or two. Drawing that crosses the snapshot in flight merges back in. If a copy notices it missed part of a stroke, it asks again. A small periodic sync recovers anything else that was dropped.
- **When the host leaves**, the next participant takes over and asks everyone for their latest view. A turn in progress carries on if the drawer (or anyone who already guessed) can vouch for the word; otherwise it ends without points. The timer, scores, round, and turn order carry on, and the new host already has the picture. The same recovery runs if the host reloads without `sessionStorage`, borrowing the picture from another participant.
- **Storage.** The host keeps the table and the picture in `sessionStorage`, scoped by session ID and user, so a host reload resumes the same turn with the same word. Everyone keeps their recent chat. In its own tab, the app is a sketchbook whose drawing survives a reload.

Names and chat are rendered as text. No Refract credentials or tokens are requested.

This is a cooperative casual-game protocol, not an anti-cheat service: the host’s browser is trusted to keep the word, check guesses fairly, and score; on the whiteboard, each person’s own page enforces whether they hold a pen. There is no backend referee.

| File | Responsibility |
| --- | --- |
| [`src/rules.js`](src/rules.js) | Pure game rules: phases, turn order, word choice, hints, scoring, end conditions, roster changes, whiteboard pens, per-player views, validation, and host hand-over |
| [`src/words.js`](src/words.js) | The built-in list, custom list parsing and limits, guess matching, near-miss detection, and hint masks |
| [`src/canvas.js`](src/canvas.js) | The shared drawing: compact stroke events, merging, undo and clears, caps, snapshots, and bucket fill |
| [`src/session.js`](src/session.js) | Refract session: host authority, per-player views, guess routing, live drawing, catch-up, recovery, and storage |
| [`src/outbox.js`](src/outbox.js) | Pacing every message under Refract’s rate limit |
| [`src/board.js`](src/board.js) | The visible sheet: rendering at screen resolution and turning pointer input into strokes |
| [`src/sound.js`](src/sound.js) | Sound effects: synthesized cues, the closing seconds’ ticks, and mute, without replaying history |
| [`src/celebrations.js`](src/celebrations.js) | Visual game moments, score pops, and confetti, with reduced-motion support and no replay of restored state |
| [`src/bridge.js`](src/bridge.js) | Refract postMessage boundary |
| [`src/app.js`](src/app.js) | UI and wiring |
| [`tools/preview.html`](tools/preview.html) | Multi-frame Refract protocol simulator |
| [`tests/`](tests/) | Rules (including randomized whole games), words, drawing, pacing, synchronization over a simulated relay, sound cues, bridge, page markup, and static-serving checks |

## Development checks

```sh
npm run check
npm test
npm run build
```

The suite uses Node’s built-in runner and an in-memory Refract relay that enforces the real message size and rate limits, with fake timers, and without a real Refract account. Among other things, it checks that the word never reaches a guesser before they guess it, that heavy drawing by several people at once is never refused, and that every copy of a drawing ends up identical. In environments that forbid child processes, run `node --test --test-isolation=none` instead.

An optional browser smoke test plays a full game in the multiplayer preview (word choice, drawing, guessing, reveals, and results), then the whiteboard with a latecomer, pen hand-outs, and the host leaving:

```sh
# Start npm run dev in another terminal first.
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tools/browser-check.mjs
node tools/layout-check.mjs
```

Both accept `TEST_URL` (defaults to `http://127.0.0.1:4173/`), `PLAYWRIGHT_MODULE` for an existing Playwright installation, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing Chromium-based browser such as Edge or Chrome. Screenshots go to the ignored `artifacts/` folder. The layout check covers desktop, tablet, and phone frames, canvas bounds, keyboard tool selection, and the empty-sheet invitation. A protocol simulator verifies the app’s side of the contract; final acceptance uses signed-in users in an actual Refract call.

## License

GNU GPL v3, matching refract-tack-toe, whose bridge and tooling this project adapts. See [LICENSE](LICENSE).
