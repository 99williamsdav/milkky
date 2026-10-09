// Turn flow, input, camera, menus and the render loop, for local and online play.
// Online, the server runs the physics: throws are sent to it and its recordings are played back here.
import * as THREE from 'three';
import { BOTTLE_HALF, STICK_HALF, FRONT_Z, ROW, RELEASE, COLORS, AIM_LIMIT, MIN_DIST, MAX_DIST } from '../shared/constants.js';
import { createPhysics, launchSpeedFor } from '../shared/physics.js';
import { createPlayers, newPlayer, scoreThrow, isGameOver, advanceTurn, planRestand, verb } from '../shared/rules.js';
import { computeInfo, planCpuThrow } from '../shared/ai.js';
import { app, renderer, canvas, scene, camera } from './scene.js';
import { decorateBottles, stickMesh, hand, aimGeo, aimLine, landRing } from './models.js';
import { clearMilk, updateMilk } from './milk.js';
import * as League from './league.js';
import { showMilkKing } from './milkking.js';
import { faceSVG } from './faces.js';
import { botById } from '../shared/roster.js';
import { createNet, savedRoom, fetchMine, hasKey, myKey, setKey, validKey } from './net.js';
import { renderHub, renderTicker, myFixture, esc } from './hub.js';

const $ = s => document.querySelector(s);
let RAPIER;
try {
  const mod = await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm');
  RAPIER = mod.default || mod;
  await RAPIER.init();
} catch (err) {
  $('#loadMsg').textContent = 'The physics engine failed to load. Reload the page to try again. (' + (err && err.message || err) + ')';
  throw err;
}

const physics = createPhysics(RAPIER);
const bottles = physics.bottles;
decorateBottles(bottles);
const HOME_C = new THREE.Vector3(0, 0, FRONT_Z - 1.5 * ROW);
let landed = false;

// ---------- Game state ----------
const game = { players: [], cur: 0, target: 50, winner: null };
let state = 'menu', viewBottles = false;
let flyTime = 0, calm = 0, phaseT = 0, tween = null, physicsOn = true;
const SLOT_TYPES = ['human', 'easy', 'medium', 'hard'];
const SLOT_LABEL = { human: 'Human', easy: 'Computer · Easy', medium: 'Computer · Medium', hard: 'Computer · Hard' };
let slots = ['human', 'medium'];
let lastSetup = slots.slice();
let chosenTarget = 50; // the score to hit exactly; going over drops you to half
let mode = 'quick', leagueMatch = null; // quick | league | online

// Online, whether player i of the game on screen is us
const isMe = i => mode === 'online' && !!online && game.players[i]?.seat === online.seat;

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function setStickHeld(pull = 0, aim = 0) {
  hand.position.copy(RELEASE).add(V(0, -pull * 0.15, pull * 0.45));
  hand.rotation.set(0, -aim, 0);
  stickMesh.position.set(0, 0, 0);
  stickMesh.rotation.set(-0.25 + pull * 0.9, 0, 0);
  if (stickMesh.parent !== hand) hand.add(stickMesh);
  stickMesh.visible = true;
}

function resetBottles() {
  landRing.visible = false; clearMilk(bottles);
  physics.resetBottles();
  for (const p of bottles) p.label.material.color.set(0xffffff);
}

function startGame(types) {
  lastSetup = types.slice();
  game.players = createPlayers(types);
  mode = 'quick'; game.target = chosenTarget;
  launch(0);
}
function launch(first) {
  game.cur = first; game.winner = null; physics.removeStick(); resetBottles();
  ['#setup', '#over', '#league'].forEach(s => $(s).hidden = true);
  beginTurn();
}
function beginTurn() {
  viewBottles = false; $('#viewBtn').textContent = 'Look at bottles';
  setStickHeld();
  const p = game.players[game.cur];
  state = p.cpu ? 'cpu' : 'aim';
  renderBoard();
  if (p.cpu) return cpuPlan(p);
  // The scoreboard shows whose turn it is; say it out loud only when people share the device.
  if (!throwTip() && game.players.filter(q => !q.cpu).length > 1) toast(`${p.name}'s turn`, 1400);
}
function renderBoard() {
  $('#board').innerHTML = game.players.map((p, i) => `
    <div class="chip ${i === game.cur && state !== 'over' ? 'active' : ''} ${p.out ? 'out' : ''}">
      <div class="nm">${p.bot ? faceSVG(p.bot, 18) : `<span class="sw" style="background:${p.color}"></span>`}${esc(p.name)}${isMe(i) ? ' (you)' : ''}${p.left ? '<small>· computer</small>' : p.away ? '<small>· away</small>' : ''}</div>
      <div class="sc">${p.score}<small>/${game.target}</small></div>
      <div class="dots">${[0, 1, 2].map(k => `<i class="${k < p.misses ? 'on' : ''}"></i>`).join('')}</div>
      <div class="cd"></div>
    </div>`).join('');
}
let toastTimer;
// small: a longer message in smaller text that can wrap
function toast(msg, ms = 2000, small = false) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('small', small); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
// How to throw, once per visit, on the first turn that's yours. Returns true if it was shown.
let tipShown = false;
function throwTip() {
  if (tipShown) return false;
  tipShown = true;
  toast('Drag down, then flick up to throw. Press left or right of centre to aim.', 4000, true);
  return true;
}

// ---------- Throwing ----------
function throwStick(speed, aim) {
  physics.throwStick(speed, aim);
  scene.add(stickMesh); stickMesh.rotation.set(0, 0, 0);
  state = 'flying'; flyTime = 0; calm = 0; landed = false; landRing.visible = false;
}

let dragging = false, samples = [], startY = 0, curAim = 0;
function aimFromX(x) {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return 0;
  return THREE.MathUtils.clamp(((x - r.left) / r.width - 0.5) * 1.1, -AIM_LIMIT, AIM_LIMIT);
}
function updateAimLine(aim) {
  const a = V(RELEASE.x, 0.004, RELEASE.z);
  const b = a.clone().add(V(Math.sin(aim), 0, -Math.cos(aim)).multiplyScalar(4.6));
  aimGeo.setFromPoints([a, b]); aimLine.computeLineDistances();
}
canvas.addEventListener('pointerdown', e => {
  if (state !== 'aim') return;
  dragging = true; canvas.setPointerCapture(e.pointerId);
  startY = e.clientY; samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
  curAim = aimFromX(e.clientX); updateAimLine(curAim); aimLine.visible = true;
});
canvas.addEventListener('pointermove', e => {
  if (!dragging) return;
  const now = performance.now();
  samples.push({ t: now, x: e.clientX, y: e.clientY });
  while (samples.length > 2 && now - samples[0].t > 250) samples.shift();
  curAim = aimFromX(e.clientX); updateAimLine(curAim);
  const pull = THREE.MathUtils.clamp((e.clientY - startY) / innerHeight * 2.5, -0.4, 1);
  setStickHeld(pull, curAim);
  if (mode === 'online' && now - lastAimSent > 100) { lastAimSent = now; net.send({ t: 'aim', aim: curAim, pull }); }
});
let lastAimSent = 0;
function release(e, cancel) {
  if (!dragging) return;
  dragging = false; aimLine.visible = false;
  if (cancel) { setStickHeld(); if (mode === 'online') net.send({ t: 'aim', aim: 0, pull: 0 }); return; }
  const now = performance.now();
  samples.push({ t: now, x: e.clientX, y: e.clientY });
  let recent = samples.filter(s => now - s.t <= 150);
  if (recent.length < 2) recent = samples.slice(-2);
  const a = recent[0], b = recent[recent.length - 1];
  const dt = Math.max(0.016, (b.t - a.t) / 1000);
  const up = -(b.y - a.y) / dt / innerHeight; // screen heights per second, upward
  if (up < 0.35) { setStickHeld(); toast('Flick upward to throw', 1500); return; }
  // Flick sets intended distance (gentle curve), then solve for the launch speed that reaches it.
  const dist = THREE.MathUtils.clamp(3.6 * Math.pow(up / 2, 0.75), MIN_DIST, MAX_DIST);
  const speed = launchSpeedFor(dist);
  if (mode === 'online') {
    // The server simulates it; hold the follow-through until its recording arrives.
    net.send({ t: 'throw', dist, aim: curAim });
    setStickHeld(-0.3, curAim); state = 'sent';
    return;
  }
  throwStick(speed, curAim);
}
canvas.addEventListener('pointerup', e => release(e, false));
canvas.addEventListener('pointercancel', e => release(e, true));

// ---------- Computer players ----------
let cpu = null;
function cpuPlan(pl) {
  cpu = { t: 0, ...planCpuThrow(pl, computeInfo(physics.bottleSpots()), game.target) };
}
function cpuTick(dt) {
  cpu.t += dt;
  const t = cpu.t;
  if (t > 0.7 && !aimLine.visible) { updateAimLine(cpu.aim); aimLine.visible = true; }
  if (t > 1.2 && t <= 1.8) setStickHeld((t - 1.2) / 0.6, cpu.aim);
  else if (t > 1.8 && t <= 1.95) setStickHeld(1 - (t - 1.8) / 0.15 * 1.3, cpu.aim);
  else if (t > 1.95) {
    aimLine.visible = false;
    if (!cpu.online) throwStick(launchSpeedFor(cpu.thrownDist), cpu.thrownAim);
    cpu = null;
  }
}

// ---------- Scoring ----------
function resolveThrow() {
  const fallen = physics.fallenBottles();
  fallen.forEach(p => p.label.material.color.set(0xff6b5b));
  const msg = scoreThrow(game, fallen.map(p => p.num));
  toast(msg, 2200); renderBoard();
  state = 'scoring'; phaseT = 0;
}
function startRestand() {
  physics.removeStick(); stickMesh.visible = false;
  physicsOn = false;
  const poses = bottles.map(p => ({ t: p.body.translation(), q: p.body.rotation() }));
  const plan = mode === 'online' ? onlineRestandPlan() : planRestand(poses);
  const items = bottles.map((p, i) => {
    const { t, q } = poses[i];
    return { p, needs: plan[i].needs, from: V(t.x, t.y, t.z), fromQ: new THREE.Quaternion(q.x, q.y, q.z, q.w), x: plan[i].x, z: plan[i].z };
  });
  tween = { items: items.filter(i => i.needs), t: 0, dur: 0.5 };
  state = 'restand';
}
function finishRestand() {
  for (const it of tween.items) {
    physics.placeUpright(it.p.body, it.x, it.z);
    it.p.spilled = false; it.p.milk.scale.y = 1; // a fresh, full bottle
  }
  bottles.forEach(p => p.label.material.color.set(0xffffff));
  tween = null; physicsOn = true;
  if (mode === 'online') return finishOnlineThrow();
  if (isGameOver(game)) return showOver();
  advanceTurn(game);
  beginTurn();
}
function showOver() {
  const { winner } = game;
  state = 'over'; renderBoard();
  $('#overTitle').textContent = !winner ? 'Out after three misses' : isMe(game.players.indexOf(winner)) ? 'You win!' : `${winner.name} ${verb(winner, 'wins', 'win')}!`;
  const sorted = [...game.players].sort((a, b) => b.score - a.score);
  $('#standings').innerHTML = sorted.map(p => `<li><span style="color:${p.color};font-weight:600">${esc(p.name)}${p.out ? ' (out)' : ''}</span><b>${p.score}</b></li>`).join('');
  $('#againBtn').textContent = mode === 'league' ? 'Continue' : mode === 'online' ? 'Back to room' : 'Play again';
  $('#overNew').textContent = mode === 'online' ? 'Leave room' : 'Change players';
  $('#overNew').hidden = mode === 'league';
  $('#over').hidden = false;
  if (mode === 'online') online.view = 'over';
}

// ---------- League ----------
const dots = sk => '●'.repeat(Math.round(1 + sk * 4)) + '○'.repeat(4 - Math.round(sk * 4));
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
// A name with its face (bots) for the league screens
const who = e => e.human ? '<b>You</b>' : `<span class="who">${faceSVG(e.bot, 22)}${esc(e.name)}</span>`;
function renderLeague() {
  const { league, lastRound, summary } = League.lg, tier = league.tier;
  const leagueOver = League.leagueDone(), done = League.seasonDone(), next = League.nextEvent();
  const above = tier > 0 ? League.tierName(tier - 1) : null, below = tier < 2 ? League.tierName(tier + 1) : null;
  $('#lgTitle').textContent = `${League.tierName(tier)} · season ${league.season}`;
  $('#lgSub').textContent = leagueOver ? `${done ? 'Season complete' : 'League games complete; the cup final is still to come'}. First to ${League.leagueTarget()}.`
    : `Round ${league.round + 1} of ${league.schedule.length} · first to ${League.leagueTarget()}. `
      + [above && `Top ${League.UP} go up to the ${above}`, below && `bottom ${League.DOWN} go down to the ${below}`].filter(Boolean).join(', ') + '.';
  // Start of a season: what happened at the end of the last one
  const moves = summary && league.round === 0 && !lastRound;
  $('#lgMovesWrap').hidden = !moves;
  if (moves) {
    const line = (t, dir) => summary.moves.filter(m => m.to === t && (dir === 'up' ? m.from > t : m.from < t));
    $('#lgMoves').innerHTML = [0, 1, 2].flatMap(t => [
      line(t, 'up').length ? `<div>Up to the ${League.tierName(t)}: ${line(t, 'up').map(m => who(m)).join(', ')}</div>` : '',
      line(t, 'down').length ? `<div>Down to the ${League.tierName(t)}: ${line(t, 'down').map(m => who(m)).join(', ')}</div>` : '',
    ]).join('') + `<div class="champs">Champions: ${summary.champions.map((n, t) => `${League.tierName(t)} <b>${esc(n)}</b>`).join(' · ')}${summary.cup ? ` · Cup <b>${esc(summary.cup.winner)}</b>` : ''}</div>`;
  }
  $('#lgResultsWrap').hidden = !lastRound;
  if (lastRound) {
    $('#lgResultsLabel').textContent = `Round ${lastRound.round} results`;
    $('#lgResults').innerHTML = lastRound.games.map(g => {
      const A = league.entries[g.a], B = league.entries[g.b];
      return `<div><span>${g.aw ? `<b>${who(A)}</b>` : who(A)}</span><span>${g.sa}–${g.sb}</span><span style="text-align:right">${g.aw ? who(B) : `<b>${who(B)}</b>`}</span></div>`;
    }).join('');
  }
  $('#lgTable').innerHTML = '<tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr>' +
    League.standings().map(({ e }, pos) => `<tr class="${e.human ? 'me' : ''} ${League.zone(pos)}"><td>${pos + 1}</td><td>${who(e)}${e.human ? '' : `<span class="skill" title="Skill">${dots(e.skill)}</span>`}</td>
      <td>${e.P}</td><td>${e.W}</td><td>${e.L}</td><td>${e.PF - e.PA > 0 ? '+' : ''}${e.PF - e.PA}</td></tr>`).join('');
  $('#lgKey').innerHTML = [above && '<span class="up">Promotion</span>', below && '<span class="down">Relegation</span>'].filter(Boolean).join('');
  renderCup();
  if (next === 'cup') {
    // Your cup tie comes before the next league round
    const t = League.myCupTie(), opp = League.entryFor(t.a === League.YOU ? t.b : t.a), b = botById(opp.bot);
    $('#lgNext').innerHTML = `<div class="opp">${faceSVG(opp.bot, 44)}<div>Cup · ${League.CUP_ROUNDS[League.lg.cup.round]}: <b>You</b> vs <b>${esc(opp.name)}</b> <span class="skill">${dots(opp.skill)}</span>
      <div class="style">“${esc(b.style)}”</div></div></div>`;
    $('#lgPlay').textContent = 'Play cup tie';
  } else if (done) {
    const table = League.standings(), pos = table.findIndex(x => x.e.human), champ = table[0].e, z = League.zone(pos);
    $('#lgNext').innerHTML = (champ.human ? `<b>Champions of the ${League.tierName(tier)}!</b> ` : `${who(champ)} wins the ${League.tierName(tier)}. You finished ${ordinal(pos + 1)}. `)
      + (z === 'up' ? `You’re promoted to the <b>${above}</b>.` : z === 'down' ? `You’re relegated to the <b>${below}</b>.` : tier === 0 && champ.human ? 'The best there is.' : `You stay in the ${League.tierName(tier)}.`)
      + (League.lg.cup.winner === League.YOU ? ' <b>And you won the cup!</b>' : '');
    $('#lgPlay').textContent = 'Next season';
  } else {
    const opp = league.entries[League.myOpponent()], b = botById(opp.bot);
    $('#lgNext').innerHTML = `<div class="opp">${faceSVG(opp.bot, 44)}<div>Next: <b>You</b> vs <b>${esc(opp.name)}</b> <span class="skill">${dots(opp.skill)}</span>
      <div class="style">“${esc(b.style)}”</div></div></div>`;
    $('#lgPlay').textContent = 'Play match';
  }
  showMilkKing($('#lgKing'), done && tier === 0 && League.standings()[0].e.human); // only for winning the Premier League
}
// The cup: how you're getting on, and the last round's results
function renderCup() {
  const cup = League.lg.cup, R = League.CUP_ROUNDS, you = League.YOU;
  const name = id => id === you ? '<b>You</b>' : who(League.entryFor(id));
  let status;
  if (cup.winner === you) status = '<b>You won the cup!</b>';
  else if (cup.out) status = `You were knocked out in the ${R[cup.out.round].toLowerCase()} by ${name(cup.out.by)}.`;
  else if (cup.winner) status = '';
  else if (cup.round === 0 && cup.byes.includes(you)) status = 'Premier League players get a bye to the second round.';
  else if (cup.round === 0) status = 'You’re in the first round. The Premier League joins in the second.';
  else status = `You’re through to the ${cup.round === R.length - 1 ? 'final' : R[cup.round].toLowerCase()}!`;
  $('#lgCupLabel').textContent = cup.winner ? `Cup · won by ${League.cupName(cup.winner)}` : `Cup · ${R[cup.round].toLowerCase()} next`;
  $('#lgCupStatus').innerHTML = status;
  const last = cup.round > 0 ? cup.ties[cup.round - 1] : null;
  $('#lgCupResultsLabel').textContent = last ? `${R[cup.round - 1]} results` : '';
  $('#lgCupResults').innerHTML = last ? last.map(t => {
    const aw = t.w === t.a;
    return `<div><span>${aw ? `<b>${name(t.a)}</b>` : name(t.a)}</span><span>${t.sa}–${t.sb}</span><span style="text-align:right">${aw ? name(t.b) : `<b>${name(t.b)}</b>`}</span></div>`;
  }).join('') : '';
}
function openLeague() {
  if (!League.lg.league) return openNewLeague();
  ['#setup', '#over', '#lgNew'].forEach(s => $(s).hidden = true);
  state = 'menu'; renderLeague(); $('#league').hidden = false;
}
// Starting a league career: choose how long each game is (first to 20, 30 or 50)
const LENGTH_NOTE = { 20: 'Quick games: first to exactly 20. A season goes by fast.', 30: 'Standard games: first to exactly 30.', 50: 'Full games: first to exactly 50, the official length.' };
let newLength = 30;
function setLength(t) {
  newLength = t;
  $('#lgLength').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.t === t));
  $('#lgLengthNote').textContent = LENGTH_NOTE[t];
}
function openNewLeague() {
  ['#setup', '#over', '#league'].forEach(s => $(s).hidden = true);
  setLength(chosenTarget in LENGTH_NOTE ? chosenTarget : 30);
  state = 'menu'; $('#lgNew').hidden = false;
}
function playLeagueMatch() {
  const { league } = League.lg;
  if (League.seasonDone()) { League.nextSeason(); renderLeague(); return; }
  if (League.nextEvent() === 'cup') {
    const t = League.myCupTie(), opp = League.entryFor(t.a === League.YOU ? t.b : t.a);
    mode = 'league'; leagueMatch = { cup: true }; game.target = League.leagueTarget();
    game.players = [newPlayer('You', null, COLORS[0]), { ...newPlayer(opp.name, opp.ai, COLORS[1]), bot: opp.bot }];
    return launch(Math.random() < 0.5 ? 0 : 1); // a coin toss for who throws first
  }
  const oi = League.myOpponent(), opp = league.entries[oi];
  mode = 'league'; leagueMatch = { oi, round: league.round }; game.target = League.leagueTarget();
  game.players = [newPlayer('You', null, COLORS[0]), { ...newPlayer(opp.name, opp.ai, COLORS[1]), bot: opp.bot }];
  launch(league.round % 2); // alternate who throws first
}
function finishLeagueMatch() {
  const [me, bot] = game.players;
  if (leagueMatch.cup) League.finishCupTie(me.score, bot.score, game.winner === me);
  else League.finishRound(leagueMatch.oi, me.score, bot.score, game.winner === me);
  leagueMatch = null; mode = 'quick';
}
League.loadLeague();

// ---------- Online play ----------
// The server owns the game. Messages that change the scene wait in a queue while a throw is being
// animated, so everyone sees each throw play out in order. Each game is a "match"; a league round has
// several at once, so we show one (our own, or one we're watching) and ignore the others' messages.
// online.view: entry | lobby | game (our match) | watch (someone else's) | hub (league screen) | over
let online = null, net = null;
const ANIMATING = ['flying', 'scoring', 'restand'];
const STICK_BODY = 12; // body index the server uses for the stick
const NAME_KEY = 'milkky-name';
const GAME_MESSAGES = new Set(['start', 'sync', 'turn', 'throw', 'aim', 'status']);

function enterOnline() {
  mode = 'online'; leagueMatch = null; cpu = null; aimLine.visible = false; tween = null;
  physics.removeStick(); resetBottles(); state = 'menu';
  online = { seat: -1, room: null, view: 'entry', queue: [], play: null, pending: null, overQueued: false,
    myMatch: null, watching: null, fixtures: null, turnEndsAt: null, nextRoundAt: null };
  if (!net) net = createNet(onNet, onNetStatus);
  $('#newBtn').textContent = 'Leave game';
}
// Give up the seat and go back to the main menu
function leaveOnline() {
  if (net) net.leave();
  exitOnline();
  $('#setup').hidden = false;
  refreshMineBtn();
}
// Step away from a game played at leisure, keeping the seat, and go to "My games"
function stepAway() {
  if (net) net.detach();
  exitOnline();
  openMine();
}
function exitOnline() {
  online = null; mode = 'quick'; cpu = null; aimLine.visible = false; tween = null; physicsOn = true;
  physics.removeStick(); resetBottles(); setStickHeld(); state = 'menu';
  $('#newBtn').textContent = 'New game'; $('#board').innerHTML = '';
  $('#ticker').hidden = true; $('#hubBtn').hidden = true;
  ['#online', '#lobby', '#over', '#hub', '#mine'].forEach(s => $(s).hidden = true);
  setRoomParam(null);
}
const isAsync = () => online?.room?.pace === 'async';
function setRoomParam(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}
// Invites go through /join or, for a league, /joinleague (join.html / joinleague.html, mapped in nginx).
// Each has its own link preview, then forwards to the game.
function shareLink(code) {
  const here = new URL(location.href), server = here.searchParams.get('server');
  const u = new URL(online?.room?.mode === 'league' ? 'joinleague' : 'join', here);
  u.searchParams.set('room', code);
  if (server) u.searchParams.set('server', server);
  return u.href;
}

// Name and room code. With a code (from a room link) the screen leads with joining that room.
function openOnline(code = '') {
  ['#setup', '#over', '#league'].forEach(s => $(s).hidden = true);
  let name = '';
  try { name = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}
  $('#onName').value = name; $('#onCode').value = code; $('#onErr').textContent = '';
  $('#onCard').classList.toggle('joining', !!code);
  $('#onTitle').textContent = code ? `Join room ${code}` : 'Play online';
  $('#onSub').textContent = code ? 'Enter your name to join the game.'
    : 'Play with friends on their own devices. Create a room and share the code, or join theirs.';
  $('#onCreate').textContent = code ? 'Create a new room instead' : 'Create a room';
  const current = savedRoom();
  $('#onNote').textContent = current && current !== code ? `This will take you out of your game in room ${current}.` : '';
  $('#onBack').textContent = current ? `Back to room ${current}` : 'Back';
  setEntryBusy(false);
  $('#online').hidden = false;
  (name ? (code ? $('#onJoin') : $('#onCreate')) : $('#onName')).focus();
}
function setEntryBusy(busy) { ['#onCreate', '#onJoin'].forEach(s => $(s).disabled = busy); }
function entryName() {
  const name = $('#onName').value.trim();
  if (!name) { $('#onErr').textContent = 'Enter your name first.'; $('#onName').focus(); return null; }
  try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  return name;
}
function connect(first) {
  enterOnline(); setEntryBusy(true); $('#onErr').textContent = '';
  net.start(first);
}

function onNet(m) {
  if (!online) return;
  if (GAME_MESSAGES.has(m.t)) return onGameMessage(m);
  switch (m.t) {
    case 'joined':
      online.seat = m.you; online.queue.length = 0; setRoomParam(m.code);
      $('#online').hidden = true;
      if (online.view === 'entry') online.view = 'lobby';
      return;
    case 'room': return onRoom(m);
    case 'fixtures': // live scores during a league round
      online.fixtures = m.fixtures;
      renderTicker(online.room, online.fixtures, online.watching, online.view === 'watch');
      if (!$('#hub').hidden) refreshHub();
      return;
    case 'error':
      if (m.code === 'gone') { leaveOnline(); return toast('That game has ended', 2500); }
      if (online.view === 'entry') { $('#onErr').textContent = m.msg; setEntryBusy(false); return; }
      if (state === 'sent') { state = 'aim'; setStickHeld(); }
      return toast(m.msg, 2500);
  }
}
function onGameMessage(m) {
  if (m.t === 'start' || m.t === 'sync') {
    // Our own match (a new round, or catching up after rejoining), or one we asked to watch
    const mine = m.t === 'start' || m.game.players.some(p => p.seat === online.seat);
    if (mine) online.myMatch = m.match;
    else if (m.match !== online.watching) return; // a game we've since stopped watching
    online.watching = m.match; online.queue.length = 0;
    return onlineSync(m);
  }
  if (m.match !== online.watching) return;
  switch (m.t) {
    case 'aim': // the thrower lining up
      if (state === 'remote') { updateAimLine(m.aim); aimLine.visible = m.pull !== 0 || m.aim !== 0; setStickHeld(m.pull, m.aim); }
      return;
    case 'status': // someone dropped, came back, or left
      m.game.players.forEach((p, i) => { if (game.players[i]) Object.assign(game.players[i], { away: p.away, left: p.left }); });
      return renderBoard();
    case 'turn':
      if (m.deadline != null) m.endsAt = performance.now() + m.deadline; // time left counts from now, not when it's shown
      online.queue.push(m); break;
    case 'throw':
      if (m.over) online.overQueued = true;
      online.queue.push(m); break;
  }
  if (renderingStopped()) catchUp();
}
function onRoom(m) {
  online.room = m; online.seat = m.you;
  if (m.fixtures) online.fixtures = m.fixtures;
  if (m.league?.nextRoundIn != null) online.nextRoundAt = performance.now() + m.league.nextRoundIn;
  online.roundEndsAt = m.league?.roundEndsIn != null ? performance.now() + m.league.roundEndsIn : null;
  $('#hubBtn').hidden = m.mode !== 'league' || !m.league || m.phase === 'lobby' || online.view === 'lobby';
  // Played at leisure: you step away (keeping your seat) rather than leave
  $('#newBtn').textContent = m.pace === 'async' ? 'My games' : 'Leave game';
  renderTicker(m, online.fixtures, online.watching, online.view === 'watch');
  const v = online.view, idle = !ANIMATING.includes(state) && !online.queue.length && !online.overQueued;
  if (v === 'lobby') {
    // A league round starting with our game in it: the start message takes over.
    const mine = myFixture(m.fixtures, m.you);
    if (m.mode === 'league' && m.phase !== 'lobby' && m.phase !== 'over' && !(mine && !mine.over)) return showHub();
    if (m.phase !== 'playing') showLobby();
    return;
  }
  if (!$('#hub').hidden) refreshHub();
  if (m.mode === 'game') {
    // The game ended while we were disconnected: back to the room.
    if (m.phase !== 'playing' && v === 'game' && idle) showLobby();
    return;
  }
  // League: our game (or the one we were watching) finished while we were away
  const shown = (m.fixtures || []).find(f => f.id === online.watching);
  if ((v === 'game' || v === 'watch') && idle && (m.phase !== 'playing' || !shown || shown.over)) showHub();
}
function onNetStatus(s) {
  if (!online) return;
  if (s === 'reconnecting') toast('Connection lost. Reconnecting…', 60000);
  else if (s === 'reconnected') toast('Reconnected', 1500);
  else if (s === 'failed') {
    if (online.view === 'entry') { $('#onErr').textContent = 'Can’t reach the game server. Check your connection and try again.'; setEntryBusy(false); }
    else { leaveOnline(); toast('Can’t reach the game server', 3000); }
  }
}

// Lobby
function showLobby() {
  online.view = 'lobby'; online.overQueued = false; state = 'menu';
  ['#over', '#online', '#setup', '#hub'].forEach(s => $(s).hidden = true);
  $('#hubBtn').hidden = true;
  renderLobby(); $('#lobby').hidden = false;
}
function renderLobby() {
  const r = online.room;
  if (!r) return;
  const host = r.you === r.host, league = r.mode === 'league', n = r.seats.length;
  $('#lbTitle').textContent = `Room ${r.code}`;
  $('#lbLink').textContent = shareLink(r.code);
  $('#lbMode').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.mode === r.mode); b.disabled = !host; });
  const rounds = n + (n % 2) - 1;
  $('#lbModeNote').textContent = league
    ? `Everyone plays everyone once. Each round's games are played at the same time, and you can watch the others when yours is done.${n >= 2 ? ` ${n} players: ${rounds} round${rounds > 1 ? 's' : ''}.` : ''}`
    : '';
  const slow = r.pace === 'async';
  $('#lbPace').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.pace === r.pace); b.disabled = !host; });
  $('#lbPaceNote').textContent = !slow ? 'Everyone plays together now.'
    : league ? 'Play your turns whenever suits you, over days. Each round lasts up to a day, and moves on as soon as its games are done. Bots finish any games still going at the deadline.'
    : 'Play your turns whenever suits you, over days. If a turn waits two days, a bot plays it.';
  $('#lbTarget').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', +b.dataset.t === r.target); b.disabled = !host; });
  // Played at leisure, people are often away; that's not worth marking.
  const away = s => !s.connected && !slow;
  $('#lbSeats').innerHTML = r.seats.map((s, i) => `
    <div class="slot ${away(s) ? 'away' : ''}"><span>${s.bot ? faceSVG(s.bot, 22) : `<i class="sw" style="background:${s.color}"></i>`}${esc(s.name)}
      ${i === r.you ? '<small>(you)</small>' : ''}${i === r.host ? '<small>· host</small>' : ''}${s.cpu ? `<small>· ${s.cpu}</small>` : ''}${away(s) ? '<small>· away</small>' : ''}</span>
      ${host && s.cpu ? `<button data-rm="${i}" aria-label="Remove ${esc(s.name)}">Remove</button>` : ''}</div>`).join('');
  $('#lbAdd').hidden = !host || n >= r.maxSeats;
  $('#lbStart').hidden = !host;
  $('#lbStart').textContent = league ? 'Start league' : 'Start game';
  $('#lbStart').disabled = n < 2;
  $('#lbWait').textContent = !host ? `Waiting for the host to start the ${league ? 'league' : 'game'}.`
    : n < 2 ? 'Share the link, or add a computer player, to start.'
    : slow ? 'Start when everyone’s in. You can close this and come back: it’s in My games.' : '';
}

// League screen. As the main view (between our games), or peeked at over the game we're playing or watching.
function showHub() {
  online.view = 'hub'; online.overQueued = false; state = 'menu'; cpu = null; aimLine.visible = false;
  online.turnEndsAt = null;
  ['#over', '#online', '#setup', '#lobby'].forEach(s => $(s).hidden = true);
  refreshHub(); $('#hub').hidden = false;
}
function peekHub() { refreshHub(); $('#hub').hidden = false; }
function refreshHub() {
  if (!online?.room?.league) return;
  const secsToNext = online.room.phase === 'between' && online.nextRoundAt ? Math.max(0, Math.ceil((online.nextRoundAt - performance.now()) / 1000)) : null;
  const roundLeft = online.roundEndsAt ? Math.max(0, online.roundEndsAt - performance.now()) : null;
  renderHub({ room: online.room, fixtures: online.fixtures, you: online.seat, view: online.view, watching: online.watching, secsToNext, roundLeft });
}
// "13h", "40m": time left, roughly
const timeLeft = ms => ms >= 3600_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
// Once a second: the countdown to the next round, and to the end of your turn (also when not drawing frames)
setInterval(() => {
  if (online?.room?.phase === 'between' && !$('#hub').hidden) refreshHub();
  if (online) updateCountdown();
}, 1000);
function watchMatch(id) {
  online.watching = id; online.queue.length = 0;
  net.send({ t: 'watch', match: id }); // the server replies with the game as it stands
  $('#hub').hidden = true;
}

// Game
function pumpOnline() {
  while (online.queue.length && !ANIMATING.includes(state)) {
    const m = online.queue.shift();
    if (m.t === 'turn') onlineTurn(m);
    else if (m.t === 'throw') onlineThrow(m);
  }
}
// Browsers pause the render loop (and throttle timers) in background tabs, so while nothing is being
// drawn, animations are skipped and messages applied as they arrive. Coming back shows the game as it is now.
const renderingStopped = () => document.hidden || performance.now() - lastFrameAt > 1000;
function catchUp() {
  for (;;) {
    if (state === 'flying') resolveOnlineThrow();
    else if (state === 'scoring') startRestand();
    else if (state === 'restand') finishRestand();
    else if (online.queue.length) pumpOnline();
    else break;
  }
  $('#toast').classList.remove('show');
}
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'online' && online) catchUp(); });
function applyGame(g) {
  game.players = g.players.map(p => ({ ...p }));
  game.cur = g.cur; game.target = g.target;
  game.winner = g.winner >= 0 ? game.players[g.winner] : null;
}
function snapPoses(poses) {
  bottles.forEach((p, i) => {
    const [x, y, z, qx, qy, qz, qw] = poses[i];
    p.body.setTranslation({ x, y, z }, false); p.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, false);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  });
}
// A new game, catching up after rejoining, or starting to watch one: draw it as the server has it.
function onlineSync(m) {
  ['#lobby', '#over', '#online', '#setup', '#league', '#hub'].forEach(s => $(s).hidden = true);
  online.view = m.match === online.myMatch ? 'game' : 'watch';
  online.play = online.pending = null; online.overQueued = false; online.turnEndsAt = null;
  tween = null; cpu = null; aimLine.visible = false; landRing.visible = false; dragging = false;
  physics.removeStick();
  clearMilk(bottles); bottles.forEach(p => p.label.material.color.set(0xffffff));
  applyGame(m.game); snapPoses(m.poses); setStickHeld();
  state = 'remote'; renderBoard();
  $('#hubBtn').hidden = online.room?.mode !== 'league';
  renderTicker(online.room, online.fixtures, online.watching, online.view === 'watch');
  if (m.t === 'sync' && m.over) return online.view === 'watch' ? showHub() : null;
  // Back to a game played at leisure: the throws you missed follow, then your turn
  if (m.replay) toast(`Catching up: ${m.replay} throw${m.replay > 1 ? 's' : ''} since you were last here`, 2600, true);
  if (m.t === 'sync' && m.turn) {
    if (m.turn.deadline != null) m.turn.endsAt = performance.now() + m.turn.deadline;
    onlineTurn(m.turn);
  }
}
function onlineTurn(m) {
  game.cur = m.cur;
  viewBottles = false; $('#viewBtn').textContent = 'Look at bottles';
  if (dragging) { dragging = false; aimLine.visible = false; }
  setStickHeld(); aimLine.visible = false; cpu = null;
  const mine = isMe(m.cur);
  state = mine && !m.cpu ? 'aim' : m.cpu ? 'cpu' : 'remote';
  online.turnEndsAt = state === 'aim' ? m.endsAt ?? null : null;
  renderBoard(); // the active chip shows whose turn it is
  const p = game.players[m.cur], seat = online.room?.seats[p.seat];
  if (mine && m.standIn) toast('Out of time, so the computer is throwing for you', 2500, true);
  else if (state === 'aim' && !throwTip()) toast('Your turn', 1400);
  // At leisure, after your throw: the other player may not be here. No need to wait around.
  else if (isAsync() && !m.cpu && !mine && seat && !seat.connected && isMe(online.lastThrower)) {
    toast(`${p.name}’s turn. They’ll see your throw when they’re back, and you can close this.`, 4000, true);
  }
  if (m.cpu) cpu = { t: 0, aim: m.cpu.aim, target: m.cpu.target, online: true };
  if (mine && !m.cpu && !$('#hub').hidden && online.view === 'game') $('#hub').hidden = true; // your turn: back to the game
}
// The last seconds of your turn, on your chip, before the computer throws for you
function updateCountdown() {
  const el = $('#board .chip.active .cd');
  if (!el) return;
  const secs = state === 'aim' && online?.turnEndsAt ? Math.max(0, Math.ceil((online.turnEndsAt - performance.now()) / 1000)) : null;
  const text = secs != null && secs <= 15 ? `${secs}s` : '';
  if (el.textContent !== text) el.textContent = text;
}
function onlineThrow(m) {
  aimLine.visible = false; cpu = null; online.turnEndsAt = null;
  online.play = m; online.lastThrower = m.seat;
  scene.add(stickMesh); stickMesh.visible = true;
  state = 'flying'; flyTime = 0; landed = false; landRing.visible = false;
  updateCountdown();
  playFrame(0);
}
// Show the recording at time t (seconds), smoothing between frames.
const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
function playFrame(t) {
  const m = online.play, last = m.frames.length - 1;
  const f = Math.min(last, t * m.fps), i = Math.max(0, Math.min(last - 1, Math.floor(f))), k = Math.min(1, f - i);
  const A = m.frames[i], B = m.frames[Math.min(last, i + 1)];
  m.bodies.forEach((b, j) => {
    const o = j * 7;
    pa.set(A[o], A[o + 1], A[o + 2]); pb.set(B[o], B[o + 1], B[o + 2]);
    qa.set(A[o + 3], A[o + 4], A[o + 5], A[o + 6]); qb.set(B[o + 3], B[o + 4], B[o + 5], B[o + 6]);
    const vel = pb.clone().sub(pa).multiplyScalar(m.fps); // only used for the milk splash
    pa.lerp(pb, k); qa.slerp(qb, k);
    if (b === STICK_BODY) {
      stickMesh.position.copy(pa); stickMesh.quaternion.copy(qa);
      if (!landed && t > 0.1 && pa.y < STICK_HALF + 0.01) { landed = true; landRing.position.set(pa.x, 0.003, pa.z); landRing.visible = true; }
    } else {
      const body = bottles[b].body;
      body.setTranslation({ x: pa.x, y: pa.y, z: pa.z }, false);
      body.setRotation({ x: qa.x, y: qa.y, z: qa.z, w: qa.w }, false);
      body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, false);
    }
  });
}
const playLength = m => (m.frames.length - 1) / m.fps;
function resolveOnlineThrow() {
  const m = online.play;
  playFrame(playLength(m));
  online.play = null; online.pending = m;
  const fallen = new Set(m.fallen);
  bottles.forEach(p => { if (fallen.has(p.num)) p.label.material.color.set(0xff6b5b); });
  applyGame(m.game); game.cur = m.seat; // keep the thrower highlighted until the next turn
  toast(m.msg, 2200); renderBoard();
  state = 'scoring'; phaseT = 0;
}
function onlineRestandPlan() {
  const plan = bottles.map(() => ({ needs: false }));
  for (const [i, x, z] of online.pending.restand) plan[i] = { needs: true, x, z };
  return plan;
}
function finishOnlineThrow() {
  const m = online.pending;
  online.pending = null;
  snapPoses(m.poses);
  if (m.over) return online.room?.mode === 'league' ? showHub() : showOver();
  game.cur = m.game.cur;
  state = 'remote'; // the next turn message is already queued
}

$('#onCreate').onclick = () => { const name = entryName(); if (name) connect({ t: 'create', name }); };
$('#onJoin').onclick = () => {
  const code = $('#onCode').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { $('#onErr').textContent = 'Room codes are 4 letters.'; return; }
  const name = entryName();
  if (name) connect({ t: 'join', code, name });
};
$('#onName').addEventListener('keydown', e => { if (e.key === 'Enter') ($('#onCode').value.trim() ? $('#onJoin') : $('#onCreate')).click(); });
$('#onCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#onJoin').click(); });
$('#onBack').onclick = () => {
  if (savedRoom()) { $('#online').hidden = true; enterOnline(); net.resume(); return; } // back to the game we came from
  if (mode === 'online') leaveOnline(); else { $('#online').hidden = true; $('#setup').hidden = false; }
};
$('#lbMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) net.send({ t: 'mode', mode: b.dataset.mode }); });
$('#lbTarget').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) net.send({ t: 'target', target: +b.dataset.t }); });
$('#lbAdd').addEventListener('click', e => { const b = e.target.closest('button'); if (b) net.send({ t: 'addCpu', level: b.dataset.level }); });
$('#lbSeats').addEventListener('click', e => { const b = e.target.closest('button[data-rm]'); if (b) net.send({ t: 'removeCpu', seat: +b.dataset.rm }); });
$('#lbStart').onclick = () => net.send({ t: 'start' });
$('#lbLeave').onclick = leaveOnline;
$('#lbCopy').onclick = async () => {
  const link = shareLink(online.room.code);
  try { await navigator.clipboard.writeText(link); toast('Link copied', 1500); } catch (e) { toast(link, 5000); }
};
$('#hubBtn').onclick = () => { if (online?.view === 'hub') return; peekHub(); };

// Menu: Rules, League, New game / Leave game. Closes after a choice or a tap elsewhere.
function setMenu(open) { $('#menu').hidden = !open; $('#menuBtn').setAttribute('aria-expanded', open); }
$('#menuBtn').onclick = () => setMenu($('#menu').hidden);
$('#menu').addEventListener('click', e => { if (e.target.closest('button')) setMenu(false); });
document.addEventListener('pointerdown', e => { if (!e.target.closest('.bottom')) setMenu(false); });
$('#hubBtns').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'back') $('#hub').hidden = true;
  else if (act === 'next') net.send({ t: 'next' });
  else if (act === 'room') showLobby();
  else if (act === 'mine') stepAway();
  else if (act === 'leave') { if (online.room.phase === 'over' || confirm('Leave the league? The computer will play your remaining games.')) leaveOnline(); }
});
$('#hubLive').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b?.dataset.act === 'watch') watchMatch(b.dataset.match);
  if (b?.dataset.act === 'play') { online.watching = b.dataset.match; net.send({ t: 'watch', match: b.dataset.match }); } // back into our own game
});
$('#lbPace').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) net.send({ t: 'pace', pace: b.dataset.pace }); });

// ---------- My games ----------
// Every room you have a seat in (live or at leisure), from the server, by your player key.
async function openMine() {
  ['#setup', '#online', '#over', '#league'].forEach(s => $(s).hidden = true);
  $('#mineSub').textContent = 'Loading…'; $('#mineList').innerHTML = '';
  $('#mineLink').textContent = personalLink();
  $('#mine').hidden = false;
  try { renderMine(await fetchMine()); }
  catch (e) { $('#mineSub').textContent = 'Can’t reach the game server just now. Try again in a moment.'; }
}
const personalLink = () => { const u = new URL(location.href); u.search = ''; u.searchParams.set('me', myKey()); return u.href; };
function mineStatus(g) {
  const m = g.match, lg = g.league;
  if (g.phase === 'lobby') return g.host ? 'Waiting for you to start it' : 'Waiting for the host to start';
  if (g.phase === 'over') return lg ? `Finished · you came ${ordinal(lg.place)}` : 'Finished';
  if (m?.yourTurn) return `Your turn${m.unseen ? ` · ${m.unseen} new throw${m.unseen > 1 ? 's' : ''} to watch` : ''}`;
  if (m && !m.over) return `Waiting for ${m.turnOf}`;
  return 'Your game is done · waiting for the round to finish';
}
function renderMine(games) {
  const rank = g => g.match?.yourTurn ? 0 : g.phase === 'lobby' && g.host ? 1 : g.phase !== 'over' ? 2 : 3;
  games.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const turns = games.filter(g => g.match?.yourTurn).length;
  $('#mineSub').textContent = !games.length ? '' : turns ? `It’s your turn in ${turns} game${turns > 1 ? 's' : ''}.` : 'Nothing waiting for you right now.';
  $('#mineList').innerHTML = games.map(g => {
    const lg = g.league, m = g.match;
    const what = g.mode === 'league'
      ? `League${lg ? ` · round ${lg.round} of ${lg.rounds}` : ''}${g.pace === 'async' ? '' : ' · live'}`
      : `Game with ${g.players.filter(n => n !== g.you).map(esc).join(', ') || 'nobody yet'}`;
    const score = m && g.phase !== 'lobby' ? ` · ${m.players.map(p => `${esc(p.name)} ${p.score}`).join(', ')}` : '';
    const ends = lg?.roundEndsIn ? ` · round ends in ${timeLeft(lg.roundEndsIn)}` : m?.deadline ? ` · ${timeLeft(m.deadline)} left` : '';
    const go = m?.yourTurn || (g.phase === 'lobby' && g.host);
    return `<div class="fx"><span class="what"><b>${what}</b><span class="status ${go ? 'go' : ''}">${mineStatus(g)}${ends}</span>
      <span class="status">Room ${g.code}${score}</span></span>
      <button class="${go ? 'primary' : ''}" data-code="${g.code}">${m?.yourTurn ? 'Play' : 'Open'}</button></div>`;
  }).join('');
}
function openGame(code) {
  $('#mine').hidden = true;
  enterOnline(); online.view = 'lobby';
  net.start({ t: 'rejoin', code });
}
// The main menu's "My games" button, with how many games are waiting for you
async function refreshMineBtn() {
  const btn = $('#mineBtn');
  btn.hidden = !hasKey();
  if (btn.hidden) return;
  btn.textContent = 'My games';
  try {
    const turns = (await fetchMine()).filter(g => g.match?.yourTurn).length;
    if (turns) btn.textContent = `My games · ${turns} your turn`;
  } catch (e) {}
}
$('#mineBtn').onclick = openMine;
$('#mineBack').onclick = () => { $('#mine').hidden = true; $('#setup').hidden = false; refreshMineBtn(); };
$('#mineNew').onclick = () => { $('#mine').hidden = true; openOnline(); };
$('#mineList').addEventListener('click', e => { const b = e.target.closest('button[data-code]'); if (b) openGame(b.dataset.code); });
$('#mineCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(personalLink()); toast('Personal link copied', 1500); } catch (e) { toast(personalLink(), 5000); }
};

// ---------- Camera ----------
const THROW_POS = V(0, 1.1, 0.9), THROW_LOOK = V(0, 0.05, -3.0);
const camPos = THROW_POS.clone(), camLook = THROW_LOOK.clone();
function bottleCentre() {
  const c = V(0, 0, 0); let n = 0;
  for (const p of bottles) {
    const t = p.body.translation();
    if (Math.hypot(t.x - HOME_C.x, t.z - HOME_C.z) < 4) { c.x += t.x; c.z += t.z; n++; }
  }
  return n ? c.multiplyScalar(1 / n) : HOME_C.clone();
}
function updateCamera(dt) {
  const throwView = ['aim', 'cpu', 'menu', 'remote', 'sent'].includes(state) || (state === 'flying' && flyTime < 0.3);
  const follow = viewBottles || !throwView;
  let tp, tl;
  if (follow) { const c = bottleCentre(); tp = c.clone().add(V(0, 0.8, 1.4)); tl = c.clone().add(V(0, 0.02, -0.1)); }
  else { tp = THROW_POS; tl = THROW_LOOK; }
  const k = 1 - Math.exp(-dt * (state === 'flying' ? 1.6 : 3));
  camPos.lerp(tp, k); camLook.lerp(tl, k);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------- Loop ----------
function resize() {
  const w = app.clientWidth, h = app.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = camera.aspect < 0.8 ? 64 : 45; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

let last = performance.now(), lastFrameAt = 0;
const tq = new THREE.Quaternion(), tv = new THREE.Vector3(), IDQ = new THREE.Quaternion();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; lastFrameAt = now;
  if (physicsOn && mode !== 'online') physics.advance(dt);
  if (mode === 'online' && online) { pumpOnline(); updateCountdown(); }
  if (state === 'cpu' && cpu) cpuTick(dt);
  if (state === 'flying') {
    flyTime += dt;
    if (mode === 'online') {
      playFrame(flyTime);
      if (flyTime >= playLength(online.play)) resolveOnlineThrow();
    } else {
      calm = physics.isMoving() ? 0 : calm + dt;
      if ((calm > 0.6 && flyTime > 0.8) || flyTime > 12) resolveThrow();
    }
  } else if (state === 'scoring') {
    phaseT += dt; if (phaseT > 1.3) startRestand();
  } else if (state === 'restand' && tween) {
    tween.t += dt;
    const k = Math.min(1, tween.t / tween.dur), e = k * k * (3 - 2 * k);
    for (const it of tween.items) {
      tv.copy(it.from).lerp(V(it.x, BOTTLE_HALF + 0.0005, it.z), e); tv.y += Math.sin(Math.PI * e) * 0.06;
      tq.copy(it.fromQ).slerp(IDQ, e);
      it.p.body.setTranslation({ x: tv.x, y: tv.y, z: tv.z }, false);
      it.p.body.setRotation({ x: tq.x, y: tq.y, z: tq.z, w: tq.w }, false);
    }
    if (k >= 1) finishRestand();
  }
  for (const p of bottles) {
    const t = p.body.translation(), r = p.body.rotation();
    p.mesh.position.set(t.x, t.y, t.z); p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    p.label.position.set(t.x, t.y + 0.15, t.z);
  }
  updateMilk(dt, bottles, state === 'flying' || state === 'scoring');
  const stick = physics.stick;
  if (stick) {
    const t = stick.translation(), r = stick.rotation();
    if (!landed && state === 'flying' && flyTime > 0.1 && t.y < STICK_HALF + 0.01) {
      landed = true; landRing.position.set(t.x, 0.003, t.z); landRing.visible = true;
    }
    stickMesh.position.set(t.x, t.y, t.z); stickMesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
  updateCamera(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- UI wiring ----------
function renderSlots() {
  $('#slots').innerHTML = slots.map((t, i) => `
    <div class="slot"><span><i class="sw" style="background:${COLORS[i]}"></i>Player ${i + 1}</span>
    <button data-i="${i}" aria-label="Player ${i + 1}: ${SLOT_LABEL[t]}. Tap to change">${SLOT_LABEL[t]}</button></div>`).join('');
  $('#count').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', +x.dataset.n === slots.length));
}
$('#count').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const n = +b.dataset.n;
  while (slots.length < n) slots.push(slots.length === 1 && slots[0] === 'human' ? 'medium' : 'human');
  slots.length = n;
  renderSlots();
});
$('#slots').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const i = +b.dataset.i;
  slots[i] = SLOT_TYPES[(SLOT_TYPES.indexOf(slots[i]) + 1) % SLOT_TYPES.length];
  renderSlots();
});
renderSlots();
$('#targetPick').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  chosenTarget = +b.dataset.t;
  $('#targetPick').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
});
$('#startBtn').onclick = () => startGame(slots);
$('#againBtn').onclick = () => {
  if (mode === 'online') return showLobby();
  if (mode === 'league') { finishLeagueMatch(); openLeague(); }
  else startGame(lastSetup);
};
$('#leagueBtn').onclick = openLeague;
$('#lgPlay').onclick = playLeagueMatch;
$('#lgMenu').onclick = () => { $('#league').hidden = true; $('#setup').hidden = false; };
$('#lgReset').onclick = () => { if (confirm('Start a new league from the Sunday League? Your career so far will be lost.')) openNewLeague(); };
$('#lgLength').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setLength(+b.dataset.t); });
$('#lgCreate').onclick = () => { League.newCareer(newLength); openLeague(); };
// Back: to the league you have (choosing Start over doesn't lose it until you start the new one), or the menu
$('#lgNewBack').onclick = () => { if (League.lg.league) openLeague(); else { $('#lgNew').hidden = true; $('#setup').hidden = false; } };
$('#onlineBtn').onclick = () => openOnline();
$('#overNew').onclick = () => {
  if (mode === 'online') return leaveOnline();
  $('#over').hidden = true; $('#setup').hidden = false; state = 'menu';
};
$('#newBtn').onclick = () => {
  if (mode === 'online' && isAsync()) return stepAway(); // your seat is kept; carry on later from My games
  if (mode === 'online') { if (confirm('Leave this online game?')) leaveOnline(); return; }
  mode = 'quick'; leagueMatch = null; cpu = null; aimLine.visible = false; physics.removeStick(); resetBottles(); physicsOn = true; tween = null; state = 'menu'; $('#setup').hidden = false;
};
$('#helpBtn').onclick = () => $('#rules').hidden = false;
$('#setupRules').onclick = () => $('#rules').hidden = false;
$('#rulesClose').onclick = () => $('#rules').hidden = true;
$('#viewBtn').onclick = () => {
  viewBottles = !viewBottles;
  $('#viewBtn').textContent = viewBottles ? 'Back to throw view' : 'Look at bottles';
};

setStickHeld();
$('#loading').hidden = true;
// A personal link (?me=…) brings that player's games to this device.
const meParam = new URLSearchParams(location.search).get('me');
if (meParam) {
  const u = new URL(location.href); u.searchParams.delete('me'); history.replaceState(null, '', u);
  const other = validKey(meParam) && (!hasKey() || myKey() !== meParam);
  if (other && (!hasKey() || confirm('Use this personal link on this device? My games will show its games instead of this device’s.'))) setKey(meParam);
}
// A refresh in an online game rejoins it; a link to a different room offers to join that one instead.
const roomParam = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4), current = savedRoom();
if (current && (!roomParam || roomParam === current)) { enterOnline(); net.resume(); }
else if (roomParam) openOnline(roomParam);
else if (meParam && validKey(meParam)) openMine();
else { $('#setup').hidden = false; refreshMineBtn(); }
