# Milkky game server

Runs online games: rooms, turns, and every throw's physics. Clients send a throw and get back a recording to play.
It imports the game code from `../src/shared/`, so deploy it alongside `src/`.

```
npm install
npm start          # PORT (default 8080), HOST (default 127.0.0.1)
npm test           # plays a full 2 people + 1 computer game against a real server
```

`GET /health` → `ok <n> rooms`. WebSocket at `/ws`. All messages are JSON with a `t` field.

## Client → server

| `t` | fields | notes |
|---|---|---|
| `create` | `name`, `leave?` | new room; you are the host |
| `join` | `code`, `name`, `leave?` | only before a game starts, max 4 seats |
| `rejoin` | `code`, `token` | after a refresh; token comes from `joined` |
| `leave` | | |
| `target` | `target` (20, 30 or 50) | host, outside a game |
| `addCpu` | `level` (`easy`/`medium`/`hard`) | host, outside a game |
| `removeCpu` | `seat` | host, outside a game |
| `start` | | host; also starts a rematch after `over` |
| `aim` | `aim`, `pull` | current thrower's live aim, relayed to others |
| `throw` | `dist` (m), `aim` (rad) | current thrower; clamped to 0.5–9.5 m and ±0.55 rad |

`leave?` on `create`/`join` is the `{ code, token }` of a seat held in another room. It is given up only once the new room has let you in.

## Server → client

| `t` | fields |
|---|---|
| `joined` | `code`, `token`, `you` (seat index) |
| `room` | `code`, `phase` (`lobby`/`playing`/`over`), `target`, `host`, `you`, `seats[{name, cpu, color, connected}]` |
| `start` | `game`, `poses` |
| `sync` | `game`, `poses`, `phase`, `turn` (sent on rejoin mid-game) |
| `turn` | `cur`, `cpu?{aim, target}` (lets clients animate the computer lining up) |
| `aim` | `aim`, `pull` |
| `throw` | `seat`, `dist`, `aim`, `fps`, `bodies`, `frames`, `fallen`, `msg`, `restand[[i, x, z]]`, `poses`, `game`, `over` |
| `error` | `msg` |

- `game`: `{ cur, target, winner (index or -1), players[{name, cpu, color, score, misses, out}] }`. In a `throw` message it is already updated: scores applied and `cur` moved to the next player.
- `poses`: one `[x, y, z, qx, qy, qz, qw]` per bottle, in bottle order.
- `frames`: recorded at `fps`. `bodies` lists which bodies moved (bottle index, `12` = stick); each frame is 7 numbers per listed body, in that order. Bottles not listed didn't move.
- After a `throw`, clients show the score for 1.3 s, stand the `restand` bottles up over 0.5 s, then snap to `poses`. The server times computer throws and rejects early throws to match.
