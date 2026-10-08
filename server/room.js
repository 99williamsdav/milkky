// A room: up to four seats (people or computer players), a lobby, and one game at a time.
// The room owns the physics world, so every throw is simulated here and only the result is sent out.
import { randomUUID } from 'node:crypto';
import { createPhysics } from '../src/shared/physics.js';
import { newPlayer, scoreThrow, isGameOver, advanceTurn, planRestand } from '../src/shared/rules.js';
import { LEVELS, computeInfo, planCpuThrow } from '../src/shared/ai.js';
import { COLORS, AIM_LIMIT, MIN_DIST, MAX_DIST, clamp } from '../src/shared/constants.js';
import { mulberry32 } from '../src/shared/rng.js';
import { simulateThrow, snapshot, settle } from './sim.js';

export const MAX_SEATS = 4;
const TARGETS = [20, 30, 50];
const CPU_LEVELS = Object.keys(LEVELS);
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
// How long clients spend animating, in seconds; matches the local game. MILKKY_ANIM_SCALE=0 skips waits in tests.
const ANIM_SCALE = process.env.MILKKY_ANIM_SCALE !== undefined ? +process.env.MILKKY_ANIM_SCALE : 1;
const SCORE_PAUSE = 1.3, RESTAND = 0.5, CPU_WINDUP = 1.95;
const EARLY_GRACE = 300; // ms: accept a throw slightly before we expect the thrower's animation to finish

export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 16);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class Room {
  constructor(code, RAPIER) {
    this.code = code;
    this.seats = [];        // { name, cpu: level | null, token, ws, connected }
    this.phase = 'lobby';   // lobby → playing → over (→ playing again)
    this.target = 50;
    this.physics = createPhysics(RAPIER);
    this.game = null;
    this.rng = Math.random;
    this.busyUntil = 0;
    this.cpuTimer = null;
    this.emptySince = null;
  }

  // ---------- Seats ----------
  get host() { return this.seats.findIndex(s => !s.cpu && s.connected); }
  canJoin() { return this.phase !== 'playing' && this.seats.length < MAX_SEATS; }
  uniqueName(name) {
    let n = name, k = 2;
    while (this.seats.some(s => s.name === n)) n = `${name} ${k++}`;
    return n;
  }
  addHuman(ws, name) {
    const seat = { name: this.uniqueName(cleanName(name) || 'Player'), cpu: null, token: randomUUID(), ws, connected: true };
    this.seats.push(seat);
    this.emptySince = null;
    return seat;
  }
  reattach(seat, ws) {
    if (seat.ws && seat.ws !== ws) seat.ws.close(4000, 'Joined from another tab');
    seat.ws = ws; seat.connected = true; this.emptySince = null;
  }
  disconnect(seat) {
    seat.ws = null; seat.connected = false;
    // Outside a game an empty seat just goes away; during one it's kept so the player can rejoin.
    if (this.phase !== 'playing') this.seats.splice(this.seats.indexOf(seat), 1);
    if (!this.seats.some(s => !s.cpu && s.connected)) this.emptySince = Date.now();
    this.broadcastRoom();
  }
  seatIndex(seat) { return this.seats.indexOf(seat); }

  // ---------- Messages ----------
  send(seat, msg) {
    if (seat.ws && seat.ws.readyState === 1) seat.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  broadcast(msg, except = null) {
    const s = JSON.stringify(msg);
    for (const seat of this.seats) if (seat !== except) this.send(seat, s);
  }
  roomState(forSeat) {
    return {
      t: 'room', code: this.code, phase: this.phase, target: this.target, host: this.host,
      you: this.seatIndex(forSeat),
      seats: this.seats.map((s, i) => ({ name: s.name, cpu: s.cpu, color: COLORS[i], connected: s.connected })),
    };
  }
  broadcastRoom() { for (const seat of this.seats) this.send(seat, this.roomState(seat)); }
  publicGame() {
    const g = this.game;
    return {
      cur: g.cur, target: g.target, winner: g.winner ? g.players.indexOf(g.winner) : -1,
      players: g.players.map(p => ({ name: p.name, cpu: p.cpu, color: p.color, score: p.score, misses: p.misses, out: p.out })),
    };
  }
  // Everything a (re)joining client needs to draw the game as it stands
  syncState() {
    return { t: 'sync', game: this.publicGame(), poses: snapshot(this.physics), phase: this.phase, turn: this.turnInfo };
  }

  // ---------- Handling a seat's message ----------
  handle(seat, m) {
    const isHost = this.seatIndex(seat) === this.host;
    switch (m.t) {
      case 'target':
        if (!isHost || this.phase === 'playing') return this.error(seat, 'Only the host can change the target before a game');
        if (!TARGETS.includes(m.target)) return this.error(seat, 'Target must be 20, 30 or 50');
        this.target = m.target; return this.broadcastRoom();
      case 'addCpu':
        if (!isHost || this.phase === 'playing') return this.error(seat, 'Only the host can add players before a game');
        if (!CPU_LEVELS.includes(m.level)) return this.error(seat, 'Unknown level');
        if (this.seats.length >= MAX_SEATS) return this.error(seat, 'The room is full');
        this.seats.push({ name: this.uniqueName(`Computer (${LEVEL_LABEL[m.level]})`), cpu: m.level, token: null, ws: null, connected: true });
        return this.broadcastRoom();
      case 'removeCpu': {
        const s = this.seats[m.seat];
        if (!isHost || this.phase === 'playing' || !s || !s.cpu) return this.error(seat, 'Can’t remove that player');
        this.seats.splice(m.seat, 1); return this.broadcastRoom();
      }
      case 'start':
        if (!isHost) return this.error(seat, 'Only the host can start');
        if (this.phase === 'playing') return this.error(seat, 'A game is already running');
        return this.start();
      case 'aim': { // live preview of the thrower lining up; not trusted for anything
        if (this.phase !== 'playing' || this.seatIndex(seat) !== this.game.cur) return;
        const aim = num(m.aim), pull = num(m.pull);
        if (aim === null || pull === null) return;
        return this.broadcast({ t: 'aim', aim: clamp(aim, -AIM_LIMIT, AIM_LIMIT), pull: clamp(pull, -0.4, 1) }, seat);
      }
      case 'throw': {
        if (this.phase !== 'playing') return this.error(seat, 'No game running');
        if (this.seatIndex(seat) !== this.game.cur) return this.error(seat, 'Not your turn');
        if (Date.now() < this.busyUntil - EARLY_GRACE) return this.error(seat, 'Wait for the last throw to finish');
        const dist = num(m.dist), aim = num(m.aim);
        if (dist === null || aim === null) return this.error(seat, 'Bad throw');
        return this.doThrow(clamp(dist, MIN_DIST, MAX_DIST), clamp(aim, -AIM_LIMIT, AIM_LIMIT));
      }
      default:
        return this.error(seat, `Unknown message ${String(m.t).slice(0, 20)}`);
    }
  }
  error(seat, msg) { this.send(seat, { t: 'error', msg }); }

  // ---------- Game flow ----------
  start() {
    clearTimeout(this.cpuTimer);
    const seed = (Math.random() * 2 ** 32) >>> 0;
    this.rng = mulberry32(seed);
    this.physics.removeStick(); this.physics.resetBottles(); settle(this.physics);
    this.game = {
      players: this.seats.map((s, i) => newPlayer(s.name, s.cpu ? LEVELS[s.cpu] : null, COLORS[i])),
      cur: 0, target: this.target, winner: null,
    };
    this.phase = 'playing'; this.busyUntil = 0;
    this.broadcastRoom();
    this.broadcast({ t: 'start', game: this.publicGame(), poses: snapshot(this.physics) });
    this.beginTurn(0);
  }
  // `delay`: seconds until clients have finished animating the previous throw
  beginTurn(delay) {
    const p = this.game.players[this.game.cur];
    this.turnInfo = { cur: this.game.cur };
    if (p.cpu) {
      const plan = planCpuThrow(p, computeInfo(this.physics.bottleSpots()), this.game.target, this.rng);
      this.turnInfo.cpu = { aim: plan.aim, target: plan.target };
      this.cpuTimer = setTimeout(() => this.doThrow(plan.thrownDist, plan.thrownAim), (delay + CPU_WINDUP * ANIM_SCALE) * 1000);
    }
    this.broadcast({ t: 'turn', ...this.turnInfo });
  }
  doThrow(dist, aim) {
    if (this.phase !== 'playing') return;
    const { physics, game } = this, thrower = game.cur;
    const { bodies, frames, fps } = simulateThrow(physics, dist, aim);
    const fallen = physics.fallenBottles().map(b => b.num);
    const msg = scoreThrow(game, fallen);

    const plan = planRestand(physics.bottles.map(b => ({ t: b.body.translation(), q: b.body.rotation() })), this.rng);
    physics.removeStick();
    const restand = [];
    physics.bottles.forEach((b, i) => {
      if (!plan[i].needs) return;
      physics.placeUpright(b.body, plan[i].x, plan[i].z);
      restand.push([i, plan[i].x, plan[i].z]);
    });
    settle(physics);

    const over = isGameOver(game);
    if (!over) advanceTurn(game);
    this.broadcast({
      t: 'throw', seat: thrower, dist, aim, fps, bodies, frames, fallen, msg, restand,
      poses: snapshot(physics), game: this.publicGame(), over,
    });
    const anim = (frames.length / fps + SCORE_PAUSE + RESTAND) * ANIM_SCALE;
    this.busyUntil = Date.now() + anim * 1000;
    if (over) { this.phase = 'over'; this.turnInfo = null; this.dropAbsentSeats(); this.broadcastRoom(); }
    else this.beginTurn(anim);
  }
  // After a game, people who left don't keep their seat in the lobby.
  dropAbsentSeats() { this.seats = this.seats.filter(s => s.cpu || s.connected); }

  dispose() { clearTimeout(this.cpuTimer); this.physics.world.free(); }
}
