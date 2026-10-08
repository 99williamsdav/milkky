// One game between some seats: its own physics world, turns, timers and computer stand-ins.
// A room runs one match at a time for a single game, or a round of them for a league.
// Every message it sends carries `match: id` so clients know which game it belongs to.
import { createPhysics } from '../src/shared/physics.js';
import { newPlayer, scoreThrow, isGameOver, advanceTurn, planRestand } from '../src/shared/rules.js';
import { LEVELS, computeInfo, planCpuThrow } from '../src/shared/ai.js';
import { COLORS, AIM_LIMIT, MIN_DIST, MAX_DIST, clamp } from '../src/shared/constants.js';
import { mulberry32 } from '../src/shared/rng.js';
import { simulateThrow, snapshot, settle } from './sim.js';

const env = (name, fallback) => (process.env[name] !== undefined ? +process.env[name] : fallback);
// How long clients spend animating, in seconds; matches the local game. MILKKY_ANIM_SCALE=0 skips waits in tests.
const ANIM_SCALE = env('MILKKY_ANIM_SCALE', 1);
const SCORE_PAUSE = 1.3, RESTAND = 0.5, CPU_WINDUP = 1.95;
const EARLY_GRACE = 300;                              // ms: accept a throw slightly before we expect animations to finish
const TURN_TIME = env('MILKKY_TURN_SECONDS', 45) * 1000;  // then the computer throws for you
const AWAY_GRACE = env('MILKKY_AWAY_SECONDS', 10) * 1000; // a disconnected player's turn waits this long (e.g. for a refresh)
const STAND_IN = LEVELS.medium;                       // how well the computer plays for someone who isn't there

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class Match {
  // seats: the players, in seat order. first: index of who throws first. onOver(match) when it ends.
  constructor(room, id, seats, { target, first = 0, onOver = () => {} }) {
    this.room = room; this.id = id; this.seats = seats; this.onOver = onOver;
    this.physics = createPhysics(room.RAPIER);
    settle(this.physics);
    this.rng = mulberry32((Math.random() * 2 ** 32) >>> 0);
    this.game = {
      players: seats.map((s, i) => newPlayer(s.name, s.cpu ? LEVELS[s.cpu] : null, COLORS[i])),
      cur: first, target, winner: null,
    };
    this.spectators = new Set();
    this.over = false; this.busyUntil = 0; this.timer = null; this.turnInfo = null;
  }

  // ---------- Messages ----------
  // Players and anyone watching
  audience() { return new Set([...this.seats, ...this.spectators]); }
  send(msg, except = null) {
    const s = JSON.stringify({ ...msg, match: this.id });
    for (const seat of this.audience()) if (seat !== except) this.room.send(seat, s);
  }
  publicGame() {
    const g = this.game;
    return {
      cur: g.cur, target: g.target, winner: g.winner ? g.players.indexOf(g.winner) : -1,
      players: g.players.map((p, i) => {
        const s = this.seats[i];
        return { name: p.name, cpu: p.cpu, color: p.color, score: p.score, misses: p.misses, out: p.out,
          seat: this.room.seatIndex(s), away: !s.cpu && !s.connected, left: !!s.left };
      }),
    };
  }
  // Everything a (re)joining player or new spectator needs to draw this game as it stands
  syncState() {
    return { t: 'sync', match: this.id, game: this.publicGame(), poses: snapshot(this.physics), over: this.over, turn: this.turnInfo && this.turnNow() };
  }
  // Turn info with the deadline as time remaining, so clients don't depend on their clocks
  turnNow() {
    const t = { ...this.turnInfo };
    if (this.deadline) t.deadline = Math.max(0, this.deadline - Date.now());
    return t;
  }

  // ---------- From players ----------
  aim(seat, m) {
    if (this.over || this.seats.indexOf(seat) !== this.game.cur || this.turnInfo?.cpu) return;
    const aim = num(m.aim), pull = num(m.pull);
    if (aim === null || pull === null) return;
    this.send({ t: 'aim', aim: clamp(aim, -AIM_LIMIT, AIM_LIMIT), pull: clamp(pull, -0.4, 1) }, seat);
  }
  throw(seat, m) {
    if (this.over) return 'This game has finished';
    if (this.seats.indexOf(seat) !== this.game.cur) return 'Not your turn';
    if (this.turnInfo?.cpu) return 'Too late, the computer is throwing for you';
    if (Date.now() < this.busyUntil - EARLY_GRACE) return 'Wait for the last throw to finish';
    const dist = num(m.dist), aim = num(m.aim);
    if (dist === null || aim === null) return 'Bad throw';
    this.doThrow(clamp(dist, MIN_DIST, MAX_DIST), clamp(aim, -AIM_LIMIT, AIM_LIMIT));
  }

  // A player connected, dropped or left: tell everyone, and hand their turn to the computer if needed.
  seatChanged(seat) {
    if (this.over || !this.seats.includes(seat)) return;
    this.send({ t: 'status', game: this.publicGame() });
    if (this.seats[this.game.cur] !== seat || this.turnInfo?.cpu) return;
    if (seat.left) this.standIn();
    else this.armTurnTimer();
  }

  // ---------- Turns ----------
  start() {
    this.send({ t: 'start', game: this.publicGame(), poses: snapshot(this.physics) });
    this.beginTurn(0);
  }
  // `delay`: seconds until clients have finished animating the previous throw
  beginTurn(delay) {
    clearTimeout(this.timer);
    const i = this.game.cur, p = this.game.players[i], seat = this.seats[i];
    this.turnStart = Date.now() + delay * 1000;
    this.deadline = null;
    if (p.cpu) return this.computerTurn(delay, p.ai);
    if (seat.left) return this.computerTurn(delay, STAND_IN, true);
    this.deadline = this.turnStart + TURN_TIME;
    this.turnInfo = { cur: i };
    this.send({ t: 'turn', ...this.turnNow() });
    this.armTurnTimer();
  }
  // A person's turn ends at the deadline, or sooner if they've lost their connection.
  armTurnTimer() {
    clearTimeout(this.timer);
    const seat = this.seats[this.game.cur];
    let at = this.deadline;
    if (!seat.connected) at = Math.max(this.turnStart, Math.min(at, (seat.awaySince || Date.now()) + AWAY_GRACE));
    this.timer = setTimeout(() => this.standIn(), Math.max(0, at - Date.now()));
  }
  // The computer throws for a person who ran out of time, isn't connected, or left.
  standIn() {
    if (this.over || this.turnInfo?.cpu) return;
    this.computerTurn(Math.max(0, (this.turnStart - Date.now()) / 1000), STAND_IN, true);
  }
  computerTurn(delay, ai, standIn = false) {
    clearTimeout(this.timer);
    const i = this.game.cur, p = this.game.players[i];
    const plan = planCpuThrow({ ...p, ai }, computeInfo(this.physics.bottleSpots()), this.game.target, this.rng);
    this.deadline = null;
    this.turnInfo = { cur: i, cpu: { aim: plan.aim, target: plan.target }, ...(standIn ? { standIn: true } : {}) };
    this.send({ t: 'turn', ...this.turnInfo });
    this.timer = setTimeout(() => this.doThrow(plan.thrownDist, plan.thrownAim), (delay + CPU_WINDUP * ANIM_SCALE) * 1000);
  }
  doThrow(dist, aim) {
    if (this.over) return;
    clearTimeout(this.timer);
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
    this.send({
      t: 'throw', seat: thrower, dist, aim, fps, bodies, frames, fallen, msg, restand,
      poses: snapshot(physics), game: this.publicGame(), over,
    });
    this.room.matchUpdated(this);
    const anim = (frames.length / fps + SCORE_PAUSE + RESTAND) * ANIM_SCALE;
    this.busyUntil = Date.now() + anim * 1000;
    if (over) { this.over = true; this.turnInfo = null; this.deadline = null; this.onOver(this); }
    else this.beginTurn(anim);
  }

  dispose() { clearTimeout(this.timer); this.over = true; this.physics.world.free(); }
}
