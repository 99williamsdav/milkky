// Career: three leagues of 8 with promotion and relegation, and a cup for all 24, season after season.
// Shared by the solo Career Mode (one person, saved in the browser) and online careers (several people, run by
// the server). The state is plain JSON, so it can be saved anywhere.
//
// Entrants are bot ids (shared/roster.js) or people, whose ids start with '@' (the solo player is '@you'). People
// start in the Sunday League, each taking the place of its weakest bot. Everyone in all three leagues plays a round
// at the same time; only games with a person in them are played for real, the rest are simulated.
//
// A season is a calendar of steps (STEPS): the 7 league rounds, with the cup's 5 rounds slotted in between. Play a
// step with playStep(), passing the results of the games people played. When the season is over (seasonOver()),
// nextSeason() moves everyone up and down and starts the next one.
import { aiFromSkill, simulateGame, simulateBattle, simulateShake } from './ai.js';
import { roundRobin, peopleLast } from './schedule.js';
import { ROSTER, botById, startingTiers, TIERS } from './roster.js';

export const SIZE = 8, UP = 2, DOWN = 2; // per league; promoted and relegated each season
export const BOTTOM = TIERS.length - 1;
export const CUP_ROUNDS = ['First round', 'Second round', 'Quarter-finals', 'Semi-finals', 'Final'];
const CUP_AFTER = [2, 3, 5, 6, 7]; // each cup round is played after this many league rounds (the final after the last)
const LEAGUE_ROUNDS = SIZE - 1;
// The season's calendar: 'L' a league round, 'C' a cup round
export const STEPS = (() => {
  const out = [];
  for (let r = 0, k = 0; r <= LEAGUE_ROUNDS; r++) {
    while (CUP_AFTER[k] === r) { out.push('C'); k++; }
    if (r < LEAGUE_ROUNDS) out.push('L');
  }
  return out;
})();

export const isPerson = id => typeof id === 'string' && id[0] === '@';
export const tierName = t => TIERS[t];
// A bot's details for playing it (name, skill, ai); people play as an average bot if their game has to be simulated
export function entryFor(id) {
  const b = botById(id);
  return b ? { bot: id, name: b.name, skill: b.skill, ai: aiFromSkill(b.skill) } : { name: id, skill: 0.5, ai: aiFromSkill(0.5) };
}
const fresh = id => ({ id, P: 0, W: 0, L: 0, PF: 0, PA: 0 });
const shuffle = (a, rng) => { for (let i = a.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const draw = (ids, rng) => { const list = shuffle([...ids], rng), ties = []; for (let i = 0; i < list.length; i += 2) ties.push({ a: list[i], b: list[i + 1] }); return ties; };

// ---------- Starting out ----------
// people: person ids. target: what each game is played to (20, 30 or 50).
// variant: 'classic', 'battle' (every game a Siege: shared/battle.js) or 'milkshake' (a Milkkshake: shared/milkshake.js)
export function newCareer({ people = ['@you'], target = 50, variant = 'classic', rng = Math.random } = {}) {
  const c = { season: 1, target, variant, tiers: startingTiers(), promotedIn: {}, waiting: [], summary: null };
  for (const id of people) addPerson(c.tiers, id);
  startSeason(c, rng);
  return c;
}
// A person joins the Sunday League (or the lowest league with a bot left in it), taking the weakest bot's place
function addPerson(tiers, id) {
  if (tiers.some(ids => ids.includes(id))) return;
  if (tiers[BOTTOM].length < SIZE) return tiers[BOTTOM].push(id);
  for (let t = BOTTOM; t >= 0; t--) {
    const bots = tiers[t].filter(x => !isPerson(x));
    if (!bots.length) continue;
    const weakest = bots.reduce((w, x) => (botById(x).skill < botById(w).skill ? x : w));
    tiers[t][tiers[t].indexOf(weakest)] = id;
    return;
  }
}
// Someone joining partway through a season waits for the next one
export function addWaiting(c, id) {
  if (!c.waiting.includes(id) && !c.tiers.some(ids => ids.includes(id))) c.waiting.push(id);
}
export const inCareer = (c, id) => c.tiers.some(ids => ids.includes(id));

function startSeason(c, rng) {
  c.step = 0; c.round = 0; c.lastLeague = null;
  // People's games against each other come as late in the season as possible
  c.leagues = c.tiers.map(ids => ({ entries: ids.map(fresh), schedule: peopleLast(ids.map(isPerson), roundRobin(ids.length), 300, rng) }));
  // The cup: the 16 outside the Premier League play a first round, the Premier League joins in the second
  c.cup = { round: 0, ties: [draw(c.tiers.slice(1).flat(), rng)], byes: [...c.tiers[0]], winner: null };
}

// ---------- Where things stand ----------
export const seasonOver = c => c.step >= STEPS.length;
// What's being played now: { kind: 'league' | 'cup', round } (round counts from 0), or null when the season is over
export function currentStep(c) {
  if (seasonOver(c)) return null;
  return STEPS[c.step] === 'L' ? { kind: 'league', round: c.round } : { kind: 'cup', round: c.cup.round };
}
// The games in the current step: [{ key, kind, tier (league games), a, b }]
export function fixtures(c) {
  const step = currentStep(c);
  if (!step) return [];
  if (step.kind === 'cup') return c.cup.ties[c.cup.round].map((t, i) => ({ key: `C-${i}`, kind: 'cup', a: t.a, b: t.b }));
  return c.leagues.flatMap((lg, tier) => lg.schedule[c.round].map(([x, y], i) =>
    ({ key: `L${tier}-${i}`, kind: 'league', tier, a: lg.entries[x].id, b: lg.entries[y].id })));
}
export const hasPerson = f => isPerson(f.a) || isPerson(f.b);
// Someone's game in the current step, if they have one (not if they're out of the cup)
export const fixtureOf = (c, id) => fixtures(c).find(f => f.a === id || f.b === id) || null;
// The league someone is in this season (0 = Premier League), or -1
export const tierOf = (c, id) => c.tiers.findIndex(ids => ids.includes(id));
const rank = entries => [...entries].sort((a, b) => b.W - a.W || (b.PF - b.PA) - (a.PF - a.PA) || b.PF - a.PF);
// A league's table, best first
export const standings = (c, tier) => rank(c.leagues[tier].entries);
// Where a table position leads at the end of the season: 'up', 'down' or ''
export function zone(c, tier, pos) {
  if (tier > 0 && pos < UP) return 'up';
  if (tier < BOTTOM && pos >= c.leagues[tier].entries.length - DOWN) return 'down';
  return '';
}
// A step's name: 'Round 3 of 7' or 'Cup · Quarter-finals' (i: its place in the calendar; the current step by default)
export function stepName(c, i = c.step) {
  if (i >= STEPS.length) return `Season ${c.season} complete`;
  const before = STEPS.slice(0, i);
  return STEPS[i] === 'L' ? `Round ${before.filter(s => s === 'L').length + 1} of ${LEAGUE_ROUNDS}`
    : `Cup · ${CUP_ROUNDS[before.filter(s => s === 'C').length]}`;
}
export const leagueDone = c => c.round >= LEAGUE_ROUNDS;
export const leagueRounds = () => LEAGUE_ROUNDS;
// How someone's cup is going: { won } | { out: { round, by } } | { bye } (waiting for round 2) | { through: round next }
export function cupStatus(c, id) {
  const cup = c.cup;
  if (cup.winner === id) return { won: true };
  for (let r = 0; r < cup.round; r++) {
    const t = cup.ties[r].find(t => t.a === id || t.b === id);
    if (t && t.w !== id) return { out: { round: r, by: t.w } };
  }
  if (cup.round === 0 && cup.byes.includes(id)) return { bye: true };
  return { through: cup.round };
}

// ---------- Playing ----------
// A game between a and b worked out without playing it: { sa, sb, aWon }
export function simulate(c, a, b, rng = Math.random) {
  const first = rng() < 0.5 ? 0 : 1;
  const res = c.variant === 'battle' ? simulateBattle(entryFor(a), entryFor(b), first, rng)
    : c.variant === 'milkshake' ? simulateShake(entryFor(a), entryFor(b), first, rng)
    : simulateGame(entryFor(a), entryFor(b), rng() < 0.5 ? 0 : 1, c.target, rng);
  return { sa: res.scores[0], sb: res.scores[1], aWon: res.winner === 0 };
}
// Put a league game's result in the table. g: { a, b, sa, sb, aWon }
export function recordGame(entries, g) {
  const A = entries.find(e => e.id === g.a), B = entries.find(e => e.id === g.b);
  A.P++; B.P++; A.PF += g.sa; A.PA += g.sb; B.PF += g.sb; B.PA += g.sa;
  if (g.aWon) { A.W++; B.L++; } else { B.W++; A.L++; }
}
// Play the current step. results: { [fixture key]: { sa, sb, aWon } } for the games people played (scores as the
// fixture's a and b); everything else is simulated. Returns the step's games: [{ ...fixture, sa, sb, aWon }].
export function playStep(c, results = {}, rng = Math.random) {
  const step = currentStep(c);
  if (!step) return [];
  const games = fixtures(c).map(f => {
    const r = results[f.key] || simulate(c, f.a, f.b, rng);
    return { ...f, sa: r.sa, sb: r.sb, aWon: !!r.aWon };
  });
  if (step.kind === 'league') {
    for (const g of games) recordGame(c.leagues[g.tier].entries, g);
    c.lastLeague = { round: c.round + 1, games };
    c.round++;
  } else {
    const cup = c.cup, ties = cup.ties[cup.round];
    games.forEach((g, i) => Object.assign(ties[i], { sa: g.sa, sb: g.sb, w: g.aWon ? g.a : g.b }));
    const through = ties.map(t => t.w);
    cup.round++;
    if (cup.round === CUP_ROUNDS.length) cup.winner = through[0];
    else cup.ties.push(draw(cup.round === 1 ? [...through, ...cup.byes] : through, rng));
  }
  c.step++;
  return games;
}

// ---------- Between seasons ----------
// Someone who has left: a bot who isn't in the career takes their place (the one whose skill best suits that
// league). If every bot is already in, they stay, and are played by a bot.
function replacePerson(c, id) {
  c.waiting = c.waiting.filter(x => x !== id);
  const t = tierOf(c, id);
  if (t < 0) return;
  const inUse = new Set(c.tiers.flat()), free = ROSTER.filter(b => !inUse.has(b.id));
  if (!free.length) return;
  const bots = c.tiers[t].filter(x => !isPerson(x)).map(botById);
  const want = bots.length ? bots.reduce((s, b) => s + b.skill, 0) / bots.length : 0.5;
  const pick = free.reduce((best, b) => (Math.abs(b.skill - want) < Math.abs(best.skill - want) ? b : best));
  c.tiers[t][c.tiers[t].indexOf(id)] = pick.id;
}
// Move the top 2 of each league up and the bottom 2 down, bring in anyone waiting, and start the next season.
// remove: people who have left, replaced by bots for the new season.
// Leaves c.summary saying what happened: { season, champions (ids by league), cup (winner id), moves: [{ id, from, to }],
//   people: { [id]: { tier, pos (1 = top), newTier, promoted, relegated, inARow, champion, cupWinner, unbeaten } } }
export function nextSeason(c, rng = Math.random, { remove = [] } = {}) {
  const order = c.tiers.map((ids, t) => standings(c, t).map(e => e.id));
  const moves = [];
  const tiers = order.map((o, t) => {
    const stay = o.filter((id, pos) => !(t > 0 && pos < UP) && !(t < BOTTOM && pos >= o.length - DOWN));
    const fromBelow = t < BOTTOM ? order[t + 1].slice(0, UP) : [];
    const fromAbove = t > 0 ? order[t - 1].slice(-DOWN) : [];
    fromBelow.forEach(id => moves.push({ id, from: t + 1, to: t }));
    fromAbove.forEach(id => moves.push({ id, from: t - 1, to: t }));
    return [...fromAbove, ...stay, ...fromBelow];
  });
  const people = {};
  order.forEach((o, t) => o.forEach((id, pos) => {
    if (!isPerson(id)) return;
    const newTier = tiers.findIndex(ids => ids.includes(id)), promoted = newTier < t;
    const inARow = promoted && c.promotedIn[id] === c.season - 1;
    if (promoted) c.promotedIn[id] = c.season;
    const e = c.leagues[t].entries.find(e => e.id === id);
    people[id] = { tier: t, pos: pos + 1, newTier, promoted, relegated: newTier > t, inARow,
      champion: pos === 0, cupWinner: c.cup.winner === id, unbeaten: e.W === LEAGUE_ROUNDS };
  }));
  c.summary = { season: c.season, champions: order.map(o => o[0]), cup: c.cup.winner, moves, people };
  c.tiers = tiers;
  for (const id of remove) replacePerson(c, id);
  for (const id of c.waiting) addPerson(c.tiers, id);
  c.waiting = [];
  c.season++;
  startSeason(c, rng);
}
