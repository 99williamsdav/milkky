// Single-player league career against the computer players, saved in this browser.
// Three leagues of 8 (shared/roster.js): you start in the Sunday League. Each season you play everyone in
// your league once; the other two leagues play their seasons in the background. Then the top 2 of each
// league go up and the bottom 2 go down, for you and the bots alike.
// Alongside the league runs a knockout cup for all 24 players: the 16 outside the Premier League play a
// first round, the Premier League joins in the second, then quarter-finals, semi-finals and a final.
import { aiFromSkill, simulateGame } from '../shared/ai.js';
import { roundRobin } from '../shared/schedule.js';
import { botById, startingTiers, TIERS } from '../shared/roster.js';

const KEY = 'milkky-career-v1';
const OLD_KEY = 'milkky-league-v1'; // the earlier one-league version, replaced by this
export const UP = 2, DOWN = 2; // promoted and relegated each season
const BOTTOM = TIERS.length - 1;

// career: { season, tier (0 = Premier League), tiers: [bot ids per league, top first; yours without you] }
// league: this season's league; entries[0] is you. summary: what happened at the end of last season.
// cup: this season's cup (see below).
export const lg = { career: null, league: null, lastRound: null, summary: null, cup: null };

export const entryFor = id => { const b = botById(id); return { bot: id, name: b.name, skill: b.skill, ai: aiFromSkill(b.skill) }; };
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
  newCup();
  saveLeague();
}
export function saveLeague() { try { localStorage.setItem(KEY, JSON.stringify(lg)); } catch (e) {} }
export function loadLeague() {
  try {
    localStorage.removeItem(OLD_KEY);
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.career && d.league) Object.assign(lg, d);
    if (lg.league && !lg.cup) { newCup(); autoCup(); saveLeague(); } // a career from before the cup existed
  } catch (e) {}
}
export const leagueTarget = () => lg.league.target || 50;
export const leagueDone = () => lg.league.round >= lg.league.schedule.length;
export const seasonDone = () => leagueDone() && cupDone();
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
  autoCup();
  saveLeague();
}

// ---------- The cup ----------
// cup: { round: rounds played, ties: [per round: [{ a, b, sa?, sb?, w? }]], byes: Premier League ids (join in
// round 2), winner, out: { round, by } once you're knocked out }. Entrants are bot ids, or 'you'.
export const YOU = 'you';
export const CUP_ROUNDS = ['First round', 'Second round', 'Quarter-finals', 'Semi-finals', 'Final'];
const CUP_AFTER = [2, 3, 5, 6, 7]; // each cup round is played after this many league rounds (the final after the last)
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const draw = ids => { const list = shuffle([...ids]), ties = []; for (let i = 0; i < list.length; i += 2) ties.push({ a: list[i], b: list[i + 1] }); return ties; };
export const cupName = id => (id === YOU ? 'You' : botById(id).name);

function newCup() {
  const c = lg.career;
  const premier = c.tier === 0 ? [...c.tiers[0], YOU] : [...c.tiers[0]];
  const rest = c.tiers.slice(1).flat().concat(c.tier > 0 ? [YOU] : []);
  lg.cup = { round: 0, ties: [draw(rest)], byes: premier, winner: null, out: null };
}
export const cupDone = () => !!lg.cup?.winner;
// Is a cup round due now (the league has got far enough)?
const cupDue = () => !cupDone() && lg.league.round >= CUP_AFTER[lg.cup.round];
// Your tie in the cup round that's due, if you're in it
export const myCupTie = () => (cupDue() ? lg.cup.ties[lg.cup.round].find(t => t.a === YOU || t.b === YOU) : null) || null;
// What you play next: 'cup' (your cup tie), 'league', or 'done' (the season is over)
export function nextEvent() {
  if (myCupTie()) return 'cup';
  if (!leagueDone()) return 'league';
  return 'done';
}
// Play the cup round that's due. mine: your result { sa, sb } as the tie's a/b scores, if you're in it.
function playCupRound(mine) {
  const cup = lg.cup, ties = cup.ties[cup.round];
  for (const t of ties) {
    if (t.a === YOU || t.b === YOU) Object.assign(t, mine);
    else {
      const res = simulateGame(entryFor(t.a), entryFor(t.b), Math.random() < 0.5 ? 0 : 1, leagueTarget());
      Object.assign(t, { sa: res.scores[0], sb: res.scores[1], w: res.winner === 0 ? t.a : t.b });
    }
  }
  const mineTie = ties.find(t => t.a === YOU || t.b === YOU);
  if (mineTie && mineTie.w !== YOU) cup.out = { round: cup.round, by: mineTie.w };
  const through = ties.map(t => t.w);
  cup.round++;
  if (cup.round === CUP_ROUNDS.length) cup.winner = through[0];
  else cup.ties.push(draw(cup.round === 1 ? [...through, ...cup.byes] : through));
}
// Play any cup rounds that are due and don't involve you
function autoCup() { while (cupDue() && !myCupTie()) playCupRound(null); }
// Record your cup tie (against the bot opponent) and play the rest of that round.
export function finishCupTie(myScore, botScore, iWon) {
  const t = myCupTie(), youA = t.a === YOU, opp = youA ? t.b : t.a;
  playCupRound({ sa: youA ? myScore : botScore, sb: youA ? botScore : myScore, w: iWon ? YOU : opp });
  autoCup();
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
  const c = lg.career;
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
    cup: { winner: cupName(lg.cup.winner), bot: lg.cup.winner === YOU ? null : lg.cup.winner, out: lg.cup.out && { round: lg.cup.out.round, by: cupName(lg.cup.out.by) } },
    moves: moves.filter(m => m.id !== YOU).map(m => ({ name: botById(m.id).name, bot: m.id, from: m.from, to: m.to })),
  };
  c.tiers = tiers.map(ids => ids.filter(id => id !== YOU));
  c.tier = newTier;
  c.season++;
  startSeason();
}
