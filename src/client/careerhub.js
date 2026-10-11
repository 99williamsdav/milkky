// The online career screen: your league's table (the others a tap away), this step's games with people in them,
// the cup, last season's comings and goings, and who's waiting to join. Pure rendering from the room state:
// room.career.state is the shared career (src/shared/career.js), read with the same rules the server uses.
// It fills the league screen (#hub), whose sections a league uses too; main.js decides when to show it.
import * as C from '../shared/career.js';
import { botById } from '../shared/roster.js';
import { faceSVG } from './faces.js';
import { showMilkKing } from './milkking.js';
import { esc, myFixture } from './hub.js';

const $ = s => document.querySelector(s);
const score = f => `${f.players[0].score}–${f.players[1].score}`;
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const timeLeft = ms => ms >= 3600_000 ? `${Math.round(ms / 3600_000)}h` : ms >= 90_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;

// view: what's behind the screen ('game' or 'watch' when peeking, otherwise 'hub'). tier: the league to show
// (null: yours). msToNext: until the next step or season. stepLeft: until this step's deadline.
export function renderCareerHub({ room, fixtures, you, view, watching, tier, msToNext, stepLeft }) {
  const cs = room.career, c = cs.state, me = cs.you, host = room.you === room.host;
  const myTier = C.tierOf(c, me), waiting = myTier < 0;
  const show = tier ?? (waiting ? C.BOTTOM : myTier);
  const between = room.phase === 'between', over = C.seasonOver(c);
  const nameOf = id => (C.isPerson(id) ? cs.people[id]?.name ?? 'Someone' : botById(id)?.name ?? id);
  const who = id => id === me ? 'You'
    : C.isPerson(id) ? `<span class="who">${esc(nameOf(id))}</span>` : `<span class="who">${faceSVG(id, 20)}${esc(nameOf(id))}</span>`;
  const line = (a, b, sa, sb, aWon) => `<div><span>${aWon ? `<b>${who(a)}</b>` : who(a)}</span><span>${sa}–${sb}</span><span style="text-align:right">${aWon ? who(b) : `<b>${who(b)}</b>`}</span></div>`;
  const mine = myFixture(fixtures, you);

  // Heading and the line under it
  let title, sub = '';
  if (room.phase === 'over') {
    title = 'This career has stopped';
    sub = 'Everyone has left, or nobody has played for a long while.';
  } else if (between && over) {
    title = `Season ${c.season} complete`;
    if (!waiting) {
      const table = C.standings(c, myTier), pos = table.findIndex(e => e.id === me), z = C.zone(c, myTier, pos);
      sub = (pos === 0 ? `<b>Champions of the ${C.tierName(myTier)}!</b> ` : `You finished ${ordinal(pos + 1)} in the ${C.tierName(myTier)}. `)
        + (z === 'up' ? `You’re promoted to the <b>${C.tierName(myTier - 1)}</b>.` : z === 'down' ? `You’re relegated to the <b>${C.tierName(myTier + 1)}</b>.` : '')
        + (c.cup.winner === me ? ' <b>And you won the cup!</b>' : '');
    }
    if (msToNext != null) sub += ` Season ${c.season + 1} starts in ${timeLeft(msToNext)}.`;
  } else if (between) {
    title = `${C.stepName(c, c.step - 1)} results`;
    if (msToNext != null) sub = `${C.stepName(c)} starts in ${timeLeft(msToNext)}.`;
  } else {
    const step = C.currentStep(c);
    title = waiting ? `Season ${c.season}` : `${C.tierName(myTier)} · season ${c.season}`;
    sub = `${C.stepName(c)}. `;
    if (waiting) sub += `You join the Sunday League when season ${c.season + 1} starts.`;
    else if (mine && !mine.over) sub += 'Your game is still going.';
    else if (mine) {
      const i = mine.seats.indexOf(you), won = mine.winner === i;
      sub += `You ${won ? 'won' : 'lost'} ${mine.players[i].score}–${mine.players[1 - i].score} against ${esc(mine.players[1 - i].name)}.`;
    } else if (step?.kind === 'cup') {
      const st = C.cupStatus(c, me);
      sub += st.bye ? 'Premier League players have a bye this round.' : 'You’re out of the cup, so you’re watching this round.';
    }
    if (stepLeft != null && fixtures?.some(f => !f.over)) sub += ` The round ends in ${timeLeft(stepLeft)} at the latest; bots finish any games still going then.`;
  }
  $('#hubTitle').innerHTML = title;
  $('#hubSub').innerHTML = sub;
  showMilkKing($('#hubKing'), over && C.standings(c, 0)[0].id === me); // winning the Premier League

  // Start of a season: what happened at the end of the last one
  const sm = c.summary, moves = sm && c.round === 0 && !c.lastLeague && !over;
  $('#hcMovesWrap').hidden = !moves;
  if (moves) {
    const moved = (t, up) => sm.moves.filter(m => m.to === t && (up ? m.from > t : m.from < t));
    $('#hcMoves').innerHTML = c.tiers.map((_, t) => [
      moved(t, true).length ? `<div>Up to the ${C.tierName(t)}: ${moved(t, true).map(m => who(m.id)).join(', ')}</div>` : '',
      moved(t, false).length ? `<div>Down to the ${C.tierName(t)}: ${moved(t, false).map(m => who(m.id)).join(', ')}</div>` : '',
    ].join('')).join('')
      + `<div class="champs">Champions: ${sm.champions.map((id, t) => `${C.tierName(t)} <b>${esc(nameOf(id))}</b>`).join(' · ')}${sm.cup ? ` · Cup <b>${esc(nameOf(sm.cup))}</b>` : ''}</div>`;
  }

  // This step's games with people in them: watch them, or get back into your own
  const live = (fixtures || []).filter(f => !f.over), done = (fixtures || []).filter(f => f.over);
  const fname = (f, i) => esc(f.players[i].name) + (f.seats[i] === you ? ' <small>(you)</small>' : '');
  const action = f => f === mine ? (view === 'game' ? '' : '<button class="primary" data-act="play" data-match="' + f.id + '">Play</button>')
    : f.id === watching && view === 'watch' ? '<small>watching</small>' : `<button data-act="watch" data-match="${f.id}">Watch</button>`;
  $('#hubLiveWrap').hidden = room.phase !== 'playing' || !live.length;
  $('#hubLive').innerHTML = live.map(f => `<div class="fx"><span>${fname(f, 0)} <b>${score(f)}</b> ${fname(f, 1)}</span>${action(f)}</div>`).join('');
  $('#hubDoneLabel').textContent = 'Finished this round';
  $('#hubDoneWrap').hidden = room.phase !== 'playing' || !done.length;
  $('#hubDone').innerHTML = done.map(f => {
    const aWon = f.winner === 0;
    return `<div class="fx"><span>${aWon ? `<b>${fname(f, 0)}</b>` : fname(f, 0)} ${score(f)} ${aWon ? fname(f, 1) : `<b>${fname(f, 1)}</b>`}</span></div>`;
  }).join('');

  // The leagues: one at a time, yours first
  $('#hubTableLabel').textContent = 'Leagues';
  $('#hcTiers').hidden = false;
  $('#hcTiers').innerHTML = c.tiers.map((_, t) => `<button data-tier="${t}" aria-pressed="${t === show}">${C.tierName(t)}</button>`).join('');
  $('#hubTable').innerHTML = '<tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr>' +
    C.standings(c, show).map((e, pos) => `<tr class="${e.id === me ? 'me' : ''} ${C.zone(c, show, pos)}"><td>${pos + 1}</td><td>${who(e.id)}${cs.people[e.id]?.left ? ' <small>(computer)</small>' : ''}</td>
      <td>${e.P}</td><td>${e.W}</td><td>${e.L}</td><td>${e.PF - e.PA > 0 ? '+' : ''}${e.PF - e.PA}</td></tr>`).join('');
  $('#hcKey').innerHTML = [show > 0 && '<span class="up">Promotion</span>', show < C.BOTTOM && '<span class="down">Relegation</span>'].filter(Boolean).join('');
  const last = c.lastLeague;
  $('#hcResultsWrap').hidden = !last;
  if (last) {
    $('#hcResultsLabel').textContent = `Round ${last.round} results`;
    $('#hcResults').innerHTML = last.games.filter(g => g.tier === show).map(g => line(g.a, g.b, g.sa, g.sb, g.aWon)).join('');
  }

  // The cup
  const cup = c.cup, R = C.CUP_ROUNDS, st = C.cupStatus(c, me);
  $('#hcCupWrap').hidden = false;
  $('#hcCupLabel').textContent = cup.winner ? `Cup · won by ${nameOf(cup.winner)}` : `Cup · ${R[cup.round].toLowerCase()} ${C.currentStep(c)?.kind === 'cup' && room.phase === 'playing' ? 'being played' : 'next'}`;
  $('#hcCupStatus').innerHTML = waiting ? 'You’ll be in next season’s cup.'
    : st.won ? '<b>You won the cup!</b>'
    : st.out ? `You were knocked out in the ${R[st.out.round].toLowerCase()} by ${who(st.out.by)}.`
    : cup.winner ? ''
    : st.bye ? 'Premier League players get a bye to the second round.'
    : cup.round === 0 ? 'You’re in the first round. The Premier League joins in the second.'
    : `You’re through to the ${cup.round === R.length - 1 ? 'final' : R[cup.round].toLowerCase()}!`;
  const lastCup = cup.round > 0 ? cup.ties[cup.round - 1] : null;
  $('#hcCupResultsLabel').textContent = lastCup ? `${R[cup.round - 1]} results` : '';
  $('#hcCupResults').innerHTML = lastCup ? lastCup.map(t => line(t.a, t.b, t.sa, t.sb, t.w === t.a)).join('') : '';

  // Who's waiting to join next season
  $('#hcWaitWrap').hidden = !c.waiting.length;
  $('#hcWaiting').innerHTML = c.waiting.map(id => (id === me ? '<b>You</b>' : esc(nameOf(id)))).join(', ');

  // Buttons
  const btns = [];
  if (view === 'game') btns.push('<button class="primary" data-act="back">Back to my game</button>');
  if (view === 'watch') btns.push('<button class="primary" data-act="back">Back to watching</button>');
  if (between && host) btns.push(`<button class="primary" data-act="next">Start next ${over ? 'season' : 'round'} now</button>`);
  if (room.phase !== 'over') btns.push('<button data-act="mine">My games</button>', '<button data-act="leave">Leave career</button>');
  else btns.push('<button data-act="leave">Leave room</button>');
  $('#hubBtns').innerHTML = btns.join('');
}

// Career achievements from where things stand (unlocking is once only, so checking often is fine)
export function careerAchievements(cs, unlock) {
  const c = cs.state, me = cs.you, tier = C.tierOf(c, me);
  const sm = c.summary?.people?.[me]; // last season
  if (sm) {
    if (sm.promoted) unlock('goingUp');
    if (sm.inARow) unlock('backToBack');
    if (sm.unbeaten) unlock('invincible');
    if (sm.cupWinner) unlock('cupWinner');
    if (sm.champion && sm.tier === 0) unlock('milkKing');
    if (sm.champion && sm.cupWinner) unlock('double');
  }
  if (tier < 0) return;
  // This season's cup ties so far: beating someone from a higher league, or a Premier League player from the bottom
  for (let r = 0; r < c.cup.round; r++) {
    const t = c.cup.ties[r].find(t => t.a === me || t.b === me);
    if (!t || t.w !== me) continue;
    const opp = t.a === me ? t.b : t.a;
    if (C.tierOf(c, opp) < tier) unlock('underdogs');
    if (tier === C.BOTTOM && c.cup.byes.includes(opp)) unlock('giantKiller');
  }
  if (c.cup.winner === me) unlock('cupWinner');
  if (!C.leagueDone(c)) return;
  const table = C.standings(c, tier), top = table[0].id === me;
  if (table.find(e => e.id === me).W === C.leagueRounds()) unlock('invincible');
  if (top && tier === 0) unlock('milkKing');
  if (top && c.cup.winner === me) unlock('double');
}
