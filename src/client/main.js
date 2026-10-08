// Local play: turn flow, input, camera, menus and the render loop.
import * as THREE from 'three';
import { BOTTLE_HALF, STICK_HALF, FRONT_Z, ROW, RELEASE, COLORS, AIM_LIMIT, MIN_DIST, MAX_DIST } from '../shared/constants.js';
import { createPhysics, launchSpeedFor } from '../shared/physics.js';
import { createPlayers, newPlayer, scoreThrow, isGameOver, advanceTurn, planRestand, verb } from '../shared/rules.js';
import { computeInfo, planCpuThrow } from '../shared/ai.js';
import { app, renderer, canvas, scene, camera } from './scene.js';
import { decorateBottles, stickMesh, hand, aimGeo, aimLine, landRing } from './models.js';
import { clearMilk, updateMilk } from './milk.js';
import * as League from './league.js';

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
let mode = 'quick', leagueMatch = null;

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
  const need = game.target - p.score;
  $('#turn').innerHTML = `<b style="color:${p.color}">${p.name}</b>${p.name === 'You' ? '' : "'s turn"} · ${p.score} points, ${need} to go`;
  if (p.cpu) cpuPlan(p);
}
function renderBoard() {
  $('#board').innerHTML = game.players.map((p, i) => `
    <div class="chip ${i === game.cur && state !== 'over' ? 'active' : ''} ${p.out ? 'out' : ''}">
      <div class="nm"><span class="sw" style="background:${p.color}"></span>${p.name}</div>
      <div class="sc">${p.score}<small>/${game.target}</small></div>
      <div class="dots">${[0, 1, 2].map(k => `<i class="${k < p.misses ? 'on' : ''}"></i>`).join('')}</div>
    </div>`).join('');
}
let toastTimer;
function toast(msg, ms = 2000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
});
function release(e, cancel) {
  if (!dragging) return;
  dragging = false; aimLine.visible = false;
  if (cancel) { setStickHeld(); return; }
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
  $('#hint').textContent = `Last throw: ${dist.toFixed(1)} m, aim ${Math.abs(Math.round(THREE.MathUtils.radToDeg(curAim)))}° ${curAim < -0.01 ? 'left' : curAim > 0.01 ? 'right' : 'straight'}`;
  throwStick(speed, curAim);
}
canvas.addEventListener('pointerup', e => release(e, false));
canvas.addEventListener('pointercancel', e => release(e, true));

// ---------- Computer players ----------
let cpu = null;
function cpuPlan(pl) {
  cpu = { t: 0, ...planCpuThrow(pl, computeInfo(physics.bottleSpots()), game.target) };
  $('#hint').textContent = `${pl.name} is lining up…`;
}
function cpuTick(dt) {
  cpu.t += dt;
  const t = cpu.t;
  if (t > 0.7 && !aimLine.visible) {
    updateAimLine(cpu.aim); aimLine.visible = true;
    $('#hint').textContent = `${game.players[game.cur].name} is going for bottle ${cpu.target}`;
  }
  if (t > 1.2 && t <= 1.8) setStickHeld((t - 1.2) / 0.6, cpu.aim);
  else if (t > 1.8 && t <= 1.95) setStickHeld(1 - (t - 1.8) / 0.15 * 1.3, cpu.aim);
  else if (t > 1.95) {
    aimLine.visible = false;
    throwStick(launchSpeedFor(cpu.thrownDist), cpu.thrownAim);
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
  const plan = planRestand(poses);
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
  if (isGameOver(game)) return showOver();
  advanceTurn(game);
  beginTurn();
}
function showOver() {
  const { winner } = game;
  state = 'over'; renderBoard();
  $('#overTitle').textContent = winner ? `${winner.name} ${verb(winner, 'wins', 'win')}!` : 'Out after three misses';
  const sorted = [...game.players].sort((a, b) => b.score - a.score);
  $('#standings').innerHTML = sorted.map(p => `<li><span style="color:${p.color};font-weight:600">${p.name}${p.out ? ' (out)' : ''}</span><b>${p.score}</b></li>`).join('');
  $('#againBtn').textContent = mode === 'league' ? 'Continue' : 'Play again';
  $('#overNew').hidden = mode === 'league';
  $('#over').hidden = false;
}

// ---------- League ----------
const dots = sk => '●'.repeat(Math.round(1 + sk * 4)) + '○'.repeat(4 - Math.round(sk * 4));
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
function renderLeague() {
  const { league, lastRound } = League.lg, done = League.seasonDone();
  $('#lgTitle').textContent = `League · season ${league.season} · first to ${League.leagueTarget()}`;
  $('#lgSub').textContent = done ? 'Season complete.' : `Round ${league.round + 1} of ${league.schedule.length}. Win games to climb the table.`;
  $('#lgResultsWrap').hidden = !lastRound;
  if (lastRound) {
    $('#lgResultsLabel').textContent = `Round ${lastRound.round} results`;
    $('#lgResults').innerHTML = lastRound.games.map(g => {
      const A = league.entries[g.a].name, B = league.entries[g.b].name;
      return `<div><span>${g.aw ? `<b>${A}</b>` : A}</span><span>${g.sa}–${g.sb}</span><span style="text-align:right">${g.aw ? B : `<b>${B}</b>`}</span></div>`;
    }).join('');
  }
  $('#lgTable').innerHTML = '<tr><th>#</th><th>Player</th><th>P</th><th>W</th><th>L</th><th>+/−</th></tr>' +
    League.standings().map(({ e }, pos) => `<tr class="${e.human ? 'me' : ''}"><td>${pos + 1}</td><td>${e.name}${e.human ? '' : `<span class="skill" title="Skill">${dots(e.skill)}</span>`}</td>
      <td>${e.P}</td><td>${e.W}</td><td>${e.L}</td><td>${e.PF - e.PA > 0 ? '+' : ''}${e.PF - e.PA}</td></tr>`).join('');
  if (done) {
    const table = League.standings(), champ = table[0].e, myPos = table.findIndex(x => x.e.human) + 1;
    $('#lgNext').innerHTML = champ.human ? '<b>You are the champion!</b>' : `<b>${champ.name}</b> wins the league. You finished ${ordinal(myPos)}.`;
    $('#lgPlay').textContent = 'Next season';
  } else {
    const opp = league.entries[League.myOpponent()];
    $('#lgNext').innerHTML = `Next: <b>You</b> vs <b>${opp.name}</b> <span style="color:var(--muted)">(skill ${dots(opp.skill)})</span>`;
    $('#lgPlay').textContent = 'Play match';
  }
}
function openLeague() {
  if (!League.lg.league) League.newLeague(1, chosenTarget);
  ['#setup', '#over'].forEach(s => $(s).hidden = true);
  state = 'menu'; renderLeague(); $('#league').hidden = false;
}
function playLeagueMatch() {
  const { league } = League.lg;
  if (League.seasonDone()) { chosenTarget = League.leagueTarget(); League.newLeague(league.season + 1, chosenTarget); renderLeague(); return; }
  const oi = League.myOpponent(), opp = league.entries[oi];
  mode = 'league'; leagueMatch = { oi, round: league.round }; game.target = League.leagueTarget();
  game.players = [newPlayer('You', null, COLORS[0]), newPlayer(opp.name, opp.ai, COLORS[1])];
  launch(league.round % 2); // alternate who throws first
}
function finishLeagueMatch() {
  const [me, bot] = game.players;
  League.finishRound(leagueMatch.oi, me.score, bot.score, game.winner === me);
  leagueMatch = null; mode = 'quick';
}
League.loadLeague();

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
  const follow = viewBottles || (state !== 'aim' && state !== 'cpu' && state !== 'menu' && !(state === 'flying' && flyTime < 0.3));
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

let last = performance.now();
const tq = new THREE.Quaternion(), tv = new THREE.Vector3(), IDQ = new THREE.Quaternion();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (physicsOn) physics.advance(dt);
  if (state === 'cpu' && cpu) cpuTick(dt);
  if (state === 'flying') {
    flyTime += dt;
    calm = physics.isMoving() ? 0 : calm + dt;
    if ((calm > 0.6 && flyTime > 0.8) || flyTime > 12) resolveThrow();
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
  if (mode === 'league') { finishLeagueMatch(); openLeague(); }
  else startGame(lastSetup);
};
$('#leagueBtn').onclick = openLeague;
$('#lgPlay').onclick = playLeagueMatch;
$('#lgMenu').onclick = () => { $('#league').hidden = true; $('#setup').hidden = false; };
$('#lgReset').onclick = () => { if (confirm(`Start a new league to ${chosenTarget}? The current table will be lost.`)) { League.newLeague(1, chosenTarget); renderLeague(); } };
$('#overNew').onclick = () => { $('#over').hidden = true; $('#setup').hidden = false; state = 'menu'; };
$('#newBtn').onclick = () => { mode = 'quick'; leagueMatch = null; cpu = null; aimLine.visible = false; physics.removeStick(); resetBottles(); physicsOn = true; tween = null; state = 'menu'; $('#setup').hidden = false; };
$('#helpBtn').onclick = () => $('#rules').hidden = false;
$('#setupRules').onclick = () => $('#rules').hidden = false;
$('#rulesClose').onclick = () => $('#rules').hidden = true;
$('#viewBtn').onclick = () => {
  viewBottles = !viewBottles;
  $('#viewBtn').textContent = viewBottles ? 'Back to throw view' : 'Look at bottles';
};

setStickHeld();
$('#loading').hidden = true;
$('#setup').hidden = false;
