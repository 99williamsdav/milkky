// Solo Career Mode: you and 23 computer players, saved in this browser. The rules are in shared/career.js;
// this keeps the career, plays the steps you're not in (cup rounds after you're knocked out), and saves.
import * as C from '../shared/career.js';
import { roundRobin } from '../shared/schedule.js';

const KEY = 'milkky-career-v2';
const OLD_KEYS = ['milkky-career-v1', 'milkky-league-v1']; // earlier versions: v1 is converted, the one before is gone
export const ME = '@you';
export const solo = { career: null };

export function newCareer(target) {
  solo.career = C.newCareer({ people: [ME], target });
  advance();
}
export function save() { try { localStorage.setItem(KEY, JSON.stringify(solo.career)); } catch (e) {} }
export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.leagues) solo.career = d;
    else {
      const old = JSON.parse(localStorage.getItem(OLD_KEYS[0]));
      if (old && old.career && old.league && old.cup) { solo.career = fromV1(old); advance(); }
    }
    OLD_KEYS.forEach(k => localStorage.removeItem(k));
  } catch (e) {}
}

// Play the steps you're not in (the cup after you're out), up to your next game or the end of the season
function advance() {
  const c = solo.career;
  while (!C.seasonOver(c) && !C.fixtureOf(c, ME)) C.playStep(c);
  save();
}
// What you play next: 'cup', 'league', or 'done' (the season is over)
export const nextEvent = () => C.fixtureOf(solo.career, ME)?.kind || 'done';
export const myFixture = () => C.fixtureOf(solo.career, ME);
export const opponentOf = f => (f.a === ME ? f.b : f.a);
// Your result in your current game; the rest of that round is simulated
export function record(myScore, oppScore, iWon) {
  const c = solo.career, f = C.fixtureOf(c, ME);
  const r = f.a === ME ? { sa: myScore, sb: oppScore, aWon: iWon } : { sa: oppScore, sb: myScore, aWon: !iWon };
  C.playStep(c, { [f.key]: r });
  advance();
}
export function nextSeason() {
  C.nextSeason(solo.career);
  advance();
}

// A career saved by the version before the shared rules: only your league was played round by round (the others
// were simulated at the end), so their rounds so far are simulated now.
function fromV1(old) {
  const id = x => (x === 'you' ? ME : x);
  const { career, league, cup } = old;
  const tiers = career.tiers.map((ids, t) => (t === career.tier ? league.entries.map(e => (e.human ? ME : e.bot)) : [...ids]));
  const c = { season: career.season, target: career.target || league.target || 50, tiers,
    promotedIn: career.promotedIn ? { [ME]: career.promotedIn } : {}, waiting: [], summary: null };
  c.leagues = tiers.map((ids, t) => t === career.tier
    ? { entries: league.entries.map((e, i) => ({ id: ids[i], P: e.P, W: e.W, L: e.L, PF: e.PF, PA: e.PA })), schedule: league.schedule }
    : { entries: ids.map(x => ({ id: x, P: 0, W: 0, L: 0, PF: 0, PA: 0 })), schedule: roundRobin(ids.length) });
  c.cup = { round: cup.round, winner: cup.winner && id(cup.winner), byes: cup.byes.map(id),
    ties: cup.ties.map(r => r.map(t => ({ ...t, a: id(t.a), b: id(t.b), ...(t.w ? { w: id(t.w) } : {}) }))) };
  c.round = 0; c.step = 0; c.lastLeague = null;
  // Catch the other leagues up, one round at a time (yours already has its results)
  c.leagues.forEach((lg, t) => {
    if (t === career.tier) return;
    for (let r = 0; r < league.round; r++) {
      for (const [x, y] of lg.schedule[r]) {
        const a = lg.entries[x].id, b = lg.entries[y].id;
        C.recordGame(lg.entries, { a, b, ...C.simulate(c, a, b) });
      }
    }
  });
  c.round = league.round; c.step = league.round + cup.round;
  return c;
}
