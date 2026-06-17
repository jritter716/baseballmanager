/**
 * Clutch — Phase 0: Identity, Roles & Access Scopes
 * -------------------------------------------------
 * A pure authorization layer to sit ABOVE the event-sourced engine.
 * The engine knows about games and events; this knows about people and
 * what they're allowed to see and do.
 *
 * Source: the Clutch master brief + clutch-access-model.ts (the spec's auth
 * authority). Brought into this repo verbatim except the inline sanity block,
 * which now lives in tests/access.test.ts. Per the brief, this layer is the
 * source of truth for §4 permissions; do not fork its rules here.
 *
 * Design split, on purpose:
 *   resolvePrincipal()  — gathers facts about a person from your stores (impure-ish, you wire it up)
 *   canRead()/canWrite() — pure decision functions over those facts (trivial to unit-test)
 */

// ---------- Branded IDs (swap for your existing ID types) ----------
type Brand<T, B> = T & { readonly __brand: B };
export type OrgId = Brand<string, 'OrgId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type PersonId = Brand<string, 'PersonId'>; // anyone who can log in
export type AccessPlayerId = Brand<string, 'PlayerId'>; // a roster entity; may or may not have a login

// ---------- Roles ----------
// Roles are held PER TEAM, not globally. The same person can be a head coach
// on the 12U and a parent on the 10U. Modeling this now avoids a rewrite later.
export type CoachRole = 'HEAD_COACH' | 'ASSISTANT_COACH';

// ---------- Principal ----------
// A fully-resolved view of one person's standing across the org.
// Build it once per request/session from your membership + roster + guardian data.
export interface Principal {
  personId: PersonId;
  isOrgAdmin: boolean;                       // Chris / org owner — reads across the org
  coachTeams: ReadonlySet<TeamId>;           // teams where this person coaches
  scorerTeams: ReadonlySet<TeamId>;          // teams where this person is a designated scorer
  playerTeams: ReadonlySet<TeamId>;          // teams where this person IS a rostered player
  guardianTeams: ReadonlySet<TeamId>;        // teams where this person guardians a rostered player
  selfPlayerIds: ReadonlySet<AccessPlayerId>;      // player entities this person *is*
  guardianPlayerIds: ReadonlySet<AccessPlayerId>;  // players this person is guardian of
}

// Raw inputs you'd pull from your stores. Shapes are illustrative — adapt freely.
export interface Membership { personId: PersonId; teamId: TeamId; role: CoachRole | 'SCORER'; }
export interface RosterEntry { playerId: AccessPlayerId; teamId: TeamId; personId?: PersonId; }
export interface Guardianship { personId: PersonId; playerId: AccessPlayerId; }

export function resolvePrincipal(
  personId: PersonId,
  opts: {
    isOrgAdmin?: boolean;
    memberships: Membership[];
    roster: RosterEntry[];
    guardianships: Guardianship[];
  },
): Principal {
  const coachTeams = new Set<TeamId>();
  const scorerTeams = new Set<TeamId>();
  for (const m of opts.memberships) {
    if (m.personId !== personId) continue;
    if (m.role === 'SCORER') scorerTeams.add(m.teamId);
    else coachTeams.add(m.teamId);
  }

  const selfPlayerIds = new Set<AccessPlayerId>();
  const playerTeams = new Set<TeamId>();
  const guardianPlayerIds = new Set<AccessPlayerId>(
    opts.guardianships.filter((g) => g.personId === personId).map((g) => g.playerId),
  );
  const guardianTeams = new Set<TeamId>();

  for (const r of opts.roster) {
    if (r.personId === personId) { selfPlayerIds.add(r.playerId); playerTeams.add(r.teamId); }
    if (guardianPlayerIds.has(r.playerId)) guardianTeams.add(r.teamId);
  }

  return {
    personId,
    isOrgAdmin: opts.isOrgAdmin ?? false,
    coachTeams, scorerTeams, playerTeams, guardianTeams,
    selfPlayerIds, guardianPlayerIds,
  };
}

// ---------- Resources ----------
export type ResourceKind =
  | 'TeamSchedule' | 'TeamRoster' | 'GameResult' // broadly visible team info
  | 'PlayerGameStats'                            // box-score stats (team-visible by default)
  | 'PlayerDevelopment'                          // PRIVATE: mistake tags, remediation, fitness numbers
  | 'TeamSigns'                                  // SECRET: signs & plays
  | 'CoachNotes'                                 // raw teachable-moment notes, in-game coach tools
  | 'PhilosophyCorpus'                           // the Clutch "brain" — org-wide coaching knowledge
  | 'GameEventStream'                            // the scoring feed itself
  | 'OrgAdmin';                                  // team/coach management

export interface ResourceRef {
  kind: ResourceKind;
  teamId?: TeamId;             // the owning team (almost everything is team-scoped)
  subjectPlayerId?: AccessPlayerId;  // for player-specific resources
}

// ---------- Helpers ----------
const coachOf = (p: Principal, t?: TeamId) => !!t && p.coachTeams.has(t);
const playerOn = (p: Principal, t?: TeamId) => !!t && p.playerTeams.has(t);
const isSelf = (p: Principal, pl?: AccessPlayerId) => !!pl && p.selfPlayerIds.has(pl);
const isGuardian = (p: Principal, pl?: AccessPlayerId) => !!pl && p.guardianPlayerIds.has(pl);
const affiliated = (p: Principal, t?: TeamId) =>
  !!t && (p.coachTeams.has(t) || p.playerTeams.has(t) || p.guardianTeams.has(t) || p.scorerTeams.has(t));

// Product toggle: may teammates see each other's box-score stats? Many apps allow it.
// Development data is NEVER team-visible regardless of this flag.
const TEAMMATES_SEE_GAME_STATS = true;

// ---------- Read decisions ----------
export function canRead(p: Principal, r: ResourceRef): boolean {
  if (p.isOrgAdmin) return true; // Chris reads across the org

  switch (r.kind) {
    // Schedules, rosters, scores — anyone connected to the team.
    case 'TeamSchedule':
    case 'TeamRoster':
    case 'GameResult':
    case 'GameEventStream':
      return affiliated(p, r.teamId);

    // Box-score stats: coaches, the player, his guardians, and (optionally) teammates.
    case 'PlayerGameStats':
      return coachOf(p, r.teamId)
        || isSelf(p, r.subjectPlayerId)
        || isGuardian(p, r.subjectPlayerId)
        || (TEAMMATES_SEE_GAME_STATS && playerOn(p, r.teamId));

    // The sensitive one. A kid's development data is private to him, his
    // guardians, and his team's coaches. Never teammates, never other parents.
    case 'PlayerDevelopment':
      return coachOf(p, r.teamId)
        || isSelf(p, r.subjectPlayerId)
        || isGuardian(p, r.subjectPlayerId);

    // Signs are competitive secrets: coaches + rostered players of THIS team only.
    // Parents excluded by default (flip if Chris wants family study-at-home).
    case 'TeamSigns':
      return coachOf(p, r.teamId) || playerOn(p, r.teamId);

    // Raw coach notes / in-game coach tools — coaches of the team only.
    case 'CoachNotes':
      return coachOf(p, r.teamId);

    // The philosophy corpus is org-wide coaching knowledge: any coach in the org.
    case 'PhilosophyCorpus':
      return p.coachTeams.size > 0;

    case 'OrgAdmin':
      return false; // org admin handled by isOrgAdmin short-circuit above

    default:
      return false; // deny by default — unknown resource is not readable
  }
}

// ---------- Write decisions ----------
export function canWrite(p: Principal, r: ResourceRef): boolean {
  if (p.isOrgAdmin) return true;

  switch (r.kind) {
    // Scoring a live game: coaches or a designated scorer of that team.
    case 'GameEventStream':
      return coachOf(p, r.teamId) || p.scorerTeams.has(r.teamId as TeamId);

    // Coaches own their team's signs, notes, and a kid's development tags/tests.
    case 'TeamSigns':
    case 'CoachNotes':
    case 'PlayerDevelopment':
    case 'TeamSchedule':
    case 'TeamRoster':
      return coachOf(p, r.teamId);

    // Any coach can contribute to the corpus. (Open question we flagged: whether
    // Chris's contributions should be weighted above a first-year coach's — that's
    // a corpus-curation policy, not an access rule, so it lives downstream of this.)
    case 'PhilosophyCorpus':
      return p.coachTeams.size > 0;

    // Stats and results are derived from the event stream, not written directly.
    case 'PlayerGameStats':
    case 'GameResult':
      return false;

    default:
      return false;
  }
}
