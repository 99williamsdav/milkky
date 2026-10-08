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
