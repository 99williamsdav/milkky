// Shared by the browser and the game server: no DOM, no Three.js.

// ---------- Dimensions (metres) ----------
export const BOTTLE_R = 0.029, BOTTLE_H = 0.15, BOTTLE_HALF = BOTTLE_H / 2;
export const STICK_R = 0.0275, STICK_HALF = 0.1125;
export const DENSITY = 600;
export const D = 0.16, ROW = D * Math.sqrt(3) / 2;
export const FRONT_Z = -3.5;
export const LAYOUT = [[7, 9, 8], [5, 11, 12, 6], [3, 10, 4], [1, 2]]; // back row to front row
export const RELEASE = Object.freeze({ x: 0, y: 0.55, z: -0.15 });
export const ELEV = 22 * Math.PI / 180;
export const COLORS = ['#1f4e8c', '#c0392b', '#2e8b57', '#d4a017'];

export const AIM_LIMIT = 0.55;             // radians either side of straight
export const MIN_DIST = 0.5, MAX_DIST = 9.5; // metres
export const FALLEN_Y = 0.045;             // a bottle whose centre is below this is lying down

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Y component of the bottle's up axis after rotation q (1 = upright, 0 = on its side)
export const upY = q => 1 - 2 * (q.x * q.x + q.z * q.z);
// The bottle's up axis after rotation q
export const upVector = q => ({
  x: 2 * (q.x * q.y - q.w * q.z),
  y: 1 - 2 * (q.x * q.x + q.z * q.z),
  z: 2 * (q.y * q.z + q.w * q.x),
});

// Starting spot of each bottle, in LAYOUT order
export function homePositions() {
  const out = [];
  LAYOUT.forEach((row, ri) => row.forEach((num, j) =>
    out.push({ num, x: (j - (row.length - 1) / 2) * D, z: FRONT_Z - (LAYOUT.length - 1 - ri) * ROW })));
  return out;
}

// Milkkshake (milkshake.js), for 2–4 players: each player's flavour of bottles in clusters of three, the clusters on
// a staggered grid. Every flavour has the same share of front, back, centre and edge clusters (each row and column
// of the grid holds each flavour equally often), so no flavour gets the easier ones:
//   2 players: 4 rows of 2, 12 each   3 players: 3 rows of 3, 9 each   4 players: 4 rows of 4, 12 each
// Grids are listed front row first; numbers are flavour indices (strawberry, blueberry, banana, chocolate).
// Bottles are numbered in blocks of 12 per flavour: strawberry 1–12, blueberry 13–24, banana 25–36, chocolate 37–48.
export const SHAKE_FLAVOURS = ['strawberry', 'blueberry', 'banana', 'chocolate'];
export const SHAKE_GAP = 0.34; // between cluster centres (closer means more risk of knocking another flavour)
const SHAKE_GRIDS = {
  2: [[0, 1], [0, 1], [1, 0], [1, 0]], // (with the rows staggered, this gives each flavour two outer and two inner clusters)
  3: [[0, 2, 1], [1, 0, 2], [2, 1, 0]],
  4: [[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]],
};
export function shakePositions(players = 2) {
  const grid = SHAKE_GRIDS[players] || SHAKE_GRIDS[2], out = [], next = SHAKE_FLAVOURS.map((_, f) => f * 12 + 1);
  grid.forEach((row, r) => row.forEach((f, k) => {
    const cx = (k - (row.length - 1) / 2) * SHAKE_GAP + (r % 2 ? SHAKE_GAP / 4 : -SHAKE_GAP / 4), cz = FRONT_Z - 0.2 - r * SHAKE_GAP * 0.87;
    for (const [dx, dz] of [[0, D * 0.58], [-D / 2, -D * 0.29], [D / 2, -D * 0.29]]) out.push({ num: next[f]++, x: cx + dx, z: cz + dz, flavour: SHAKE_FLAVOURS[f] });
  }));
  return out;
}
// The bottles for a game's rules: the classic rack of 12, or a Milkkshake rack for that many players
export const positionsFor = (variant, players = 2) => (variant === 'milkshake' ? shakePositions(players) : homePositions());
