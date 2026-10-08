// A room: a lobby of seats (people or computer players), then either a single game or a league.
// League: everyone plays everyone once, a round at a time, with each round's fixtures played at the same
// time. A filler computer player evens the numbers; anyone who leaves is played by the computer.
import { randomUUID } from 'node:crypto';
import { LEVELS, BOT_NAMES } from '../src/shared/ai.js';
import { roundRobin } from '../src/shared/schedule.js';
import { Match } from './match.js';

const env = (name, fallback) => (process.env[name] !== undefined ? +process.env[name] : fallback);
export const MAX_SEATS = { game: 4, league: 8 };
const TARGETS = [20, 30, 50];
const CPU_LEVELS = Object.keys(LEVELS);
const SEAT_COLORS = ['#1f4e8c', '#c0392b', '#2e8b57', '#d4a017', '#7d3c98', '#d35400', '#16a085', '#5d6d7e'];
const LOBBY_GRACE = 60_000; // ms a disconnected player keeps their lobby seat, so a refresh doesn't lose it
const BETWEEN_ROUNDS = env('MILKKY_BETWEEN_SECONDS', 20) * 1000;

export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 16);
// Computer players are "Aino (bot)"; people can't give themselves that suffix.
const BOT_SUFFIX = ' (bot)';
const humanName = s => cleanName(s).replace(/\s*\(\s*bot\s*\)\s*$/i, '').trim();

export class Room {
  constructor(code, RAPIER) {
    this.code = code; this.RAPIER = RAPIER;
    this.seats = [];        // { name, cpu: level | null, token, ws, connected, awaySince, left }
    this.mode = 'game';     // game | league
    // game: lobby → playing → over.  league: lobby → playing ⇄ between → over.  Both can start again from over.
    this.phase = 'lobby';
    this.target = 50;
    this.matches = [];      // the game, or this league round's fixtures
    this.league = null;
    this.timer = null;
    this.emptySince = null;
  }

  // ---------- Seats ----------
  get host() { return this.seats.findIndex(s => !s.cpu && s.connected); }
  get inProgress() { return this.phase === 'playing' || this.phase === 'between'; }
  canJoin() { return !this.inProgress && this.seats.length < MAX_SEATS[this.mode]; }
  uniqueName(name) {
    let n = name, k = 2;
    while (this.seats.some(s => s.name === n)) n = `${name} ${k++}`;
    return n;
  }
  // A Finnish name not already used in this room (or by this league's filler)
  botName() {
    const seats = [...this.seats, ...(this.league?.entries.map(e => e.seat) || [])];
    const taken = new Set(seats.map(s => s.name.replace(BOT_SUFFIX, '')));
    const free = BOT_NAMES.filter(n => !taken.has(n));
    return this.uniqueName((free.length ? free[(Math.random() * free.length) | 0] : 'Bot') + BOT_SUFFIX);
  }
  addHuman(ws, name) {
    const seat = { name: this.uniqueName(humanName(name) || 'Player'), cpu: null, token: randomUUID(), ws, connected: true };
    this.seats.push(seat);
    this.emptySince = null;
    return seat;
  }
  reattach(seat, ws) {
    if (seat.ws && seat.ws !== ws) seat.ws.close(4000, 'Joined from another tab');
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
    } else { // e.g. a page refresh in the lobby
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
  // People who aren't connected don't keep their seat into the next game.
  dropAbsentSeats() { for (const s of this.seats.filter(s => !s.cpu && !s.connected)) this.removeSeat(s); }
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
      name: e.seat.name, seat: this.seatIndex(e.seat), cpu: e.seat.cpu, left: !!e.seat.left,
      P: e.P, W: e.W, L: e.L, PF: e.PF, PA: e.PA,
    })).sort((a, b) => b.W - a.W || (b.PF - b.PA) - (a.PF - a.PA) || b.PF - a.PF);
    return {
      round: lg.round + 1, rounds: lg.schedule.length, table, results: lg.results,
      nextRoundIn: this.phase === 'between' ? Math.max(0, this.nextRoundAt - Date.now()) : null,
    };
  }
  roomState(forSeat) {
    return {
      t: 'room', code: this.code, mode: this.mode, phase: this.phase, target: this.target, host: this.host,
      you: this.seatIndex(forSeat), maxSeats: MAX_SEATS[this.mode],
      seats: this.seats.map((s, i) => ({ name: s.name, cpu: s.cpu, color: SEAT_COLORS[i], connected: s.connected, left: !!s.left })),
      league: this.leagueState(),
      fixtures: this.mode === 'league' ? this.fixtures() : null,
    };
  }
  broadcastRoom() { for (const seat of this.seats) this.send(seat, this.roomState(seat)); }
  // After (re)joining: the game this seat is in, as it stands now
  resync(seat) {
    const m = this.inProgress && this.matchOf(seat);
    if (m && !m.over) this.send(seat, m.syncState());
  }
  // Called by a match after every throw
  matchUpdated() {
    if (this.mode === 'league') this.broadcast({ t: 'fixtures', fixtures: this.fixtures() });
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
      case 'target':
        if (lobbyOnly('change the target')) return;
        if (!TARGETS.includes(m.target)) return this.error(seat, 'Target must be 20, 30 or 50');
        this.target = m.target; return this.broadcastRoom();
      case 'addCpu':
        if (lobbyOnly('add players')) return;
        if (!CPU_LEVELS.includes(m.level)) return this.error(seat, 'Unknown level');
        if (this.seats.length >= MAX_SEATS[this.mode]) return this.error(seat, 'The room is full');
        this.seats.push({ name: this.botName(), cpu: m.level, token: null, ws: null, connected: true });
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
      case 'watch': { // watch another fixture, or stop watching (match: null)
        this.matches.forEach(x => x.spectators.delete(seat));
        const target = this.matches.find(x => x.id === m.match);
        if (!target || target.seats.includes(seat)) return;
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
  start(seat) {
    this.dropAbsentSeats(); // anyone still away from the lobby doesn't play
    if (this.mode === 'league' && this.seats.length < 2) return this.error(seat, 'A league needs at least 2 players');
    this.seats.forEach(s => { s.left = false; });
    this.disposeMatches(); clearTimeout(this.timer);
    if (this.mode === 'league') return this.startLeague();
    this.league = null;
    this.phase = 'playing';
    this.matches = [new Match(this, 'game', [...this.seats], { target: this.target, onOver: () => this.gameOver() })];
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
    if (entries.length % 2) entries.push(entry({ name: this.botName(), cpu: 'medium', connected: true, filler: true }));
    this.league = { entries, schedule: roundRobin(entries.length), round: -1, results: [] };
    this.startRound();
  }
  startRound() {
    clearTimeout(this.timer);
    const lg = this.league;
    lg.round++;
    this.disposeMatches();
    this.phase = 'playing';
    this.matches = lg.schedule[lg.round].map(([a, b], k) => new Match(this, `r${lg.round + 1}-${k + 1}`,
      [lg.entries[a].seat, lg.entries[b].seat],
      { target: this.target, first: lg.round % 2, onOver: m => this.fixtureOver(m, a, b) }));
    this.broadcastRoom();
    this.matches.forEach(m => m.start());
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
    if (lg.round >= lg.schedule.length - 1) {
      this.phase = 'over';
      this.dropAbsentSeats();
    } else {
      this.phase = 'between';
      this.nextRoundAt = Date.now() + BETWEEN_ROUNDS;
      this.timer = setTimeout(() => this.startRound(), BETWEEN_ROUNDS);
    }
    this.broadcastRoom();
  }

  disposeMatches() { this.matches.forEach(m => m.dispose()); this.matches = []; }
  dispose() { clearTimeout(this.timer); this.disposeMatches(); this.seats.forEach(s => clearTimeout(s.dropTimer)); }
}
