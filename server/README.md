# Milkky game server

Runs online games: rooms, turns, and every throw's physics. Clients send a throw and get back a recording to play.
A room plays either a single game or a league (everyone plays everyone once, each round's fixtures at the same time),
at one of two paces: `live` (everyone plays together now) or `async` ("take your time": turns whenever suits, over days;
seats are kept while people are away, a league round lasts up to a day and moves on as soon as its games are done,
bots finish games still going at the deadline, and returning players first watch the throws they missed).
Each browser has a player key (`me`), sent when creating or joining, which finds all your games across rooms.
It imports the game code from `../src/shared/`, so deploy it alongside `src/`.

```
npm install
npm start          # PORT (default 8080), HOST (default 127.0.0.1)
npm test           # single game, stand-ins, live league, restarting mid-game, and an async league, against a real server
```

`GET /health` → `ok <n> rooms`. WebSocket at `/ws`. All messages are JSON with a `t` field.

Games are saved to disk (one JSON file per room) and picked up again after a restart or deploy. The folder is
`MILKKY_DATA_DIR`, else systemd's `STATE_DIRECTORY` (see `deploy/milkky-server@.service`), else `server/data`.

Settings for testing (environment): `MILKKY_ANIM_SCALE` (0 skips animation waits), `MILKKY_TURN_SECONDS` (45),
`MILKKY_AWAY_SECONDS` (10), `MILKKY_BETWEEN_SECONDS` (20, between live league rounds), `MILKKY_ASYNC_BETWEEN_SECONDS`
(120, between async league rounds), `MILKKY_ROUND_SECONDS`
(86400, longest async league round), `MILKKY_ASYNC_TURN_HOURS` (48, async single game).

## Code

- `room.js`: lobby, seats, single game or league (schedule, rounds, table).
- `match.js`: one game: physics world, turns, turn timer, computer stand-ins.
- `sim.js`: runs a throw to rest and records it.
- `store.js`: saves rooms to disk and loads them at startup.

## Client → server

| `t` | fields | notes |
|---|---|---|
| `create` | `name`, `me`, `leave?` | new room; you are the host |
| `join` | `code`, `name`, `me`, `leave?` | only between games; 4 seats for a game, 8 for a league (already in it: back to your seat) |
| `rejoin` | `code`, `token` or `me` | after a refresh (token from `joined`), or opening a game from My games (`me`) |
| `mine` | `me` | your games across all rooms (any time, in a room or not) |
| `leave` | | during a game or league, the computer plays your seat from then on |
| `detach` | | step away from an async game, keeping your seat |
| `pace` | `pace` (`live`/`async`) | host, between games |
| `mode` | `mode` (`game`/`league`) | host, between games |
| `target` | `target` (20, 30 or 50) | host, between games |
| `addCpu` | `level` (`easy`/`medium`/`hard`) | host, between games |
| `removeCpu` | `seat` | host, between games |
| `start` | | host; also starts a rematch or a new league |
| `next` | | host: start the next league round now |
| `watch` | `match` (or null to stop) | watch another fixture; replies with its `sync` (your own match: back into it) |
| `aim` | `aim`, `pull` | current thrower's live aim, relayed to others |
| `throw` | `dist` (m), `aim` (rad) | current thrower; clamped to 0.5–9.5 m and ±0.55 rad |

`leave?` on `create`/`join` is the `{ code, token }` of a seat held in another room. It is given up only once the new room has let you in.

## Server → client

| `t` | fields |
|---|---|
| `joined` | `code`, `token`, `you` (seat index) |
| `mine` | `games[{code, mode, pace, phase, target, you, host, players, league?{round, rounds, roundEndsIn, place}, match?{yourTurn, turnOf, unseen, deadline, over, players}}]` |
| `room` | `code`, `mode`, `pace`, `phase`, `target`, `host`, `you`, `maxSeats`, `seats[{name, cpu, color, connected, left}]`, `league`, `fixtures` |
| `fixtures` | `fixtures` (live scores, league only, after every throw) |
| `start` | `match`, `game`, `poses` (sent to the match's players) |
| `sync` | `match`, `game`, `poses`, `over`, `turn`, `replay?` (on rejoin, or when you start watching; with `replay` the `throw`s you missed follow, then the current `turn`) |
| `turn` | `match`, `cur`, `deadline?` (ms left), `cpu?{aim, target}`, `standIn?` |
| `status` | `match`, `game` (someone dropped, came back or left) |
| `aim` | `match`, `aim`, `pull` |
| `throw` | `match`, `seq`, `seat`, `dist`, `aim`, `fps`, `bodies`, `frames`, `fallen`, `hit` (`{num, top}` the stick's first bottle touch, or null), `msg`, `restand[[i, x, z]]`, `poses`, `game`, `over` |
| `error` | `msg` |

- `phase`: single game `lobby` → `playing` → `over`; league `lobby` → `playing` ⇄ `between` → `over`.
- `game`: `{ cur, target, winner (index or -1), players[{name, cpu, color, score, misses, out, seat, away, left}] }`. In a `throw` message it is already updated: scores applied and `cur` moved to the next player.
- `league`: `{ round, rounds, table[{name, seat, cpu, left, P, W, L, PF, PA}], results, nextRoundIn, roundEndsIn }` (ms). `fixtures`: `[{ id, over, cur, winner, seats, players[{name, score, out}] }]`.
- `turn` with `cpu` is a computer throwing: a computer player, or a stand-in (`standIn`) for a person who ran out of time, is disconnected, or left.
- `poses`: one `[x, y, z, qx, qy, qz, qw]` per bottle, in bottle order.
- `frames`: recorded at `fps`. `bodies` lists which bodies moved (bottle index, `12` = stick); each frame is 7 numbers per listed body, in that order. Bottles not listed didn't move.
- After a `throw`, clients show the score for 1.3 s, stand the `restand` bottles up over 0.5 s, then snap to `poses`. The server times computer throws and rejects early throws to match.
