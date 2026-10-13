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

// Milkkshake (milkshake.js): 12 strawberry and 12 blueberry bottles in clusters of three, two staggered rows of
// four clusters, the flavours alternating like a chequerboard. Bottles 1–12 are strawberry, 13–24 blueberry.
export const SHAKE_GAP = 0.34; // between cluster centres (closer means more risk of knocking the other flavour)
export function shakePositions() {
  const out = [], next = { strawberry: 1, blueberry: 13 };
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < 4; k++) {
      const cx = (k - 1.5) * SHAKE_GAP + (row ? SHAKE_GAP / 2 : 0) - SHAKE_GAP / 4, cz = FRONT_Z - 0.2 - row * SHAKE_GAP * 0.87;
      const flavour = (k + row) % 2 ? 'blueberry' : 'strawberry';
      for (const [dx, dz] of [[0, D * 0.58], [-D / 2, -D * 0.29], [D / 2, -D * 0.29]]) out.push({ num: next[flavour]++, x: cx + dx, z: cz + dz, flavour });
    }
  }
  return out;
}
// The bottles for a game's rules: the classic rack of 12, or Milkkshake's 24
export const positionsFor = variant => (variant === 'milkshake' ? shakePositions() : homePositions());
