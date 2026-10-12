// The Career stats screen (solo Career Mode and online careers). Keeping the stats is in src/shared/careerstats.js.
import { tierName, BOTTOM } from '../shared/career.js';
import { botById } from '../shared/roster.js';
export * from '../shared/careerstats.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- The screen ----------
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
const per = (a, b) => (b ? (a / b).toFixed(1) : '–');
const tile = (label, value, more = '') => `<div><span>${label}</span><b>${value}</b>${more ? `<em>${more}</em>` : ''}</div>`;
const section = (title, tiles) => `<div class="sectionlabel">${title}</div><div class="trstats cstats">${tiles.join('')}</div>`;

// nameOf(id): an opponent's name (bots by default; online careers also have people)
export function renderStats(s, nameOf = id => botById(id)?.name ?? id) {
  if (!s || !s.games) return '<p class="sub">No games yet. Play a match and your stats will start here.</p>';
  const rivals = Object.entries(s.vs).map(([id, r]) => ({ name: nameOf(id), ...r }));
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
