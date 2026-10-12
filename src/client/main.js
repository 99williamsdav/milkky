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
import * as Career from '../shared/career.js';
import { showMilkKing } from './milkking.js';
import { faceSVG } from './faces.js';
import * as Achv from './achievements.js';
import * as Push from './push.js';
import { wormHTML } from './worm.js';
import * as Stats from './careerstats.js';
import { botById } from '../shared/roster.js';
import { createNet, savedRoom, fetchMine, hasKey, myKey, setKey, validKey, serverOverride } from './net.js';
import { renderHub, renderTicker, myFixture, esc } from './hub.js';
import { renderCareerHub, careerAchievements as careerAchievementsOnline } from './careerhub.js';

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
  for (const p of bottles) { p.label.material.color.set(0xffffff); p.mesh.visible = p.label.visible = true; } // (training hides them)
}

function startGame(types) {
  lastSetup = types.slice();
  game.players = createPlayers(types);
  mode = 'quick'; game.target = chosenTarget;
  launch(0);
}
// The game's worm: each player's score after each of their throws (game.log: [player, score after, missed])
function gameWorm(g) {
  const series = g.players.map((p, i) => ({ name: p.name, color: p.color,
    points: (g.log || []).filter(e => e[0] === i).map(e => ({ y: e[1], miss: !!e[2] })) }));
  return series.some(s => s.points.length) ? wormHTML(series, { max: g.target, target: g.target }) : '';
}
function launch(first) {
  game.cur = first; game.winner = null; game.log = []; physics.removeStick(); resetBottles();
  ['#setup', '#over', '#league'].forEach(s => $(s).hidden = true);
  Achv.gameStarted(game.players.map(p => !p.cpu)); // on this device, every person's throws count
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
// Where each bottle stands now: { [num]: { x, z } } (for achievements that care where a bottle was)
const bottlePlaces = () => Object.fromEntries(bottles.map(p => { const t = p.body.translation(); return [p.num, { x: t.x, z: t.z }]; }));
let throwFrom = null; // the bottles' places when this throw was made
function throwStick(speed, aim) {
  throwFrom = bottlePlaces();
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
  const thrower = game.cur, before = game.players[thrower], scoreBefore = before.score, missesBefore = before.misses;
  const msg = scoreThrow(game, fallen.map(p => p.num));
  game.log.push([thrower, game.players[thrower].score, fallen.length ? 0 : 1]); // for the worm
  if (mode === 'league' && careerTally && thrower === 0) Stats.recordThrow(careerTally, fallen.map(p => p.num), scoreBefore, game.target);
  Achv.thrown({ who: thrower, fallen: fallen.map(p => p.num), hit: physics.firstHit, needle: physics.needle, before: throwFrom || {}, release: RELEASE,
    target: game.target, players: game.players, scoreBefore, missesBefore,
    winner: game.winner ? game.players.indexOf(game.winner) : -1, over: isGameOver(game) });
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
  $('#overWorm').innerHTML = gameWorm(game);
  $('#againBtn').textContent = mode === 'league' ? 'Continue' : mode === 'online' ? 'Back to room' : 'Play again';
  $('#overNew').textContent = mode === 'online' ? 'Leave room' : 'Change players';
  $('#overNew').hidden = mode === 'league';
  $('#over').hidden = false;
  if (mode === 'online') online.view = 'over';
}

// ---------- Career Mode ----------
const dots = sk => '●'.repeat(Math.round(1 + sk * 4)) + '○'.repeat(4 - Math.round(sk * 4));
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const solo = () => League.solo.career;
const YOU = League.ME;
const nameOf = id => (id === YOU ? 'You' : Career.entryFor(id).name);
// A name with its face (bots) for the career screens
const who = id => id === YOU ? '<b>You</b>' : `<span class="who">${faceSVG(id, 22)}${esc(nameOf(id))}</span>`;
function renderLeague() {
  const c = solo(), tier = Career.tierOf(c, YOU);
  const leagueOver = Career.leagueDone(c), done = Career.seasonOver(c), next = League.nextEvent();
  const above = tier > 0 ? Career.tierName(tier - 1) : null, below = tier < Career.BOTTOM ? Career.tierName(tier + 1) : null;
  $('#lgTitle').textContent = `${Career.tierName(tier)} · season ${c.season}`;
  $('#lgSub').textContent = leagueOver ? `${done ? 'Season complete' : 'League games complete; the cup final is still to come'}. First to ${c.target}.`
    : `Round ${c.round + 1} of ${Career.leagueRounds()} · first to ${c.target}. `
      + [above && `Top ${Career.UP} go up to the ${above}`, below && `bottom ${Career.DOWN} go down to the ${below}`].filter(Boolean).join(', ') + '.';
  // Start of a season: what happened at the end of the last one
  const sm = c.summary, moves = sm && c.round === 0 && !c.lastLeague;
  $('#lgMovesWrap').hidden = !moves;
  if (moves) {
    const line = (t, dir) => sm.moves.filter(m => m.id !== YOU && m.to === t && (dir === 'up' ? m.from > t : m.from < t));
    $('#lgMoves').innerHTML = c.tiers.map((_, t) => t).flatMap(t => [
      line(t, 'up').length ? `<div>Up to the ${Career.tierName(t)}: ${line(t, 'up').map(m => who(m.id)).join(', ')}</div>` : '',
      line(t, 'down').length ? `<div>Down to the ${Career.tierName(t)}: ${line(t, 'down').map(m => who(m.id)).join(', ')}</div>` : '',
    ]).join('') + `<div class="champs">Champions: ${sm.champions.map((id, t) => `${Career.tierName(t)} <b>${esc(nameOf(id))}</b>`).join(' · ')}${sm.cup ? ` · Cup <b>${esc(nameOf(sm.cup))}</b>` : ''}</div>`;
  }
  // Your league's last round
  const last = c.lastLeague;
  $('#lgResultsWrap').hidden = !last;
  if (last) {
    $('#lgResultsLabel').textContent = `Round ${last.round} results`;
    $('#lgResults').innerHTML = last.games.filter(g => g.tier === tier).map(g =>
      `<div><span>${g.aWon ? `<b>${who(g.a)}</b>` : who(g.a)}</span><span>${g.sa}–${g.sb}</span><span style="text-align:right">${g.aWon ? who(g.b) : `<b>${who(g.b)}</b>`}</span></div>`).join('');
  }
  const table = Career.standings(c, tier);
  $('#lgTable').innerHTML = '<tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr>' +
    table.map((e, pos) => `<tr class="${e.id === YOU ? 'me' : ''} ${Career.zone(c, tier, pos)}"><td>${pos + 1}</td><td>${who(e.id)}${e.id === YOU ? '' : `<span class="skill" title="Skill">${dots(Career.entryFor(e.id).skill)}</span>`}</td>
      <td>${e.P}</td><td>${e.W}</td><td>${e.L}</td><td>${e.PF - e.PA > 0 ? '+' : ''}${e.PF - e.PA}</td></tr>`).join('');
  $('#lgKey').innerHTML = [above && '<span class="up">Promotion</span>', below && '<span class="down">Relegation</span>'].filter(Boolean).join('');
  renderCup();
  if (done) {
    const pos = table.findIndex(e => e.id === YOU), champ = table[0].id, z = Career.zone(c, tier, pos);
    $('#lgNext').innerHTML = (champ === YOU ? `<b>Champions of the ${Career.tierName(tier)}!</b> ` : `${who(champ)} wins the ${Career.tierName(tier)}. You finished ${ordinal(pos + 1)}. `)
      + (z === 'up' ? `You’re promoted to the <b>${above}</b>.` : z === 'down' ? `You’re relegated to the <b>${below}</b>.` : tier === 0 && champ === YOU ? 'The best there is.' : `You stay in the ${Career.tierName(tier)}.`)
      + (c.cup.winner === YOU ? ' <b>And you won the cup!</b>' : '');
    $('#lgPlay').textContent = 'Next season';
  } else {
    // Your next game: a cup tie, or the next league round
    const opp = League.opponentOf(League.myFixture()), b = botById(opp), e = Career.entryFor(opp);
    const what = next === 'cup' ? `Cup · ${Career.CUP_ROUNDS[c.cup.round]}:` : 'Next:';
    $('#lgNext').innerHTML = `<div class="opp">${faceSVG(opp, 44)}<div>${what} <b>You</b> vs <b>${esc(e.name)}</b> <span class="skill">${dots(e.skill)}</span>
      <div class="style">“${esc(b.style)}”</div></div></div>`;
    $('#lgPlay').textContent = next === 'cup' ? 'Play cup tie' : 'Play match';
  }
  showMilkKing($('#lgKing'), done && tier === 0 && table[0].id === YOU); // only for winning the Premier League
}
// The cup: how you're getting on, and the last round's results
function renderCup() {
  const c = solo(), cup = c.cup, R = Career.CUP_ROUNDS, st = Career.cupStatus(c, YOU);
  let status;
  if (st.won) status = '<b>You won the cup!</b>';
  else if (st.out) status = `You were knocked out in the ${R[st.out.round].toLowerCase()} by ${who(st.out.by)}.`;
  else if (cup.winner) status = '';
  else if (st.bye) status = 'Premier League players get a bye to the second round.';
  else if (cup.round === 0) status = 'You’re in the first round. The Premier League joins in the second.';
  else status = `You’re through to the ${cup.round === R.length - 1 ? 'final' : R[cup.round].toLowerCase()}!`;
  $('#lgCupLabel').textContent = cup.winner ? `Cup · won by ${nameOf(cup.winner)}` : `Cup · ${R[cup.round].toLowerCase()} next`;
  $('#lgCupStatus').innerHTML = status;
  const last = cup.round > 0 ? cup.ties[cup.round - 1] : null;
  $('#lgCupResultsLabel').textContent = last ? `${R[cup.round - 1]} results` : '';
  $('#lgCupResults').innerHTML = last ? last.map(t => {
    const aw = t.w === t.a;
    return `<div><span>${aw ? `<b>${who(t.a)}</b>` : who(t.a)}</span><span>${t.sa}–${t.sb}</span><span style="text-align:right">${aw ? who(t.b) : `<b>${who(t.b)}</b>`}</span></div>`;
  }).join('') : '';
}
function openLeague() {
  if (!solo()) return openNewLeague();
  ['#setup', '#over', '#lgNew'].forEach(s => $(s).hidden = true);
  state = 'menu'; renderLeague(); $('#league').hidden = false;
}
// Starting a career: choose how long each game is (first to 20, 30 or 50)
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
// Career stats: kept in the career's save (started now for a career from before they existed), and this game's
// tally of your throws
let careerTally = null;
const careerStats = () => (solo().stats ||= Stats.emptyStats(solo().season, Career.tierOf(solo(), YOU)));
function playLeagueMatch() {
  const c = solo();
  if (Career.seasonOver(c)) {
    League.nextSeason();
    const sm = c.summary.people[YOU];
    Stats.recordSeason(careerStats(), sm); League.save();
    if (sm.promoted) Achv.unlock('goingUp');
    if (sm.inARow) Achv.unlock('backToBack');
    renderLeague(); return;
  }
  const f = League.myFixture(), opp = Career.entryFor(League.opponentOf(f));
  mode = 'league'; leagueMatch = { cup: f.kind === 'cup' }; game.target = c.target; careerTally = Stats.newTally();
  game.players = [newPlayer('You', null, COLORS[0]), { ...newPlayer(opp.name, opp.ai, COLORS[1]), bot: opp.bot }];
  // League games alternate who throws first; cup ties are a coin toss
  launch(f.kind === 'cup' ? (Math.random() < 0.5 ? 0 : 1) : c.round % 2);
}
function finishLeagueMatch() {
  const [me, bot] = game.players, won = game.winner === me, c = solo(), tier = Career.tierOf(c, YOU);
  if (leagueMatch.cup) {
    // Giant Killer: knocking a Premier League player (they had a bye) out of the cup from the Sunday League
    if (won && tier === Career.BOTTOM && c.cup.byes.includes(bot.bot)) Achv.unlock('giantKiller');
    // Underdogs: beating anyone from a league above yours
    if (won && Career.tierOf(c, bot.bot) < tier) Achv.unlock('underdogs');
  }
  if (careerTally) Stats.recordGame(careerStats(), careerTally, { won, cup: leagueMatch.cup, opp: bot.bot, youOut: me.out, theyOut: bot.out });
  League.record(me.score, bot.score, won); // (saves the career, stats included)
  leagueMatch = null; mode = 'quick'; careerTally = null;
  careerAchievements();
}
// Season milestones (cup ties between bots can decide some of these, so check after every match)
function careerAchievements() {
  const c = solo(), tier = Career.tierOf(c, YOU), cupWon = c.cup.winner === YOU;
  if (cupWon) Achv.unlock('cupWinner');
  if (!Career.leagueDone(c)) return;
  const table = Career.standings(c, tier), top = table[0].id === YOU, mine = table.find(e => e.id === YOU);
  if (mine.W === Career.leagueRounds()) Achv.unlock('invincible');
  if (top && tier === 0) Achv.unlock('milkKing');
  if (top && cupWon) Achv.unlock('double');
}
League.load();

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
// A league or a career: rounds of games played at the same time, with the league screen between them
const isMulti = r => r?.mode === 'league' || r?.mode === 'career';

function enterOnline() {
  mode = 'online'; leagueMatch = null; cpu = null; aimLine.visible = false; tween = null;
  physics.removeStick(); resetBottles(); state = 'menu';
  online = { seat: -1, room: null, view: 'entry', queue: [], play: null, pending: null, overQueued: false,
    myMatch: null, watching: null, fixtures: null, turnEndsAt: null, nextRoundAt: null, watchers: [] };
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
  $('#ticker').hidden = true; $('#hubBtn').hidden = true; $('#watchers').hidden = true; showEmotes(false);
  ['#online', '#lobby', '#over', '#hub', '#mine', '#careerStats'].forEach(s => $(s).hidden = true);
  setRoomParam(null);
}
const isAsync = () => online?.room?.pace === 'async';
function setRoomParam(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}
// Invites go through /join, /joinleague or /joincareer (join.html and so on, mapped in nginx).
// Each has its own link preview, then forwards to the game.
function shareLink(code) {
  const here = new URL(location.href), server = serverOverride();
  const mode = online?.room?.mode;
  const u = new URL(mode === 'career' ? 'joincareer' : mode === 'league' ? 'joinleague' : 'join', here);
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
    case 'watchers': return setWatchers(m.match, m.names);
    case 'emote': return m.match === online.watching && ['game', 'watch'].includes(online.view) && showEmote(m);
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
  // A new round's game being held until we press Play: keep what happens in it, to play back then
  if (online.held && m.match === online.held[0].match) {
    if (m.t === 'turn' || m.t === 'throw') online.held.push(stampTurn(m));
    return;
  }
  if (m.t === 'start' || m.t === 'sync') {
    // Our own match (a new round, or catching up after rejoining), or one we asked to watch
    const mine = m.t === 'start' || m.game.players.some(p => p.seat === online.seat);
    if (mine) online.myMatch = m.match;
    else if (m.match !== online.watching) return; // a game we've since stopped watching
    online.watching = m.match;
    // A new round waits until the last one's final throw has finished playing
    if (m.t === 'start' && (ANIMATING.includes(state) || online.queue.length)) { online.queue.push(m); return; }
    if (m.t === 'start' && holdNewRound()) return hold([m]);
    online.queue.length = 0;
    return onlineSync(m);
  }
  if (m.match !== online.watching) return;
  switch (m.t) {
    case 'aim': // the thrower lining up
      if (state === 'remote') { updateAimLine(m.aim); aimLine.visible = m.pull !== 0 || m.aim !== 0; setStickHeld(m.pull, m.aim); }
      return;
    case 'status': // someone dropped, came back, or left
      m.game.players.forEach((p, i) => { if (game.players[i]) Object.assign(game.players[i], { away: p.away, left: p.left }); });
      renderBoard(); return refreshEmotes();
    case 'turn':
      online.queue.push(stampTurn(m)); break;
    case 'throw':
      if (m.over) online.overQueued = true;
      online.queue.push(m); break;
  }
  if (renderingStopped()) catchUp();
}
function onRoom(m) {
  online.room = m; online.seat = m.you;
  // Long Haul: a take-your-time league we were in has finished
  if (m.mode === 'league' && m.pace === 'async' && m.phase === 'over' && m.league?.table.some(e => e.seat === m.you)) Achv.unlock('longHaul');
  if (m.fixtures) online.fixtures = m.fixtures;
  const nextIn = m.league?.nextRoundIn ?? m.career?.nextStepIn, endsIn = m.league?.roundEndsIn ?? m.career?.stepEndsIn;
  if (nextIn != null) online.nextRoundAt = performance.now() + nextIn;
  online.roundEndsAt = endsIn != null ? performance.now() + endsIn : null;
  if (m.career) careerAchievementsOnline(m.career, Achv.unlock);
  $('#hubBtn').textContent = m.mode === 'career' ? 'Career' : 'League';
  $('#hubBtn').hidden = !isMulti(m) || !(m.league || m.career) || m.phase === 'lobby' || online.view === 'lobby';
  // Played at leisure: you step away (keeping your seat) rather than leave
  $('#newBtn').textContent = m.pace === 'async' ? 'My games' : 'Leave game';
  renderTicker(m, online.fixtures, online.watching, online.view === 'watch');
  const v = online.view, idle = !ANIMATING.includes(state) && !online.queue.length && !online.overQueued;
  if (v === 'lobby') {
    // A league round (or career step) starting with our game in it: the start message takes over.
    const mine = myFixture(m.fixtures, m.you);
    if (isMulti(m) && m.phase !== 'lobby' && m.phase !== 'over' && !(mine && !mine.over)) return showHub();
    if (m.mode === 'career' && m.phase === 'over') return showHub(); // a career that has stopped
    if (m.phase !== 'playing') showLobby();
    return;
  }
  if (!$('#hub').hidden) refreshHub();
  if (m.mode === 'game') {
    // The game ended while we were disconnected: back to the room.
    if (m.phase !== 'playing' && v === 'game' && idle) showLobby();
    return;
  }
  // League or career: our game (or the one we were watching) finished while we were away
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

// Who's watching our game: a note when someone starts, and a reminder under the scores while they're there
function setWatchers(match, names, announce = true) {
  if (match !== online.watching) return;
  const arrived = names.filter(n => !online.watchers.includes(n));
  online.watchers = names;
  if (announce && arrived.length && online.view === 'game') {
    const who = arrived.length > 1 ? `${arrived.slice(0, -1).join(', ')} and ${arrived.at(-1)} are` : `${arrived[0]} is`;
    toast(`${who} watching your game`, 2200, true);
  }
  renderWatchers();
}
function renderWatchers() {
  refreshEmotes();
  const el = $('#watchers'), names = online?.watchers || [];
  el.hidden = !names.length || online.view !== 'game';
  if (el.hidden) return;
  el.textContent = names.length > 2 ? `${names.length} watching` : `${names.join(' and ')} watching`;
  el.title = names.join(', ');
}

// Emotes: quick faces for everyone in the game, when there's another person to see them
// (a person playing in it, or someone watching)
const EMOJI = { smile: '😊', laugh: '😂', sad: '😢', angry: '😠' };
function hasCompany() {
  if (!online || !game || !['game', 'watch'].includes(online.view)) return false;
  const people = game.players.filter(p => !p.cpu && !p.left && p.seat !== online.seat).length;
  const watchers = online.watchers.length - (online.view === 'watch' ? 1 : 0); // (we're one of them)
  return people + watchers > 0;
}
function refreshEmotes() { showEmotes(hasCompany()); }
function showEmotes(on) {
  $('#emoteBtn').hidden = !on;
  if (!on) setTray(false);
}
function setTray(open) {
  $('#emoteTray').hidden = !open; $('#emoteBtn').setAttribute('aria-expanded', open);
}
$('#emoteBtn').onclick = () => setTray($('#emoteTray').hidden);
$('#emoteTray').onclick = e => {
  const b = e.target.closest('button[data-e]');
  if (!b || !online?.watching) return;
  net.send({ t: 'emote', match: online.watching, e: b.dataset.e });
  setTray(false);
};
// Float someone's emote up the side of the screen, with their name in their colour
function showEmote(m) {
  const p = game?.players.find(q => q.seat === m.seat);
  const el = document.createElement('div');
  el.className = 'emote';
  el.innerHTML = `<span class="face">${EMOJI[m.e]}</span><span class="who"></span>`;
  el.querySelector('.who').textContent = m.seat === online.seat ? 'You' : m.name;
  if (p) el.querySelector('.who').style.color = p.color;
  el.style.left = `${8 + Math.random() * 14}%`;
  $('#emoteFeed').append(el);
  setTimeout(() => el.remove(), 2600);
}

// Push notifications: offered on My games, and in rooms played at leisure (where you're often away)
let pushNow = null; // the last known state (see push.js)
const PUSH_TEXT = {
  off: 'Get a notification when it’s your turn.',
  on: 'Notifications are on for this device.',
  blocked: 'Notifications are blocked for this site in your browser’s settings.',
  homescreen: 'For notifications on an iPhone or iPad, add Milkky to your Home Screen (Share, then Add to Home Screen) and open it from there.',
};
function renderPush() {
  document.querySelectorAll('[data-push]').forEach(el => {
    const inRoom = el.dataset.push === 'room';
    // In a room only when it's played at leisure, and only to suggest turning them on
    el.hidden = !pushNow || pushNow === 'unavailable' || (inRoom && (online?.room?.pace !== 'async' || pushNow === 'on'));
    if (el.hidden) return;
    const btn = pushNow === 'off' ? '<button class="primary" data-push-act="on">Notify me</button>'
      : pushNow === 'on' ? '<button data-push-act="off">Turn off</button>' : '';
    el.innerHTML = `<span>${PUSH_TEXT[pushNow]}</span>${btn}`;
  });
}
async function updatePush() { pushNow = await Push.pushState(); renderPush(); }
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-push-act]');
  if (!b) return;
  b.disabled = true;
  try { pushNow = b.dataset.pushAct === 'on' ? await Push.turnOn() : await Push.turnOff(); }
  catch (err) { toast('Couldn’t turn on notifications here', 2500); }
  if (pushNow === 'on' && b.dataset.pushAct === 'on') toast('Notifications on', 1500);
  renderPush();
});

// Lobby
function showLobby() {
  online.view = 'lobby'; online.overQueued = false; state = 'menu'; renderWatchers();
  ['#over', '#online', '#setup', '#hub'].forEach(s => $(s).hidden = true);
  $('#hubBtn').hidden = true;
  renderLobby(); $('#lobby').hidden = false;
  updatePush();
}
function renderLobby() {
  const r = online.room;
  if (!r) return;
  const host = r.you === r.host, league = r.mode === 'league', career = r.mode === 'career', n = r.seats.length;
  $('#lbTitle').textContent = `Room ${r.code}`;
  $('#lbLink').textContent = shareLink(r.code);
  $('#lbMode').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.mode === r.mode); b.disabled = !host; });
  const rounds = n + (n % 2) - 1;
  $('#lbModeNote').textContent = league
    ? `Everyone plays everyone once. Each round's games are played at the same time, and you can watch the others when yours is done.${n >= 2 ? ` ${n} players: ${rounds} round${rounds > 1 ? 's' : ''}.` : ''}`
    : career ? 'Start together in the Sunday League, with computer players, and work your way up to the Premier League. There’s a cup too, and it goes on season after season. People can join any time and start the next season.'
    : '';
  const slow = r.pace === 'async';
  // A career is always at your own pace
  ['#lbPaceLabel', '#lbPace'].forEach(sel => $(sel).hidden = career);
  $('#lbPace').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', b.dataset.pace === r.pace); b.disabled = !host; });
  $('#lbPaceNote').textContent = career ? 'Played at your own pace: each round lasts up to a day, and moves on as soon as its games are done. Bots finish any games still going at the deadline.'
    : !slow ? 'Everyone plays together now.'
    : league ? 'Play your turns whenever suits you, over days. Each round lasts up to a day, and moves on as soon as its games are done. Bots finish any games still going at the deadline.'
    : 'Play your turns whenever suits you, over days. If a turn waits two days, a bot plays it.';
  $('#lbTarget').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', +b.dataset.t === r.target); b.disabled = !host; });
  // Played at leisure, people are often away; that's not worth marking.
  const away = s => !s.connected && !slow;
  $('#lbSeats').innerHTML = r.seats.map((s, i) => `
    <div class="slot ${away(s) ? 'away' : ''}"><span>${s.bot ? faceSVG(s.bot, 22) : `<i class="sw" style="background:${s.color}"></i>`}${esc(s.name)}
      ${i === r.you ? '<small>(you)</small>' : ''}${i === r.host ? '<small>· host</small>' : ''}${s.cpu ? `<small>· ${s.cpu}</small>` : ''}${away(s) ? '<small>· away</small>' : ''}</span>
      ${host && s.cpu ? `<button data-rm="${i}" aria-label="Remove ${esc(s.name)}">Remove</button>` : ''}</div>`).join('');
  $('#lbAdd').hidden = !host || n >= r.maxSeats || career;
  $('#lbStart').hidden = !host;
  $('#lbStart').textContent = league ? 'Start league' : career ? 'Start career' : 'Start game';
  $('#lbStart').disabled = n < (career ? 1 : 2);
  renderPush(); // (the pace may have changed)
  $('#lbWait').textContent = !host ? `Waiting for the host to start the ${league ? 'league' : career ? 'career' : 'game'}.`
    : career ? 'Start when you like. Anyone who joins later starts at the beginning of the next season.'
    : n < 2 ? 'Share the link, or add a computer player, to start.'
    : slow ? 'Start when everyone’s in. You can close this and come back: it’s in My games.' : '';
}

// League screen. As the main view (between our games), or peeked at over the game we're playing or watching.
function showHub() {
  online.view = 'hub'; online.overQueued = false; state = 'menu'; cpu = null; aimLine.visible = false;
  online.turnEndsAt = null; renderWatchers();
  ['#over', '#online', '#setup', '#lobby', '#careerStats'].forEach(s => $(s).hidden = true);
  refreshHub(); $('#hub').hidden = false;
  updatePush();
}
function peekHub() { refreshHub(); $('#hub').hidden = false; }
// Our game's worm, kept for the league screen once it's over
function noteWorm(match) {
  if (match === online.myMatch) online.lastWorm = { match, html: gameWorm(game) };
}
function renderHubWorm() {
  const mine = myFixture(online.fixtures, online.seat), w = online.lastWorm;
  const show = !!(mine?.over && w?.match === mine.id && w.html);
  $('#hubWormWrap').hidden = !show;
  if (show) $('#hubWorm').innerHTML = w.html;
}
function refreshHub() {
  if (online) renderHubWorm();
  if (online?.room?.career) {
    const r = online.room, now = performance.now();
    return renderCareerHub({ room: r, fixtures: online.fixtures, you: online.seat, view: online.view, watching: online.watching, tier: online.careerTier ?? null,
      msToNext: r.phase === 'between' && online.nextRoundAt ? Math.max(0, online.nextRoundAt - now) : null,
      stepLeft: online.roundEndsAt ? Math.max(0, online.roundEndsAt - now) : null });
  }
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
    else if (m.t === 'start') {
      if (!holdNewRound()) onlineSync(m);
      else { // take the new game's messages out of the queue too
        hold([m, ...online.queue.filter(x => x.match === m.match)]);
        online.queue = online.queue.filter(x => x.match !== m.match);
      }
    }
  }
}
// A turn's time left counts from when it arrives, not when it's shown
function stampTurn(m) { if (m.t === 'turn' && m.deadline != null) m.endsAt = performance.now() + m.deadline; return m; }
// Take-your-time leagues: a new round starting while we're looking at the table doesn't whisk us away.
// We stay put, and go into the new game with Play (its throws so far play back first).
const holdNewRound = () => isAsync() && online.view === 'hub';
function hold(msgs) {
  online.held = msgs;
  refreshHub();
  const r = online.room, round = r?.career ? Career.stepName(r.career.state) : `Round ${r?.league?.round ?? ''}`;
  toast(`${round} has started. Tap Play when you’re ready.`, 3500, true);
}
function playHeld() {
  const [start, ...rest] = online.held;
  online.held = null; online.watching = start.match;
  onlineSync(start);
  online.queue.push(...rest);
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
document.addEventListener('visibilitychange', () => {
  if (mode !== 'online' || !online) return;
  if (document.hidden) catchUp();
  net.send({ t: 'visible', visible: !document.hidden }); // the server only notifies people who aren't looking
});
function applyGame(g) {
  game.players = g.players.map(p => ({ ...p }));
  game.log = g.log || [];
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
  ['#lobby', '#over', '#online', '#setup', '#league', '#hub', '#careerStats'].forEach(s => $(s).hidden = true);
  online.view = m.match === online.myMatch ? 'game' : 'watch';
  online.watchers = []; setWatchers(m.match, m.watchers || [], false);
  online.play = online.pending = null; online.overQueued = false; online.turnEndsAt = null;
  tween = null; cpu = null; aimLine.visible = false; landRing.visible = false; dragging = false;
  physics.removeStick();
  clearMilk(bottles); bottles.forEach(p => p.label.material.color.set(0xffffff));
  applyGame(m.game); snapPoses(m.poses); setStickHeld();
  if (m.over) noteWorm(m.match);
  // Achievements count in our own game; joining partway (a rejoin) doesn't count as the opening throw
  if (online.view === 'game') Achv.gameStarted(game.players.map((p, i) => isMe(i)), { midway: m.t === 'sync' }); else Achv.gameLeft();
  state = 'remote'; renderBoard(); refreshEmotes();
  $('#hubBtn').hidden = !isMulti(online.room);
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
  const p = game.players[m.seat];
  online.throwFrom = { before: bottlePlaces(), scoreBefore: p?.score ?? 0, missesBefore: p?.misses ?? 0 };
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
  if (m.over) noteWorm(m.match);
  if (online.view === 'game') { // our own game (not one we're watching)
    const f = online.throwFrom;
    Achv.thrown({ who: m.seat, fallen: m.fallen, hit: m.hit, needle: m.needle, before: f.before, release: RELEASE, target: game.target,
      players: game.players, scoreBefore: f.scoreBefore, missesBefore: f.missesBefore, winner: m.game.winner, over: m.over });
    if (m.over && game.players.some((p, i) => !p.cpu && !isMe(i))) Achv.unlock('goodCompany');
  }
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
  if (m.over) return isMulti(online.room) ? showHub() : showOver();
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
  else if (act === 'stats') { // an online career: your stats, kept by the server
    const cs = online.room.career;
    showCareerStats(cs.stats, cs.state.season, '#hub', id => cs.people[id]?.name ?? botById(id)?.name ?? 'Someone who left');
  }
  else if (act === 'leave') {
    const sure = online.room.phase === 'over' || confirm(online.room.mode === 'career'
      ? 'Leave the career? The computer will play your games until the end of the season, then a computer player takes your place.'
      : 'Leave the league? The computer will play your remaining games.');
    if (sure) leaveOnline();
  }
});
// Career: which league's table to show
$('#hcTiers').addEventListener('click', e => { const b = e.target.closest('button[data-tier]'); if (b) { online.careerTier = +b.dataset.tier; refreshHub(); } });
$('#hubLive').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b?.dataset.act === 'watch') watchMatch(b.dataset.match);
  if (b?.dataset.act === 'play') { // into our own game
    if (online.held?.[0].match === b.dataset.match) playHeld(); // a new round we've been holding
    else { online.watching = b.dataset.match; net.send({ t: 'watch', match: b.dataset.match }); }
  }
});
$('#lbPace').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) net.send({ t: 'pace', pace: b.dataset.pace }); });

// ---------- My games ----------
// Every room you have a seat in (live or at leisure), from the server, by your player key.
async function openMine() {
  ['#setup', '#online', '#over', '#league'].forEach(s => $(s).hidden = true);
  $('#mineSub').textContent = 'Loading…'; $('#mineList').innerHTML = '';
  $('#mineLink').textContent = personalLink();
  $('#mine').hidden = false;
  updatePush();
  try { renderMine(await fetchMine()); }
  catch (e) { $('#mineSub').textContent = 'Can’t reach the game server just now. Try again in a moment.'; }
}
const personalLink = () => { const u = new URL(location.href); u.search = ''; u.searchParams.set('me', myKey()); return u.href; };
function mineStatus(g) {
  const m = g.match, lg = g.league;
  if (g.phase === 'lobby') return g.host ? 'Waiting for you to start it' : 'Waiting for the host to start';
  if (g.phase === 'over') return lg ? `Finished · you came ${ordinal(lg.place)}` : g.career ? 'Stopped' : 'Finished';
  if (g.career?.waiting) return 'Waiting for the next season to start';
  if (m?.yourTurn) return `Your turn${m.unseen ? ` · ${m.unseen} new throw${m.unseen > 1 ? 's' : ''} to watch` : ''}`;
  if (m && !m.over) return `Waiting for ${m.turnOf}`;
  if (g.phase === 'between') return g.career?.step >= g.career?.steps ? 'Season over · the next one starts soon' : 'The next round starts soon';
  return 'Your game is done · waiting for the round to finish';
}
function renderMine(games) {
  const rank = g => g.match?.yourTurn ? 0 : g.phase === 'lobby' && g.host ? 1 : g.phase !== 'over' ? 2 : 3;
  games.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const turns = games.filter(g => g.match?.yourTurn).length;
  $('#mineSub').textContent = !games.length ? '' : turns ? `It’s your turn in ${turns} game${turns > 1 ? 's' : ''}.` : 'Nothing waiting for you right now.';
  $('#mineList').innerHTML = games.map(g => {
    const lg = g.league, m = g.match;
    const cr = g.career;
    const what = g.mode === 'league'
      ? `League${lg ? ` · round ${lg.round} of ${lg.rounds}` : ''}${g.pace === 'async' ? '' : ' · live'}`
      : g.mode === 'career' ? `Career${cr ? ` · season ${cr.season}${cr.waiting ? '' : ` · ${Career.tierName(cr.tier)}, ${ordinal(cr.place)}`}` : ''}`
      : `Game with ${g.players.filter(n => n !== g.you).map(esc).join(', ') || 'nobody yet'}`;
    const score = m && g.phase !== 'lobby' ? ` · ${m.players.map(p => `${esc(p.name)} ${p.score}`).join(', ')}` : '';
    const ends = lg?.roundEndsIn ? ` · round ends in ${timeLeft(lg.roundEndsIn)}` : cr?.stepEndsIn && m && !m.over ? ` · round ends in ${timeLeft(cr.stepEndsIn)}` : m?.deadline ? ` · ${timeLeft(m.deadline)} left` : '';
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
  Push.refresh(); // keep the server's record of this device's notifications up to date
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

// ---------- Training ----------
// Ten throws of practice, chosen from the Training menu:
//   target: the bottles are cleared away and a target appears on the lawn; scored on how close the stick lands
//   lateral: one bottle as far away as the back row, moved left and right; scored on left/right only
//   length: one bottle straight ahead, moved nearer and further; scored on long/short only
//   strike: the full starting rack every throw; scored on how many bottles go over
const TRAIN_THROWS = 10;
// Your personal best in a mode: its total, and (for bests set since the worm) each throw's points
function readBest(kind) {
  const key = TRAINING[kind].best;
  let total = 0, throws = null;
  try {
    total = +localStorage.getItem(key) || 0;
    const t = JSON.parse(localStorage.getItem(key + '-throws'));
    if (Array.isArray(t) && t.length === TRAIN_THROWS && t.reduce((s, x) => s + x, 0) === total) throws = t;
  } catch (e) {}
  return { total, throws };
}
function saveBest(kind, total, throws) {
  try { localStorage.setItem(TRAINING[kind].best, total); localStorage.setItem(TRAINING[kind].best + '-throws', JSON.stringify(throws)); } catch (e) {}
}
const TRAINING = {
  target: { name: 'Target Practice', short: 'Target', view: 'Look at target', best: 'milkky-training-best' },
  lateral: { name: 'Lateral Training', short: 'Lateral', view: 'Look at bottle', best: 'milkky-training-best-lateral' },
  length: { name: 'Length Training', short: 'Length', view: 'Look at bottle', best: 'milkky-training-best-length' },
  strike: { name: 'Strike Training', short: 'Strike', view: 'Look at bottles', best: 'milkky-training-best-strike' },
};
// training: { kind, throws: [...], target: where to aim, land: where the stick first touched down, bottle (lateral/length) }
// Each throw: { pts, d } plus { long, side } (target), { err, hit } (lateral/length), or { fallen } (strike)
let training = null;
const targetMesh = (() => {
  // Red and white rings, 10 cm apart, 1 m across
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  [[128, '#c0392b'], [102, '#fbf6ea'], [77, '#c0392b'], [51, '#fbf6ea'], [26, '#c0392b']].forEach(([r, col]) => {
    g.fillStyle = col; g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.fill();
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, transparent: true }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true; m.visible = false; scene.add(m);
  return m;
})();
// Out of 10: full marks within 10 cm, falling away to nothing at 50 cm (the target's edge)
const TARGET_R = 0.5, BULL_R = 0.1;
const trainPoints = d => Math.round(10 * THREE.MathUtils.clamp((TARGET_R - d) / (TARGET_R - BULL_R), 0, 1));
const distText = d => d < 1 ? `${Math.round(d * 100)} cm` : `${d.toFixed(2)} m`;
const trainTotal = () => training.throws.reduce((s, t) => s + t.pts, 0);
const trainMax = kind => TRAIN_THROWS * (kind === 'strike' ? 12 : 10);
// Aim (left/right) and length (long/short) marked separately, each throw out of 10 like the points
const partScore = errs => errs.reduce((s, e) => s + trainPoints(Math.abs(e)), 0);
const meanAbs = errs => errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
// Which way you tend to miss, if there's a clear pattern (more than 10 cm on average)
function tendency(errs, plus, minus) {
  const bias = errs.reduce((s, e) => s + e, 0) / errs.length;
  return Math.abs(bias) < 0.1 ? 'no clear bias' : `tends ${bias > 0 ? plus : minus}`;
}
const sideText = e => `${distText(Math.abs(e))} ${e >= 0 ? 'right' : 'left'}`;
const longText = e => `${distText(Math.abs(e))} ${e >= 0 ? 'long' : 'short'}`;
// Mostly near the middle of [lo, hi], now and then out towards the edges
const middling = (lo, hi) => lo + (hi - lo) * (Math.random() + Math.random() + Math.random()) / 3;
// The back row's distance, and the bottle used for lateral and length training (the middle of the back row)
const BACK_DIST = RELEASE.z - (FRONT_Z - 3 * ROW);
const trainBottle = () => bottles.find(p => p.num === 9);
// How a throw missed the spot aimed at, seen from where you throw: how much further (+) or shorter it went,
// and how far right (+) or left its direction was, measured at the spot's distance (so a short throw in the
// wrong direction still shows how far off the aim was)
function missFrom(spot, l) {
  const polar = p => ({ a: Math.atan2(p.x - RELEASE.x, RELEASE.z - p.z), d: Math.hypot(p.x - RELEASE.x, p.z - RELEASE.z) });
  const s = polar(spot), t = polar(l);
  return { long: t.d - s.d, side: (t.a - s.a) * s.d };
}

// Park the bottles out of sight (behind you, still on the lawn), or bring them back
function bottlesAway(away) {
  if (!away) return resetBottles();
  bottles.forEach((p, i) => {
    physics.placeUpright(p.body, 20 + (i % 4) * 0.3, 24 + Math.floor(i / 4) * 0.3);
    p.mesh.visible = p.label.visible = false;
  });
}
function openTrainingMenu() {
  ['#setup', '#trainOver'].forEach(s => $(s).hidden = true);
  for (const kind of Object.keys(TRAINING)) {
    const best = readBest(kind).total;
    $(`#trBest-${kind}`).textContent = best ? `Best ${best} / ${trainMax(kind)}` : '';
  }
  $('#trainMenu').hidden = false;
}
function startTraining(kind) {
  mode = 'training'; leagueMatch = null; cpu = null; tween = null; physicsOn = true;
  ['#setup', '#over', '#league', '#trainOver', '#trainMenu'].forEach(s => $(s).hidden = true);
  physics.removeStick(); clearMilk(bottles); bottlesAway(true);
  const pb = readBest(kind); // your personal best in this mode, shown while you play and on the worm after
  training = { kind, throws: [], target: V(0, 0, 0), land: null, best: pb.total, bestThrows: pb.throws };
  nextTarget();
}
function nextTarget() {
  if (training.throws.length >= TRAIN_THROWS) return showTrainingResult();
  const kind = training.kind, tg = training.target;
  physics.removeStick(); clearMilk(bottles);
  targetMesh.visible = false;
  if (kind === 'target') {
    // Anywhere you can reach, but mostly around the middle: 2.5 to 6.5 m out, up to 0.35 rad either side
    const a = middling(-0.35, 0.35), d = middling(2.5, 6.5);
    tg.set(RELEASE.x + Math.sin(a) * d, 0, RELEASE.z - Math.cos(a) * d);
    targetMesh.position.set(tg.x, 0.002, tg.z); targetMesh.visible = true;
  } else if (kind === 'strike') {
    resetBottles();
  } else {
    // One bottle: as far as the back row but moved sideways, or straight ahead at a new distance
    tg.set(kind === 'lateral' ? middling(-1.5, 1.5) : 0, 0, kind === 'lateral' ? FRONT_Z - 3 * ROW : RELEASE.z - middling(2, 7));
    const p = trainBottle();
    physics.placeUpright(p.body, tg.x, tg.z);
    p.mesh.visible = p.label.visible = true; p.label.material.color.set(0xffffff);
  }
  training.land = null; landRing.visible = false;
  setStickHeld();
  viewBottles = false; $('#viewBtn').textContent = TRAINING[kind].view;
  state = 'aim'; renderTraining();
  throwTip();
}
function renderTraining() {
  const n = training.throws.length, kind = training.kind, total = trainTotal(), best = training.best;
  // Your score and average per throw, your personal best and its average, and (like a cricket chase's required
  // run rate) the average you need from the throws left to beat it: shown as "10+" in red once it's out of reach
  const perThrow = kind === 'strike' ? 12 : 10, left = TRAIN_THROWS - n, need = best - total + 1;
  const avg = x => x.toFixed(1);
  const rate = need / Math.max(1, left);
  const chase = !best ? '' : !left && total <= best // the round's over and it wasn't beaten
    ? `<div class="chip"><div class="nm">To beat it</div><div class="sc over">✗</div><div class="tsub">${need} short</div></div>`
    : total > best
    ? '<div class="chip"><div class="nm">To beat it</div><div class="sc">✓</div><div class="tsub">New best!</div></div>'
    : `<div class="chip"><div class="nm">To beat it</div>
      <div class="sc ${rate > perThrow ? 'over' : ''}">${rate > perThrow ? `${perThrow}+` : avg(rate)}<small> a throw</small></div>
      <div class="tsub">${need} from ${left}</div></div>`;
  $('#board').innerHTML = `<div class="chip active"><div class="nm">${TRAINING[kind].short}</div>
    <div class="sc">${total}<small> ${kind !== 'strike' ? 'pts' : total === 1 ? 'bottle' : 'bottles'}</small></div>
    <div class="tsub">${Math.min(n + 1, TRAIN_THROWS)}/${TRAIN_THROWS} · avg ${n ? avg(total / n) : '–'}</div></div>
    <div class="chip"><div class="nm">Best</div>
    <div class="sc">${best || '–'}<small> / ${trainMax(kind)}</small></div>
    <div class="tsub">${best ? `avg ${avg(best / TRAIN_THROWS)}` : 'Set one now'}</div></div>${chase}`;
}
// The stick has come to rest: score the throw
function resolveTraining() {
  const kind = training.kind;
  const t = physics.stick?.translation(), l = training.land || (t && { x: t.x, z: t.z }) || { x: 99, z: 99 };
  let throwRec, msg;
  if (kind === 'strike') {
    const fallen = physics.fallenBottles();
    fallen.forEach(b => bottles.find(p => p.num === b.num)?.label.material.color.set(0xff6b5b));
    throwRec = { pts: fallen.length, fallen: fallen.length };
    msg = fallen.length === 12 ? 'Strike! All 12' : `${fallen.length} bottle${fallen.length === 1 ? '' : 's'}`;
  } else if (kind === 'target') {
    const d = Math.hypot(l.x - training.target.x, l.z - training.target.z);
    throwRec = { d, pts: trainPoints(d), ...missFrom(training.target, l) };
    msg = `+${throwRec.pts} · ${distText(d)} away`;
  } else {
    // Only one direction counts. Hitting the bottle counts as spot on.
    const hit = !!physics.firstHit, m = missFrom(training.target, l);
    const err = hit ? 0 : kind === 'lateral' ? m.side : m.long;
    throwRec = { err, hit, d: Math.abs(err), pts: trainPoints(Math.abs(err)) };
    msg = `+${throwRec.pts} · ${hit ? 'Hit!' : kind === 'lateral' ? sideText(err) : longText(err)}`;
  }
  training.throws.push(throwRec);
  toast(msg, 2200);
  renderTraining();
  state = 'scoring'; phaseT = 0;
}
function showTrainingResult() {
  state = 'over';
  const kind = training.kind, ts = training.throws, total = trainTotal(), max = trainMax(kind);
  const prev = training.best;
  if (total > prev) saveBest(kind, total, ts.map(t => t.pts));
  $('#trWormLabel').textContent = prev ? 'Against your personal best' : 'This round';
  $('#trWorm').innerHTML = trainingWorm(ts.map(t => t.pts), prev, training.bestThrows, max);
  $('#trTitle').textContent = total > prev && prev ? 'New personal best!' : `${TRAINING[kind].name} complete`;
  const stat = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
  const part = (label, errs, plus, minus) => `<div><span>${label}</span><b>${partScore(errs)}<small> / ${TRAIN_THROWS * 10}</small></b>
    <em>${distText(meanAbs(errs))} off on average, ${tendency(errs, plus, minus)}</em></div>`;
  const row = (i, what, detail, pts) => `<div><span>${i + 1}</span><span>${what}${detail ? `<em>${detail}</em>` : ''}</span><b>+${pts}</b></div>`;
  let rating, stats, parts = '', rows;
  if (kind === 'strike') {
    const avg = total / ts.length, best = Math.max(...ts.map(t => t.fallen));
    rating = avg >= 9 ? 'Demolition expert!' : avg >= 6 ? 'Solid hitting.' : avg >= 3 ? 'Getting there.'
      : 'Keep practising: aim for the middle of the front of the rack.';
    stats = stat('Bottles', `${total} / ${max}`) + stat('Average per throw', avg.toFixed(1))
      + stat('Best throw', `${best} bottle${best === 1 ? '' : 's'}`) + stat('Personal best', `${Math.max(total, prev)} / ${max}`);
    rows = ts.map((t, i) => row(i, `${t.fallen} bottle${t.fallen === 1 ? '' : 's'}`, t.fallen === 12 ? 'strike' : '', t.pts));
  } else {
    const avg = ts.reduce((s, t) => s + t.d, 0) / ts.length, best = ts.reduce((b, t) => (t.d < b.d ? t : b));
    rating = avg < 0.15 ? 'Sharpshooter! Barely a stick’s width off.' : avg < 0.35 ? 'A steady hand.'
      : avg < 0.7 ? 'Getting there.' : 'Keep practising: watch where the stick lands and adjust your flick.';
    const avgLabel = { target: 'Average distance', lateral: 'Average left / right miss', length: 'Average long / short miss' }[kind];
    stats = stat('Points', `${total} / ${max}`) + stat(avgLabel, distText(avg))
      + stat('Best throw', best.hit ? 'Hit (+10)' : `${distText(best.d)} (+${best.pts})`) + stat('Personal best', `${Math.max(total, prev)} / ${max}`);
    if (kind === 'target') {
      parts = part('Aim (left / right)', ts.map(t => t.side), 'right', 'left') + part('Length (long / short)', ts.map(t => t.long), 'long', 'short');
      rows = ts.map((t, i) => row(i, distText(t.d), `${sideText(t.side)}, ${longText(t.long)}`, t.pts));
    } else {
      const errs = ts.filter(t => !t.hit).map(t => t.err), hits = ts.filter(t => t.hit).length;
      const [plus, minus] = kind === 'lateral' ? ['right', 'left'] : ['long', 'short'];
      parts = `<div><span>Hits</span><b>${hits}<small> / ${TRAIN_THROWS}</small></b></div>`
        + `<div><span>Misses</span><b>${errs.length}</b><em>${errs.length ? tendency(errs, plus, minus) : 'none at all!'}</em></div>`;
      rows = ts.map((t, i) => row(i, t.hit ? 'Hit' : kind === 'lateral' ? sideText(t.err) : longText(t.err), '', t.pts));
    }
  }
  $('#trRating').textContent = rating;
  $('#trStats').innerHTML = stats;
  $('#trParts').innerHTML = parts; $('#trParts').hidden = !parts;
  $('#trThrows').innerHTML = rows.join('');
  $('#trainOver').hidden = false;
}
// Running totals, throw by throw: this round, and your best (its own throws, or a straight line at its average
// pace for a best set before throws were kept)
function trainingWorm(pts, best, bestThrows, max) {
  const running = list => { let s = 0; return list.map(p => ({ y: s += p, miss: !p })); };
  const series = [{ name: 'This round', color: '#1f4e8c', points: running(pts) }];
  if (bestThrows) series.push({ name: `Personal best (${best})`, color: '#d4a017', points: running(bestThrows) });
  else if (best) series.push({ name: `Personal best (${best}), at its average pace`, color: '#d4a017', dashed: true,
    points: Array.from({ length: TRAIN_THROWS }, (_, i) => ({ y: best * (i + 1) / TRAIN_THROWS })) });
  // Scaled to just above whichever finished higher, so low totals aren't squashed flat
  const top = Math.max(10, best, pts.reduce((s, p) => s + p, 0));
  return wormHTML(series, { max: Math.min(max, Math.ceil(top * 1.1 / 10) * 10), yLabel: 'Total' });
}
function exitTraining() {
  training = null; targetMesh.visible = false; landRing.visible = false;
  physics.removeStick(); clearMilk(bottles); bottlesAway(false); setStickHeld();
  $('#board').innerHTML = ''; $('#viewBtn').textContent = 'Look at bottles'; $('#trainOver').hidden = true;
  mode = 'quick'; state = 'menu';
}
$('#trainBtn').onclick = openTrainingMenu;
for (const kind of Object.keys(TRAINING)) $(`#tr-${kind}`).onclick = () => startTraining(kind);
$('#trainBack').onclick = () => { $('#trainMenu').hidden = true; $('#setup').hidden = false; };
$('#trAgain').onclick = () => startTraining(training.kind);
$('#trMenu').onclick = () => { exitTraining(); openTrainingMenu(); };

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
  if (follow) { const c = training && training.kind !== 'strike' ? training.target.clone() : bottleCentre(); tp = c.clone().add(V(0, 0.8, 1.4)); tl = c.clone().add(V(0, 0.02, -0.1)); }
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
      if ((calm > 0.6 && flyTime > 0.8) || flyTime > 12) (training ? resolveTraining : resolveThrow)();
    }
  } else if (state === 'scoring') {
    phaseT += dt; if (phaseT > (training ? 1.8 : 1.3)) (training ? nextTarget : startRestand)();
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
      if (training) training.land = { x: t.x, z: t.z };
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
// The Career stats screen, over the screen it was opened from (solo Career Mode's, or an online career's)
let statsFrom = '#league';
function showCareerStats(s, season, from, nameOf) {
  const seasons = s ? season - s.since + 1 : 0;
  $('#csSub').textContent = s?.games ? `Your career${s.since > 1 ? ` since season ${s.since}` : ''}: ${s.games} game${s.games > 1 ? 's' : ''} over ${seasons} season${seasons > 1 ? 's' : ''}.` : '';
  $('#csBody').innerHTML = Stats.renderStats(s, nameOf);
  statsFrom = from;
  $(from).hidden = true; $('#careerStats').hidden = false;
}
$('#lgStats').onclick = () => showCareerStats(solo().stats, solo().season, '#league');
$('#csBack').onclick = () => { $('#careerStats').hidden = true; $(statsFrom).hidden = false; };
$('#lgReset').onclick = () => { if (confirm('Start a new career from the Sunday League? Your career so far will be lost.')) openNewLeague(); };
$('#lgLength').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setLength(+b.dataset.t); });
$('#lgCreate').onclick = () => { League.newCareer(newLength); openLeague(); };
// Back: to the league you have (choosing Start over doesn't lose it until you start the new one), or the menu
$('#lgNewBack').onclick = () => { if (solo()) openLeague(); else { $('#lgNew').hidden = true; $('#setup').hidden = false; } };
$('#onlineBtn').onclick = () => openOnline();

// ---------- Achievements ----------
const TROPHY = (locked = false, size = 34) => { const [fill, ink] = locked ? ['#c9c4b8', '#8a8578'] : ['#f2c230', '#8a6a10'];
  return `<svg class="trophy" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><path d="M12 6h16v8a8 8 0 0 1-16 0z" fill="${fill}" stroke="${ink}" stroke-width="2"/>
    <path d="M12 9H6c0 6 3 9 7 9M28 9h6c0 6-3 9-7 9" fill="none" stroke="${ink}" stroke-width="2"/><rect x="18" y="22" width="4" height="7" fill="${fill}" stroke="${ink}" stroke-width="2"/>
    <rect x="12" y="29" width="16" height="5" rx="1" fill="${fill}" stroke="${ink}" stroke-width="2"/></svg>`; };
// Unlock pop-ups, one after another
const achvQueue = [];
let achvShowing = false;
function nextAchievement() {
  const a = achvQueue.shift(), el = $('#achvPop');
  if (!a) { achvShowing = false; return; }
  achvShowing = true;
  el.innerHTML = `${TROPHY()}<span class="t"><small>Achievement unlocked</small><b>${esc(a.name)}</b><span class="d">${esc(a.desc)}</span></span>`;
  el.classList.add('show');
  setTimeout(() => { el.classList.remove('show'); setTimeout(nextAchievement, 400); }, 3800);
}
Achv.onUnlocked(a => { achvQueue.push(a); if (!achvShowing) nextAchievement(); refreshAchBtn(); });
function refreshAchBtn() { $('#achBtn').innerHTML = `${TROPHY(false, 22)}Achievements · ${Achv.count()}/${Achv.ACHIEVEMENTS.length}`; }
// Locked achievements stay a mystery: a padlock and question marks until you earn them
const LOCK = `<svg class="lock" viewBox="0 0 40 40" aria-hidden="true"><rect x="9" y="18" width="22" height="16" rx="3" fill="#c9c4b8" stroke="#8a8578" stroke-width="2"/><path d="M14 18v-5a6 6 0 0 1 12 0v5" fill="none" stroke="#8a8578" stroke-width="2.5"/><circle cx="20" cy="26" r="2.2" fill="#8a8578"/></svg>`;
function openAchievements() {
  const got = Achv.unlocked(), when = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  $('#achvSub').textContent = `${Achv.count()} of ${Achv.ACHIEVEMENTS.length} unlocked.`;
  $('#achvList').innerHTML = Achv.GROUPS.map(g => `<div class="sectionlabel">${g}</div>` + Achv.ACHIEVEMENTS.filter(a => a.group === g).map(a =>
    got[a.id]
      ? `<div class="ach">${TROPHY(false, 30)}<span class="t"><b>${esc(a.name)}</b><span class="d">${esc(a.desc)}</span></span><time>${when(got[a.id])}</time></div>`
      : `<div class="ach locked" aria-label="Locked achievement">${LOCK}<span class="t"><b>???</b><span class="d">Locked</span></span></div>`).join('')).join('');
  $('#setup').hidden = true; $('#achv').hidden = false;
}
$('#achBtn').onclick = openAchievements;
$('#achvBack').onclick = () => { $('#achv').hidden = true; $('#setup').hidden = false; };
refreshAchBtn();
$('#overNew').onclick = () => {
  if (mode === 'online') return leaveOnline();
  $('#over').hidden = true; $('#setup').hidden = false; state = 'menu';
};
$('#newBtn').onclick = () => {
  if (training) exitTraining();
  if (mode === 'online' && isAsync()) return stepAway(); // your seat is kept; carry on later from My games
  if (mode === 'online') { if (confirm('Leave this online game?')) leaveOnline(); return; }
  mode = 'quick'; leagueMatch = null; cpu = null; aimLine.visible = false; physics.removeStick(); resetBottles(); physicsOn = true; tween = null; state = 'menu'; $('#setup').hidden = false;
};
$('#helpBtn').onclick = () => $('#rules').hidden = false;
$('#setupRules').onclick = () => $('#rules').hidden = false;
$('#rulesClose').onclick = () => $('#rules').hidden = true;
$('#viewBtn').onclick = () => {
  viewBottles = !viewBottles;
  $('#viewBtn').textContent = viewBottles ? 'Back to throw view' : training ? TRAINING[training.kind].view : 'Look at bottles';
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
