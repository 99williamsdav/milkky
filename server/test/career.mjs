// Career rules (src/shared/career.js), without a server: seasons of three leagues and a cup, promotion and
// relegation, people joining, and people's games against each other coming last.
import * as C from '../../src/shared/career.js';
import { mulberry32 } from '../../src/shared/rng.js';
import { botById } from '../../src/shared/roster.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const rng = mulberry32(7);

check(C.STEPS.join('') === 'LLCLCLLCLCLC', `a season is 7 league rounds with 5 cup rounds between them (${C.STEPS.join('')})`);

// Solo: you fill the Sunday League's empty place
const solo = C.newCareer({ people: ['@you'], target: 30, rng });
check(solo.tiers.map(t => t.length).join() === '8,8,8' && solo.tiers[2].includes('@you'), 'solo: three leagues of 8, you in the Sunday League');

// Three people: two take the places of the weakest bots
const people = ['@ann', '@bob', '@cat'];
const c = C.newCareer({ people, target: 20, rng });
const all = () => c.tiers.flat();
check(people.every(p => c.tiers[2].includes(p)) && !all().includes('veikko') && !all().includes('aino'),
  'people start in the Sunday League, replacing its weakest bots');
check(new Set(all()).size === 24, '24 different players');
// People's games against each other come in the last rounds (3 people: 3 such games, in rounds 5 to 7)
const sched = c.leagues[2].schedule, ids = c.leagues[2].entries.map(e => e.id);
const pvpRounds = sched.flatMap((r, i) => r.filter(([a, b]) => C.isPerson(ids[a]) && C.isPerson(ids[b])).map(() => i + 1));
check(pvpRounds.length === 3 && Math.min(...pvpRounds) >= 5, `people play each other last (rounds ${pvpRounds.join(', ')})`);

// A season: people "play" their games (results passed in), everything else is simulated
function playSeason() {
  const counts = { league: 0, cup: [] };
  while (!C.seasonOver(c)) {
    const step = C.currentStep(c), fx = C.fixtures(c), results = {};
    if (step.kind === 'league') {
      counts.league++;
      const everyone = fx.flatMap(f => [f.a, f.b]);
      if (everyone.length !== 24 || new Set(everyone).size !== 24) check(false, 'everyone plays once each league round');
    } else counts.cup.push(fx.length);
    for (const f of fx.filter(C.hasPerson)) results[f.key] = { sa: 20, sb: 11, aWon: true };
    const games = C.playStep(c, results, rng);
    for (const f of fx.filter(C.hasPerson)) {
      const g = games.find(g => g.key === f.key);
      if (g.sa !== 20 || !g.aWon) check(false, 'people\'s results are used as given');
    }
  }
  return counts;
}
const s1 = playSeason();
check(s1.league === 7 && s1.cup.join() === '8,8,4,2,1', `season 1: 7 league rounds and cup rounds of ${s1.cup.join(', ')} ties`);
check(c.leagues.every(lg => lg.entries.every(e => e.P === 7)), 'everyone played 7 league games');
check(!!c.cup.winner && all().includes(c.cup.winner), `the cup has a winner (${c.cup.winner})`);
const people1 = people.map(p => C.cupStatus(c, p));
check(people1.every(s => s.won || s.out), 'each person either won the cup or knows who knocked them out');

// Someone joins partway through: they wait for the next season
C.addWaiting(c, '@dan');
check(!C.inCareer(c, '@dan') && c.waiting.includes('@dan'), 'someone joining mid-season waits');
const before = c.tiers.map(t => C.standings(c, c.tiers.indexOf(t)).map(e => e.id));
C.nextSeason(c, rng);
check(c.season === 2 && c.tiers.map(t => t.length).join() === '8,8,8', 'season 2: still three leagues of 8');
check(c.tiers[2].includes('@dan') && !c.waiting.length, 'the waiting person joined the Sunday League');
check(before[2].slice(0, 2).every(id => c.tiers[1].includes(id)) && before[1].slice(-2).every(id => c.tiers[2].includes(id)),
  'the Sunday League\'s top 2 went up and the Championship\'s bottom 2 came down');
check(before[0].slice(-2).every(id => c.tiers[1].includes(id)) && before[1].slice(0, 2).every(id => c.tiers[0].includes(id)),
  'the Championship\'s top 2 went up and the Premier League\'s bottom 2 came down');
const sm = c.summary;
check(sm.season === 1 && people.every(p => sm.people[p]) && sm.moves.length === 8, 'the summary has each person\'s season and the 8 moves');
check(people.every(p => sm.people[p].promoted === (sm.people[p].newTier < sm.people[p].tier)), 'promotions are recorded');
check(c.cup.byes.length === 8 && c.cup.ties[0].length === 8 && c.cup.byes.every(id => c.tiers[0].includes(id)), 'the new cup: Premier League byes, 8 first-round ties');

// Many seasons: the shape holds, and people keep their places in it
for (let s = 0; s < 8; s++) { playSeason(); C.nextSeason(c, rng); }
const flat = all();
check(flat.length === 24 && new Set(flat).size === 24 && [...people, '@dan'].every(p => flat.includes(p)),
  `after ${c.season - 1} seasons: 24 players, all 4 people still in (tiers of people: ${[...people, '@dan'].map(p => C.tierOf(c, p)).join(', ')})`);
check(flat.filter(id => !C.isPerson(id)).every(id => botById(id)), 'everyone else is a real bot');
check(JSON.stringify(JSON.parse(JSON.stringify(c))) === JSON.stringify(c), 'the career is plain JSON');

// The solo career keeps going on its own too, including the cup after you're knocked out
let steps = 0;
while (!C.seasonOver(solo) && steps++ < 20) C.playStep(solo, {}, rng);
check(C.seasonOver(solo) && steps === 12, 'a solo season (all simulated) takes 12 steps');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
