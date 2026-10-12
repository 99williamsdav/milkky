# Milkky game server

Runs online games: rooms, turns, and every throw's physics. Clients send a throw and get back a recording to play.
A room plays either a single game or a league (everyone plays everyone once, each round's fixtures at the same time),
at one of two paces: `live` (everyone plays together now) or `async` ("take your time": turns whenever suits, over days;
seats are kept while people are away, a league round lasts up to a day and moves on as soon as its games are done,
bots finish games still going at the deadline, and returning players first watch the throws they missed).
A room can also hold a career (always `async`): the people join three leagues of the roster's bots, with promotion,
relegation and a cup, season after season (rules in `../src/shared/career.js`). Each step of a season (a league round or
a cup round) plays the games with a person in them for real and simulates the rest. People can join at any time and
start the next season in the Sunday League; anyone who leaves is played by a bot, then replaced by one when the season
ends. A career stops if everyone has left or nobody has visited for `MILKKY_CAREER_IDLE_DAYS` (30).
Each browser has a player key (`me`), sent when creating or joining, which finds all your games across rooms.
It imports the game code from `../src/shared/`, so deploy it alongside `src/`.

```
npm install
npm start          # PORT (default 8080), HOST (default 127.0.0.1)
npm test           # career rules, an online career, push notifications, single game, stand-ins, live league, restarting mid-game, an async league, and robustness
```

`GET /health` → `ok <n> rooms`. WebSocket at `/ws`. All messages are JSON with a `t` field.

Games are saved to disk (one JSON file per room) and picked up again after a restart or deploy. The folder is
`MILKKY_DATA_DIR`, else systemd's `STATE_DIRECTORY` (see `deploy/milkky-server@.service`), else `server/data`.
If a room throws while carrying on by itself (a timer: a computer's throw, the next round), it is closed and its
save renamed to `CODE.json.bad`, so one broken room can't take the server down (or keep doing so after each restart).

Limits: each connection may send 20 messages a second (bursts of 60; the rest are dropped), and one address can have
`MILKKY_ROOMS_PER_ADDRESS` (20) rooms it created open at once (behind nginx, the address is the last `X-Forwarded-For`
entry). A room is closed as soon as nobody has a seat in it.

Settings for testing (environment): `MILKKY_ANIM_SCALE` (0 skips animation waits), `MILKKY_TURN_SECONDS` (45),
`MILKKY_AWAY_SECONDS` (10), `MILKKY_BETWEEN_SECONDS` (20, between live league rounds), `MILKKY_ASYNC_BETWEEN_SECONDS`
(120, between async league rounds), `MILKKY_ROUND_SECONDS`
(86400, longest async league round or career step), `MILKKY_ASYNC_TURN_HOURS` (48, async single game),
`MILKKY_SEASON_BREAK_SECONDS` (900, between career seasons).

## Push notifications

For games played at leisure, people who aren't looking get a notification when it's their turn (once, until they
come back), when an async round is about to run out with their game unfinished (`MILKKY_REMIND_HOURS`, 3, before the
deadline), and when a new career season starts. Browsers subscribe through `src/sw.js`; subscriptions are kept by
player key in `push.json` in the data folder. Push needs a VAPID key pair, generated once:

```
npx web-push generate-vapid-keys
```

then in `/etc/milkky/<env>.env`: `MILKKY_VAPID_PUBLIC=...`, `MILKKY_VAPID_PRIVATE=...` and
`MILKKY_VAPID_SUBJECT=mailto:you@example.com`. Without them push is off and the game doesn't offer it.
(Tests set `MILKKY_PUSH_LOG` to log notifications to a file instead.)

## Code

- `room.js`: lobby, seats, single game, league (schedule, rounds, table) or career (steps, seasons).
- `match.js`: one game: physics world, turns, turn timer, computer stand-ins.
- `sim.js`: runs a throw to rest and records it.
- `store.js`: saves rooms to disk and loads them at startup.
- `push.js`: push subscriptions, and sending notifications.

## Client → server

| `t` | fields | notes |
|---|---|---|
| `create` | `name`, `me`, `leave?` | new room; you are the host |
| `join` | `code`, `name`, `me`, `leave?` | only between games (a career: any time); 4 seats for a game, 8 for a league, 16 for a career (already in it: back to your seat) |
| `rejoin` | `code`, `token` or `me` | after a refresh (token from `joined`), or opening a game from My games (`me`) |
| `mine` | `me` | your games across all rooms (any time, in a room or not) |
| `pushKey` | | the key to subscribe to notifications with (any time) |
| `pushSubscribe` | `me`, `sub` (the browser's PushSubscription as JSON) | notifications for this device (any time) |
| `pushUnsubscribe` | `me`, `endpoint` | no more notifications for this device |
| `visible` | `visible` | in a room: the page was hidden or shown (only people not looking are notified) |
| `leave` | | during a game or league, the computer plays your seat from then on |
| `detach` | | step away from an async game, keeping your seat |
| `pace` | `pace` (`live`/`async`) | host, between games |
| `mode` | `mode` (`game`/`league`/`career`) | host, between games; a career is `async` and removes added bots |
| `target` | `target` (20, 30 or 50) | host, between games |
| `addCpu` | `level` (`easy`/`medium`/`hard`) | host, between games (not in a career) |
| `removeCpu` | `seat` | host, between games |
| `start` | | host; also starts a rematch or a new league |
| `next` | | host: start the next league round (or career step) now |
| `watch` | `match` (or null to stop) | watch another fixture; replies with its `sync` (your own match: back into it) |
| `aim` | `aim`, `pull` | current thrower's live aim, relayed to others |
| `emote` | `match`, `e` (`smile`/`laugh`/`sad`/`angry`) | a quick face to everyone playing or watching that game (at most one every 0.6 s) |
| `throw` | `dist` (m), `aim` (rad) | current thrower; clamped to 0.5–9.5 m and ±0.55 rad |

`leave?` on `create`/`join` is the `{ code, token }` of a seat held in another room. It is given up only once the new room has let you in.

## Server → client

| `t` | fields |
|---|---|
| `joined` | `code`, `token`, `you` (seat index) |
| `pushKey` | `key` (null: push is off) |
| `pushSubscribed` | `ok` |
| `mine` | `games[{code, mode, pace, phase, target, you, host, players, league?{round, rounds, roundEndsIn, place}, career?{season, step, steps, waiting, tier, place, stepEndsIn}, match?{yourTurn, turnOf, unseen, deadline, over, players}}]` |
| `room` | `code`, `mode`, `pace`, `phase`, `target`, `host`, `you`, `maxSeats`, `seats[{name, cpu, color, connected, left}]`, `league`, `career?{state, people{[id]: {name, seat, left}}, you, nextStepIn, stepEndsIn}` (`state` is the shared career state; people's ids start with `@`), `fixtures` (career: each with its `key`) |
| `fixtures` | `fixtures` (live scores, league or career, after every throw) |
| `start` | `match`, `game`, `poses` (sent to the match's players) |
| `sync` | `match`, `game`, `poses`, `over`, `turn`, `watchers`, `replay?` (on rejoin, or when you start watching; with `replay` the `throw`s you missed follow, then the current `turn`) |
| `turn` | `match`, `cur`, `deadline?` (ms left), `cpu?{aim, target}`, `standIn?` |
| `status` | `match`, `game` (someone dropped, came back or left) |
| `watchers` | `match`, `names` (who is watching this game; sent to its players and watchers when it changes) |
| `aim` | `match`, `aim`, `pull` |
| `emote` | `match`, `e`, `name`, `seat` (someone in the game, or watching it, sent a face) |
| `throw` | `match`, `seq`, `seat`, `dist`, `aim`, `fps`, `bodies`, `frames`, `fallen`, `hit` (`{num, top}` the stick's first bottle touch, or null), `needle` (`{a, b, gap}` the narrowest gap between standing bottles it passed through before touching any, or null), `msg`, `restand[[i, x, z]]`, `poses`, `game`, `over` |
| `error` | `msg` |

- `phase`: single game `lobby` → `playing` → `over`; league `lobby` → `playing` ⇄ `between` → `over`.
- `game`: `{ cur, target, winner (index or -1), players[{name, cpu, color, score, misses, out, seat, away, left}] }`. In a `throw` message it is already updated: scores applied and `cur` moved to the next player.
- `league`: `{ round, rounds, table[{name, seat, cpu, left, P, W, L, PF, PA}], results, nextRoundIn, roundEndsIn }` (ms). `fixtures`: `[{ id, over, cur, winner, seats, players[{name, score, out}] }]`.
- `turn` with `cpu` is a computer throwing: a computer player, or a stand-in (`standIn`) for a person who ran out of time, is disconnected, or left.
- `poses`: one `[x, y, z, qx, qy, qz, qw]` per bottle, in bottle order.
- `frames`: recorded at `fps`. `bodies` lists which bodies moved (bottle index, `12` = stick); each frame is 7 numbers per listed body, in that order. Bottles not listed didn't move.
- After a `throw`, clients show the score for 1.3 s, stand the `restand` bottles up over 0.5 s, then snap to `poses`. The server times computer throws and rejects early throws to match.
