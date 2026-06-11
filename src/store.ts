import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
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
export interface GameStoreOptions {
  /** Path to a JSONL append-only log. If set, games are persisted and recovered
   *  on startup. If omitted, the store is purely in-memory (tests, ephemeral). */
  file?: string;
}

/**
 * Authoritative event store. By default in-memory; pass `{ file }` to make it
 * durable. Durability uses an append-only JSONL log — one line per record, the
 * exact event-sourced shape — fsync'd on append. On startup the log is re-folded
 * to rebuild every game's state (and `seq`), so a restart loses nothing. JSONL
 * keeps the engine's zero-runtime-dependency philosophy (no DB server, no ORM)
 * and maps 1:1 onto the append-only model; recovery is just reading lines.
 */
export class GameStore {
  private games = new Map<string, GameRecord>();
  private file: string | null;
  private fd: number | null = null;

  constructor(opts: GameStoreOptions = {}) {
    this.file = opts.file ?? null;
    if (this.file) this.load();
  }

  /** Recover all games by re-folding the persisted log. Tolerates a corrupt or
   *  partially-written final line (a crash mid-append) by skipping bad lines. */
  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, "utf8").split("\n");
    let skipped = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { skipped++; continue; }
      if (rec.k === "game") {
        if (!this.games.has(rec.id)) {
          this.games.set(rec.id, { id: rec.id, setup: rec.setup, events: [], serverSeq: 0 });
        }
      } else if (rec.k === "event") {
        const g = this.games.get(rec.gameId);
        if (!g) { skipped++; continue; }
        g.events.push(rec.event as EventEnvelope);
        if (rec.event.seq > g.serverSeq) g.serverSeq = rec.event.seq;
      }
    }
    if (skipped) {
      // eslint-disable-next-line no-console
      console.warn(`GameStore: skipped ${skipped} unreadable log line(s) during recovery`);
    }
  }

  private appendLine(obj: unknown): void {
    if (!this.file) return;
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, "a"); // append mode
    }
    fs.writeSync(this.fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(this.fd); // durable before we acknowledge
  }

  /** Flush + close the log file descriptor (call on graceful shutdown). */
  close(): void {
    if (this.fd !== null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null; }
  }

  create(setup: GameSetup): GameRecord {
    const rec: GameRecord = { id: randomUUID(), setup, events: [], serverSeq: 0 };
    this.games.set(rec.id, rec);
    this.appendLine({ k: "game", id: rec.id, setup });
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
    for (const e of appended) this.appendLine({ k: "event", gameId: id, event: e });
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
