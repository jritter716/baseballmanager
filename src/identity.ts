/**
 * Clutch — identity store (the store-touching side of the access layer).
 *
 * The pure decisions live in access.ts; this is the only piece that touches a
 * store. It holds the org's people, teams, rosters, coach/scorer memberships,
 * and guardianships, and composes them into a Principal via the pure
 * resolvePrincipal(). Persistence mirrors the game store: an append-only JSONL
 * log, fsync'd, re-folded on startup (additive, restart-safe). In-memory when no
 * file is given (tests).
 *
 * This is what makes the access layer real: resolvePrincipal(personId) now has
 * actual people/roles/roster to resolve against, and roster PlayerIds become the
 * stable, canonical player identity that games reference (PlayerId unification).
 */
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import {
  OrgId, TeamId, PersonId, AccessPlayerId, CoachRole,
  Membership, RosterEntry, Guardianship, Principal,
  resolvePrincipal as resolvePure,
} from "./access";

export interface Org { id: OrgId; name: string; }
export interface Team { id: TeamId; orgId: OrgId; name: string; }
export interface Person { id: PersonId; name: string; isOrgAdmin?: boolean; }
/** A roster player — the canonical, stable player identity across games. */
export interface RosterPlayer {
  id: AccessPlayerId; teamId: TeamId; name: string; jersey?: string; personId?: PersonId;
}

export const newOrgId = () => randomUUID() as unknown as OrgId;
export const newTeamId = () => randomUUID() as unknown as TeamId;
export const newPersonId = () => randomUUID() as unknown as PersonId;
export const newPlayerId = () => randomUUID() as unknown as AccessPlayerId;

export interface IdentityStoreOptions { file?: string; }

export class IdentityStore {
  private orgs = new Map<OrgId, Org>();
  private teamsById = new Map<TeamId, Team>();
  private persons = new Map<PersonId, Person>();
  private players = new Map<AccessPlayerId, RosterPlayer>();
  private memberships: Membership[] = [];
  private guardianships: Guardianship[] = [];
  private file: string | null;
  private fd: number | null = null;

  constructor(opts: IdentityStoreOptions = {}) {
    this.file = opts.file ?? null;
    if (this.file) this.load();
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    let skipped = 0;
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { skipped++; continue; }
      switch (rec.k) {
        case "org": this.orgs.set(rec.org.id, rec.org); break;
        case "team": this.teamsById.set(rec.team.id, rec.team); break;
        case "person": this.persons.set(rec.person.id, rec.person); break;
        case "roster": this.players.set(rec.player.id, rec.player); break;
        case "membership":
          if (!this.memberships.some((m) => m.personId === rec.m.personId && m.teamId === rec.m.teamId && m.role === rec.m.role))
            this.memberships.push(rec.m);
          break;
        case "guardian":
          if (!this.guardianships.some((g) => g.personId === rec.g.personId && g.playerId === rec.g.playerId))
            this.guardianships.push(rec.g);
          break;
        default: skipped++;
      }
    }
    if (skipped) console.warn(`IdentityStore: skipped ${skipped} unreadable log line(s)`);
  }

  private appendLine(obj: unknown): void {
    if (!this.file) return;
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, "a");
    }
    fs.writeSync(this.fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(this.fd);
  }
  close(): void { if (this.fd !== null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null; } }

  // ---- writes ----
  addOrg(name: string): Org { const org = { id: newOrgId(), name }; this.orgs.set(org.id, org); this.appendLine({ k: "org", org }); return org; }
  addTeam(orgId: OrgId, name: string): Team { const team = { id: newTeamId(), orgId, name }; this.teamsById.set(team.id, team); this.appendLine({ k: "team", team }); return team; }
  addPerson(name: string, isOrgAdmin = false): Person { const person = { id: newPersonId(), name, isOrgAdmin }; this.persons.set(person.id, person); this.appendLine({ k: "person", person }); return person; }
  addRosterPlayer(teamId: TeamId, name: string, jersey?: string, personId?: PersonId): RosterPlayer {
    const player: RosterPlayer = { id: newPlayerId(), teamId, name, ...(jersey ? { jersey } : {}), ...(personId ? { personId } : {}) };
    this.players.set(player.id, player); this.appendLine({ k: "roster", player }); return player;
  }
  addMembership(personId: PersonId, teamId: TeamId, role: CoachRole | "SCORER"): void {
    const m: Membership = { personId, teamId, role }; this.memberships.push(m); this.appendLine({ k: "membership", m });
  }
  addGuardianship(personId: PersonId, playerId: AccessPlayerId): void {
    const g: Guardianship = { personId, playerId }; this.guardianships.push(g); this.appendLine({ k: "guardian", g });
  }

  // ---- reads ----
  listTeams(): Team[] { return [...this.teamsById.values()]; }
  getTeam(id: TeamId): Team | undefined { return this.teamsById.get(id); }
  rosterOf(teamId: TeamId): RosterPlayer[] { return [...this.players.values()].filter((p) => p.teamId === teamId); }
  getPerson(id: PersonId): Person | undefined { return this.persons.get(id); }

  /** Compose a person's full standing from the stored facts (the one impure
   *  bridge into the pure access decisions). */
  resolvePrincipal(personId: PersonId): Principal {
    const roster: RosterEntry[] = [...this.players.values()].map((p) => ({ playerId: p.id, teamId: p.teamId, personId: p.personId }));
    return resolvePure(personId, {
      isOrgAdmin: this.persons.get(personId)?.isOrgAdmin ?? false,
      memberships: this.memberships,
      roster,
      guardianships: this.guardianships,
    });
  }
}
