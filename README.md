# Baseball scoring engine

An event-sourced scoring engine for baseball. The authoritative record of a
game is an **append-only log of events**; everything else — live game state,
box scores, season stats, pitch counts, eligibility — is *derived* by folding
that log. The fold is a pure, deterministic function, so the identical code can
run on the scorer's phone (for instant live state) and on the server (for the
authoritative recompute after offline sync), and the two are guaranteed to agree.

## Why event sourcing

- **One source of truth.** Record what the scorer observed (a pitch, a play, a
  substitution). Never store derived numbers — recompute them.
- **Free editability.** Fixing a mistake three plays ago is just editing an
  event and re-folding. At youth-game scale (a few hundred events) you can
  re-reduce the whole game on every change without caring about performance.
- **Free export.** The log *is* the data. CSV/JSON export is a serialization of
  events plus rollups — the "open" feature falls out for nothing.
- **Add stats later.** New metric next season? Add a projection; old games light
  up retroactively with no migration.

## Layout

| File | Responsibility |
|------|----------------|
| `src/types.ts` | Events, state, runner moves, outcomes, lineups |
| `src/reducer.ts` | `apply` (one event) and `reduce` (the whole log) → `GameState` |
| `src/defaults.ts` | Standard runner movements per outcome (default-and-override) |
| `src/validate.ts` | Reject impossible events before they corrupt state |
| `src/stats.ts` | Batting / pitching / fielding projection + earned-run logic |
| `src/pitching.ts` | League pitch-count rules, rest tiers, eligibility |
| `src/decisions.ts` | Win / loss / save attribution |
| `src/retrosheet.ts` | Parse + replay Retrosheet event files (test oracle) |
| `src/lineup.ts` | Resolve current batter/pitcher/fielders; apply substitutions |
| `src/sync.ts` | Offline-first reconciliation of local/remote logs (device side) |
| `src/store.ts` | Authoritative event store: idempotent append + derived views |
| `src/server.ts` | HTTP sync endpoints + SSE follower stream with gap-resume |

## Quick start

```ts
import { reduce, stats, GameSetup, GameEvent } from "./src";

const setup: GameSetup = { away: {...}, home: {...} };
const events: GameEvent[] = [ /* pitches, pa_results, baserunning, subs */ ];

const state = reduce(setup, events);   // live game state
const box   = stats(setup, events);    // batting/pitching/fielding lines
```

### The default-and-override flow

A `pa_result` may omit `runners`; the engine fills in standard movements for the
outcome and current base state. The scorer supplies explicit `runners` only when
a play is non-routine (a runner takes an extra base, gets thrown out, etc.). This
is what keeps pitch-by-pitch scoring to a single tap on the common case.

### Pitches never end a plate appearance

A `pitch` event only updates the count and the pitcher's tally. Ball four and
strike three do **not** auto-resolve; the scorer emits an explicit `pa_result`
(`walk`, `strikeout`). This concentrates all PA-ending logic in one place and
makes the dropped-third-strike case natural (a `strikeout` whose runner move puts
the batter on first).

## Known simplifications

Baseball scoring has genuine edge cases; this engine is principled but not the
final word on every official-scorer judgment call:

- **Earned runs** use a reconstruction that marks a run unearned if the scoring
  runner reached on an error, if the scoring move was flagged `onError`, or once
  the inning's reconstructed out total (real outs + phantom outs from errors)
  reaches three. Phantom outs come from `reached_on_error` and from any move
  flagged `wouldHaveBeenOut`. Complex multi-error innings can require judgment
  this approximation doesn't fully capture.
- **Third-out timing.** When a run scores on the same play as the third out, the
  engine counts the run as listed in the move list rather than fully modeling the
  force-out timing rule. The scorer can override by editing the moves.
- **Win/loss/save** attribution (`decisions.ts`) implements the deterministic
  core: the win goes to the winning team's pitcher of record at the permanent
  go-ahead, the loss to the pitcher charged with that run. Two clauses are
  scorer judgment and are approximated: reassigning a win when the starter falls
  short of the 5-inning minimum (we pick the most-used reliever), and the save's
  "3 effective innings" / "tying run on deck" conditions (the ≤3-run-lead, 1+
  inning save clause is exact).

## Backend, sync & live following

The server is the authoritative home for the same append-only log. The same
reducer recomputes state there, and followers are just one more subscriber to
the event stream — no separate broadcast pipeline.

`GameStore` (`store.ts`) holds each game's setup and ordered events in memory
(swap the Map for a database: one row per event envelope, one row per game).
Append is idempotent — events carry a stable `id`, resends are dropped, and new
events get a server-assigned monotonic `seq` that is the authoritative order.

`server.ts` exposes:

| Method & path | Purpose |
|---------------|---------|
| `POST /games` | Create a game from a `setup` |
| `POST /games/:id/events` | Idempotent append (the scorer's sync push) → broadcasts |
| `GET /games/:id/events?since=N` | Incremental pull (device catch-up) |
| `GET /games/:id/state` | Authoritative scoreboard + box score + decisions |
| `GET /games/:id/stream` | SSE follower feed (live plays + scoreboard frames) |
| `GET /games/:id/export.json` · `export.csv` | Open-data export of the log |

Offline-first: the scorer's device scores optimistically against the same
reducer while offline; on reconnect it pulls, merges (`sync.ts` —
remote-authoritative ordering, pending local events renumbered after), and
pushes its unsynced events. Because the device and server run the identical
fold, the live view matches the authoritative recompute once synced.

Live following degrades gracefully: the SSE stream emits each event with its
`seq` as the SSE id, so a follower who drops reconnects with `Last-Event-ID` and
the server replays exactly what they missed before resuming live — no frozen
scoreboard, no lying about being live.

```bash
npm run serve        # start the server (PORT env, default 8787)
npm run test:server  # in-process integration test (needs a bindable socket)
```

`tests/run.ts` folds a hand-built first inning and asserts the resulting box
score, plus unit checks of the pitch-count rules and validation.

`src/retrosheet.ts` is the **replay harness**: `parseGame(text)` translates a
Retrosheet event file (its `start`/`sub`/`play`/`data` records and the compact
play grammar like `S8`, `64(1)3/GDP`, `HR/9.3-H;1-H`, `SB2`, `E6`) into our
`GameEvent`s, and `replay(text)` folds them through `reduce`/`stats`.
`tests/retrosheet.test.ts` parses a hand-built game in real Retrosheet syntax
and asserts the derived box score — and as the headline check, confirms the
engine's computed earned runs match the file's own `data,er` records.

To harden the rules against real history, download Retrosheet `.EV*` files and
run them through `replay`, asserting the derived box score matches the published
one. The parser covers high-frequency events and throws loudly on unsupported
tokens (a correctness tool must fail safe rather than mis-score); extend
`translate()` as you encounter notation it doesn't yet handle. Retrosheet data
is free but copyrighted with usage conditions — review them before shipping it.

```bash
npm install
npm test   # engine + Retrosheet + decisions + sync  ->  67, 27, 12, 16 passing
```
