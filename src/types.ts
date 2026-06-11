// ---------------------------------------------------------------------------
// Core identifiers and enums
// ---------------------------------------------------------------------------

export type Base = 1 | 2 | 3;
export type PlayerId = string;
export type TeamSide = "away" | "home";
export type Half = "top" | "bottom";

export type Position =
  | "P" | "C" | "1B" | "2B" | "3B" | "SS" | "LF" | "CF" | "RF" | "DH";

/** What a single pitch was. `in_play` and `hit_by_pitch` advance the pitch
 *  count but do not change the ball/strike count; the plate appearance is then
 *  resolved by an explicit pa_result event. */
export type PitchResult =
  | "ball"
  | "called_strike"
  | "swinging_strike"
  | "foul"
  | "foul_tip"
  | "in_play"
  | "hit_by_pitch";

/** How a plate appearance ended. */
export type PaOutcome =
  | "single"
  | "double"
  | "triple"
  | "home_run"
  | "walk"
  | "intentional_walk"
  | "hit_by_pitch"
  | "strikeout"
  | "groundout"
  | "flyout"
  | "lineout"
  | "popout"
  | "fielders_choice"
  | "reached_on_error"
  | "sacrifice_fly"
  | "sacrifice_bunt"
  | "double_play"
  | "triple_play";

export type RunnerOrigin = Base | "batter";
export type RunnerDest = Base | "home" | "out";

// ---------------------------------------------------------------------------
// Runner movement — the heart of correct stat derivation
// ---------------------------------------------------------------------------

export interface RunnerMove {
  /** The player moving. For the batter use from: "batter". */
  id: PlayerId;
  from: RunnerOrigin;
  to: RunnerDest;
  /** Fielders involved in recording this out, e.g. ["SS","2B"]. Last = putout. */
  outBy?: Position[];
  /** Who is credited the RBI for a run scored on this move (usually the batter). */
  rbiTo?: PlayerId;
  /** Scorer flags this when an error allowed the move (advance or reach). */
  onError?: boolean;
  /** Scorer flags this when the runner WOULD have been out absent an error.
   *  Drives the earned-run "reconstructed third out". */
  wouldHaveBeenOut?: boolean;
}

// ---------------------------------------------------------------------------
// Events — the append-only log
// ---------------------------------------------------------------------------

interface BaseEvent {
  /** Monotonic ordering key; also the basis for offline sync reconciliation. */
  seq: number;
}

export interface PitchEvent extends BaseEvent {
  type: "pitch";
  pitcher: PlayerId;
  result: PitchResult;
}

export interface PaResultEvent extends BaseEvent {
  type: "pa_result";
  batter: PlayerId;
  pitcher: PlayerId;
  outcome: PaOutcome;
  /** Putout/assist sequence for the batter's out, e.g. ["6","4","3"] as positions. */
  fielders?: Position[];
  /** Fielders charged with an error on the play. */
  errors?: Position[];
  /** Explicit runner movements. If omitted, the engine fills in standard
   *  defaults for the outcome (the "default-and-override" flow). */
  runners?: RunnerMove[];
}

export interface BaserunningEvent extends BaseEvent {
  type: "baserunning";
  kind:
    | "stolen_base"
    | "caught_stealing"
    | "wild_pitch"
    | "passed_ball"
    | "balk"
    | "pickoff"
    | "other";
  pitcher?: PlayerId;
  errors?: Position[];
  runners: RunnerMove[];
}

export interface SubstitutionEvent extends BaseEvent {
  type: "substitution";
  team: TeamSide;
  kind: "offensive" | "defensive" | "pitching";
  /** Batting-order slot (0-based) the incoming player occupies. */
  slot: number;
  playerIn: PlayerId;
  playerOut?: PlayerId;
  position?: Position;
}

export type GameEvent =
  | PitchEvent
  | PaResultEvent
  | BaserunningEvent
  | SubstitutionEvent;

// ---------------------------------------------------------------------------
// Lineups and setup
// ---------------------------------------------------------------------------

export interface LineupSlot {
  playerId: PlayerId;
  position: Position;
}

export interface TeamLineup {
  teamId: string;
  /** Batting order, length 9 (or 10 with a DH). Index 0 bats first. */
  battingOrder: LineupSlot[];
}

export interface GameSetup {
  away: TeamLineup;
  home: TeamLineup;
  /** Innings in a regulation game (used only by gameStatus helper). */
  regulationInnings?: number;
}

// ---------------------------------------------------------------------------
// Derived game state (output of the reducer)
// ---------------------------------------------------------------------------

export interface LineupState {
  /** Current player + position for each batting slot, by side. */
  away: LineupSlot[];
  home: LineupSlot[];
}

export interface GameState {
  inning: number;
  half: Half;
  outs: number;
  count: { balls: number; strikes: number };
  bases: Partial<Record<Base, PlayerId>>;
  score: { away: number; home: number };
  battingTeam: TeamSide;
  /** Batting-order pointer per side. */
  order: { away: number; home: number };
  /** Current pitcher for each team's defense. */
  pitcher: { away: PlayerId; home: PlayerId };
  /** Total pitches thrown today, per pitcher. */
  pitchCount: Record<PlayerId, number>;
  lineup: LineupState;
}
