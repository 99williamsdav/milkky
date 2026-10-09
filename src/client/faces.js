// Simple drawn faces for the computer players (specs in shared/roster.js), as inline SVG.
import { botById } from '../shared/roster.js';

const INK = '#2b2622';

const HAIR = {
  bald: () => '',
  short: c => `<path d="M8 19 C8 9 32 9 32 19 C28 14 12 14 8 19 Z" fill="${c}"/>`,
  spiky: c => `<path d="M8 20 L9 10 L13 15 L16 6 L20 13 L24 6 L27 15 L31 10 L32 20 C27 15 13 15 8 20 Z" fill="${c}"/>`,
  long: c => `<path d="M7 33 C4 18 9 8 20 8 C31 8 36 18 33 33 L29 33 C31 22 28 15 20 15 C12 15 9 22 11 33 Z" fill="${c}"/>`,
  bun: c => `<circle cx="20" cy="6" r="4.5" fill="${c}"/><path d="M8 19 C8 9 32 9 32 19 C28 14 12 14 8 19 Z" fill="${c}"/>`,
  mohawk: c => `<path d="M16 16 L16 4 C19 2 21 2 24 4 L24 16 Z" fill="${c}"/>`,
  curly: c => [10, 15, 20, 25, 30].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 10 : 12}" r="4.6" fill="${c}"/>`).join('')
    + `<circle cx="8" cy="17" r="3.6" fill="${c}"/><circle cx="32" cy="17" r="3.6" fill="${c}"/>`,
};
const EYES = {
  dots: () => `<circle cx="15" cy="21" r="1.6" fill="${INK}"/><circle cx="25" cy="21" r="1.6" fill="${INK}"/>`,
  wide: () => `<circle cx="15" cy="21" r="3" fill="#fff" stroke="${INK}" stroke-width="1"/><circle cx="25" cy="21" r="3" fill="#fff" stroke="${INK}" stroke-width="1"/>
    <circle cx="15.6" cy="21.4" r="1.4" fill="${INK}"/><circle cx="24.4" cy="21.4" r="1.4" fill="${INK}"/>`,
  sleepy: () => `<path d="M12.5 21.5 Q15 23 17.5 21.5 M22.5 21.5 Q25 23 27.5 21.5" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>`,
  glasses: () => `<circle cx="15" cy="21" r="3.6" fill="#fff" fill-opacity=".5" stroke="${INK}" stroke-width="1.2"/><circle cx="25" cy="21" r="3.6" fill="#fff" fill-opacity=".5" stroke="${INK}" stroke-width="1.2"/>
    <path d="M18.6 21 L21.4 21" stroke="${INK}" stroke-width="1.2"/><circle cx="15" cy="21" r="1.2" fill="${INK}"/><circle cx="25" cy="21" r="1.2" fill="${INK}"/>`,
  wink: () => `<circle cx="15" cy="21" r="1.6" fill="${INK}"/><path d="M22.5 21.5 L27.5 20.5" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>`,
};
const MOUTH = {
  smile: () => `<path d="M15 28 Q20 32 25 28" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`,
  grin: () => `<path d="M14 27 Q20 34 26 27 Z" fill="#fff" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>`,
  flat: () => `<path d="M16 29 L24 29" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`,
  o: () => `<ellipse cx="20" cy="29" rx="2" ry="2.4" fill="#7a1f1f" stroke="${INK}" stroke-width="1"/>`,
  smirk: () => `<path d="M16 29 Q21 30 25 27" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`,
};
const EXTRA = {
  none: () => '',
  moustache: c => `<path d="M14 26.5 Q17 24.5 20 26 Q23 24.5 26 26.5 Q23 27.5 20 26.8 Q17 27.5 14 26.5 Z" fill="${c}"/>`,
  beard: c => `<path d="M9 24 C9 33 14 36 20 36 C26 36 31 33 31 24 C29 30 25 31 20 31 C15 31 11 30 9 24 Z" fill="${c}"/>`,
  cap: () => `<path d="M8 17 C8 7 32 7 32 17 Z" fill="#c0392b"/><path d="M6 17 L34 17 L36 19 L6 19 Z" fill="#a52e22"/>`,
  headband: () => `<path d="M7.5 15 C14 12 26 12 32.5 15 L32.5 18 C26 15 14 15 7.5 18 Z" fill="#e8334a"/>`,
  freckles: () => [[13, 25], [15, 26], [25, 25], [27, 26]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".7" fill="#b5651d"/>`).join(''),
  blush: () => `<ellipse cx="12.5" cy="26" rx="2.4" ry="1.4" fill="#e86f80" opacity=".55"/><ellipse cx="27.5" cy="26" rx="2.4" ry="1.4" fill="#e86f80" opacity=".55"/>`,
};

// An <svg> face for a bot (by id), `size` px; empty if there's no such bot
export function faceSVG(id, size = 24) {
  const b = botById(id);
  if (!b) return '';
  const f = b.face;
  const hairOnTop = f.hair !== 'long'; // long hair hangs behind the head
  return `<svg class="face" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">`
    + (hairOnTop ? '' : HAIR.long(f.hairColor))
    + `<circle cx="20" cy="22" r="13" fill="${f.skin}" stroke="${INK}" stroke-width="1.5"/>`
    + (hairOnTop ? HAIR[f.hair](f.hairColor) : HAIR.short(f.hairColor)) // long hair: a fringe on top too
    + EYES[f.eyes]() + MOUTH[f.mouth]() + EXTRA[f.extra](f.hairColor)
    + '</svg>';
}
