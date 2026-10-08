// Turn timer and computer stand-ins: running out of time, dropping out, and leaving mid-game.
import { startServer, checks, client, is, sleep } from './helpers.mjs';

const PORT = 8098;
// 2 s to throw; a disconnected player's turn waits 1 s
const srv = await startServer(PORT, { MILKKY_TURN_SECONDS: '2', MILKKY_AWAY_SECONDS: '1' });
const { check, finish } = checks(srv);

const A = client(PORT, 'Alice'), B = client(PORT, 'Bob');
await Promise.all([A.open, B.open]);
A.send({ t: 'create', name: 'Alice' });
const aJoined = await A.next(is('joined'));
B.send({ t: 'join', code: aJoined.code, name: 'Bob' });
const bJoined = await B.next(is('joined'));
A.send({ t: 'start' });
await A.next(is('start'));

// 1. Alice doesn't throw: the computer throws for her when time runs out.
const t0 = Date.now();
const first = await A.next(is('turn'));
check(first.cur === 0 && first.deadline > 1500 && !first.cpu, `Alice's turn comes with a deadline (${first.deadline} ms)`);
const stand = await A.next(m => m.t === 'turn' && m.cur === 0 && m.standIn);
check(Date.now() - t0 >= 1800, `after ${Date.now() - t0} ms the computer steps in for Alice`);
A.send({ t: 'throw', dist: 3.6, aim: 0 });
// (with animations off in tests the computer may already have thrown, so either refusal counts)
const late = (await A.next(is('error'))).msg;
check(late.startsWith('Too late') || late === 'Not your turn', `Alice can’t throw once the computer has taken her turn ("${late}")`);
check((await A.next(is('throw'))).seat === 0, 'the computer throws for Alice');

// 2. Bob drops on his turn: shown as away, and the computer throws after the short grace period.
await A.next(m => m.t === 'turn' && m.cur === 1 && !m.cpu);
B.ws.terminate();
const t1 = Date.now();
check((await A.next(m => m.t === 'status' && m.game.players[1].away)).game.players[1].away, 'Bob is shown as away');
await A.next(m => m.t === 'turn' && m.cur === 1 && m.standIn);
check(Date.now() - t1 < 1700, `the computer steps in for Bob after ${Date.now() - t1} ms, not the full turn time`);
await A.next(m => m.t === 'throw' && m.seat === 1);

// 3. Bob comes back and throws for himself again.
const B2 = client(PORT, 'Bob again'); await B2.open;
B2.send({ t: 'rejoin', code: aJoined.code, token: bJoined.token });
await B2.next(is('sync'));
check(!(await A.next(m => m.t === 'status' && !m.game.players[1].away)).game.players[1].away, 'Bob is back');
await A.next(m => m.t === 'turn' && m.cur === 0 && m.standIn); // Alice still isn't throwing
await A.next(m => m.t === 'throw' && m.seat === 0);
const bTurn = await B2.next(m => m.t === 'turn' && m.cur === 1);
check(!bTurn.cpu, 'Bob gets his own turn back');
B2.send({ t: 'throw', dist: 3.6, aim: 0 });
check((await B2.next(m => m.t === 'throw' || m.t === 'error')).t === 'throw', 'Bob throws');

// 4. Alice leaves: from now on the computer plays her turns straight away.
A.send({ t: 'leave' });
check((await B2.next(m => m.t === 'status' && m.game.players[0].left)).game.players[0].left, 'Alice is shown as having left');
let quick = true, aliceTurns = 0, over = false;
B2.onMessage = m => {
  if (m.t === 'turn' && m.cur === 1 && !m.cpu) B2.send({ t: 'throw', dist: 3.4 + Math.random() * 0.8, aim: (Math.random() - 0.5) * 0.1 });
  if (m.t === 'turn' && m.cur === 0) { aliceTurns++; if (!m.standIn) quick = false; }
  if (m.t === 'throw' && m.over) over = true;
};
for (let i = 0; i < 200 && !over; i++) await sleep(100);
check(over, 'the game still finishes');
check(quick && aliceTurns > 0, `every later turn of Alice's (${aliceTurns}) went straight to the computer`);
const room = await B2.next(m => m.t === 'room' && m.phase === 'over');
check(room.seats.length === 1 && room.seats[0].name === 'Bob', 'after the game, Alice’s seat is gone');

finish();
