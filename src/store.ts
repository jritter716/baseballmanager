import { randomUUID } from "crypto";
import { GameEvent, GameSetup, Base } from "./types";
import { reduce } from "./reducer";
import { stats, StatsResult } from "./stats";
import { decisions, Decisions } from "./decisions";
import { EventEnvelope } from "./sync";

export interface GameRecord {
  id: string;
  setup: GameSetup;
  events: EventEnvelope[];
  serverSeq: number;
}

/** Compact scoreboard pushed to followers. */
export interface Scoreboard {
  score: { away: number; home: number };
  inning: number;
  half: "top" | "bottom";
  outs: number;
  count: { balls: number; strikes: number };
  bases: number[]; // occupied base numbers
  serverSeq: number;
}

export interface GameView {
  scoreboard: Scoreboard;
  box: StatsResult;
  decisions: Decisions;
}

/**
 * The authoritative log. In-memory here for a runnable reference; the shape
 * maps directly onto an `events` table (one row per envelope) plus a `games`
 * table for setup. Swap the Map for your database and the rest is unchanged.
 */
export class GameStore {
  private games = new Map<string, GameRecord>();

  create(setup: GameSetup): GameRecord {
    const rec: GameRecord = { id: randomUUID(), setup, events: [], serverSeq: 0 };
    this.games.set(rec.id, rec);
    return rec;
  }

  get(id: string): GameRecord | undefined {
    return this.games.get(id);
  }

  /** Append events idempotently. Events already present (by id) are skipped.
   *  New events get a server-assigned monotonic `seq` (the authoritative order). */
  append(id: string, incoming: Array<GameEvent & { id?: string }>): EventEnvelope[] {
    const rec = this.require(id);
    const seen = new Set(rec.events.map((e) => e.id));
    const appended: EventEnvelope[] = [];
    for (const ev of incoming) {
      const eid = ev.id ?? randomUUID();
      if (seen.has(eid)) continue;
      const stored = { ...ev, id: eid, seq: ++rec.serverSeq } as EventEnvelope;
      rec.events.push(stored);
      seen.add(eid);
      appended.push(stored);
    }
    return appended;
  }

  /** Events with server seq greater than `since` (incremental pull / SSE resume). */
  since(id: string, since: number): EventEnvelope[] {
    return this.require(id).events.filter((e) => e.seq > since);
  }

  scoreboard(id: string): Scoreboard {
    const rec = this.require(id);
    const s = reduce(rec.setup, rec.events);
    return {
      score: s.score,
      inning: s.inning,
      half: s.half,
      outs: s.outs,
      count: s.count,
      bases: ([1, 2, 3] as Base[]).filter((b) => s.bases[b] !== undefined),
      serverSeq: rec.serverSeq,
    };
  }

  view(id: string): GameView {
    const rec = this.require(id);
    return {
      scoreboard: this.scoreboard(id),
      box: stats(rec.setup, rec.events),
      decisions: decisions(rec.setup, rec.events),
    };
  }

  private require(id: string): GameRecord {
    const rec = this.games.get(id);
    if (!rec) throw new Error(`Unknown game: ${id}`);
    return rec;
  }
}
