// Round-robin fixtures: every entry plays every other once. n must be even (add a filler if not).
// Returns rounds, each a list of [a, b] index pairs.
export function roundRobin(n) {
  let arr = [...Array(n).keys()]; const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push(r % 2 ? [arr[n - 1 - i], arr[i]] : [arr[i], arr[n - 1 - i]]);
    rounds.push(pairs);
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return rounds;
}

// A random full set of rounds (everyone plays everyone once, everyone plays every round), by trying
// random pairings and backing up when stuck. Quick for leagues this size (up to 8).
function randomRounds(n, rng) {
  const used = new Set(), key = (a, b) => a < b ? a * 16 + b : b * 16 + a, rounds = [];
  const fill = (round, free) => {
    if (!free.length) return true;
    const a = free[0], options = free.slice(1).filter(b => !used.has(key(a, b)));
    for (let i = options.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [options[i], options[j]] = [options[j], options[i]]; }
    for (const b of options) {
      used.add(key(a, b)); round.push(rng() < 0.5 ? [a, b] : [b, a]);
      if (fill(round, free.filter(x => x !== a && x !== b))) return true;
      used.delete(key(a, b)); round.pop();
    }
    return false;
  };
  const build = r => {
    if (r === n - 1) return true;
    for (let attempt = 0; attempt < 20; attempt++) {
      const round = [];
      if (fill(round, [...Array(n).keys()])) { rounds.push(round); if (build(r + 1)) return true; rounds.pop(); round.forEach(([a, b]) => used.delete(key(a, b))); }
    }
    return false;
  };
  return build(0) ? rounds : null;
}

// The fixtures arranged so games between people (isPerson[i]) come as late as possible: the earliest such
// game as late as it can be, then the rest. Any full set of rounds will do, in any order, so this tries
// many and keeps the best. Pairs are [home, away].
export function peopleLast(isPerson, rounds, tries = 300, rng = Math.random) {
  const n = isPerson.length;
  const pvp = round => round.filter(([a, b]) => isPerson[a] && isPerson[b]).length;
  if (!rounds.some(pvp)) return rounds;
  let best = rounds, bestScore = -Infinity;
  for (let t = 0; t < tries; t++) {
    const candidate = t === 0 ? rounds : randomRounds(n, rng);
    if (!candidate) continue;
    const arranged = [...candidate].sort((x, y) => pvp(x) - pvp(y));
    const when = arranged.flatMap((r, i) => Array(pvp(r)).fill(i)); // the round of each people-v-people game
    const score = Math.min(...when) * 1000 + when.reduce((s, i) => s + i, 0);
    if (score > bestScore) { bestScore = score; best = arranged; }
  }
  return best;
}
