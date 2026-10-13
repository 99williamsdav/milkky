// A room: a lobby of seats (people or computer players), then a single game, a league or a career.
// League: everyone plays everyone once, a round at a time, with each round's fixtures played at the same
// time. A filler computer player evens the numbers; anyone who leaves is played by the computer.
// Career (always at leisure): the people join three leagues of bots with promotion and relegation, and a cup,
// season after season (rules in src/shared/career.js). Each step of a season (a league round or a cup round)
// plays the games that have a person in them; the rest are simulated. People can join at any time and start
// the next season in the Sunday League; anyone who leaves is played by a bot, then replaced at the season's end.
//
// Pace: 'live' expects everyone to play together now. 'async' is played at leisure over days: seats are
// kept while people are away, a league round lasts up to a day (and moves on as soon as its games are
// done), and at the deadline bots finish any games still going.
import { randomUUID, createHash } from 'node:crypto';
import { LEVELS, aiFromSkill } from '../src/shared/ai.js';
import { ROSTER, botsForLevel, botById } from '../src/shared/roster.js';
import { roundRobin, peopleLast } from '../src/shared/schedule.js';
import * as Career from '../src/shared/career.js';
import * as Stats from '../src/shared/careerstats.js';
import { Match, TURN_TIME, ASYNC_TURN_TIME } from './match.js';
import * as store from './store.js';
import * as push from './push.js';

const env = (name, fallback) => (process.env[name] !== undefined ? +process.env[name] : fallback);
export const MAX_SEATS = { game: 4, league: 8, career: 16 };
const TARGETS = [20, 30, 50];
const VARIANTS = ['classic', 'battle']; // the rules: the classic game, or a battle (shared/battle.js: two players)
const PACES = ['live', 'async'];
const CPU_LEVELS = Object.keys(LEVELS);
const SEAT_COLORS = ['#1f4e8c', '#c0392b', '#2e8b57', '#d4a017', '#7d3c98', '#d35400', '#16a085', '#5d6d7e'];
const EMOTES = ['smile', 'laugh', 'sad', 'angry'], EMOTE_GAP = 600; // ms between one player's emotes
const LOBBY_GRACE = 60_000; // live: ms a disconnected player keeps their lobby seat, so a refresh doesn't lose it
const BETWEEN_ROUNDS = env('MILKKY_BETWEEN_SECONDS', 20) * 1000;  // live league: pause between rounds
const ASYNC_BETWEEN_ROUNDS = env('MILKKY_ASYNC_BETWEEN_SECONDS', 120) * 1000; // async league: the same, a little longer
const ROUND_TIME = env('MILKKY_ROUND_SECONDS', 24 * 3600) * 1000; // async league: longest a round can last
const SEASON_BREAK = env('MILKKY_SEASON_BREAK_SECONDS', 15 * 60) * 1000; // career: pause between seasons
const CAREER_IDLE = env('MILKKY_CAREER_IDLE_DAYS', 30) * 24 * 3600_000;  // career: stops after this long with nobody visiting
const REMIND_BEFORE = env('MILKKY_REMIND_HOURS', 3) * 3600_000;           // async rounds: a reminder this long before the deadline
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
    // { name, cpu: level | null, token, me (key hash), ws, connected, awaySince, left, pid (career: their id) }
    this.seats = [];
    this.mode = 'game';     // game | league | career
    this.pace = 'live';     // live | async (a career is always async)
    // game: lobby → playing → over.  league: lobby → playing ⇄ between → over.  Both can start again from over.
    // career: lobby → playing ⇄ between, for good.
    this.phase = 'lobby';
    this.target = 50;
    this.variant = 'classic';
    this.matches = [];      // the game, this league round's fixtures, or this career step's games with people in
    this.league = null;
    this.career = null;     // the career's state (shared/career.js), and the results of this step's played games
    this.stepResults = {};
    this.botSeats = new Map(); // career: a seat for each bot playing in a match, by bot id
    this.careerStats = {};     // career: each person's stats (shared/careerstats.js), by their career id
    this.timer = null;      // next league round (live), or this round's deadline (async)
    this.emptySince = null;
    this.updatedAt = Date.now();
    this.lastVisit = Date.now(); // when someone last came to the room (a career stops if nobody does for a long time)
    this.origin = null;     // a hash of the address that created it (to limit rooms per address)
    this.failed = false;    // something it did later threw: it's being closed
  }

  // ---------- Seats ----------
  get async() { return this.pace === 'async'; }
  // Live: the first person here. Async: the first person in the room, here or not (they'll be back).
  get host() { return this.seats.findIndex(s => !s.cpu && !s.left && (this.async || s.connected)); }
  get inProgress() { return this.phase === 'playing' || this.phase === 'between'; }
  // Anyone (not a computer player) still has a seat, here or not
  get hasPeople() { return this.seats.some(s => !s.cpu); }
  // A career takes people at any time (they wait for the next season)
  canJoin() { return (!this.inProgress || this.mode === 'career') && this.seats.length < this.maxSeats(); }
  // A single battle is for two; otherwise as many as the game type allows
  maxSeats(mode = this.mode) { return mode === 'game' && this.variant === 'battle' ? 2 : MAX_SEATS[mode]; }
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
    const seat = { name: this.uniqueName(humanName(name) || 'Player'), cpu: null, token: randomUUID(), me: hashKey(me), ws, connected: true,
      pid: '@' + randomUUID().slice(0, 8) };
    this.seats.push(seat);
    this.emptySince = null; this.lastVisit = Date.now();
    if (this.career) Career.addWaiting(this.career, seat.pid); // joining a career already under way
    return seat;
  }
  // Career: the seat for a bot in a match (one of the roster characters, playing at its own skill)
  careerBot(id) {
    if (!this.botSeats.has(id)) {
      const b = botById(id);
      this.botSeats.set(id, { name: b.name + BOT_SUFFIX, bot: id, cpu: 'career', ai: aiFromSkill(b.skill), token: null, ws: null, connected: true });
    }
    return this.botSeats.get(id);
  }
  // Career: the seat playing as a career entrant (a person's seat, or a bot's)
  careerSeat(id) { return Career.isPerson(id) ? this.seats.find(s => s.pid === id) : this.careerBot(id); }
  // The seat a (re)joining player holds: by the token from `joined`, or by their player key
  findSeat(token, me) {
    const h = hashKey(me);
    return this.seats.find(s => !s.cpu && ((token && s.token === token) || (h && s.me === h)));
  }
  reattach(seat, ws) {
    if (seat.ws && seat.ws !== ws) { seat.ws.room = seat.ws.seat = null; seat.ws.close(4000, 'Opened somewhere else'); }
    clearTimeout(seat.dropTimer);
    seat.ws = ws; seat.connected = true; this.emptySince = null; this.lastVisit = Date.now();
    seat.visible = true; seat.notified = false;
    this.matches.forEach(m => m.seatChanged(seat));
  }
  stopWatching(seat) {
    this.matches.forEach(m => { if (m.spectators.delete(seat)) m.watchersChanged(); });
  }
  // `left`: the player chose to go (or moved to another room), rather than losing the connection.
  disconnect(seat, { left = false } = {}) {
    seat.ws = null; seat.connected = false; seat.awaySince = Date.now(); seat.visible = false;
    if (left) seat.left = true;
    this.stopWatching(seat);
    if (this.inProgress) {
      // Keep the seat: they can rejoin, and the computer plays their turns meanwhile (or from now on, if they left).
      this.matches.forEach(m => m.seatChanged(seat));
    } else if (left) {
      this.removeSeat(seat);
    } else if (!this.async) { // e.g. a page refresh in a live lobby (async lobbies keep their seats)
      this.dropLater(seat);
    }
    if (!this.seats.some(s => !s.cpu && s.connected)) this.emptySince = Date.now();
    this.broadcastRoom();
  }
  // Live lobby: a disconnected person's seat is let go if they don't come back soon (e.g. from a refresh)
  dropLater(seat) {
    seat.dropTimer = this.later(() => { if (!seat.connected && !this.inProgress) { this.removeSeat(seat); this.broadcastRoom(); } }, LOBBY_GRACE);
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
      id: m.id, key: this.mode === 'career' ? m.fixture : undefined, // career: the fixture's key in the career
      over: m.over, cur: m.game.cur, winner: m.game.winner ? m.game.players.indexOf(m.game.winner) : -1,
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
  // The career as it stands (the shared state, which the client reads with shared/career.js), plus who's who
  careerState(forSeat) {
    const c = this.career;
    if (!c) return null;
    const people = {};
    for (const s of this.seats) if (s.pid) people[s.pid] = { name: s.name, seat: this.seatIndex(s), left: !!s.left };
    return {
      state: c, people, you: forSeat?.pid || null, stats: (forSeat?.pid && this.careerStats[forSeat.pid]) || null,
      nextStepIn: this.phase === 'between' ? Math.max(0, this.nextRoundAt - Date.now()) : null,
      stepEndsIn: this.phase === 'playing' && this.roundEndsAt ? Math.max(0, this.roundEndsAt - Date.now()) : null,
    };
  }
  roomState(forSeat) {
    return {
      t: 'room', code: this.code, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target, host: this.host,
      you: this.seatIndex(forSeat), maxSeats: this.maxSeats(), variant: this.variant,
      seats: this.seats.map((s, i) => ({ name: s.name, cpu: s.cpu, bot: s.bot || null, color: SEAT_COLORS[i % SEAT_COLORS.length], connected: s.connected, left: !!s.left })),
      league: this.leagueState(),
      career: this.careerState(forSeat),
      fixtures: this.mode !== 'game' ? this.fixtures() : null,
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
    if (this.mode !== 'game') this.broadcast({ t: 'fixtures', fixtures: this.fixtures() });
    this.updatedAt = Date.now();
    store.save(this);
  }
  // This room as it looks to the player with key hash `me`, for their "My games" list
  summaryFor(me) {
    const seat = this.seats.find(s => s.me === me && !s.left);
    if (!seat) return null;
    const m = this.matchOf(seat), lg = this.league, c = this.career;
    const tier = c ? Career.tierOf(c, seat.pid) : -1;
    return {
      code: this.code, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target, variant: this.variant, updatedAt: this.updatedAt,
      you: seat.name, host: this.seatIndex(seat) === this.host, players: this.seats.map(s => s.name),
      league: lg && { round: lg.round + 1, rounds: lg.schedule.length, roundEndsIn: this.leagueState().roundEndsIn,
        place: this.leagueState().table.findIndex(e => e.seat === this.seatIndex(seat)) + 1 },
      // Career: the season, your league and place in it (or that you're waiting for the next season)
      career: c && { season: c.season, step: c.step, steps: Career.STEPS.length, waiting: tier < 0, tier,
        place: tier < 0 ? 0 : Career.standings(c, tier).findIndex(e => e.id === seat.pid) + 1,
        stepEndsIn: this.careerState(seat).stepEndsIn },
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
        if (this.seats.length > this.maxSeats(m.mode)) return this.error(seat, `A single ${this.variant === 'battle' ? 'battle' : 'game'} is for up to ${this.maxSeats(m.mode)} players`);
        this.mode = m.mode;
        // A career is played at leisure, against its own bots
        if (m.mode === 'career') { this.pace = 'async'; this.seats.filter(s => s.cpu).forEach(s => this.removeSeat(s)); }
        return this.broadcastRoom();
      case 'pace':
        if (lobbyOnly('change the pace')) return;
        if (!PACES.includes(m.pace)) return this.error(seat, 'Unknown pace');
        if (this.mode === 'career' && m.pace !== 'async') return this.error(seat, 'A career is always played at your own pace');
        this.pace = m.pace; return this.broadcastRoom();
      case 'variant':
        if (lobbyOnly('change the rules')) return;
        if (!VARIANTS.includes(m.variant)) return this.error(seat, 'Unknown rules');
        if (m.variant === 'battle' && this.mode === 'game' && this.seats.length > 2) return this.error(seat, 'A battle is for 2 players: remove some first');
        this.variant = m.variant; return this.broadcastRoom();
      case 'target':
        if (lobbyOnly('change the target')) return;
        if (!TARGETS.includes(m.target)) return this.error(seat, 'Target must be 20, 30 or 50');
        this.target = m.target; return this.broadcastRoom();
      case 'addCpu':
        if (lobbyOnly('add players')) return;
        if (!CPU_LEVELS.includes(m.level)) return this.error(seat, 'Unknown level');
        if (this.mode === 'career') return this.error(seat, 'A career brings its own computer players');
        if (this.seats.length >= this.maxSeats()) return this.error(seat, this.variant === 'battle' && this.mode === 'game' ? 'A battle is for 2 players' : 'The room is full');
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
      case 'next': // host skips the wait between league rounds (or career steps)
        if (!isHost || this.phase !== 'between') return;
        return this.mode === 'career' ? this.careerNext() : this.startRound();
      case 'watch': { // watch another fixture, or stop watching (match: null); your own: back into it
        this.stopWatching(seat);
        const target = this.matches.find(x => x.id === m.match);
        if (!target) return;
        if (target.seats.includes(seat)) return target.catchUp(seat);
        target.spectators.add(seat);
        this.send(seat, target.syncState());
        return target.watchersChanged();
      }
      case 'emote': { // a quick face to everyone in the game you're playing or watching
        const match = this.matches.find(x => x.id === m.match);
        if (!match || !EMOTES.includes(m.e) || !match.audience().has(seat)) return;
        const now = Date.now();
        if (now - (seat.lastEmote || 0) < EMOTE_GAP) return;
        seat.lastEmote = now;
        return match.send({ t: 'emote', e: m.e, name: seat.name, seat: this.seatIndex(seat) });
      }
      case 'visible': // the page was hidden or shown (so we know whether a notification would help)
        seat.visible = !!m.visible;
        if (seat.visible) seat.notified = false;
        return;
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
    // Live: a short turn timer. Async single game: a long one. Async league or career: none, the round deadline covers it.
    return { target: this.target, pace: this.pace, turnTime: !this.async ? TURN_TIME : this.mode === 'game' ? ASYNC_TURN_TIME : null, variant: this.variant };
  }
  start(seat) {
    this.dropAbsentSeats(); // anyone who left (or, live, isn't here) doesn't play
    if (this.mode === 'league' && this.seats.length < 2) return this.error(seat, 'A league needs at least 2 players');
    if (this.mode === 'game' && this.variant === 'battle' && this.seats.length !== 2) return this.error(seat, 'A battle is for exactly 2 players');
    this.seats.forEach(s => { s.left = false; });
    this.disposeMatches(); clearTimeout(this.timer);
    if (this.mode === 'league') return this.startLeague();
    if (this.mode === 'career') return this.startCareer();
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
    // People play each other in the final rounds; their earlier games are against the bots
    const schedule = peopleLast(entries.map(e => !e.seat.cpu), roundRobin(entries.length));
    this.league = { entries, schedule, round: -1, results: [] };
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
  // Async: when the round's time is up, bots finish every game still going. A little before, people whose
  // games aren't done get a reminder.
  armRoundDeadline(at) {
    this.roundEndsAt = at;
    clearTimeout(this.timer); clearTimeout(this.reminder);
    this.timer = this.later(() => this.matches.forEach(m => m.finishWithBots()), at - Date.now());
    if (at - REMIND_BEFORE > Date.now()) this.reminder = this.later(() => this.remindUnfinished(), at - REMIND_BEFORE - Date.now());
  }
  remindUnfinished() {
    const h = Math.round(REMIND_BEFORE / 3600_000), mins = Math.max(1, Math.round(REMIND_BEFORE / 60_000));
    const left = h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : `${mins} minute${mins === 1 ? '' : 's'}`;
    for (const m of this.matches.filter(m => !m.over)) {
      for (const seat of m.seats) {
        const others = m.seats.filter(s => s !== seat).map(s => s.name).join(' and ');
        this.notify(seat, { title: `${left} left to play`,
          body: `Your game against ${others} isn't finished. After that, bots finish it for you.` }, { force: true });
      }
    }
  }

  // ---------- Notifications ----------
  // A push notification for someone not looking at the game (games at leisure only). Once sent, no more until
  // they come back, except reminders (force).
  notify(seat, msg, { force = false } = {}) {
    if (!this.async || this.restoring || !seat?.me || seat.cpu || seat.left || (seat.connected && seat.visible !== false)) return;
    if (seat.notified && !force) return;
    seat.notified = true;
    push.notify(seat.me, { ...msg, room: this.code });
  }
  // It's a person's turn (called by the match)
  turnWaiting(seat, m) {
    if (!this.async) return;
    const others = m.seats.filter(s => s !== seat).map(s => s.name).join(' and ');
    const when = this.mode === 'career' ? `${Career.stepName(this.career)}: ` : this.mode === 'league' ? `Round ${this.league.round + 1}: ` : '';
    this.notify(seat, { title: 'Your turn in Milkky', body: `${when}${when ? 'your' : 'Your'} game against ${others} is waiting for you.` });
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
    clearTimeout(this.timer); clearTimeout(this.reminder); this.roundEndsAt = null;
    if (lg.round >= lg.schedule.length - 1) {
      this.phase = 'over';
      this.dropAbsentSeats();
    } else {
      // A pause to look at the table before the next round (async: everyone's done, so no need to wait
      // for the deadline, but not straight away either). The host can skip it.
      const pause = this.async ? ASYNC_BETWEEN_ROUNDS : BETWEEN_ROUNDS;
      this.phase = 'between';
      this.nextRoundAt = Date.now() + pause;
      this.timer = this.later(() => this.startRound(), pause);
    }
    this.broadcastRoom();
  }

  // ---------- Career ----------
  startCareer() {
    this.league = null;
    this.career = Career.newCareer({ people: this.seats.filter(s => !s.cpu).map(s => s.pid), target: this.target, variant: this.variant });
    this.careerStats = {};
    this.startStep();
  }
  // The next step of the season: a match for each game with a person in it; if there are none (everyone's
  // out of the cup), it's simulated straight away.
  startStep() {
    clearTimeout(this.timer);
    const c = this.career;
    this.disposeMatches(); this.botSeats.clear();
    this.stepResults = {};
    const games = Career.fixtures(c).filter(Career.hasPerson);
    if (!games.length) return this.endStep();
    const step = Career.currentStep(c);
    this.phase = 'playing';
    this.matches = games.map(f => {
      // League games alternate who throws first; cup ties are a coin toss
      const first = step.kind === 'league' ? c.round % 2 : Math.random() < 0.5 ? 0 : 1;
      const m = new Match(this, `s${c.season}-${c.step + 1}-${f.key}`, [this.careerSeat(f.a), this.careerSeat(f.b)],
        { ...this.matchOptions(), first, onOver: m => this.careerGameOver(m) });
      m.fixture = f.key;
      return m;
    });
    this.armRoundDeadline(Date.now() + ROUND_TIME);
    this.broadcastRoom();
    this.matches.forEach(m => m.start());
  }
  careerGameOver(m) {
    const [pa, pb] = m.game.players;
    const aWon = m.game.winner ? m.game.winner === pa : pa.score >= pb.score;
    this.stepResults[m.fixture] = { sa: pa.score, sb: pb.score, aWon };
    // Each person's stats: the result, and the throws they made themselves
    const cup = Career.currentStep(this.career)?.kind === 'cup';
    m.seats.forEach((seat, i) => {
      if (!seat.pid) return;
      const other = m.seats[1 - i], me = m.game.players[i], them = m.game.players[1 - i];
      Stats.recordGame(this.statsFor(seat.pid), m.tally?.[i] || Stats.newTally(),
        { won: i === 0 ? aWon : !aWon, cup, opp: other.pid || other.bot, youOut: me.out, theyOut: them.out, battle: !!m.game.battle });
    });
    if (this.matches.every(x => x.over)) return this.endStep();
    this.broadcastRoom();
  }
  statsFor(pid) {
    const tier = Career.tierOf(this.career, pid);
    return (this.careerStats[pid] ||= Stats.emptyStats(this.career.season, tier < 0 ? Career.BOTTOM : tier));
  }
  // A throw in a career game (called by the match): it counts for a person's stats if they threw it themselves
  thrown(m, i, fallen, scoreBefore, own) {
    if (this.mode !== 'career' || !own || !m.seats[i].pid || m.game.battle) return;
    m.tally ||= {};
    Stats.recordThrow(m.tally[i] ||= Stats.newTally(), fallen, scoreBefore, m.game.target);
  }
  // Every played game is done: simulate the rest of the step, then pause (longer at the end of a season)
  endStep() {
    clearTimeout(this.timer); clearTimeout(this.reminder); this.roundEndsAt = null;
    Career.playStep(this.career, this.stepResults);
    this.stepResults = {};
    const pause = Career.seasonOver(this.career) ? SEASON_BREAK : ASYNC_BETWEEN_ROUNDS;
    this.phase = 'between';
    this.nextRoundAt = Date.now() + pause;
    this.timer = this.later(() => this.careerNext(), pause);
    this.broadcastRoom();
  }
  // After the pause: the next step, or, at the end of a season, the next season. People who have left are
  // replaced by bots, and anyone waiting comes in.
  careerNext() {
    const c = this.career;
    // Nobody left, or nobody's been for weeks: the career stops (and the room is tidied away in time, as usual)
    if (!this.seats.some(s => !s.cpu && !s.left) || Date.now() - this.lastVisit > CAREER_IDLE) {
      this.phase = 'over'; this.disposeMatches(); return this.broadcastRoom();
    }
    if (Career.seasonOver(c)) {
      const gone = this.seats.filter(s => s.left && s.pid);
      Career.nextSeason(c, Math.random, { remove: gone.map(s => s.pid) });
      for (const [pid, line] of Object.entries(c.summary.people)) Stats.recordSeason(this.statsFor(pid), line);
      gone.filter(s => !Career.inCareer(c, s.pid)).forEach(s => this.removeSeat(s));
      for (const s of this.seats) {
        const tier = Career.tierOf(c, s.pid);
        if (tier >= 0) this.notify(s, { title: `Season ${c.season} has started`, body: `You’re in the ${Career.tierName(tier)}. Your first game is ready.` });
      }
    }
    this.startStep();
  }

  // ---------- Saving and restoring ----------
  serialize() {
    const lg = this.league;
    // Seats are saved once; league entries and matches refer to them by position (or, for the filler, inline).
    const entryOf = seat => lg ? lg.entries.findIndex(e => e.seat === seat) : -1;
    const seatRef = seat => this.seats.includes(seat) ? { s: this.seatIndex(seat) } : seat.cpu === 'career' ? { bot: seat.bot } : { e: entryOf(seat) };
    return {
      v: 1, code: this.code, origin: this.origin, mode: this.mode, pace: this.pace, phase: this.phase, target: this.target, variant: this.variant,
      nextRoundAt: this.nextRoundAt || null, roundEndsAt: this.roundEndsAt || null, updatedAt: this.updatedAt, lastVisit: this.lastVisit,
      seats: this.seats.map(s => ({ name: s.name, cpu: s.cpu, bot: s.bot || null, token: s.token, me: s.me || null, left: !!s.left, pid: s.pid || null })),
      career: this.career, stepResults: this.stepResults, careerStats: this.careerStats,
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
    Object.assign(room, { origin: d.origin || null, mode: d.mode, pace: d.pace || 'live', phase: d.phase, target: d.target, variant: d.variant || 'classic', nextRoundAt: d.nextRoundAt,
      emptySince: Date.now(), updatedAt: d.updatedAt || Date.now(), lastVisit: d.lastVisit || Date.now(),
      career: d.career || null, stepResults: d.stepResults || {}, careerStats: d.careerStats || {} });
    room.seats = d.seats.map(s => ({ ...s, ws: null, connected: !!s.cpu, awaySince: back }));
    if (d.league) {
      room.league = {
        round: d.league.round, schedule: d.league.schedule, results: d.league.results,
        entries: d.league.entries.map(e => ({
          ...e, seat: e.seat.filler ? { ...e.seat.filler, connected: true, filler: true } : room.seats[e.seat.s],
        })),
      };
    }
    const seatOf = r => r.s != null ? room.seats[r.s] : r.bot ? room.careerBot(r.bot) : room.league.entries[r.e].seat;
    room.matches = d.matches.map(md => Match.restore(room, md, md.seats.map(seatOf),
      room.mode === 'career' ? m => room.careerGameOver(m)
        : md.fixture ? m => room.fixtureOver(m, md.fixture[0], md.fixture[1])
          : () => room.gameOver()));
    // Carry on: unfinished games continue, round timers resume, and live lobby seats that nobody comes
    // back for are let go as usual.
    room.restoring = true; // (turns picking up again aren't news: no notifications)
    room.matches.forEach(m => m.resume());
    room.restoring = false;
    if (room.phase === 'between') {
      room.timer = room.later(() => (room.mode === 'career' ? room.careerNext() : room.startRound()), d.nextRoundAt - Date.now());
    }
    if (room.phase === 'playing' && d.roundEndsAt) room.armRoundDeadline(d.roundEndsAt);
    if (!room.inProgress && !room.async) {
      for (const s of room.seats.filter(s => !s.cpu)) room.dropLater(s);
    }
    return room;
  }

  // ---------- Timers ----------
  // Everything a room does later goes through here. If it throws, the room is closed (and its save set aside,
  // see Room.onFail) rather than crashing the server, and crashing it again after every restart.
  later(fn, ms) { return setTimeout(() => this.safely(fn), Math.max(0, ms)); }
  safely(fn) {
    if (this.failed) return;
    try { fn(); } catch (err) {
      this.failed = true;
      console.error('room failed, closing it', this.code, err);
      try { this.broadcast({ t: 'error', msg: 'Something went wrong with this game, so it has been closed', code: 'gone' }); } catch {}
      Room.onFail(this);
    }
  }
  // Set by the server: take a failed room away
  static onFail = room => room.dispose();

  disposeMatches() { this.matches.forEach(m => m.dispose()); this.matches = []; }
  dispose() { clearTimeout(this.timer); clearTimeout(this.reminder); this.disposeMatches(); this.seats.forEach(s => clearTimeout(s.dropTimer)); }
}
