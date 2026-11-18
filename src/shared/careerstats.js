// Career stats, kept per person: the solo Career Mode keeps yours in its save (src/client), and the server keeps
// each person's in an online career. A tally is kept during each game (the person's own throws), added in when it
// ends, and each season's summary adds the honours. Each season also keeps its own line (bySeason), for the charts
// season by season: these start from the season they were added in (careers from before only have the totals).
// The screen that shows them is src/client/careerstats.js.
import { BOTTOM, CUP_ROUNDS } from './career.js';

export function emptyStats(season, tier) {
  return {
    since: season, games: 0, won: 0, lost: 0, streak: 0, bestStreak: 0,
    throws: 0, points: 0, bottles: 0, misses: 0, singles: 0, overs: 0, bestThrow: 0,
    winSingle: 0, winMulti: 0, wonByMisses: 0, lostByMisses: 0, fastestWin: null,
    cupPlayed: 0, cupWon: 0, seasons: 0, titles: 0, promotions: 0, relegations: 0, cups: 0, highest: tier,
    bestFinish: null, // { tier, pos }: your best league finish (the highest league, then the highest place in it)
    bestCup: null, // the furthest you've got in the cup: the round you went out in (from 0), or CUP_ROUNDS.length for winning it
    vs: {}, // opponent (bot id, or a person's career id) → { w, l }
    bySeason: {}, // season → its own line (seasonLine)
  };
}
const SEASON_KEYS = ['games', 'won', 'lost', 'throws', 'points', 'misses', 'winSingle', 'winMulti', 'wonByMisses', 'lostByMisses', 'battles'];
// A season's line: its game totals, then (once it's over) where you finished: tier, pos (1 = top), cup (as bestCup)
const seasonLine = (s, season) => ((s.bySeason ||= {})[season] ||= Object.fromEntries(SEASON_KEYS.map(k => [k, 0])));

// ---------- During a game: your throws ----------
export const newTally = () => ({ throws: 0, points: 0, bottles: 0, misses: 0, singles: 0, overs: 0, best: 0, last: 0 });
// fallen: bottle numbers knocked over; scoreBefore: your score before the throw
export function recordThrow(t, fallen, scoreBefore, target) {
  const n = fallen.length, pts = !n ? 0 : n === 1 ? fallen[0] : n;
  t.throws++; t.bottles += n; t.points += pts; t.last = n;
  if (!n) t.misses++;
  if (n === 1) t.singles++;
  if (n && scoreBefore + pts > target) t.overs++;
  t.best = Math.max(t.best, pts);
}

// ---------- When it ends ----------
// won; cup (a cup tie); opp (their career id: a bot id, or a person's); youOut / theyOut (went out on three misses)
// battle: a battle (shared/battle.js), where only the result counts (its throws aren't the classic game's)
// season: the season it was played in (for its line in bySeason)
export function recordGame(s, t, { won, cup, opp, youOut, theyOut, battle = false, season = null }) {
  const before = season == null ? null : { ...s };
  s.games++;
  if (battle) s.battles = (s.battles || 0) + 1;
  if (battle) t = { throws: 0, points: 0, bottles: 0, misses: 0, singles: 0, overs: 0, best: 0, last: -1 };
  for (const k of ['throws', 'points', 'bottles', 'misses', 'singles', 'overs']) s[k] += t[k];
  s.bestThrow = Math.max(s.bestThrow, t.best);
  const v = (s.vs[opp] ||= { w: 0, l: 0 });
  if (won) {
    s.won++; v.w++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
    if (battle) { /* no classic finish */ }
    else if (theyOut) s.wonByMisses++;
    else if (t.last === 1) s.winSingle++;
    else s.winMulti++;
    if (!theyOut && !battle) s.fastestWin = s.fastestWin == null ? t.throws : Math.min(s.fastestWin, t.throws);
  } else {
    s.lost++; v.l++; s.streak = 0;
    if (youOut && !battle) s.lostByMisses++;
  }
  if (cup) { s.cupPlayed++; if (won) s.cupWon++; }
  if (before) { const line = seasonLine(s, season); for (const k of SEASON_KEYS) line[k] += (s[k] || 0) - (before[k] || 0); }
}
// The end of a season: your line from the career's summary (shared/career.js nextSeason), and its number
export function recordSeason(s, me, season = null) {
  if (!me) return;
  if (s.cups && s.bestCup == null) s.bestCup = CUP_ROUNDS.length; // (won before cup runs were kept)
  if (!s.bestFinish || me.tier < s.bestFinish.tier || (me.tier === s.bestFinish.tier && me.pos < s.bestFinish.pos)) s.bestFinish = { tier: me.tier, pos: me.pos };
  if (me.cupRound != null) s.bestCup = Math.max(s.bestCup ?? -1, me.cupRound);
  if (season != null) Object.assign(seasonLine(s, season), { tier: me.tier, pos: me.pos, cup: me.cupRound ?? null });
  s.seasons++;
  if (me.champion) s.titles++;
  if (me.promoted) s.promotions++;
  if (me.relegated) s.relegations++;
  if (me.cupWinner) s.cups++;
  s.highest = Math.min(s.highest ?? BOTTOM, me.tier, me.newTier);
}
