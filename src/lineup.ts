import {
  GameSetup,
  GameState,
  LineupSlot,
  LineupState,
  Position,
  PlayerId,
  SubstitutionEvent,
  TeamSide,
} from "./types";

export function fieldingSide(battingTeam: TeamSide): TeamSide {
  return battingTeam === "away" ? "home" : "away";
}

export function initLineupState(setup: GameSetup): LineupState {
  return {
    away: setup.away.battingOrder.map((s) => ({ ...s })),
    home: setup.home.battingOrder.map((s) => ({ ...s })),
  };
}

/** The player currently at the plate for the batting team. */
export function currentBatter(state: GameState): PlayerId {
  const side = state.battingTeam;
  const slot = state.order[side] % state.lineup[side].length;
  return state.lineup[side][slot].playerId;
}

/** The pitcher currently on the mound (the fielding team's "P"). */
export function currentPitcher(state: GameState): PlayerId {
  return state.pitcher[fieldingSide(state.battingTeam)];
}

/** Find the player a given side currently has at a position. */
export function playerAtPosition(
  lineup: LineupState,
  side: TeamSide,
  position: Position
): PlayerId | undefined {
  const slot = lineup[side].find((s) => s.position === position);
  return slot?.playerId;
}

/** Apply a substitution to a lineup state (returns a new state). */
export function applySubstitution(
  lineup: LineupState,
  ev: SubstitutionEvent
): LineupState {
  const next: LineupState = {
    away: lineup.away.map((s) => ({ ...s })),
    home: lineup.home.map((s) => ({ ...s })),
  };
  const order = next[ev.team];
  const existing = order[ev.slot];
  const newSlot: LineupSlot = {
    playerId: ev.playerIn,
    position: ev.position ?? existing?.position ?? "DH",
  };
  order[ev.slot] = newSlot;
  return next;
}

export function pitcherOfLineup(slots: LineupSlot[]): PlayerId {
  const p = slots.find((s) => s.position === "P");
  return p ? p.playerId : slots[0].playerId;
}
