import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';

const run = promisify(execFile);
const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-cli.js');

function setup(base, { expired = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-cc-'));
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ mall_id: 'testmall', access_token: 'access-1', refresh_token: 'refresh-1', access_expires_ms: expired ? Date.now() - 1000 : Date.now() + 3600_000 }));
  const env = {
    PATH: process.env.PATH,
    CAFE24_MALL_ID: 'testmall',
    CAFE24_CLIENT_ID: 'clientid123',
    CAFE24_CLIENT_SECRET: 'secretvalue123',
    CAFE24_REDIRECT_URI: 'https://testmall.cafe24.com',
    TEST_MOCK_API_BASE: base,
    CAFE24_TOKEN_FILE: tokenFile,
    CAFE24_ENV_FILE: path.join(dir, 'no.env'),
    CAFE24_HOME: dir,
    CAFE24_MIN_INTERVAL_MS: '1',
  };
  return { env, dir, tokenFile };
}
/** 테스트용: pid 프로세스가 잠금을 잡고 있는 상태를 만든다 (이름표 방식) */
function holdLock(file, pid, label) {
  fs.mkdirSync(`${file}.d`, { recursive: true });
  const t = path.join(`${file}.d`, `${pid}.held`);
  fs.writeFileSync(t, JSON.stringify({ pid, label, at: 'now' }));
  return () => fs.rmSync(t, { force: true });
}
const tickets = (file) => (fs.existsSync(`${file}.d`) ? fs.readdirSync(`${file}.d`) : []);
const cli = (args, env) => {
  const p = run('node', [HARNESS, ...args], { env, timeout: 60_000 });
  p.child.stdin.end();
  return p;
};

test('요청은 하나씩, 최소 간격을 두고 보낸다 (동시에 불러도)', async () => {
  const mock = await startMockServer({ slowAdminMs: 30 });
  try {
    const { Cafe24Client } = await import('../src/api.js');
    const cfg = { apiBase: mock.base, mallId: 'testmall', shopNo: 1, apiVersion: '' };
    const client = new Cafe24Client(cfg, { minIntervalMs: 100, getToken: async () => 'access-1' });
    await Promise.all(Array.from({ length: 6 }, () => client.get('/categories', {})));
    const times = mock.state.calls.filter((c) => c.path === '/api/v2/admin/categories').map((c) => c.at);
    assert.equal(times.length, 6);
    // 보낸 시각 기준 100ms 간격. 서버가 받은 시각은 네트워크 지연만큼 흔들리므로 여유를 둔다.
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 80, `간격 ${times[i] - times[i - 1]}ms`);
    assert.equal(mock.state.maxInflight, 1, '동시에 둘 이상 보내지 않음');
  } finally {
    await mock.close();
  }
});

test('토큰 갱신은 동시에 여러 요청이 와도 한 번만 (같은 프로세스)', async () => {
  const mock = await startMockServer({ refreshDelayMs: 200 });
  try {
    const { dir, tokenFile } = setup(mock.base, { expired: true });
    // 이 테스트 프로세스의 TOKEN_FILE을 임시 파일로 쓰는 별도 프로세스에서 확인
    const script = `
      import { __setTestApiBase } from ${JSON.stringify(path.resolve('src/config.js'))};
      __setTestApiBase(${JSON.stringify(mock.base)});
      const { getAccessToken } = await import(${JSON.stringify(path.resolve('src/auth.js'))});
      const cfg = { apiBase: ${JSON.stringify(mock.base)}, mallId: 'testmall', clientId: 'clientid123', clientSecret: 'secretvalue123' };
      const tokens = await Promise.all(Array.from({ length: 5 }, () => getAccessToken(cfg)));
      console.log(JSON.stringify(tokens));`;
    const out = await run('node', ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, CAFE24_TOKEN_FILE: tokenFile, CAFE24_HOME: dir, CAFE24_ENV_FILE: path.join(dir, 'no.env') } });
    assert.deepEqual(new Set(JSON.parse(out.stdout)), new Set(['access-2']));
    assert.equal(mock.state.refreshCount, 1);
  } finally {
    await mock.close();
  }
});

test('토큰 갱신은 두 프로세스가 동시에 해도 한 번만 (잠금 + 다시 읽기)', async () => {
  const mock = await startMockServer({ refreshDelayMs: 400 });
  try {
    const { env } = setup(mock.base, { expired: true });
    const [a, b] = await Promise.all([cli(['categories'], env), cli(['categories'], env)]);
    assert.match(a.stdout, /상의/);
    assert.match(b.stdout, /상의/);
    assert.equal(mock.state.refreshCount, 1, '두 번째 프로세스는 첫 번째가 받은 새 토큰을 씀');
  } finally {
    await mock.close();
  }
});

test('쓰기 잠금: 다른 프로세스가 쓰기 작업 중이면 시작하지 않고, 죽은 프로세스의 이름표는 무시한다', async () => {
  const mock = await startMockServer();
  try {
    const { env, dir } = setup(mock.base);
    const lockFile = path.join(dir, 'cafe24-dummy.write.lock');
    // 살아 있는 프로세스(이 테스트)가 잡고 있는 잠금
    const free = holdLock(lockFile, process.pid, 'delete');
    await assert.rejects(cli(['create', '-n', '1', '--no-image'], env), /다른 쓰기 작업이 실행 중입니다 \(delete, pid/);
    assert.ok(!mock.state.calls.some((c) => c.method === 'POST'));
    // 읽기 명령은 잠금과 상관없이 동작
    assert.match((await cli(['categories'], env)).stdout, /상의/);
    // dry-run도 동작
    assert.match((await cli(['create', '-n', '1', '--dry-run'], env)).stdout, /dry-run/);
    free();
    // 죽은 프로세스의 이름표는 무시하고 진행, 끝나면 내 이름표 정리
    holdLock(lockFile, 999999, 'old');
    const ok = await cli(['create', '-n', '1', '--no-image'], env);
    assert.match(ok.stdout, /성공 1개/);
    assert.deepEqual(tickets(lockFile), [], '끝나면 이름표가 남지 않음');
  } finally {
    await mock.close();
  }
});

test('잠금: 여러 프로세스가 동시에 잡으려 해도 한 번에 하나만 잡는다 (죽은 프로세스의 이름표가 있어도)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-lock-'));
  const lockFile = path.join(dir, 'x.lock');
  const logFile = path.join(dir, 'log.txt');
  holdLock(lockFile, 999999, 'crashed');
  const script = `
    import fs from 'node:fs';
    const { withLock } = await import(${JSON.stringify(path.resolve('src/lock.js'))});
    await withLock(${JSON.stringify(lockFile)}, 'p' + process.pid, async () => {
      fs.appendFileSync(${JSON.stringify(logFile)}, 'in ' + process.pid + '\\n');
      await new Promise((res) => setTimeout(res, 60));
      fs.appendFileSync(${JSON.stringify(logFile)}, 'out ' + process.pid + '\\n');
    }, { waitMs: 20000 });`;
  await Promise.all(Array.from({ length: 6 }, () => run('node', ['--input-type=module', '-e', script])));
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 12, '모두 한 번씩 잠금을 잡음');
  for (let i = 0; i < lines.length; i += 2) {
    const [a, pa] = lines[i].split(' ');
    const [b, pb] = lines[i + 1].split(' ');
    assert.ok(a === 'in' && b === 'out' && pa === pb, `겹쳐서 잡은 프로세스가 있음:\n${lines.join('\n')}`);
  }
  assert.deepEqual(tickets(lockFile), [], '이름표가 남지 않음 (죽은 프로세스의 것도 청소됨)');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['log.txt', 'x.lock.d'], '임시 파일이 남지 않음');
});

test('잠금 경쟁 재현: 이름표를 만든 직후 다른 프로세스가 끼어들어도 주인은 많아야 하나', async () => {
  const { tryLock } = await import('../src/lock.js');
  const alive = new Set();
  const isAlive = (pid) => alive.has(pid);
  const opts = (pid, hooks) => ({ pid, isAlive, hooks });
  const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c24-race-')), 'x.lock');

  // (1) A가 이름표를 만든 직후, 폴더를 읽기 전에 B와 C가 차례로 시도 → B·C는 A를 보고 물러나고 A만 잡는다
  {
    const file = fresh();
    holdLock(file, 999, 'crashed'); // 죽은 프로세스의 이름표
    alive.add(1001);
    const holders = [];
    const A = tryLock(file, 'A', opts(1001, {
      afterTicketCreated: () => {
        for (const [pid, l] of [[1002, 'B'], [1003, 'C']]) {
          alive.add(pid);
          if (tryLock(file, l, opts(pid)).release) holders.push(l);
        }
      },
    }));
    if (A.release) holders.push('A');
    assert.deepEqual(holders, ['A']);
    A.release();
    assert.deepEqual(tickets(file), []);
  }

  // (2) A와 B가 둘 다 이름표를 만든 뒤 각자 폴더를 읽는다 → 두 사람의 읽기 모두 상대 이름표를 보고 물러남
  //     (A가 읽기 직전에 B의 이름표가 생기고, B가 읽을 때도 A의 이름표가 그대로 있는 순서를 강제로 만든다)
  {
    const file = fresh();
    alive.add(2001).add(2002);
    const bTicket = path.join(`${file}.d`, '2002.pending'); // B가 이름표만 만들고 아직 읽지 않은 상태
    const A = tryLock(file, 'A', opts(2001, {
      afterTicketCreated: () => fs.writeFileSync(bTicket, JSON.stringify({ pid: 2002, label: 'B' })),
    }));
    assert.ok(!A.release, 'A는 B의 이름표를 보고 물러남');
    // 이번에는 A가 이름표만 만든 상태에서 B가 읽는다
    const aTicket = path.join(`${file}.d`, '2001.pending');
    fs.writeFileSync(aTicket, JSON.stringify({ pid: 2001, label: 'A' }));
    fs.rmSync(bTicket);
    const B = tryLock(file, 'B', opts(2002));
    assert.ok(!B.release, 'B도 A의 이름표를 보고 물러남');
    fs.rmSync(aTicket);
    assert.deepEqual(tickets(file), [], '물러날 때 자기 이름표를 지움');
    // 경쟁이 끝나면 다시 시도해서 잡을 수 있다
    const A2 = tryLock(file, 'A', opts(2001));
    assert.ok(A2.release);
    A2.release();
  }

  // (3) 잠금 주인이 오래 멈춰 있어도(시간과 상관없이) 살아 있으면 다른 프로세스는 그 이름표를 지우지 않고 물러난다
  {
    const file = fresh();
    alive.add(3001).add(3002);
    const A = tryLock(file, 'A', opts(3001));
    assert.ok(A.release);
    const mine = tickets(file);
    fs.utimesSync(path.join(`${file}.d`, mine[0]), new Date(0), new Date(0)); // 아주 오래된 것처럼
    const B = tryLock(file, 'B', opts(3002));
    assert.ok(!B.release);
    assert.equal(B.holder.label, 'A');
    assert.deepEqual(tickets(file), mine, 'A의 이름표는 그대로');
    // A가 죽으면 B가 잡을 수 있다 (A의 이름표는 무시·청소)
    alive.delete(3001);
    const B2 = tryLock(file, 'B', opts(3002));
    assert.ok(B2.release);
    B2.release();
  }
});

test('늦게 받은 401: 다른 프로세스가 이미 갱신했으면 다시 갱신하지 않고 새 토큰으로 한 번 더 보낸다', async () => {
  const mock = await startMockServer();
  try {
    const { dir, tokenFile } = setup(mock.base);
    mock.state.validToken = 'access-2'; // 다른 프로세스가 이미 갱신해서 access-1은 더 이상 안 통함
    const script = `
      import fs from 'node:fs';
      import { __setTestApiBase } from ${JSON.stringify(path.resolve('src/config.js'))};
      __setTestApiBase(${JSON.stringify(mock.base)});
      const { getAccessToken } = await import(${JSON.stringify(path.resolve('src/auth.js'))});
      const { Cafe24Client } = await import(${JSON.stringify(path.resolve('src/api.js'))});
      const cfg = { apiBase: ${JSON.stringify(mock.base)}, mallId: 'testmall', shopNo: 1, apiVersion: '', clientId: 'clientid123', clientSecret: 'secretvalue123' };
      let first = true;
      const client = new Cafe24Client(cfg, { minIntervalMs: 1, getToken: async (c, o) => {
        const t = await getAccessToken(c, o);
        if (first) {
          first = false; // access-1로 보낸 요청이 401을 받기 전에, 다른 프로세스가 파일을 access-2로 바꿔 둔 상황
          fs.writeFileSync(${JSON.stringify(tokenFile)}, JSON.stringify({ mall_id: 'testmall', access_token: 'access-2', refresh_token: 'refresh-1', access_expires_ms: Date.now() + 3600_000 }));
        }
        return t;
      } });
      const r = await client.get('/categories', {});
      console.log(Array.isArray(r.categories) ? 'OK' : 'BAD');`;
    const out = await run('node', ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, CAFE24_TOKEN_FILE: tokenFile, CAFE24_HOME: dir, CAFE24_ENV_FILE: path.join(dir, 'no.env') } });
    assert.equal(out.stdout.trim(), 'OK');
    assert.equal(mock.state.refreshCount, 0, '이미 갱신된 토큰을 그대로 씀');
    const auths = mock.state.calls.filter((c) => c.path === '/api/v2/admin/categories').length;
    assert.equal(auths, 2, '401 뒤 한 번만 다시 보냄');
  } finally {
    await mock.close();
  }
});
