import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-cli.js');
const SECRET = 'secretvalue123';

/** UI 서버를 테스트 실행기로 띄운다 (도구와 상관없는 임시 폴더에서). */
async function startUi(mock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-ui-'));
  const urlFile = path.join(dir, 'launch-url');
  const env = {
    TEST_UI_URL_FILE: urlFile, // 테스트 실행기만 쓰는 값: 토큰이 든 주소를 화면 대신 이 파일로 받음
    PATH: process.env.PATH,
    HOME: dir,
    CAFE24_HOME: path.join(dir, 'data'),
    TEST_MOCK_API_BASE: mock.base,
    TEST_FAKE_DNS: '1',
    CAFE24_MIN_INTERVAL_MS: '1',
  };
  const child = spawn('node', [HARNESS, 'ui', '--no-open'], { env, cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const m = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`UI 서버가 뜨지 않음: ${out}`)), 15_000);
    const check = () => {
      const r = fs.existsSync(urlFile) && /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]{64})/.exec(fs.readFileSync(urlFile, 'utf8'));
      if (r) {
        clearTimeout(t);
        resolve(r);
      } else setTimeout(check, 50);
    };
    check();
  });
  const base = `http://127.0.0.1:${m[1]}`;
  const responses = [];
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Session-Token': m[2], ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    responses.push(text);
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* html 등 */
    }
    return { status: res.status, data, headers: res.headers, text };
  };
  return { base, port: Number(m[1]), token: m[2], dir, env, call, responses, output: () => out, stop: () => child.kill() };
}

function rawRequest(port, { method = 'GET', path: p = '/api/state', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitJob(ui) {
  for (let i = 0; i < 200; i++) {
    const { data } = await ui.call('GET', '/api/job');
    if (data.job && data.job.status !== 'running') return data.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('작업이 끝나지 않음');
}

async function connectAndLogin(ui) {
  const saved = await ui.call('POST', '/api/config', { mall: 'https://testmall.cafe24.com/admin', clientId: 'clientid123', clientSecret: SECRET, redirectUri: 'https://testmall.cafe24.com' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.data.saved, true);
  const start = await ui.call('POST', '/api/login/start', {});
  const state = new URL(start.data.authorizeUrl).searchParams.get('state');
  const done = await ui.call('POST', '/api/login/complete', { url: `https://testmall.cafe24.com/?code=good-code&state=${state}` });
  assert.equal(done.status, 200, done.text);
}

test('UI 서버 보안: 토큰·Host·Origin·Sec-Fetch-Site·Content-Type·크기 검사, CORS 없음, CSP 있음', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    const page = await fetch(`${ui.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*script-src 'self'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.doesNotMatch(await page.text(), /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, '외부 자원 없음');
    assert.doesNotMatch(ui.output(), new RegExp(`${ui.token}|#token=`), '터미널 출력에 토큰이 없음');
    assert.match(ui.output(), /UI 서버를 열었습니다: http:\/\/127\.0\.0\.1:\d+ /);

    assert.equal((await fetch(`${ui.base}/api/state`)).status, 401, '토큰 없음');
    assert.equal((await fetch(`${ui.base}/api/state`, { headers: { 'X-Session-Token': 'x'.repeat(64) } })).status, 401, '틀린 토큰');
    assert.equal((await rawRequest(ui.port, { headers: { Host: 'evil.example', 'X-Session-Token': ui.token } })).status, 421, 'Host 위조');
    assert.equal((await rawRequest(ui.port, { headers: { Host: `127.0.0.1:${ui.port}`, Origin: 'https://evil.example', 'X-Session-Token': ui.token } })).status, 403, '다른 출처');
    assert.equal((await rawRequest(ui.port, { headers: { Host: `127.0.0.1:${ui.port}`, 'Sec-Fetch-Site': 'cross-site', 'X-Session-Token': ui.token } })).status, 403, 'cross-site');
    const jsonx = await rawRequest(ui.port, { method: 'POST', path: '/api/config', headers: { Host: `127.0.0.1:${ui.port}`, 'X-Session-Token': ui.token, 'Content-Type': 'application/jsonx' }, body: '{}' });
    assert.equal(jsonx.status, 415, '비슷한 이름의 형식도 거부');
    const plain = await rawRequest(ui.port, { method: 'POST', path: '/api/config', headers: { Host: `127.0.0.1:${ui.port}`, 'X-Session-Token': ui.token, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
    const big = await rawRequest(ui.port, { method: 'POST', path: '/api/config', headers: { Host: `127.0.0.1:${ui.port}`, 'X-Session-Token': ui.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
    assert.equal(big.status, 413);
    const ok = await ui.call('GET', '/api/state');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 전체 흐름: 연결 → 로그인 → 채우기 → 현황 → 정리 (Secret·코드·토큰은 어떤 응답에도 없음)', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    // 없는 쇼핑몰은 확인을 받는다
    const nf = await ui.call('POST', '/api/config', { mall: 'nosuchshop', clientId: 'clientid123', clientSecret: SECRET });
    assert.equal(nf.data.needsConfirm, true);
    assert.match(nf.data.warning, /찾을 수 없습니다/);

    await connectAndLogin(ui);
    const envFile = path.join(ui.env.CAFE24_HOME, '.env');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const st = await ui.call('GET', '/api/state');
    assert.equal(st.data.config.secret, 'file');
    assert.equal(st.data.login.mallId, 'testmall');

    // 틀린 로그인 URL은 안내만
    await ui.call('POST', '/api/login/start', {});
    const bad = await ui.call('POST', '/api/login/complete', { url: 'https://testmall.cafe24.com/?code=good-code&state=deadbeef' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /state 불일치/);

    const cats = await ui.call('GET', '/api/categories');
    assert.ok(cats.data.categories.some((c) => c.no === 25 && c.leaf));

    // 채우기 + 동시에 두 번째 작업은 거부
    const seed = await ui.call('POST', '/api/jobs/seed', { count: 4, categoryMode: 'spread', withOptions: true, withImage: false, hidden: false });
    assert.equal(seed.status, 200, seed.text);
    const second = await ui.call('POST', '/api/jobs/seed', { count: 1, categoryMode: 'none' });
    assert.equal(second.status, 409);
    const job = await waitJob(ui);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.result.created, 4);
    const dummies = [...mock.state.products.values()].filter((p) => /^DUMMY-\d{15}-\d{3}$/.test(p.custom_product_code || ''));
    assert.equal(dummies.length, 4);

    const batches = await ui.call('GET', '/api/batches');
    assert.equal(batches.data.batches.length, 1);
    assert.equal(batches.data.batches[0].products, 4);

    // 정리: 미리보기 → 실행. 미리보기는 한 번만.
    const plan = await ui.call('POST', '/api/cleanup/plan', { runId: job.result.runId });
    assert.equal(plan.data.counts.products, 4);
    const run = await ui.call('POST', '/api/jobs/cleanup', { planId: plan.data.planId });
    assert.equal(run.status, 200, run.text);
    const cj = await waitJob(ui);
    assert.equal(cj.result.products, 4);
    assert.equal((await ui.call('POST', '/api/jobs/cleanup', { planId: plan.data.planId })).status, 400, '같은 미리보기 재사용 불가');
    assert.ok([1, 2, 3].every((n) => mock.state.products.has(n)), '진짜 상품은 남음');

    // 어떤 응답에도 비밀값이 없어야 함
    const all = ui.responses.join('\n');
    assert.doesNotMatch(all, new RegExp(`${SECRET}|good-code|access-1|refresh-1`));
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 회귀: 빈 배치 ID는 "전체 정리"가 되지 않고 거부된다', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    for (const runId of ['', null, 'x']) {
      const r = await ui.call('POST', '/api/cleanup/plan', { runId });
      assert.equal(r.status, 400, `runId=${JSON.stringify(runId)}`);
      assert.match(r.data.error, /배치 ID가 올바르지 않습니다/);
    }
    assert.equal(ui.responses.filter((t) => t.includes('planId')).length, 0, '어떤 미리보기도 만들어지지 않음');
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 회귀: 카페24 오류 문구에 토큰이 섞여 와도 응답에는 가려서 보낸다', async () => {
  const mock = await startMockServer({ echoAuthInErrors: true });
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    const r = await ui.call('GET', '/api/categories');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /\[가림\]/);
    assert.doesNotMatch(r.text, /access-1|AbCdEfGhIjKlMnOpQrStUvWxYz012345/);
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 회귀: 본문 없는 POST(로그인 열기)도 화면 코드처럼 JSON으로 보내면 동작한다', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    await ui.call('POST', '/api/config', { mall: 'testmall', clientId: 'clientid123', clientSecret: SECRET, redirectUri: 'https://testmall.cafe24.com' });
    // app.js의 api()는 POST면 항상 Content-Type: application/json + "{}" 를 보낸다
    const src = fs.readFileSync(path.join(path.dirname(HARNESS), '..', 'ui', 'app.js'), 'utf8');
    assert.match(src, /method === 'POST' \? \{ 'Content-Type': 'application\/json' \}/);
    const start = await ui.call('POST', '/api/login/start', {});
    assert.equal(start.status, 200);
    assert.match(start.data.authorizeUrl, /\/api\/v2\/oauth\/authorize\?/);
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 후속: 설정을 바꾸면 이후 토큰 갱신은 새 Client ID·Secret으로 한다', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui); // clientid123 / secretvalue123
    const tokenFile = path.join(ui.env.CAFE24_HOME, '.cafe24-token.json');
    await ui.call('GET', '/api/categories'); // 이전 설정으로 연결이 만들어진 상태
    const saved = await ui.call('POST', '/api/config', { mall: 'testmall', clientId: 'newclient456', clientSecret: 'newsecret789', redirectUri: 'https://testmall.cafe24.com' });
    assert.equal(saved.status, 200, saved.text);
    // 토큰을 만료시켜 다음 요청에서 갱신이 일어나게 함
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, access_expires_ms: Date.now() - 1000 }), { mode: 0o600 });
    const r = await ui.call('GET', '/api/categories');
    assert.equal(r.status, 200, r.text);
    const refresh = mock.state.calls.filter((c) => c.path === '/api/v2/oauth/token' && /grant_type=refresh_token/.test(c.raw)).at(-1);
    assert.ok(refresh, '갱신 요청이 있어야 함');
    assert.equal(refresh.authorization, `Basic ${Buffer.from('newclient456:newsecret789').toString('base64')}`);
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 4단계: 한 번의 채우기로 상품 → 메인진열 → 후기, 정리는 후기 → 메인진열 → 상품', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    const seed = await ui.call('POST', '/api/jobs/seed', { count: 4, categoryMode: 'none', withImage: false, mains: { enabled: true, perGroup: 2 }, reviews: { enabled: true, maxPerProduct: 2 } });
    assert.equal(seed.status, 200, seed.text);
    const job = await waitJob(ui);
    assert.equal(job.status, 'done', JSON.stringify(job));
    const st = Object.fromEntries(job.result.stages.map((s) => [s.name, s]));
    assert.deepEqual(job.result.stages.map((s) => s.status), ['done', 'done', 'done']);
    assert.equal(st['상품 등록'].counts.created, 4);
    assert.equal(st['메인진열 채우기'].counts.added, 4); // 메인분류 2곳 × 2개
    assert.ok(st['상품후기 달기'].counts.created >= 4);
    assert.ok(job.logs.some((l) => /2\/3 메인진열/.test(l)) && job.logs.some((l) => /3\/3 상품후기/.test(l)));

    const b = (await ui.call('GET', '/api/batches')).data.batches[0];
    assert.equal(b.products, 4);
    assert.equal(b.mains, 4);
    assert.equal(b.reviews, st['상품후기 달기'].counts.created);

    const plan = await ui.call('POST', '/api/cleanup/plan', { runId: job.result.runId });
    assert.deepEqual(plan.data.counts, { reviews: b.reviews, mains: 4, products: 4 });
    await ui.call('POST', '/api/jobs/cleanup', { planId: plan.data.planId });
    const cj = await waitJob(ui);
    assert.equal(cj.result.products, 4);
    assert.equal(cj.result.reviews, b.reviews);
    assert.equal(b.reviews, st['상품후기 달기'].counts.created);
    assert.equal(cj.result.mains, 4);
    const deletes = mock.state.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.split('/')[4]);
    assert.ok(deletes.lastIndexOf('boards') < deletes.indexOf('mains') && deletes.lastIndexOf('mains') < deletes.indexOf('products'), deletes.join(','));
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 4단계: 중간 단계가 실패해도 앞 단계 결과는 남고, 다음 단계는 진행하며, 결과에 알린다', async () => {
  const mock = await startMockServer({ failMainsList: true });
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    await ui.call('POST', '/api/jobs/seed', { count: 2, categoryMode: 'none', withImage: false, mains: { enabled: true, perGroup: 2 }, reviews: { enabled: true, maxPerProduct: 1 } });
    const job = await waitJob(ui);
    assert.equal(job.status, 'done');
    const st = Object.fromEntries(job.result.stages.map((s) => [s.name, s]));
    assert.equal(st['상품 등록'].counts.created, 2);
    assert.equal(st['메인진열 채우기'].status, 'stopped');
    assert.match(st['메인진열 채우기'].error, /mains unavailable/);
    assert.equal(st['상품후기 달기'].counts.created, 2, '후기 단계는 진행됨');
    assert.equal((await ui.call('GET', '/api/batches')).data.batches[0].products, 2, '상품 소유 기록은 남음');
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 4단계: 터미널에서 쓰기 작업 중이면 UI 작업은 시작하지 않는다', async () => {
  const mock = await startMockServer();
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    const lockFile = path.join(ui.env.CAFE24_HOME, 'cafe24-dummy.write.lock');
    fs.mkdirSync(`${lockFile}.d`, { recursive: true });
    const ticket = path.join(`${lockFile}.d`, `${process.pid}.held`);
    fs.writeFileSync(ticket, JSON.stringify({ pid: process.pid, label: 'create', at: 'now' }));
    const r = await ui.call('POST', '/api/jobs/seed', { count: 1, categoryMode: 'none', withImage: false });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /다른 쓰기 작업이 실행 중입니다 \(create/);
    fs.rmSync(ticket);
    const ok = await ui.call('POST', '/api/jobs/seed', { count: 1, categoryMode: 'none', withImage: false });
    assert.equal(ok.status, 200);
    await waitJob(ui);
    assert.deepEqual(fs.readdirSync(`${lockFile}.d`), [], '작업이 끝나면 잠금 해제');
  } finally {
    ui.stop();
    await mock.close();
  }
});

test('UI 4단계 회귀: 후기가 일부 등록된 뒤 권한 오류로 멈추면 "멈춤"과 숫자를 그대로 알린다', async () => {
  const mock = await startMockServer({ articlesPostLimit: 1 });
  const ui = await startUi(mock);
  try {
    await connectAndLogin(ui);
    // 6개 상품 × 1~3개 = 12개 → 10개씩 두 번 보냄, 두 번째에서 403
    await ui.call('POST', '/api/jobs/seed', { count: 6, categoryMode: 'none', withImage: false, reviews: { enabled: true, maxPerProduct: 3 } });
    const job = await waitJob(ui);
    const rv = job.result.stages.find((s) => s.name === '상품후기 달기');
    assert.equal(rv.status, 'stopped');
    assert.equal(rv.counts.created, 10);
    assert.ok(rv.counts.failed > 0);
    assert.match(rv.error, /권한 오류/);
  } finally {
    ui.stop();
    await mock.close();
  }
});
