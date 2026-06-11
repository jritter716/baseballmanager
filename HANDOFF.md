# Baseball Scoring App — Engineering Handoff

A handoff for picking the project up in Claude Code. It covers what exists, the
load-bearing design decisions, where the bodies are buried, and a prioritized
roadmap with concrete starter tasks.

---

## What this is

An **open, event-sourced baseball scoring and team-management app**, modeled on
GameChanger but built around the thing GameChanger won't do: **let users get
their raw data out**. Near-term users are the coaches and parents of one youth
team (the owner's son's), with the door left open to a commercial product later.

Two GameChanger-parity capabilities anchor the product: **live pitch-by-pitch
scoring** and **live game-following** for people not at the field. The wedge is
that the underlying event log is exportable as CSV/JSON, first-class.

---

## Current status at a glance

- **Engine + backend** (`/src`): TypeScript, strict, zero runtime dependencies.
- **Live scoring web app** (`/web/scoring-app.html`): event-driven UI that
  **imports the compiled engine** (`web/dist/engine.js`, bundled from
  `src/client.ts` by `npm run build:web`) — no engine logic lives in the page.
  Now an **offline-first, installable PWA wired to the backend**: events apply
  locally instantly, queue in localStorage, POST to the server, and reconcile on
  reconnect. A **live follower view** (`/web/follower.html`) streams the game to
  spectators over SSE. Served same-origin by `npm run serve`.
- **Tests**: `npm test` runs four suites — **122 assertions, all passing**
  (engine 67, Retrosheet replay 27, decisions 12, sync/store 16). A fifth,
  `test:server`, is an in-process HTTP/SSE integration test that needs a
  bindable socket (it was not runnable in the authoring sandbox, but type-checks
  and is ready to run locally).

---

## Architecture: one idea, then principles

**The single source of truth is an append-only log of `GameEvent`s. Everything
else is derived by folding that log with pure functions.** Live state, box
scores, pitch counts, win/loss/save, export, and the follower broadcast are all
*projections* of the same log.

Principles that follow from this (don't break these without a reason):

1. **The reducer is pure and deterministic.** `reduce(setup, events)` has no side
   effects and no hidden inputs, so the *same* code runs on the scorer's device
   (instant local state) and on the server (authoritative recompute). They must
   agree to the digit — that agreement is what makes offline-first safe.
2. **Record observations, derive everything.** Events capture what the scorer
   saw (a pitch, a play, a substitution). Never store computed numbers.
3. **Pitches never end a plate appearance.** A `pitch` only updates the count and
   pitch tally; ball four / strike three are resolved by an explicit `pa_result`
   the UI emits. This concentrates PA-ending logic in one place and makes the
   dropped-third-strike case natural.
4. **Default-and-override runner movement.** `pa_result` may omit `runners`; the
   engine fills standard movements for the outcome. The scorer supplies explicit
   `runners` only for non-routine plays. (The override UI is **not built yet** —
   see gaps.)
5. **Projections are separate folds.** `stats` and `decisions` fold the same log
   independently of `reduce`, so adding a new metric never touches play-state
   logic.
6. **Move application is two-pass.** `applyRunnerMoves` vacates every origin base
   before placing any destination, so a forced runner frees a base before the
   batter fills it. (This was the consecutive-walk bug; there's a regression
   test. Preserve this if you touch move logic.)
7. **League rules are config, not code.** Pitch-count limits / rest tiers live in
   `LeagueRules` (`pitching.ts`); hardcode the owner's league for now.
8. **Opponents persist; player names are optional.** Opposing players are real
   `Player` records with everything but jersey number nullable (lazy entry).

---

## Repository layout

```
baseball-engine/
├── src/
│   ├── types.ts        # GameEvent union, GameState, RunnerMove, GameSetup, etc.
│   ├── reducer.ts      # apply() + reduce(): the pure fold -> GameState
│   ├── defaults.ts     # default runner movements per outcome
│   ├── validate.ts     # reject impossible events before they corrupt state
│   ├── stats.ts        # batting/pitching/fielding projection + earned runs
│   ├── pitching.ts     # league pitch-count rules, rest tiers, eligibility
│   ├── decisions.ts    # win / loss / save attribution
│   ├── lineup.ts       # resolve current batter/pitcher/fielders; subs
│   ├── retrosheet.ts   # parse + replay Retrosheet event files (test oracle)
│   ├── sync.ts         # offline-first reconciliation (device side, pure)
│   ├── store.ts        # authoritative event store: idempotent append + views
│   ├── server.ts       # HTTP sync endpoints + SSE follower stream (gap-resume)
│   ├── index.ts        # full public API surface (Node: includes store/server)
│   └── client.ts       # browser/mobile-safe entrypoint (pure pieces, no Node deps)
├── tests/
│   ├── run.ts              # engine: scoring rules, walks, pitch limits, validation
│   ├── retrosheet.test.ts  # replay a hand-built game; ER matches data,er records
│   ├── decisions.test.ts   # W/L/S across complete-game, save, reliever-win
│   ├── sync.test.ts        # merge logic + idempotent store append
│   ├── server.test.ts      # in-process HTTP/SSE integration (needs a socket)
│   └── sync-client.test.mjs # offline queue + reconcile (drives the real store)
├── web/
│   ├── scoring-app.html # live-scoring UI; offline-first, backend-wired PWA
│   ├── follower.html    # read-only live follower (SSE, gap-resume)
│   ├── sync-client.js   # offline-first event queue + reconciliation glue
│   ├── playlog.js       # shared play-by-play formatter (scorer + follower)
│   ├── sw.js            # service worker (app-shell cache for offline launch)
│   ├── manifest.webmanifest # PWA manifest
│   ├── icon-192.png / icon-512.png # app icons (generated by scripts/make-icons.mjs)
│   └── dist/engine.js   # generated ESM bundle of src/client.ts (gitignored)
├── README.md            # fuller architecture notes
├── package.json         # scripts: build, test, test:server, serve
└── tsconfig.json
```

---

## Core data shapes (the engine contract)

```ts
type GameEvent =
  | { type: "pitch"; seq; pitcher; result }                    // count + pitch tally only
  | { type: "pa_result"; seq; batter; pitcher; outcome;        // ends a plate appearance
      fielders?; errors?; runners? }                           // runners optional -> defaults
  | { type: "baserunning"; seq; kind; pitcher?; errors?; runners }  // SB/CS/WP/PB/balk/pickoff
  | { type: "substitution"; seq; team; kind; slot; playerIn; playerOut?; position? };

interface RunnerMove {                  // the heart of correct stat derivation
  id; from: Base | "batter"; to: Base | "home" | "out";
  outBy?: Position[];                   // last = putout, earlier = assists
  rbiTo?: PlayerId;                     // who is credited an RBI for a run on this move
  onError?: boolean;                    // run is unearned / batter reached on error
  wouldHaveBeenOut?: boolean;           // drives earned-run "reconstructed third out"
}

interface GameState {                   // derived; never stored
  inning; half; outs; count{balls,strikes};
  bases: { 1?:PlayerId; 2?:PlayerId; 3?:PlayerId };   // who is on each base
  score{away,home}; battingTeam; order{away,home}; pitcher{away,home};
  pitchCount: Record<PlayerId, number>; lineup;
}

// Setup the game is initialized with (lineups, league):
interface GameSetup { away: TeamLineup; home: TeamLineup; regulationInnings? }
```

Sync/transport adds a stable id: `type EventEnvelope = GameEvent & { id: string }`.
The server assigns the authoritative `seq` on append; `reduce` orders by `seq`.

---

## What's built and verified

- **Scoring engine** — full outcome set, baserunning, substitutions, half-inning
  flips, batting-order tracking. Verified against a hand-built inning and a
  consecutive-walk regression.
- **Stats** — AVG/OBP/SLG/OPS, ERA/WHIP/IP, fielding PO/A/E, earned-run
  reconstruction, RBI rules (no RBI on DP/error).
- **Pitch-count rules** — daily max, rest tiers, next-boundary, cross-game
  eligibility (`pitching.ts`).
- **Win/loss/save** — pitcher of record at the permanent go-ahead; starter
  5-inning rule; save conditions.
- **Retrosheet replay harness** — parses real Retrosheet notation and folds it
  through the engine; the headline test confirms computed ER equals the file's
  own `data,er` records. This is the correctness oracle for hardening the rules.
- **Backend** — idempotent append store, derived views, offline-first merge, and
  an SSE follower stream with `Last-Event-ID` gap-resume.
- **Live scoring UI** — pitches/outcomes emit real events; count, outs, bases,
  score, pitch-count bar, and play-by-play all read from `reduce`; undo pops the
  last action and re-folds; on-base panel records steals/caught-stealing; export
  drawer shows the raw event stream + CSV/JSON. **Runner-advancement override**
  ("Adjust runners" sheet) lets the scorer correct non-routine baserunning while
  routine plays stay one tap.

---

## Known limitations and documented gaps

These are intentional and documented in code/README, not oversights:

- **Earned-run reconstruction** approximates complex multi-error innings (relies
  on the scorer flagging `onError` / `reached_on_error` / `wouldHaveBeenOut`).
- **Third-out timing** — a run scoring on the same play as the third out is
  counted as listed in the move list rather than fully modeling the force-out
  timing rule.
- **Retrosheet parser is a high-frequency subset** — it throws loudly on
  unsupported tokens (fail-safe). Widening coverage is roadmap work.
- **Fielding PO/A on complex plays is approximate** (matches Retrosheet's own
  note that defensive data is least-proofed).
- **Win/L/S judgment clauses** — starter-under-5 reassignment picks the most-used
  reliever; the save "3 effective innings" / "tying run on deck" clauses are
  approximated. The ≤3-run-lead + 1-inning save clause is exact.
- **Runner-advancement override UI — built (Phase 2).** The scorer can adjust
  where each runner ends up (hold/advance/score/out) and flag errors, via the
  "Adjust runners" sheet (`src/runners.ts` + UI). Remaining minor approximation:
  overridden outs don't capture the specific fielder (`outBy`), so PO/A on those
  plays isn't credited; double steals are still entered as individual steals.
- **Sync is single-writer-friendly** — idempotent dedup covers the one-scorer
  case; true multi-writer conflict resolution would need more.
- **Undo only removes un-synced events** — once an event is acknowledged by the
  server it can't be popped (the log is append-only). Editing/correcting synced
  events is future work (it pairs naturally with the runner-override UI). The
  scorer can still undo freely while offline, where nothing is synced yet.
- **No auth/accounts yet.** **COPPA** (data about minors) is deferred while the
  app serves one known team; revisit before any public signup.
- **Store durability (Phase 3)** — the server persists to an append-only JSONL
  log (`STORE_FILE`, default `data/games.jsonl`), fsync'd on append, re-folded on
  startup; games survive a restart. Still single-file/single-node; a real DB
  would be the move for multi-node or large scale, but isn't needed yet.

---

## Build / test / run

```bash
npm install
npm test          # tsc + engine, retrosheet, decisions, sync suites (122 assertions)
npm run test:server   # in-process HTTP/SSE integration test (needs a bindable socket)
npm run serve         # start the server (PORT env, default 8787)
npm run build         # tsc -> dist/
npm run build:web     # esbuild src/client.ts -> web/dist/engine.js (the web app's engine)
```

To run the web app: `npm run build:web`, then serve the `web/` directory over
http (e.g. `python3 -m http.server --directory web 8125`) and open
`scoring-app.html`. It must be served over http because it loads the engine as
an ES module.

Server endpoints: `POST /games`, `POST /games/:id/events`,
`GET /games/:id/events?since=N`, `GET /games/:id/state`,
`GET /games/:id/stream` (SSE), `GET /games/:id/export.{json,csv}`.

---

## Roadmap (suggested order)

1. ~~**Runner-advancement override UI.**~~ **Done (Phase 2).** `src/runners.ts`
   (`editableRunners`/`toRunnerMoves`) + an "Adjust runners" sheet in the scorer
   let the scorer set each runner's destination and error flag; the event carries
   explicit `runners` and rounds through sync + the follower.
2. ~~**Wire the scorer to the backend.**~~ **Done (Phase 1).** Offline-first queue
   in `web/sync-client.js`; POSTs to `/games/:id/events`, reconciles via `sync.ts`.
3. ~~**Follower web view.**~~ **Done (Phase 1).** `web/follower.html` — SSE stream,
   `Last-Event-ID` resume, "last updated" freshness, graceful reconnect.
   (Also delivered in Phase 1: PWA manifest + service worker for installable,
   offline-launch use.)
4. ~~**Persist the store.**~~ **Done (Phase 3).** Append-only JSONL log
   (`src/store.ts`, `STORE_FILE` env); fsync on append, re-fold on startup,
   idempotent + partial-line-safe. A real DB is only needed for multi-node/scale.
5. **Harden the Retrosheet parser** against downloaded `.EV*` files; widen rule
   coverage by replaying real seasons and fixing whatever throws. (Data is free
   but copyrighted — review terms before shipping it inside a product.)
6. **Pre-game pitcher eligibility.** Use persisted pitching appearances to warn a
   coach before handing a kid the ball (cross-game rest math; logic exists in
   `pitching.ts`, needs the appearance records wired in).
7. **Accounts + COPPA** when moving toward public/commercial.
8. **Mobile packaging.** The UI is HTML today; decide React Native vs. a wrapped
   web app for the real mobile client.

---

## Conventions for working in this repo

- **TypeScript strict, no runtime deps in the engine.** Keep it that way; the
  engine must stay portable (it runs in the browser UI too).
- **Every rule gets a test.** Tests are plain assertion scripts (`eq(actual,
  expected, label)`) that `process.exit(1)` on failure — no test framework. Add
  cases to the relevant `tests/*.test.ts`.
- **The reducer stays pure.** No I/O, no clock, no randomness inside `apply`.
- **Use the Retrosheet replay as the oracle** for any scoring-rule change: if a
  real game's derived box score still matches, you didn't regress.
- **The engine is single-sourced.** `web/scoring-app.html` imports the compiled
  bundle (`web/dist/engine.js`, built from `src/client.ts` via `npm run
  build:web`); there is no hand-kept JS port to keep in sync. If you change
  engine logic, rebuild the bundle — never re-inline engine functions into the
  page. The page keeps only UI and thin presentation helpers (`playLog`, verb
  maps) that call the imported functions. (Note: ES-module imports require the
  page to be **served over http**, not opened via `file://`.)
- **Document judgment calls in code** (as done for earned runs and decisions)
  rather than pretending the rules are fully deterministic.

---

## Copy-paste starter tasks for Claude Code

> "Read README.md and HANDOFF.md. Then build the runner-advancement override UI
> described in roadmap item 1: in scoring-app.html, after an outcome is recorded,
> let me tap each baserunner to change where they ended (advance/hold/out) and
> the result re-folds through the engine. Add the explicit `runners` array to the
> emitted `pa_result`."

> "Wire scoring-app.html to the backend in src/server.ts: POST new events to
> /games/:id/events in batches, queue them when offline, and reconcile on
> reconnect using the functions in src/sync.ts. Keep all current in-memory
> behavior working when no server is configured."

> "Build a read-only follower page that subscribes to GET /games/:id/stream via
> EventSource, renders the live scoreboard and play-by-play, shows a 'last
> updated Ns ago' indicator, and resumes cleanly with Last-Event-ID after a drop."

> "Replace the in-memory GameStore in src/store.ts with SQLite (better-sqlite3),
> keeping the same public methods and all tests in tests/sync.test.ts passing."
