// Career Mode stats: kept with the solo career (in its save), from the start of the career, or from when stats were
// added for a career begun before. A tally is kept during each game (your throws), added in when it ends, and each
// season's summary adds the honours.
import { botById } from '../shared/roster.js';
import { tierName, BOTTOM } from '../shared/career.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function emptyStats(season, tier) {
  return {
    since: season, games: 0, won: 0, lost: 0, streak: 0, bestStreak: 0,
    throws: 0, points: 0, bottles: 0, misses: 0, singles: 0, overs: 0, bestThrow: 0,
    winSingle: 0, winMulti: 0, wonByMisses: 0, lostByMisses: 0, fastestWin: null,
    cupPlayed: 0, cupWon: 0, seasons: 0, titles: 0, promotions: 0, relegations: 0, cups: 0, highest: tier,
    vs: {}, // bot id → { w, l }
  };
}

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
// won; cup (a cup tie); opp (their bot id); youOut / theyOut (went out on three misses)
export function recordGame(s, t, { won, cup, opp, youOut, theyOut }) {
  s.games++;
  for (const k of ['throws', 'points', 'bottles', 'misses', 'singles', 'overs']) s[k] += t[k];
  s.bestThrow = Math.max(s.bestThrow, t.best);
  const v = (s.vs[opp] ||= { w: 0, l: 0 });
  if (won) {
    s.won++; v.w++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
    if (theyOut) s.wonByMisses++;
    else if (t.last === 1) s.winSingle++;
    else s.winMulti++;
    if (!theyOut) s.fastestWin = s.fastestWin == null ? t.throws : Math.min(s.fastestWin, t.throws);
  } else {
    s.lost++; v.l++; s.streak = 0;
    if (youOut) s.lostByMisses++;
  }
  if (cup) { s.cupPlayed++; if (won) s.cupWon++; }
}
// The end of a season: your line from the career's summary (shared/career.js nextSeason)
export function recordSeason(s, me) {
  if (!me) return;
  s.seasons++;
  if (me.champion) s.titles++;
  if (me.promoted) s.promotions++;
  if (me.relegated) s.relegations++;
  if (me.cupWinner) s.cups++;
  s.highest = Math.min(s.highest ?? BOTTOM, me.tier, me.newTier);
}

// ---------- The screen ----------
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
const per = (a, b) => (b ? (a / b).toFixed(1) : '–');
const tile = (label, value, more = '') => `<div><span>${label}</span><b>${value}</b>${more ? `<em>${more}</em>` : ''}</div>`;
const section = (title, tiles) => `<div class="sectionlabel">${title}</div><div class="trstats cstats">${tiles.join('')}</div>`;

export function renderStats(s) {
  if (!s || !s.games) return '<p class="sub">No games yet. Play a match and your stats will start here.</p>';
  const rivals = Object.entries(s.vs).map(([id, r]) => ({ name: botById(id)?.name ?? id, ...r }));
  const most = key => rivals.filter(r => r[key] > 0).sort((a, b) => b[key] - a[key] || (key === 'w' ? a.l - b.l : a.w - b.w))[0];
  const fav = most('w'), nemesis = most('l');
  return section('Record', [
    tile('Games', s.games, `${s.won} won, ${s.lost} lost`),
    tile('Win rate', pct(s.won, s.games)),
    tile('Longest winning run', s.bestStreak, s.streak > 1 ? `${s.streak} in a row now` : ''),
    tile('Cup ties', `${s.cupWon} / ${s.cupPlayed}`, 'won'),
  ]) + section('Throwing', [
    tile('Points scored', s.points, `${per(s.points, s.games)} a game, ${per(s.points, s.throws)} a throw`),
    tile('Bottles knocked over', s.bottles, `${per(s.bottles, s.games)} a game, ${per(s.bottles, s.throws)} a throw`),
    tile('Throws', s.throws, `${per(s.throws, s.games)} a game`),
    tile('Misses', pct(s.misses, s.throws), `${s.misses} of your throws`),
    tile('Single-pin throws', pct(s.singles, s.throws), `${s.singles} of your throws`),
    tile('Best throw', `${s.bestThrow} pts`),
  ]) + section('Finishing', [
    tile('Won with a single pin', s.winSingle, `${pct(s.winSingle, s.won)} of wins · ${per(s.winSingle, s.games)} a game`),
    tile('Won with several pins', s.winMulti, `${pct(s.winMulti, s.won)} of wins`),
    tile('Won through their 3 misses', pct(s.wonByMisses, s.won), `${s.wonByMisses} of your wins`),
    tile('Lost through your 3 misses', pct(s.lostByMisses, s.lost), `${s.lostByMisses} of your defeats`),
    tile('Went over the target', s.overs, `${per(s.overs, s.games)} a game`),
    tile('Fastest win', s.fastestWin == null ? '–' : `${s.fastestWin} throws`),
  ]) + section('Honours', [
    tile('Seasons', s.seasons),
    tile('League titles', s.titles),
    tile('Promotions', s.promotions, s.relegations ? `${s.relegations} relegation${s.relegations > 1 ? 's' : ''}` : 'never relegated'),
    tile('Cups', s.cups),
    tile('Highest league', tierName(s.highest ?? BOTTOM)),
  ]) + (fav || nemesis ? section('Rivals', [
    fav ? tile('Favourite opponent', esc(fav.name), `beaten ${fav.w} time${fav.w > 1 ? 's' : ''}`) : '',
    nemesis ? tile('Nemesis', esc(nemesis.name), `lost to ${nemesis.l} time${nemesis.l > 1 ? 's' : ''}`) : '',
  ]) : '');
}
