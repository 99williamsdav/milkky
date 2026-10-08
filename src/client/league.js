// Single-player league against simulated bots, saved in this browser.
import { aiFromSkill, simulateGame, BOT_NAMES } from '../shared/ai.js';
import { roundRobin } from '../shared/schedule.js';

const LG_KEY = 'milkky-league-v1';

// The human is always entry 0.
export const lg = { league: null, lastRound: null };

export function newLeague(season, target) {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 7);
  const skills = [0.08, 0.22, 0.38, 0.5, 0.62, 0.78, 0.92].map(v => Math.min(0.98, Math.max(0.02, v + (Math.random() - 0.5) * 0.08))).sort(() => Math.random() - 0.5); // mixed order, so the schedule isn't easiest-first
  const entries = [{ name: 'You', human: true }].concat(names.map((nm, i) => ({ name: nm, skill: skills[i], ai: aiFromSkill(skills[i]) })));
  entries.forEach(e => Object.assign(e, { P: 0, W: 0, L: 0, PF: 0, PA: 0 }));
  lg.league = { season, entries, schedule: roundRobin(entries.length), round: 0, target };
  lg.lastRound = null; saveLeague();
}
export function saveLeague() { try { localStorage.setItem(LG_KEY, JSON.stringify(lg)); } catch (e) {} }
export function loadLeague() {
  try { const d = JSON.parse(localStorage.getItem(LG_KEY)); if (d && d.league) { lg.league = d.league; lg.lastRound = d.lastRound; } } catch (e) {}
}
export const leagueTarget = () => lg.league.target || 50;
export const seasonDone = () => lg.league.round >= lg.league.schedule.length;
export function standings() {
  return lg.league.entries.map((e, i) => ({ e, i })).sort((a, b) =>
    b.e.W - a.e.W || (b.e.PF - b.e.PA) - (a.e.PF - a.e.PA) || b.e.PF - a.e.PF);
}
export function myPair() { return lg.league.schedule[lg.league.round].find(([a, b]) => a === 0 || b === 0); }
// Index of the human's opponent this round
export function myOpponent() { const [a, b] = myPair(); return a === 0 ? b : a; }

function recordWinner(ai, bi, sa, sb, aWon) {
  const A = lg.league.entries[ai], B = lg.league.entries[bi];
  A.P++; B.P++; A.PF += sa; A.PA += sb; B.PF += sb; B.PA += sa;
  if (aWon) { A.W++; B.L++; } else { B.W++; A.L++; }
}
// Record the human's result against entry `oi`, simulate the rest of the round, and move on.
export function finishRound(oi, myScore, botScore, iWon) {
  const league = lg.league, [a] = myPair();
  recordWinner(0, oi, myScore, botScore, iWon);
  const games = [a === 0
    ? { a: 0, b: oi, sa: myScore, sb: botScore, aw: iWon }
    : { a: oi, b: 0, sa: botScore, sb: myScore, aw: !iWon }];
  for (const [x, y] of league.schedule[league.round]) {
    if (x === 0 || y === 0) continue;
    const res = simulateGame(league.entries[x], league.entries[y], Math.random() < 0.5 ? 0 : 1, leagueTarget());
    const [sx, sy] = res.scores;
    recordWinner(x, y, sx, sy, res.winner === 0);
    games.push({ a: x, b: y, sa: sx, sb: sy, aw: res.winner === 0 });
  }
  lg.lastRound = { round: league.round + 1, games };
  league.round++;
  saveLeague();
}
