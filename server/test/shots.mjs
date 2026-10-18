// Shared shots: share a recording and get an id, fetch it back by id, and the checks (malformed recordings, unknown
// ids, big messages that aren't shots, and the limit on how many one address can share).
import { startServer, checks, client, is } from './helpers.mjs';

const PORT = 8088;
const srv = await startServer(PORT, { MILKKY_SHARES_PER_HOUR: '3' });
const { check, finish } = checks(srv, 60_000);
const c = client(PORT, 'c');
await c.open;
const ask = async (msg, reply) => { c.send(msg); return c.next(is(reply)); };

// A recording like the game makes: 12 bottles; the stick (body 12) and bottle 3 moving for 2 seconds
const pose = (x, z) => [x, 0.075, z, 0, 0, 0, 1];
const before = Array.from({ length: 12 }, (_, i) => pose((i % 4) * 0.16, -3.6 - Math.floor(i / 4) * 0.14));
const frames = Array.from({ length: 61 }, (_, k) => [...pose(0, -0.15 - k * 0.06), ...pose(0.32, -3.6 + k * 0.001)]);
const rec = { v: 1, fps: 30, before, hidden: [], bodies: [12, 2], frames, variant: 'classic', players: 2, when: Date.now() };

const shared = await ask({ t: 'shareShot', shot: { rec, label: 'Skittled! All 12!', who: 'Alice <b>' } }, 'sharedShot');
check(/^[A-Z2-9]{6}$/.test(shared.id || ''), `a shot is shared and gets an id (${shared.id})`);
const got = await ask({ t: 'getShot', id: shared.id }, 'shot');
check(got.shot && JSON.stringify(got.shot.rec.frames) === JSON.stringify(frames) && got.shot.label === 'Skittled! All 12!' && got.shot.who === 'Alice b',
  'fetching it by id gives the same recording back (and its names cleaned up)');
check((await ask({ t: 'getShot', id: 'ZZZZZZ' }, 'shot')).shot === null, 'an unknown id gives nothing');
check((await ask({ t: 'getShot', id: '../../etc' }, 'shot')).shot === null, 'and so does a made-up one');
check((await ask({ t: 'shareShot', shot: { rec: { ...rec, frames: frames.map(f => f.slice(1)) } } }, 'sharedShot')).id === null, 'a malformed recording isn’t kept');
check((await ask({ t: 'shareShot', shot: { rec: { ...rec, bodies: [99] } } }, 'sharedShot')).id === null, 'nor one with bodies that don’t exist');
// Big messages are only allowed for shots
c.send({ t: 'mine', me: 'x'.repeat(5000) });
c.send({ t: 'getShot', id: shared.id });
const next = await c.next(m => m.t === 'mine' || m.t === 'shot');
check(next.t === 'shot', 'a big message that isn’t a shot is ignored');
// The hourly limit (3 for this test): one shared already, two more allowed, then no
const more = [];
for (let k = 0; k < 3; k++) more.push(await ask({ t: 'shareShot', shot: { rec, label: `Shot ${k}` } }, 'sharedShot'));
check(more[0].id && more[1].id && !more[2].id && /a lot of shots/.test(more[2].msg), `one address can only share so many an hour ("${more[2].msg}")`);
finish();
