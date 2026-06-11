// Shared play-by-play presentation, built on the imported engine.
// Used by both the scorer (scoring-app.html) and the live follower (follower.html)
// so the human-readable play log is formatted in exactly one place.
import { initialState, apply, defaultRunnerMoves } from "./dist/engine.js";

export const PA_VERB = {
  single: "singles", double: "doubles", triple: "triples", home_run: "homers",
  walk: "walks", intentional_walk: "walks (IBB)", hit_by_pitch: "hit by pitch",
  strikeout: "strikes out", groundout: "grounds out", flyout: "flies out",
  lineout: "lines out", popout: "pops out",
  fielders_choice: "reaches on fielder's choice", reached_on_error: "reaches on error",
  sacrifice_fly: "sac fly", sacrifice_bunt: "sac bunt",
  double_play: "into a double play", triple_play: "into a triple play",
};

export const BR_VERB = {
  stolen_base: "steals", caught_stealing: "caught stealing", wild_pitch: "wild pitch",
  passed_ball: "passed ball", balk: "balk", pickoff: "picked off", other: "advances",
};

export function baseName(b) {
  return b === 2 ? "second" : b === 3 ? "third" : b === "home" ? "home" : "first";
}

/**
 * Fold the event log into a human-readable play-by-play, most-recent first.
 * `nameOf(playerId)` resolves a display name. Returns [{ tag, tx }].
 */
export function playLog(setup, events, nameOf) {
  let s = initialState(setup);
  const out = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const tag = (s.half === "top" ? "T" : "B") + s.inning;
    if (e.type === "pa_result") {
      const mv = e.runners || defaultRunnerMoves(e.outcome, s.bases, e.batter);
      const r = mv.filter((m) => m.to === "home").length;
      let t = nameOf(e.batter) + " " + (PA_VERB[e.outcome] || e.outcome);
      if (r > 0) t += " — " + r + " run" + (r > 1 ? "s" : "");
      out.push({ tag, tx: t });
    } else if (e.type === "baserunning") {
      const m = e.runners[0];
      const r = e.runners.filter((x) => x.to === "home").length;
      let t = nameOf(m.id) + " " + (BR_VERB[e.kind] || "advances");
      if (e.kind === "stolen_base" && m.to !== "out") t += " " + baseName(m.to);
      if (r > 0) t += " — " + r + " run" + (r > 1 ? "s" : "");
      out.push({ tag, tx: t });
    }
    s = apply(s, e);
  }
  return out.reverse();
}
