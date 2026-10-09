// The computer players: 23 characters, three leagues' worth (8 in the Premier League and the Championship,
// 7 in the Sunday League, which you join). Each has a skill (0 hopeless to 1 brilliant), a playing style,
// and a face (drawn by client/faces.js).
//
// face: skin, hair (bald | short | spiky | long | bun | mohawk | curly), hairColor,
//       eyes (dots | wide | sleepy | glasses | wink), mouth (smile | grin | flat | o | smirk),
//       extra (none | moustache | beard | cap | headband | freckles | blush)

const S = { pale: '#f6d7c3', light: '#eec39a', tan: '#d9a066', brown: '#a8693c', dark: '#6b4024' };
const H = { black: '#1f1a17', brown: '#6b3e1f', blonde: '#e8c15a', ginger: '#d9622b', grey: '#a8a8a8', white: '#f1efe8', blue: '#3a6fd8', pink: '#e86fa8' };

const bot = (id, name, skill, style, skin, hair, hairColor, eyes, mouth, extra = 'none') =>
  ({ id, name, skill, style, face: { skin: S[skin], hair, hairColor: H[hairColor], eyes, mouth, extra } });

export const ROSTER = [
  // Premier League material
  bot('tapio', 'Tapio', 0.97, 'Has never gone over the target. Ever.', 'light', 'short', 'grey', 'glasses', 'flat', 'moustache'),
  bot('helmi', 'Helmi', 0.93, 'Aims for the 12 every single time', 'pale', 'bun', 'black', 'wide', 'smirk'),
  bot('ilmari', 'Ilmari', 0.89, 'Throws like he’s skimming stones', 'tan', 'bald', 'black', 'sleepy', 'smile', 'beard'),
  bot('venla', 'Venla', 0.85, 'Reads the bottles like a book', 'light', 'long', 'blonde', 'glasses', 'smile'),
  bot('urho', 'Urho', 0.81, 'Slow, steady, terrifying', 'brown', 'short', 'black', 'dots', 'flat', 'beard'),
  bot('siiri', 'Siiri', 0.78, 'Celebrates every throw like a final', 'pale', 'curly', 'ginger', 'wide', 'grin', 'freckles'),
  bot('kalle', 'Kalle', 0.74, 'Knocks over clusters on purpose', 'tan', 'mohawk', 'blue', 'wink', 'grin'),
  bot('ritva', 'Ritva', 0.71, 'Retired champion, still dangerous', 'light', 'short', 'white', 'glasses', 'smirk', 'blush'),
  // Championship
  bot('mikko', 'Mikko', 0.66, 'Big arm, small patience', 'light', 'spiky', 'brown', 'wide', 'grin', 'headband'),
  bot('noora', 'Noora', 0.62, 'Plays the percentages', 'dark', 'bun', 'black', 'dots', 'smile'),
  bot('eero', 'Eero', 0.59, 'Hums while he aims', 'pale', 'curly', 'blonde', 'sleepy', 'o'),
  bot('kaisa', 'Kaisa', 0.55, 'Never takes the easy bottle', 'tan', 'long', 'brown', 'wink', 'smirk'),
  bot('juhani', 'Juhani', 0.52, 'Wears his lucky cap backwards', 'light', 'short', 'ginger', 'dots', 'grin', 'cap'),
  bot('hilkka', 'Hilkka', 0.48, 'Tea break between every throw', 'pale', 'curly', 'grey', 'glasses', 'smile', 'blush'),
  bot('lauri', 'Lauri', 0.45, 'Overthinks, then overthrows', 'brown', 'spiky', 'black', 'wide', 'o'),
  bot('elsa', 'Elsa', 0.41, 'Trash talks the bottles', 'light', 'mohawk', 'pink', 'wink', 'grin'),
  // Sunday League
  bot('matti', 'Matti', 0.37, 'Brought his own stick. It’s worse.', 'tan', 'bald', 'black', 'dots', 'smile', 'moustache'),
  bot('sanna', 'Sanna', 0.32, 'Here for the picnic, honestly', 'pale', 'long', 'ginger', 'sleepy', 'smile', 'freckles'),
  bot('onni', 'Onni', 0.27, 'Throws with his eyes shut', 'light', 'spiky', 'blonde', 'sleepy', 'grin'),
  bot('pirkko', 'Pirkko', 0.22, 'Still learning which end to hold', 'brown', 'bun', 'grey', 'wide', 'o', 'blush'),
  bot('toivo', 'Toivo', 0.16, 'Lucky socks, unlucky arm', 'pale', 'short', 'brown', 'dots', 'flat', 'cap'),
  bot('aino', 'Aino', 0.11, 'Mostly aims at the trees', 'tan', 'curly', 'black', 'wink', 'smile', 'headband'),
  bot('veikko', 'Veikko', 0.05, 'Has knocked over one bottle, once', 'light', 'bald', 'white', 'glasses', 'o', 'beard'),
];

export const botById = id => ROSTER.find(b => b.id === id) || null;

// The leagues, top to bottom
export const TIERS = ['Premier League', 'Championship', 'Sunday League'];
// Where each bot starts: strongest 8 at the top, then 8, then the weakest 7 (plus you) at the bottom
export function startingTiers() {
  const ids = [...ROSTER].sort((a, b) => b.skill - a.skill).map(b => b.id);
  return [ids.slice(0, 8), ids.slice(8, 16), ids.slice(16)];
}
// Online, a computer player added at a difficulty is one of that league's characters
export const LEVEL_TIER = { hard: 0, medium: 1, easy: 2 };
export const botsForLevel = level => startingTiers()[LEVEL_TIER[level] ?? 1].map(botById);
