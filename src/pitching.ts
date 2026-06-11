import { GameState } from "./types";
import { PlayerId } from "./types";

/** A rest tier: throwing up to `maxPitches` requires `restDays` days off. */
export interface RestTier {
  maxPitches: number;
  restDays: number;
}

export interface LeagueRules {
  /** Daily maximum pitches; a pitcher reaching it may finish the current batter. */
  dailyMax: number;
  /** Tiers in ascending pitch order. */
  restTiers: RestTier[];
}

/** Little League "Majors" / 12U style defaults — configure per your league. */
export const LITTLE_LEAGUE_MAJORS: LeagueRules = {
  dailyMax: 85,
  restTiers: [
    { maxPitches: 20, restDays: 0 },
    { maxPitches: 35, restDays: 1 },
    { maxPitches: 50, restDays: 2 },
    { maxPitches: 65, restDays: 3 },
    { maxPitches: Infinity, restDays: 4 },
  ],
};

export function restDaysRequired(rules: LeagueRules, pitches: number): number {
  if (pitches <= 0) return 0;
  for (const tier of rules.restTiers) {
    if (pitches <= tier.maxPitches) return tier.restDays;
  }
  return rules.restTiers[rules.restTiers.length - 1].restDays;
}

/** Pitches until the next rest tier, and what that tier would cost. */
export function nextRestBoundary(
  rules: LeagueRules,
  pitches: number
): { atPitches: number; restDays: number } | null {
  for (const tier of rules.restTiers) {
    if (pitches < tier.maxPitches && Number.isFinite(tier.maxPitches)) {
      return { atPitches: tier.maxPitches + 1, restDays: nextTierRest(rules, tier) };
    }
  }
  return null;
}

function nextTierRest(rules: LeagueRules, tier: RestTier): number {
  const idx = rules.restTiers.indexOf(tier);
  const next = rules.restTiers[idx + 1];
  return next ? next.restDays : tier.restDays;
}

export interface CountStatus {
  pitches: number;
  remaining: number;
  atLimit: boolean;
  approaching: boolean; // within 15 of the daily max
  restDays: number;
  nextBoundary: { atPitches: number; restDays: number } | null;
}

export function countStatus(
  rules: LeagueRules,
  pitches: number
): CountStatus {
  return {
    pitches,
    remaining: Math.max(rules.dailyMax - pitches, 0),
    atLimit: pitches >= rules.dailyMax,
    approaching: pitches >= rules.dailyMax - 15 && pitches < rules.dailyMax,
    restDays: restDaysRequired(rules, pitches),
    nextBoundary: nextRestBoundary(rules, pitches),
  };
}

/** Convenience: live status for a given pitcher straight from game state. */
export function pitcherStatus(
  rules: LeagueRules,
  state: GameState,
  pitcher: PlayerId
): CountStatus {
  return countStatus(rules, state.pitchCount[pitcher] ?? 0);
}

/**
 * Cross-game eligibility: given prior outings (pitches thrown on dates), is the
 * pitcher eligible to throw on `date`? Requires that enough rest days have
 * elapsed since the most demanding recent outing.
 */
export interface Outing {
  date: string; // ISO date
  pitches: number;
}

export function isEligible(
  rules: LeagueRules,
  outings: Outing[],
  date: string
): { eligible: boolean; reason?: string } {
  const target = Date.parse(date);
  for (const o of outings) {
    const owed = restDaysRequired(rules, o.pitches);
    if (owed === 0) continue;
    const daysSince = Math.floor((target - Date.parse(o.date)) / 86_400_000);
    if (daysSince < owed) {
      return {
        eligible: false,
        reason: `Threw ${o.pitches} on ${o.date} (needs ${owed} days rest; only ${daysSince} elapsed).`,
      };
    }
  }
  return { eligible: true };
}
