# Milkky game server

Runs online games: rooms, turns, and every throw's physics. Clients send a throw and get back a recording to play.
A room plays either a single game or a league (everyone plays everyone once, each round's fixtures at the same time).
It imports the game code from `../src/shared/`, so deploy it alongside `src/`.

```
npm install
npm start          # PORT (default 8080), HOST (default 127.0.0.1)
npm test           # single game, computer stand-ins, and a full league, against a real server
```

`GET /health` → `ok <n> rooms`. WebSocket at `/ws`. All messages are JSON with a `t` field.

Settings for testing (environment): `MILKKY_ANIM_SCALE` (0 skips animation waits), `MILKKY_TURN_SECONDS` (45),
`MILKKY_AWAY_SECONDS` (10), `MILKKY_BETWEEN_SECONDS` (20, between league rounds).

## Code

- `room.js`: lobby, seats, single game or league (schedule, rounds, table).
- `match.js`: one game: physics world, turns, turn timer, computer stand-ins.
- `sim.js`: runs a throw to rest and records it.

## Client → server

| `t` | fields | notes |
|---|---|---|
| `create` | `name`, `leave?` | new room; you are the host |
| `join` | `code`, `name`, `leave?` | only between games; 4 seats for a game, 8 for a league |
| `rejoin` | `code`, `token` | after a refresh; token comes from `joined` |
| `leave` | | during a game or league, the computer plays your seat from then on |
| `mode` | `mode` (`game`/`league`) | host, between games |
| `target` | `target` (20, 30 or 50) | host, between games |
| `addCpu` | `level` (`easy`/`medium`/`hard`) | host, between games |
| `removeCpu` | `seat` | host, between games |
| `start` | | host; also starts a rematch or a new league |
| `next` | | host: start the next league round now |
| `watch` | `match` (or null to stop) | watch another fixture; replies with its `sync` |
| `aim` | `aim`, `pull` | current thrower's live aim, relayed to others |
| `throw` | `dist` (m), `aim` (rad) | current thrower; clamped to 0.5–9.5 m and ±0.55 rad |

`leave?` on `create`/`join` is the `{ code, token }` of a seat held in another room. It is given up only once the new room has let you in.

## Server → client

| `t` | fields |
|---|---|
| `joined` | `code`, `token`, `you` (seat index) |
| `room` | `code`, `mode`, `phase`, `target`, `host`, `you`, `maxSeats`, `seats[{name, cpu, color, connected, left}]`, `league`, `fixtures` |
| `fixtures` | `fixtures` (live scores, league only, after every throw) |
| `start` | `match`, `game`, `poses` (sent to the match's players) |
| `sync` | `match`, `game`, `poses`, `over`, `turn` (on rejoin, or when you start watching) |
| `turn` | `match`, `cur`, `deadline?` (ms left), `cpu?{aim, target}`, `standIn?` |
| `status` | `match`, `game` (someone dropped, came back or left) |
| `aim` | `match`, `aim`, `pull` |
| `throw` | `match`, `seat`, `dist`, `aim`, `fps`, `bodies`, `frames`, `fallen`, `msg`, `restand[[i, x, z]]`, `poses`, `game`, `over` |
| `error` | `msg` |

- `phase`: single game `lobby` → `playing` → `over`; league `lobby` → `playing` ⇄ `between` → `over`.
- `game`: `{ cur, target, winner (index or -1), players[{name, cpu, color, score, misses, out, seat, away, left}] }`. In a `throw` message it is already updated: scores applied and `cur` moved to the next player.
- `league`: `{ round, rounds, table[{name, seat, cpu, left, P, W, L, PF, PA}], results, nextRoundIn }` (ms). `fixtures`: `[{ id, over, cur, winner, seats, players[{name, score, out}] }]`.
- `turn` with `cpu` is a computer throwing: a computer player, or a stand-in (`standIn`) for a person who ran out of time, is disconnected, or left.
- `poses`: one `[x, y, z, qx, qy, qz, qw]` per bottle, in bottle order.
- `frames`: recorded at `fps`. `bodies` lists which bodies moved (bottle index, `12` = stick); each frame is 7 numbers per listed body, in that order. Bottles not listed didn't move.
- After a `throw`, clients show the score for 1.3 s, stand the `restand` bottles up over 0.5 s, then snap to `poses`. The server times computer throws and rejects early throws to match.
