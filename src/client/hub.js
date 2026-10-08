// The online league screen (live games, this round's results, the table) and the live-scores strip.
// Pure rendering from the room state the server sends; main.js decides when to show it.
const $ = s => document.querySelector(s);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const score = f => `${f.players[0].score}–${f.players[1].score}`;
// The fixture this seat is playing in this round
export const myFixture = (fixtures, you) => (fixtures || []).find(f => f.seats.includes(you)) || null;

// The other games, as small pills under the scoreboard. `showing`: the match on screen (left out).
export function renderTicker(room, fixtures, showing) {
  const el = $('#ticker');
  const others = room?.mode === 'league' && room.phase === 'playing' ? (fixtures || []).filter(f => f.id !== showing) : [];
  el.hidden = !others.length;
  if (!others.length) return;
  const lg = room.league;
  el.innerHTML = `<span class="lbl">Round ${lg.round} of ${lg.rounds}</span>` + others.map(f =>
    `<span>${esc(f.players[0].name)} <b>${score(f)}</b> ${esc(f.players[1].name)}${f.over ? ' <span class="lbl">final</span>' : ''}</span>`).join('');
}

// view: what's behind the screen ('game' or 'watch' when just peeking at it, otherwise 'hub').
// secsToNext: countdown to the next round. Buttons carry data-act (and data-match for watching).
export function renderHub({ room, fixtures, you, view, watching, secsToNext }) {
  const lg = room.league;
  if (!lg) return;
  const host = room.you === room.host;
  const mine = myFixture(fixtures, you);
  const live = (fixtures || []).filter(f => !f.over), done = (fixtures || []).filter(f => f.over);
  const name = (f, i) => esc(f.players[i].name) + (f.seats[i] === you ? ' <small>(you)</small>' : '');
  const result = f => {
    const [a, b] = f.players, aWon = f.winner === 0;
    return `<div class="fx"><span>${aWon ? `<b>${name(f, 0)}</b>` : name(f, 0)} ${a.score}–${b.score} ${aWon ? name(f, 1) : `<b>${name(f, 1)}</b>`}</span></div>`;
  };

  // Heading and the line under it
  let title, sub = '';
  if (room.phase === 'over') {
    const champ = lg.table[0];
    title = champ.seat === you ? 'You win the league!' : `${esc(champ.name)} wins the league!`;
    sub = `Final table after ${lg.rounds} round${lg.rounds > 1 ? 's' : ''}.`;
  } else if (room.phase === 'between') {
    title = `Round ${lg.round} results`;
    sub = secsToNext != null ? `Round ${lg.round + 1} of ${lg.rounds} starts in ${secsToNext}s.` : '';
  } else {
    title = `Round ${lg.round} of ${lg.rounds}`;
    if (mine && !mine.over) sub = 'Your game is still going.';
    else if (mine) {
      const me = mine.seats.indexOf(you), them = 1 - me, won = mine.winner === me;
      sub = `You ${won ? 'won' : 'lost'} ${mine.players[me].score}–${mine.players[them].score} against ${esc(mine.players[them].name)}.`
        + (live.length ? ' Watch a game while the others finish.' : '');
    }
  }
  $('#hubTitle').innerHTML = title;
  $('#hubSub').innerHTML = sub;

  // Live games you can watch (not your own)
  $('#hubLiveWrap').hidden = room.phase !== 'playing' || !live.length;
  $('#hubLive').innerHTML = live.map(f => `<div class="fx"><span>${name(f, 0)} <b>${score(f)}</b> ${name(f, 1)}</span>${
    f === mine ? '' : f.id === watching && view === 'watch' ? '<small>watching</small>' : `<button data-act="watch" data-match="${f.id}">Watch</button>`}</div>`).join('');
  $('#hubDoneLabel').textContent = room.phase === 'over' ? `Round ${lg.round} results` : room.phase === 'between' ? 'Results' : 'Finished this round';
  $('#hubDoneWrap').hidden = !done.length;
  $('#hubDone').innerHTML = done.map(result).join('');

  $('#hubTable').innerHTML = '<tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr>' +
    lg.table.map((e, i) => `<tr class="${e.seat === you ? 'me' : ''}"><td>${i + 1}</td><td>${esc(e.name)}${e.left ? ' <small>(computer)</small>' : ''}</td>
      <td>${e.P}</td><td>${e.W}</td><td>${e.L}</td><td>${e.PF - e.PA > 0 ? '+' : ''}${e.PF - e.PA}</td></tr>`).join('');

  // Buttons
  const btns = [];
  if (view === 'game') btns.push('<button class="primary" data-act="back">Back to my game</button>');
  if (view === 'watch') btns.push('<button class="primary" data-act="back">Back to watching</button>');
  if (room.phase === 'between' && host) btns.push('<button class="primary" data-act="next">Start next round now</button>');
  if (room.phase === 'over') btns.push('<button class="primary" data-act="room">Back to room</button>', '<button data-act="leave">Leave room</button>');
  else btns.push('<button data-act="leave">Leave league</button>');
  $('#hubBtns').innerHTML = btns.join('');
}
