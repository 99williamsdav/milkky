// Achievements: unlocked once each, remembered in this browser (localStorage), announced with a pop-up.
// main.js reports what happens (each throw, and career and online milestones); this decides what's earned.
// Throws count when they're yours: in local games any person's throw on this device, online only your own.
const KEY = 'milkky-achievements-v1';

export const GROUPS = ['Throwing', 'Winning', 'Funny ones', 'Career', 'Online'];
export const ACHIEVEMENTS = [
  { id: 'pinpoint', group: 'Throwing', name: 'Pinpoint', desc: 'Knock over a single bottle by landing the stick on its head' },
  { id: 'singleSingle', group: 'Throwing', name: 'Single Single', desc: 'Knock over the 1, and only the 1' },
  { id: 'bulldozer', group: 'Throwing', name: 'Bulldozer', desc: 'Knock over 7 bottles in one throw' },
  { id: 'skittled', group: 'Throwing', name: 'Skittled', desc: 'Knock over all 12 bottles in one throw' },
  { id: 'longRange', group: 'Throwing', name: 'Long Range', desc: 'Knock over a single bottle more than 6 m away' },
  { id: 'backRow', group: 'Throwing', name: 'Back Row', desc: 'Knock over the 7, 8 or 9 with the opening throw of a game' },
  { id: 'bowlingAlley', group: 'Throwing', name: 'Bowling Alley', desc: 'Knock over the 1, 2, 3, 10 and 4 (the front two rows) in one throw' },
  { id: 'hailMary', group: 'Winning', name: 'Hail Mary', desc: 'Win with a single 12' },
  { id: 'clutch', group: 'Winning', name: 'Clutch', desc: 'Win while on your last life' },
  { id: 'comeback', group: 'Winning', name: 'Comeback Kid', desc: 'Win after going over the target and dropping back to half' },
  { id: 'flawless', group: 'Winning', name: 'Flawless', desc: 'Win a game without a single miss' },
  { id: 'speedDemon', group: 'Winning', name: 'Speed Demon', desc: 'Win a game to 50 in 8 throws or fewer' },
  { id: 'countdown', group: 'Winning', name: 'Countdown', desc: 'Score 12, 11, 10 with three throws in a row' },
  { id: 'butterfingers', group: 'Funny ones', name: 'Butterfingers', desc: 'Go out with three misses in a row' },
  { id: 'yoyo', group: 'Funny ones', name: 'Yo-Yo', desc: 'Go over the target three times in one game' },
  { id: 'soClose', group: 'Funny ones', name: 'So Close', desc: 'Lose a game when you needed just 1 point' },
  { id: 'goingUp', group: 'Career', name: 'Going Up', desc: 'Win your first promotion' },
  { id: 'invincible', group: 'Career', name: 'Invincible', desc: 'Win every league game in a season' },
  { id: 'giantKiller', group: 'Career', name: 'Giant Killer', desc: 'Knock a Premier League player out of the cup while you’re in the Sunday League' },
  { id: 'cupWinner', group: 'Career', name: 'Cup Winner', desc: 'Win the cup' },
  { id: 'double', group: 'Career', name: 'The Double', desc: 'Win your league and the cup in the same season' },
  { id: 'milkKing', group: 'Career', name: 'Milk King', desc: 'Win the Premier League' },
  { id: 'goodCompany', group: 'Online', name: 'Good Company', desc: 'Finish an online game against another person' },
  { id: 'longHaul', group: 'Online', name: 'Long Haul', desc: 'Finish a take-your-time league' },
];
const byId = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

// ---------- What you've unlocked: { id: time unlocked } ----------
let got = {};
try { got = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
export const unlocked = () => got;
export const count = () => Object.keys(got).filter(id => byId[id]).length;

let onUnlock = () => {};
export function onUnlocked(fn) { onUnlock = fn; }
export function unlock(id) {
  if (got[id] || !byId[id]) return false;
  got[id] = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(got)); } catch (e) {}
  onUnlock(byId[id]);
  return true;
}

// ---------- During a game ----------
// Per player: throws taken, whether they've missed, times gone over, whether they dropped to half,
// and recent single-bottle scores (for Countdown). `throws` counts every throw in the game (for Back Row).
let match = null;
// mine[i]: whether player i is you
export function gameStarted(mine, { midway = false } = {}) {
  match = { throws: midway ? 1 : 0, players: mine.map(m => ({ mine: m, throws: 0, missed: false, overs: 0, halved: false, recent: [] })) };
}

const FRONT = [1, 2, 3, 10, 4], BACK = [7, 8, 9];
// A throw has been played and scored. t: {
//   who: thrower's index, fallen: bottle numbers, hit: { num, top } | null (the stick's first touch),
//   before: { [num]: { x, z } } bottle positions before the throw, release: { x, z } where it's thrown from,
//   target, players: [{ score, misses, out }] after the throw, scoreBefore, missesBefore (the thrower's),
//   winner: index or -1, over: the game has ended }
export function thrown(t) {
  if (!match || !match.players[t.who]) return;
  const p = match.players[t.who], f = t.fallen, single = f.length === 1 ? f[0] : null;
  const opening = match.throws === 0;
  match.throws++;
  p.throws++;
  const pts = !f.length ? 0 : single ?? f.length;
  const wentOver = f.length && t.scoreBefore + pts > t.target;
  if (!f.length) p.missed = true;
  if (wentOver) { p.overs++; p.halved = true; }
  p.recent = [...p.recent, f.length && !wentOver ? single : null].slice(-3);

  if (p.mine) {
    if (single && t.hit?.top && t.hit.num === single) unlock('pinpoint');
    if (single === 1) unlock('singleSingle');
    if (f.length >= 7) unlock('bulldozer');
    if (f.length === 12) unlock('skittled');
    const at = single && t.before[single];
    if (at && Math.hypot(at.x - t.release.x, at.z - t.release.z) > 6) unlock('longRange');
    if (opening && f.some(n => BACK.includes(n))) unlock('backRow');
    if (FRONT.every(n => f.includes(n))) unlock('bowlingAlley');
    if (p.recent.join() === '12,11,10') unlock('countdown');
    if (p.overs >= 3) unlock('yoyo');
    if (t.players[t.who].out) unlock('butterfingers');
  }
  if (!t.over) return;
  // The game's over: wins (the winner may not be the thrower, if everyone else went out) and near misses
  match.players.forEach((q, i) => {
    if (!q.mine) return;
    const now = t.players[i];
    if (i === t.winner) {
      if (i === t.who && single === 12) unlock('hailMary');
      if ((i === t.who ? t.missesBefore : now.misses) >= 2) unlock('clutch');
      if (q.halved) unlock('comeback');
      if (!q.missed) unlock('flawless');
      if (t.target === 50 && q.throws <= 8) unlock('speedDemon');
    } else if (t.target - now.score === 1) unlock('soClose');
  });
  match = null;
}
// Not a throw of ours to count (e.g. watching someone else's game)
export function gameLeft() { match = null; }
