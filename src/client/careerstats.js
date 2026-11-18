// The Career stats screen (solo Career Mode and online careers). Keeping the stats is in src/shared/careerstats.js.
import { tierName, BOTTOM, SIZE, CUP_ROUNDS } from '../shared/career.js';
import { TIERS } from '../shared/roster.js';
import { botById } from '../shared/roster.js';
export * from '../shared/careerstats.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- The screen ----------
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
const per = (a, b) => (b ? (a / b).toFixed(1) : '–');
// A tile; chart: the key of its season-by-season chart (CHARTS), which opens when it's tapped
const tile = (label, value, more = '', chart = null) => chart
  ? `<button class="cstile" data-chart="${chart}"><span>${label}<i aria-hidden="true">›</i></span><b>${value}</b>${more ? `<em>${more}</em>` : ''}</button>`
  : `<div><span>${label}</span><b>${value}</b>${more ? `<em>${more}</em>` : ''}</div>`;
export const ordinal = n => `${n}${[, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
// The furthest you've got in the cup, by the round you went out in (CUP_ROUNDS.length: won it)
const cupRun = r => (r >= CUP_ROUNDS.length ? 'Won it' : CUP_ROUNDS[r]);
const section = (title, tiles) => `<div class="sectionlabel">${title}</div><div class="trstats cstats">${tiles.join('')}</div>`;

// nameOf(id): an opponent's name (bots by default; online careers also have people)
export function renderStats(s, nameOf = id => botById(id)?.name ?? id) {
  if (!s || !s.games) return '<p class="sub">No games yet. Play a match and your stats will start here.</p>';
  const rivals = Object.entries(s.vs).map(([id, r]) => ({ name: nameOf(id), ...r }));
  const most = key => rivals.filter(r => r[key] > 0).sort((a, b) => b[key] - a[key] || (key === 'w' ? a.l - b.l : a.w - b.w))[0];
  const fav = most('w'), nemesis = most('l');
  return section('Record', [
    tile('Games', s.games, `${s.won} won, ${s.lost} lost`),
    tile('Win rate', pct(s.won, s.games), '', 'winRate'),
    tile('Longest winning run', s.bestStreak, s.streak > 1 ? `${s.streak} in a row now` : ''),
    tile('Cup ties', `${s.cupWon} / ${s.cupPlayed}`, 'won'),
  ]) + section('Throwing', [
    tile('Points scored', s.points, `${per(s.points, s.games)} a game, ${per(s.points, s.throws)} a throw`, 'points'),
    tile('Bottles knocked over', s.bottles, `${per(s.bottles, s.games)} a game, ${per(s.bottles, s.throws)} a throw`),
    tile('Throws', s.throws, `${per(s.throws, s.games)} a game`, 'throws'),
    tile('Misses', pct(s.misses, s.throws), `${s.misses} of your throws`, 'misses'),
    tile('Single-pin throws', pct(s.singles, s.throws), `${s.singles} of your throws`),
    tile('Best throw', `${s.bestThrow} pts`),
  ]) + section('Finishing', [
    tile('Won with a single pin', s.winSingle, `${pct(s.winSingle, s.won)} of wins · ${per(s.winSingle, s.games)} a game`, 'winSingle'),
    tile('Won with several pins', s.winMulti, `${pct(s.winMulti, s.won)} of wins`, 'winMulti'),
    tile('Won through their 3 misses', pct(s.wonByMisses, s.won), `${s.wonByMisses} of your wins`, 'wonByMisses'),
    tile('Lost through your 3 misses', pct(s.lostByMisses, s.lost), `${s.lostByMisses} of your defeats`, 'lostByMisses'),
    tile('Went over the target', s.overs, `${per(s.overs, s.games)} a game`),
    tile('Fastest win', s.fastestWin == null ? '–' : `${s.fastestWin} throws`),
  ]) + section('Honours', [
    tile('Seasons', s.seasons),
    tile('League titles', s.titles),
    tile('Promotions', s.promotions, s.relegations ? `${s.relegations} relegation${s.relegations > 1 ? 's' : ''}` : 'never relegated'),
    tile('Cups', s.cups),
    s.bestFinish ? tile('Highest league position', ordinal(s.bestFinish.pos), `in the ${tierName(s.bestFinish.tier)}`, 'finishes')
      : tile('Highest league position', s.seasons ? tierName(s.highest ?? BOTTOM) : '–', s.seasons ? 'places are kept from the end of this season' : 'after your first season', 'finishes'),
    tile('Best cup run', s.bestCup == null ? (s.cups ? 'Won it' : '–') : cupRun(s.bestCup),
      s.bestCup == null && !s.cups ? (s.seasons ? 'kept from the end of this season' : 'after your first season')
        : s.cups ? `won ${s.cups} time${s.cups > 1 ? 's' : ''}` : s.bestCup === CUP_ROUNDS.length - 1 ? 'runners-up' : 'knocked out there'),
  ]) + (fav || nemesis ? section('Rivals', [
    fav ? tile('Favourite opponent', esc(fav.name), `beaten ${fav.w} time${fav.w > 1 ? 's' : ''}`) : '',
    nemesis ? tile('Nemesis', esc(nemesis.name), `lost to ${nemesis.l} time${nemesis.l > 1 ? 's' : ''}`) : '',
  ]) : '');
}

// ---------- Season by season ----------
// Each chart: its title, a note on what it measures, what's measured each season (of: null when there's nothing to
// measure), shown against the whole career (the dashed line); pc: a percentage
const rate = (a, b) => (b ? (100 * a) / b : null);
const each = (a, b) => (b > 0 ? a / b : null);
const CHARTS = {
  finishes: { title: 'League finishes' },
  winRate: { title: 'Win rate', pc: true, of: l => rate(l.won, l.games) },
  winSingle: { title: 'Wins with a single pin', note: 'As a share of your wins', pc: true, of: l => rate(l.winSingle, l.won) },
  winMulti: { title: 'Wins with several pins', note: 'As a share of your wins', pc: true, of: l => rate(l.winMulti, l.won) },
  wonByMisses: { title: 'Wins through their 3 misses', note: 'As a share of your wins', pc: true, of: l => rate(l.wonByMisses, l.won) },
  lostByMisses: { title: 'Defeats through your 3 misses', note: 'As a share of your defeats', pc: true, of: l => rate(l.lostByMisses, l.lost) },
  misses: { title: 'Misses', note: 'As a share of your throws', pc: true, of: l => rate(l.misses, l.throws) },
  points: { title: 'Points scored per game', of: l => each(l.points, l.games - (l.battles || 0)) },
  throws: { title: 'Throws per game', of: l => each(l.throws, l.games - (l.battles || 0)) },
};
const W = 320, H = 180, L = 30, R = 8, T = 16, B = 26;
const svgOf = (inner, label) => `<div class="worm"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${inner}</svg></div>`;
const nice = v => [5, 10, 20, 25, 50, 100, 200, 500].find(n => n >= v) || Math.ceil(v / 100) * 100;
const seasonAxis = (seasons, x) => seasons.map((n, i) => `<text class="wtick" x="${x(i).toFixed(1)}" y="${H - B + 13}" text-anchor="middle">${n}</text>`).join('')
  + `<text class="wlabel" x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle">Season</text>`;

// One measure: a bar for each season (the palest is the season being played), the whole career as a dashed line
function barChart(s, c, seasons, now) {
  const vals = seasons.map(n => c.of(s.bySeason[n] || {}));
  const all = c.of(s), fmt = v => (c.pc ? `${Math.round(v)}%` : v.toFixed(1));
  const top = c.pc ? 100 : nice(Math.max(1, all || 0, ...vals.filter(v => v != null)) * 1.15);
  const n = seasons.length, slot = (W - L - R) / Math.max(n, 4), bw = Math.min(28, slot * 0.6);
  const x = i => L + slot * (i + 0.5), y = v => T + (1 - v / top) * (H - T - B);
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = (top * k) / 4;
    g += `<line class="wgrid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="wtick" x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  vals.forEach((v, i) => {
    if (v == null) { g += `<text class="wtick" x="${x(i).toFixed(1)}" y="${y(0) - 4}" text-anchor="middle">–</text>`; return; }
    const cls = seasons[i] === now ? 'cbar now' : 'cbar';
    g += `<rect class="${cls}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y(0) - y(v)).toFixed(1)}" rx="3"/>`;
    if (n <= 12) g += `<text class="cval" x="${x(i).toFixed(1)}" y="${(y(v) - 4).toFixed(1)}" text-anchor="middle">${fmt(v)}</text>`;
  });
  if (all != null) g += `<line class="wtarget" x1="${L}" x2="${W - R}" y1="${y(all)}" y2="${y(all)}"/>`;
  g += `<line class="waxis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` + seasonAxis(seasons, x);
  const notes = [c.note ? `${c.note}.` : '', all != null ? `The dashed line is your whole career: ${fmt(all)}.` : '',
    seasons.includes(now) ? 'The palest bar is this season so far.' : ''].filter(Boolean).join(' ');
  return svgOf(g, c.title) + (notes ? `<p class="sub cnote">${notes}</p>` : '');
}
// Where you finished each season: the three leagues as one ladder, the top of the Premier League at the top
function finishChart(s, seasons) {
  const done = seasons.filter(n => s.bySeason[n].pos != null);
  if (!done.length) return '<p class="sub cnote">Your first finish shows here at the end of the season.</p>';
  const rungs = TIERS.length * SIZE, n = done.length, slot = (W - L - R) / Math.max(n, 4);
  const x = i => L + slot * (i + 0.5), y = r => T + ((r - 0.5) / rungs) * (H - T - B);
  let g = '';
  TIERS.forEach((name, t) => {
    g += `<rect class="cband b${t % 2}" x="${L}" width="${W - L - R}" y="${y(t * SIZE + 0.5).toFixed(1)}" height="${(y(SIZE + 0.5) - y(0.5)).toFixed(1)}"/>`;
    g += `<text class="wlabel" x="${W - R - 4}" y="${(y(t * SIZE + 0.5) + 11).toFixed(1)}" text-anchor="end">${esc(name)}</text>`;
  });
  const pts = done.map((k, i) => { const l = s.bySeason[k]; return [x(i), y(l.tier * SIZE + l.pos), l]; });
  if (pts.length > 1) g += `<polyline class="wline" stroke="var(--blue)" points="${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`;
  for (const [px, py, l] of pts) {
    g += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${l.pos === 1 ? 5 : 3.5}" fill="${l.pos === 1 ? '#d4a017' : 'var(--blue)'}"/>`;
    if (n <= 12) g += `<text class="cval" x="${px.toFixed(1)}" y="${(py - 7).toFixed(1)}" text-anchor="middle">${ordinal(l.pos)}</text>`;
  }
  g += `<line class="waxis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>` + seasonAxis(done, x);
  const runs = done.filter(k => s.bySeason[k].cup != null).map(k => `season ${k} ${cupRun(s.bySeason[k].cup).toLowerCase()}`);
  return svgOf(g, 'League finishes') + `<p class="sub cnote">Gold: champions.${runs.length ? ` In the cup (the round you went out in): ${runs.join(', ')}.` : ''}</p>`;
}
// The chart behind a tile (key: from CHARTS); season: the one being played now
export function renderChart(s, key, season) {
  const c = CHARTS[key];
  if (!c) return '';
  const kept = Object.keys(s.bySeason || {}).map(Number);
  const seasons = [...new Set(key === 'finishes' || !kept.length ? kept : [...kept, season])].sort((a, b) => a - b);
  const first = seasons[0];
  const note = first == null ? 'Season-by-season figures start now: they’ll show here after your next game.'
    : first > (s.since ?? first) ? `Season by season from season ${first}: earlier seasons only count in your totals.` : '';
  const body = !seasons.length ? '' : key === 'finishes' ? finishChart(s, seasons) : barChart(s, c, seasons, season);
  return `<div class="sectionlabel">${c.title}</div>${body}${note ? `<p class="sub cnote">${note}</p>` : ''}
    <div class="row"><button id="csAll">All stats</button></div>`;
}
