// A room: a lobby of seats (people or computer players), then either a single game or a league.
// League: everyone plays everyone once, a round at a time, with each round's fixtures played at the same
// time. A filler computer player evens the numbers; anyone who leaves is played by the computer.
//
// Pace: 'live' expects everyone to play together now. 'async' is played at leisure over days: seats are
// kept while people are away, a league round lasts up to a day (and moves on as soon as its games are
// done), and at the deadline bots finish any games still going.
import { randomUUID, createHash } from 'node:crypto';
import { LEVELS } from '../src/shared/ai.js';
import { ROSTER, botsForLevel } from '../src/shared/roster.js';
import { roundRobin } from '../src/shared/schedule.js';
import { Match, TURN_TIME, ASYNC_TURN_TIME } from './match.js';
import * as store from './store.js';

const env = (name, fallback) => (process.env[name] !== undefined ? +process.env[name] : fallback);
export const MAX_SEATS = { game: 4, league: 8 };
const TARGETS = [20, 30, 50];
const PACES = ['live', 'async'];
const CPU_LEVELS = Object.keys(LEVELS);
const SEAT_COLORS = ['#1f4e8c', '#c0392b', '#2e8b57', '#d4a017', '#7d3c98', '#d35400', '#16a085', '#5d6d7e'];
const LOBBY_GRACE = 60_000; // live: ms a disconnected player keeps their lobby seat, so a refresh doesn't lose it
const BETWEEN_ROUNDS = env('MILKKY_BETWEEN_SECONDS', 20) * 1000;  // live league: pause between rounds
const ROUND_TIME = env('MILKKY_ROUND_SECONDS', 24 * 3600) * 1000; // async league: longest a round can last
const RESTART_GRACE = 20_000; // live: after a server restart, extra time for players to reconnect before bots take their turns

export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 16);
// Computer players are "Aino (bot)"; people can't give themselves that suffix.
const BOT_SUFFIX = ' (bot)';
const humanName = s => cleanName(s).replace(/\s*\(\s*bot\s*\)\s*$/i, '').trim();
// A player's key (kept in their browser) identifies them across rooms; only its hash is stored.
export const hashKey = key => (typeof key === 'string' && key.length >= 16 && key.length <= 100)
  ? createHash('sha256').update(key).digest('hex') : null;

export class Room {
  constructor(code, RAPIER) {
    this.code = code; this.RAPIER = RAPIER;
    this.seats = [];        // { name, cpu: level | null, token, me (key hash), ws, connected, awaySince, left }
    this.mode = 'game';     // game | league
    this.pace = 'live';     // live | async
    // game: lobby → playing → over.  league: lobby → playing ⇄ between → over.  Both can start again from over.
    this.phase = 'lobby';
    this.target = 50;
    this.matches = [];      // the game, or this league round's fixtures
    this.league = null;
    this.timer = null;      // next league round (live), or this round's deadline (async)
    this.emptySince = null;
    this.updatedAt = Date.now();
  }

  // ---------- Seats ----------
  get async() { return this.pace === 'async'; }
  // Live: the first person here. Async: the first person in the room, here or not (they'll be back).
  get host() { return this.seats.findIndex(s => !s.cpu && !s.left && (this.async || s.connected)); }
  get inProgress() { return this.phase === 'playing' || this.phase === 'between'; }
  canJoin() { return !this.inProgress && this.seats.length < MAX_SEATS[this.mode]; }
  uniqueName(name) {
    let n = name, k = 2;
    while (this.seats.some(s => s.name === n)) n = `${name} ${k++}`;
    return n;
  }
  // A computer player at `level`: one of that league's characters (shared/roster.js) not already in this
  // room (or this league), falling back to anyone free, then to a plain "Bot".
  newBot(level, extra = {}) {
    const seats = [...this.seats, ...(this.league?.entries.map(e => e.seat) || [])];
    const taken = new Set(seats.map(s => s.bot));
    const pick = list => { const free = list.filter(b => !taken.has(b.id)); return free[(Math.random() * free.length) | 0]; };
    const b = pick(botsForLevel(level)) || pick(ROSTER);
    return { name: this.uniqueName((b ? b.name : 'Bot') + BOT_SUFFIX), bot: b?.id || null, cpu: level, token: null, ws: null, connected: true, ...extra };
  }
  addHuman(ws, name, me) {
    const seat = { name: this.uniqueName(humanName(name) || 'Player'), cpu: null, token: randomUUID(), me: hashKey(me), ws, connected: true };
    this.seats.push(seat);
    this.emptySince = null;
    return seat;
  }
  // The seat a (re)joining player holds: by the token from `joined`, or by their player key
  findSeat(token, me) {
    const h = hashKey(me);
    return this.seats.find(s => !s.cpu && ((token && s.token === token) || (h && s.me === h)));
  }
  reattach(seat, ws) {
    if (seat.ws && seat.ws !== ws) { seat.ws.room = seat.ws.seat = null; seat.ws.close(4000, 'Opened somewhere else'); }
    clearTimeout(seat.dropTimer);
    seat.ws = ws; seat.connected = true; this.emptySince = null;
    this.matches.forEach(m => m.seatChanged(seat));
  }
  // `left`: the player chose to go (or moved to another room), rather than losing the connection.
  disconnect(seat, { left = false } = {}) {
    seat.ws = null; seat.connected = false; seat.awaySince = Date.now();
    if (left) seat.left = true;
    this.matches.forEach(m => m.spectators.delete(seat));
    if (this.inProgress) {
      // Keep the seat: they can rejoin, and the computer plays their turns meanwhile (or from now on, if they left).
      this.matches.forEach(m => m.seatChanged(seat));
    } else if (left) {
      this.removeSeat(seat);
    } else if (!this.async) { // e.g. a page refresh in a live lobby (async lobbies keep their seats)
      seat.dropTimer = setTimeout(() => { if (!seat.connected && !this.inProgress) { this.removeSeat(seat); this.broadcastRoom(); } }, LOBBY_GRACE);
    }
    if (!this.seats.some(s => !s.cpu && s.connected)) this.emptySince = Date.now();
    this.broadcastRoom();
  }
  removeSeat(seat) {
    clearTimeout(seat.dropTimer);
    const i = this.seats.indexOf(seat);
    if (i >= 0) this.seats.splice(i, 1);
  }
  // People who left don't keep their seat into the next game; live, neither do people who aren't here.
  dropAbsentSeats() { for (const s of this.seats.filter(s => !s.cpu && (s.left || (!this.async && !s.connected)))) this.removeSeat(s); }
  seatIndex(seat) { return this.seats.indexOf(seat); }
  // The match this seat is playing in (an unfinished one first)
  matchOf(seat) { return this.matches.find(m => !m.over && m.seats.includes(seat)) || this.matches.find(m => m.seats.includes(seat)); }

  // ---------- Messages ----------
  send(seat, msg) {
    if (seat.ws && seat.ws.readyState === 1) seat.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const seat of this.seats) this.send(seat, s);
  }
  // Live state of each fixture, for the scores strip and the "watch a game" list
  fixtures() {
    return this.matches.map(m => ({
      id: m.id, over: m.over, cur: m.game.cur, winner: m.game.winner ? m.game.players.indexOf(m.game.winner) : -1,
      seats: m.seats.map(s => this.seatIndex(s)),
      players: m.game.players.map(p => ({ name: p.name, score: p.score, out: p.out })),
    }));
  }
  leagueState() {
    const lg = this.league;
    if (!lg) return null;
    const table = lg.entries.map(e => ({
      name: e.seat.name, seat: this.seatIndex(e.seat), cpu: e.seat.cpu, bot: e.seat.bot || null, left: !!e.seat.left,
      P: e.P, W: e.W, L: e.L, PF: e.PF, PA: e.PA,
    })).sort((a, b) => b.W - a.W || (b.PF - b.PA) - (a.PF - a.PA) || b.PF - a.PF);
    return {
      round: lg.round + 1, rounds: lg.schedule.length, table, results: lg.results,
      nextRoundIn: this.phase === 'between' ? Math.max(0, this.nextRoundAt - Date.now()) : null,
      roundEndsIn: this.async && this.phase === 'playing' && this.roundEndsAt ? Math.max(0, this.roundEndsAt - Date.now()) : null,
    };
  }
  roomState(forSeat) {
    return {
      t: 'room', code: this.code, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target, host: this.host,
      you: this.seatIndex(forSeat), maxSeats: MAX_SEATS[this.mode],
      seats: this.seats.map((s, i) => ({ name: s.name, cpu: s.cpu, bot: s.bot || null, color: SEAT_COLORS[i], connected: s.connected, left: !!s.left })),
      league: this.leagueState(),
      fixtures: this.mode === 'league' ? this.fixtures() : null,
    };
  }
  // Every change to the room goes out to its players, so this is also where it's saved.
  broadcastRoom() {
    for (const seat of this.seats) this.send(seat, this.roomState(seat));
    this.updatedAt = Date.now();
    store.save(this);
  }
  // After (re)joining: the game this seat is in, as it stands now (async: from where they left off)
  resync(seat) {
    const m = this.matchOf(seat);
    if (!m) return;
    if (m.over ? m.unseenBy(seat) : this.inProgress) m.catchUp(seat);
  }
  // Called by a match after every throw
  matchUpdated() {
    if (this.mode === 'league') this.broadcast({ t: 'fixtures', fixtures: this.fixtures() });
    this.updatedAt = Date.now();
    store.save(this);
  }
  // This room as it looks to the player with key hash `me`, for their "My games" list
  summaryFor(me) {
    const seat = this.seats.find(s => s.me === me && !s.left);
    if (!seat) return null;
    const m = this.matchOf(seat), lg = this.league;
    return {
      code: this.code, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target, updatedAt: this.updatedAt,
      you: seat.name, host: this.seatIndex(seat) === this.host, players: this.seats.map(s => s.name),
      league: lg && { round: lg.round + 1, rounds: lg.schedule.length, roundEndsIn: this.leagueState().roundEndsIn,
        place: this.leagueState().table.findIndex(e => e.seat === this.seatIndex(seat)) + 1 },
      match: m && {
        over: m.over, unseen: m.unseenBy(seat),
        yourTurn: !m.over && m.seats[m.game.cur] === seat && !m.turnInfo?.cpu,
        turnOf: m.over ? null : m.game.players[m.game.cur].name,
        deadline: m.deadline && m.seats[m.game.cur] === seat ? Math.max(0, m.deadline - Date.now()) : null,
        players: m.game.players.map(p => ({ name: p.name, score: p.score })),
      },
    };
  }

  // ---------- Handling a seat's message ----------
  handle(seat, m) {
    const isHost = this.seatIndex(seat) === this.host;
    // Lobby settings: host only, and not while a game or league is running. Returns true if refused.
    const lobbyOnly = what => {
      if (isHost && !this.inProgress) return false;
      this.error(seat, `Only the host can ${what}, between games`);
      return true;
    };
    switch (m.t) {
      case 'mode':
        if (lobbyOnly('change the game type')) return;
        if (!(m.mode in MAX_SEATS)) return this.error(seat, 'Unknown game type');
        if (this.seats.length > MAX_SEATS[m.mode]) return this.error(seat, `A single game is for up to ${MAX_SEATS[m.mode]} players`);
        this.mode = m.mode; return this.broadcastRoom();
      case 'pace':
        if (lobbyOnly('change the pace')) return;
        if (!PACES.includes(m.pace)) return this.error(seat, 'Unknown pace');
        this.pace = m.pace; return this.broadcastRoom();
      case 'target':
        if (lobbyOnly('change the target')) return;
        if (!TARGETS.includes(m.target)) return this.error(seat, 'Target must be 20, 30 or 50');
        this.target = m.target; return this.broadcastRoom();
      case 'addCpu':
        if (lobbyOnly('add players')) return;
        if (!CPU_LEVELS.includes(m.level)) return this.error(seat, 'Unknown level');
        if (this.seats.length >= MAX_SEATS[this.mode]) return this.error(seat, 'The room is full');
        this.seats.push(this.newBot(m.level));
        return this.broadcastRoom();
      case 'removeCpu': {
        const s = this.seats[m.seat];
        if (lobbyOnly('remove players')) return;
        if (!s || !s.cpu) return this.error(seat, 'Can’t remove that player');
        this.removeSeat(s); return this.broadcastRoom();
      }
      case 'start':
        if (!isHost) return this.error(seat, 'Only the host can start');
        if (this.inProgress) return this.error(seat, 'A game is already running');
        return this.start(seat);
      case 'next': // host skips the wait between league rounds
        if (!isHost || this.phase !== 'between') return;
        return this.startRound();
      case 'watch': { // watch another fixture, or stop watching (match: null); your own: back into it
        this.matches.forEach(x => x.spectators.delete(seat));
        const target = this.matches.find(x => x.id === m.match);
        if (!target) return;
        if (target.seats.includes(seat)) return target.catchUp(seat);
        target.spectators.add(seat);
        return this.send(seat, target.syncState());
      }
      case 'aim': return this.matchOf(seat)?.aim(seat, m);
      case 'throw': {
        const match = this.inProgress && this.matchOf(seat);
        const err = match ? match.throw(seat, m) : 'No game running';
        return err && this.error(seat, err);
      }
      default:
        return this.error(seat, `Unknown message ${String(m.t).slice(0, 20)}`);
    }
  }
  error(seat, msg) { this.send(seat, { t: 'error', msg }); }

  // ---------- Game flow ----------
  matchOptions() {
    // Live: a short turn timer. Async single game: a long one. Async league: none, the round deadline covers it.
    return { target: this.target, pace: this.pace, turnTime: !this.async ? TURN_TIME : this.mode === 'league' ? null : ASYNC_TURN_TIME };
  }
  start(seat) {
    this.dropAbsentSeats(); // anyone who left (or, live, isn't here) doesn't play
    if (this.mode === 'league' && this.seats.length < 2) return this.error(seat, 'A league needs at least 2 players');
    this.seats.forEach(s => { s.left = false; });
    this.disposeMatches(); clearTimeout(this.timer);
    if (this.mode === 'league') return this.startLeague();
    this.league = null;
    this.phase = 'playing';
    this.matches = [new Match(this, 'game', [...this.seats], { ...this.matchOptions(), onOver: () => this.gameOver() })];
    this.broadcastRoom();
    this.matches[0].start();
  }
  gameOver() {
    this.phase = 'over';
    this.dropAbsentSeats(); this.broadcastRoom();
  }

  startLeague() {
    const entry = seat => ({ seat, P: 0, W: 0, L: 0, PF: 0, PA: 0 });
    const entries = this.seats.map(entry);
    if (entries.length % 2) entries.push(entry(this.newBot('medium', { filler: true })));
    this.league = { entries, schedule: roundRobin(entries.length), round: -1, results: [] };
    this.startRound();
  }
  startRound() {
    clearTimeout(this.timer);
    const lg = this.league;
    lg.round++;
    this.disposeMatches();
    this.phase = 'playing';
    this.matches = lg.schedule[lg.round].map(([a, b], k) => {
      const m = new Match(this, `r${lg.round + 1}-${k + 1}`, [lg.entries[a].seat, lg.entries[b].seat],
        { ...this.matchOptions(), first: lg.round % 2, onOver: m => this.fixtureOver(m, a, b) });
      m.fixture = [a, b]; // which league entries are playing
      return m;
    });
    if (this.async) this.armRoundDeadline(Date.now() + ROUND_TIME);
    this.broadcastRoom();
    this.matches.forEach(m => m.start());
  }
  // Async: when the round's time is up, bots finish every game still going
  armRoundDeadline(at) {
    this.roundEndsAt = at;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.matches.forEach(m => m.finishWithBots()), Math.max(0, at - Date.now()));
  }
  fixtureOver(m, a, b) {
    const lg = this.league, [pa, pb] = m.game.players;
    const aWon = m.game.winner ? m.game.winner === pa : pa.score >= pb.score;
    const A = lg.entries[a], B = lg.entries[b];
    A.P++; B.P++; A.PF += pa.score; A.PA += pb.score; B.PF += pb.score; B.PA += pa.score;
    if (aWon) { A.W++; B.L++; } else { B.W++; A.L++; }
    lg.results.push({ round: lg.round + 1, a: A.seat.name, b: B.seat.name, sa: pa.score, sb: pb.score, aWon });
    if (this.matches.every(x => x.over)) return this.endRound();
    this.broadcastRoom();
  }
  endRound() {
    const lg = this.league;
    clearTimeout(this.timer); this.roundEndsAt = null;
    if (lg.round >= lg.schedule.length - 1) {
      this.phase = 'over';
      this.dropAbsentSeats();
    } else if (this.async) {
      return this.startRound(); // everyone's done: no need to wait for the deadline
    } else {
      this.phase = 'between';
      this.nextRoundAt = Date.now() + BETWEEN_ROUNDS;
      this.timer = setTimeout(() => this.startRound(), BETWEEN_ROUNDS);
    }
    this.broadcastRoom();
  }

  // ---------- Saving and restoring ----------
  serialize() {
    const lg = this.league;
    // Seats are saved once; league entries and matches refer to them by position (or, for the filler, inline).
    const entryOf = seat => lg ? lg.entries.findIndex(e => e.seat === seat) : -1;
    const seatRef = seat => this.seats.includes(seat) ? { s: this.seatIndex(seat) } : { e: entryOf(seat) };
    return {
      v: 1, code: this.code, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target,
      nextRoundAt: this.nextRoundAt || null, roundEndsAt: this.roundEndsAt || null, updatedAt: this.updatedAt,
      seats: this.seats.map(s => ({ name: s.name, cpu: s.cpu, bot: s.bot || null, token: s.token, me: s.me || null, left: !!s.left })),
      league: lg && {
        round: lg.round, schedule: lg.schedule, results: lg.results,
        entries: lg.entries.map(e => ({
          seat: this.seats.includes(e.seat) ? { s: this.seatIndex(e.seat) } : { filler: { name: e.seat.name, cpu: e.seat.cpu, bot: e.seat.bot || null } },
          P: e.P, W: e.W, L: e.L, PF: e.PF, PA: e.PA,
        })),
      },
      matches: this.matches.map(m => m.serialize(seatRef)),
    };
  }
  // Rebuild a saved room. Nobody is connected yet: live, people have a while to come back before the
  // computer plays their turns, as if they'd all just dropped their connection.
  static restore(d, RAPIER) {
    const room = new Room(d.code, RAPIER);
    const back = Date.now() + RESTART_GRACE;
    Object.assign(room, { mode: d.mode, pace: d.pace || 'live', phase: d.phase, target: d.target, nextRoundAt: d.nextRoundAt,
      emptySince: Date.now(), updatedAt: d.updatedAt || Date.now() });
    room.seats = d.seats.map(s => ({ ...s, ws: null, connected: !!s.cpu, awaySince: back }));
    if (d.league) {
      room.league = {
        round: d.league.round, schedule: d.league.schedule, results: d.league.results,
        entries: d.league.entries.map(e => ({
          ...e, seat: e.seat.filler ? { ...e.seat.filler, connected: true, filler: true } : room.seats[e.seat.s],
        })),
      };
    }
    const seatOf = r => r.s != null ? room.seats[r.s] : room.league.entries[r.e].seat;
    room.matches = d.matches.map(md => Match.restore(room, md, md.seats.map(seatOf), md.fixture
      ? m => room.fixtureOver(m, md.fixture[0], md.fixture[1])
      : () => room.gameOver()));
    // Carry on: unfinished games continue, round timers resume, and live lobby seats that nobody comes
    // back for are let go as usual.
    room.matches.forEach(m => m.resume());
    if (room.phase === 'between') room.timer = setTimeout(() => room.startRound(), Math.max(0, d.nextRoundAt - Date.now()));
    if (room.phase === 'playing' && d.roundEndsAt) room.armRoundDeadline(d.roundEndsAt);
    if (!room.inProgress && !room.async) {
      for (const s of room.seats.filter(s => !s.cpu)) {
        s.dropTimer = setTimeout(() => { if (!s.connected && !room.inProgress) { room.removeSeat(s); room.broadcastRoom(); } }, LOBBY_GRACE);
      }
    }
    return room;
  }

  disposeMatches() { this.matches.forEach(m => m.dispose()); this.matches = []; }
  dispose() { clearTimeout(this.timer); this.disposeMatches(); this.seats.forEach(s => clearTimeout(s.dropTimer)); }
}
