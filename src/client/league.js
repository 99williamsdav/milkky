// Single-player league career against the computer players, saved in this browser.
// Three leagues of 8 (shared/roster.js): you start in the Sunday League. Each season you play everyone in
// your league once; the other two leagues play their seasons in the background. Then the top 2 of each
// league go up and the bottom 2 go down, for you and the bots alike.
import { aiFromSkill, simulateGame } from '../shared/ai.js';
import { roundRobin } from '../shared/schedule.js';
import { botById, startingTiers, TIERS } from '../shared/roster.js';

const KEY = 'milkky-career-v1';
const OLD_KEY = 'milkky-league-v1'; // the earlier one-league version, replaced by this
export const UP = 2, DOWN = 2; // promoted and relegated each season
const BOTTOM = TIERS.length - 1;

// career: { season, tier (0 = Premier League), tiers: [bot ids per league, top first; yours without you] }
// league: this season's league; entries[0] is you. summary: what happened at the end of last season.
export const lg = { career: null, league: null, lastRound: null, summary: null };

const entryFor = id => { const b = botById(id); return { bot: id, name: b.name, skill: b.skill, ai: aiFromSkill(b.skill) }; };
const fresh = e => Object.assign(e, { P: 0, W: 0, L: 0, PF: 0, PA: 0 });

export function newCareer(target) {
  lg.career = { season: 1, tier: BOTTOM, tiers: startingTiers(), target };
  lg.summary = null;
  startSeason();
}
function startSeason() {
  const c = lg.career;
  const entries = [{ name: 'You', human: true }, ...c.tiers[c.tier].map(entryFor)].map(fresh);
  lg.league = { season: c.season, tier: c.tier, entries, schedule: roundRobin(entries.length), round: 0, target: c.target };
  lg.lastRound = null;
  saveLeague();
}
export function saveLeague() { try { localStorage.setItem(KEY, JSON.stringify(lg)); } catch (e) {} }
export function loadLeague() {
  try {
    localStorage.removeItem(OLD_KEY);
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.career && d.league) Object.assign(lg, d);
  } catch (e) {}
}
export const leagueTarget = () => lg.league.target || 50;
export const seasonDone = () => lg.league.round >= lg.league.schedule.length;
export const tierName = t => TIERS[t];
const rank = entries => entries.map((e, i) => ({ e, i })).sort((a, b) =>
  b.e.W - a.e.W || (b.e.PF - b.e.PA) - (a.e.PF - a.e.PA) || b.e.PF - a.e.PF);
export const standings = () => rank(lg.league.entries);
// Where a table position leads at the end of the season: 'up', 'down' or ''
export function zone(pos, tier = lg.league.tier) {
  if (tier > 0 && pos < UP) return 'up';
  if (tier < BOTTOM && pos >= lg.league.entries.length - DOWN) return 'down';
  return '';
}
export function myPair() { return lg.league.schedule[lg.league.round].find(([a, b]) => a === 0 || b === 0); }
// Index of the human's opponent this round
export function myOpponent() { const [a, b] = myPair(); return a === 0 ? b : a; }

function recordWinner(entries, ai, bi, sa, sb, aWon) {
  const A = entries[ai], B = entries[bi];
  A.P++; B.P++; A.PF += sa; A.PA += sb; B.PF += sb; B.PA += sa;
  if (aWon) { A.W++; B.L++; } else { B.W++; A.L++; }
}
// Record the human's result against entry `oi`, simulate the rest of the round, and move on.
export function finishRound(oi, myScore, botScore, iWon) {
  const league = lg.league, [a] = myPair();
  recordWinner(league.entries, 0, oi, myScore, botScore, iWon);
  const games = [a === 0
    ? { a: 0, b: oi, sa: myScore, sb: botScore, aw: iWon }
    : { a: oi, b: 0, sa: botScore, sb: myScore, aw: !iWon }];
  for (const [x, y] of league.schedule[league.round]) {
    if (x === 0 || y === 0) continue;
    const res = simulateGame(league.entries[x], league.entries[y], Math.random() < 0.5 ? 0 : 1, leagueTarget());
    const [sx, sy] = res.scores;
    recordWinner(league.entries, x, y, sx, sy, res.winner === 0);
    games.push({ a: x, b: y, sa: sx, sb: sy, aw: res.winner === 0 });
  }
  lg.lastRound = { round: league.round + 1, games };
  league.round++;
  saveLeague();
}

// A whole season for a league of bots, played in the background. Returns the bot ids, best first.
function simulateSeason(ids) {
  const entries = ids.map(entryFor).map(fresh);
  for (const round of roundRobin(entries.length)) {
    for (const [x, y] of round) {
      const res = simulateGame(entries[x], entries[y], Math.random() < 0.5 ? 0 : 1, leagueTarget());
      recordWinner(entries, x, y, res.scores[0], res.scores[1], res.winner === 0);
    }
  }
  return rank(entries).map(({ e }) => e.bot);
}

// End of season: finish the other leagues, move everyone up and down, and start the next season.
// Leaves lg.summary saying what happened.
export function nextSeason() {
  const c = lg.career, YOU = 'you';
  // Final order of every league, best first ('you' in yours)
  const order = c.tiers.map((ids, t) => t === c.tier
    ? standings().map(({ e }) => e.human ? YOU : e.bot)
    : simulateSeason(ids));
  const champions = order.map(o => o[0]);
  const moves = [];
  const tiers = order.map((o, t) => {
    const stay = o.filter((id, pos) => !(t > 0 && pos < UP) && !(t < BOTTOM && pos >= o.length - DOWN));
    const fromBelow = t < BOTTOM ? order[t + 1].slice(0, UP) : [];
    const fromAbove = t > 0 ? order[t - 1].slice(-DOWN) : [];
    fromBelow.forEach(id => moves.push({ id, from: t + 1, to: t }));
    fromAbove.forEach(id => moves.push({ id, from: t - 1, to: t }));
    return [...fromAbove, ...stay, ...fromBelow];
  });
  const myPos = order[c.tier].indexOf(YOU), newTier = tiers.findIndex(ids => ids.includes(YOU));
  lg.summary = {
    season: c.season, tier: c.tier, pos: myPos + 1, newTier,
    champions: champions.map(id => (id === YOU ? 'You' : botById(id).name)),
    moves: moves.filter(m => m.id !== YOU).map(m => ({ name: botById(m.id).name, bot: m.id, from: m.from, to: m.to })),
  };
  c.tiers = tiers.map(ids => ids.filter(id => id !== YOU));
  c.tier = newTier;
  c.season++;
  startSeason();
}
