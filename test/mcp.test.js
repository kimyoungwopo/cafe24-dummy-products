import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-cli.js');
const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(base, { login = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-mcp-'));
  const tokenFile = path.join(dir, '.cafe24-token.json');
  if (login) {
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ mall_id: 'testmall', access_token: 'access-1', refresh_token: 'refresh-1', access_expires_ms: Date.now() + 3600_000, scopes: ['mall.read_product', 'mall.write_product', 'mall.read_category', 'mall.read_community', 'mall.write_community'] }),
    );
  }
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    CAFE24_HOME: dir,
    CAFE24_MALL_ID: 'testmall',
    CAFE24_CLIENT_ID: 'clientid123',
    CAFE24_CLIENT_SECRET: 'secretvalue123',
    CAFE24_REDIRECT_URI: 'https://testmall.cafe24.com',
    CAFE24_MIN_INTERVAL_MS: '1',
    TEST_MOCK_API_BASE: base,
    TEST_UI_URL_FILE: path.join(dir, 'url'),
  };
  return { dir, env, confirmFile: path.join(dir, 'url.confirm') };
}

/** MCP 서버를 자식 프로세스로 띄우고 요청-응답을 주고받는 작은 클라이언트 */
function startMcp(env) {
  const child = spawn('node', [HARNESS, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line); // 모든 stdout 줄은 JSON이어야 한다 (아니면 여기서 테스트 실패)
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  let nextId = 1;
  const raw = (text) => child.stdin.write(text);
  const request = (method, params, { id = nextId++ } = {}) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`응답 없음: ${method}`)), 20_000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      raw(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  const waitId = (id) => new Promise((resolve) => waiters.set(id, resolve));
  const call = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args, _meta: MODERN });
    assert.ok(m.result, JSON.stringify(m));
    return m.result;
  };
  return { child, lines, raw, request, waitId, call, exited, stderr: () => stderr, close: () => child.stdin.end() };
}

async function waitJob(mcp, jobId) {
  for (let i = 0; i < 400; i++) {
    const r = await mcp.call('get_job', { jobId });
    if (r.structuredContent.status !== 'running') return r.structuredContent;
    await sleep(25);
  }
  throw new Error('작업이 끝나지 않음');
}

const writes = (mock) => mock.state.calls.filter((c) => c.method !== 'GET');

test('MCP 프로토콜: 예전(initialize)·현재(_meta) 방식 모두 받고, stdout에는 MCP 메시지만', async () => {
  const mock = await startMockServer();
  const { env } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    // ping은 언제나
    assert.deepEqual((await mcp.request('ping')).result, {});
    // _meta도 initialize도 없으면 거부
    const noMeta = await mcp.request('tools/list');
    assert.equal(noMeta.error.code, -32602);
    // 현재 방식
    const disc = await mcp.request('server/discover', { _meta: MODERN });
    assert.deepEqual(disc.result.supportedVersions, ['2026-07-28']);
    assert.equal(disc.result.resultType, 'complete');
    assert.equal(disc.result._meta['io.modelcontextprotocol/serverInfo'].name, 'cafe24-dummy-products');
    const unsupported = await mcp.request('tools/list', { _meta: { ...MODERN, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
    assert.equal(unsupported.error.code, -32022);
    assert.ok(unsupported.error.data.supported.includes('2026-07-28') && unsupported.error.data.supported.includes('2025-11-25'));
    const noCaps = await mcp.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(noCaps.error.code, -32602);
    const list = await mcp.request('tools/list', { _meta: MODERN });
    assert.equal(list.result.resultType, 'complete');
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['get_status', 'list_presets', 'list_categories', 'preview_products', 'start_seed', 'get_job', 'list_batches', 'plan_cleanup', 'execute_cleanup']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(list.result.tools.find((t) => t.name === 'execute_cleanup').annotations.destructiveHint, true);

    // 예전 방식: initialize → 같은 버전, 이후 _meta 없이도 처리
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /사용자가 직접 승인/);
    mcp.raw('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const legacyList = await mcp.request('tools/list');
    assert.equal(legacyList.result.tools.length, 9);
    assert.equal(legacyList.result.resultType, undefined, '예전 방식에는 resultType을 넣지 않음');
    const future = await mcp.request('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(future.result.protocolVersion, '2025-11-25', '모르는 버전이면 지원하는 최신 예전 버전');

    // 오류들
    assert.equal((await mcp.request('nope/method', { _meta: MODERN })).error.code, -32601);
    assert.equal((await mcp.request('tools/call', { name: 'no_such_tool', arguments: {}, _meta: MODERN })).error.code, -32602);
    assert.equal((await mcp.request('tools/call', { name: 'get_status', arguments: [], _meta: MODERN })).error.code, -32602);
    // 쪼개서 보낸 요청, 한 번에 보낸 여러 줄, 잘못된 JSON, 배열(배치)
    const p1 = mcp.waitId(901);
    mcp.raw('{"jsonrpc":"2.0","id":901,"meth');
    await sleep(30);
    mcp.raw('od":"ping"}\n');
    assert.deepEqual((await p1).result, {});
    const p2 = mcp.waitId(902);
    const p3 = mcp.waitId(903);
    mcp.raw('{"jsonrpc":"2.0","id":902,"method":"ping"}\n{"jsonrpc":"2.0","id":903,"method":"ping"}\n');
    await Promise.all([p2, p3]);
    const pe = mcp.waitId(null);
    mcp.raw('{not json\n');
    assert.equal((await pe).error.code, -32700);
    const pb = mcp.waitId(null);
    mcp.raw('[{"jsonrpc":"2.0","id":904,"method":"ping"}]\n');
    assert.equal((await pb).error.code, -32600);
    // 알림에는 응답하지 않는다
    const before = mcp.lines.length;
    mcp.raw('{"jsonrpc":"2.0","method":"notifications/whatever"}\n');
    await mcp.request('ping');
    assert.equal(mcp.lines.length, before + 1);
  } finally {
    mcp.close();
    assert.equal(await mcp.exited, 0);
    for (const l of mcp.lines) assert.doesNotThrow(() => JSON.parse(l));
    await mock.close();
  }
});

test('MCP 도구: 업종으로 채우고 → 배치 확인 → 정리는 사람이 브라우저 확인 화면에서 승인해야만 실행', async () => {
  const mock = await startMockServer();
  const { env, confirmFile } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const st = (await mcp.call('get_status')).structuredContent;
    assert.equal(st.configured, true);
    assert.equal(st.login.mallId, 'testmall');
    assert.equal(st.next, null);

    const pv = await mcp.call('preview_products', { preset: 'food', withOptions: true });
    assert.equal(pv.isError, false);
    assert.equal(pv.structuredContent.preset.id, 'food');
    assert.equal(pv.content[1].type, 'image');

    const seed = await mcp.call('start_seed', { preset: 'beauty', count: 3, categoryMode: 'none', withImage: false, reviewsMax: 2, mainsPerGroup: 1 });
    assert.equal(seed.isError, false, JSON.stringify(seed));
    const { jobId, runId } = seed.structuredContent;
    assert.match(runId, /^\d{15}$/);
    assert.match(seed.structuredContent.visibility, /손님 화면에 보임/);
    const job = await waitJob(mcp, jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.deepEqual(job.result.stages.map((s) => s.status), ['done', 'done', 'done']);
    assert.ok(job.result.stages[1].counts.added >= 1, '메인진열도 채움');
    assert.equal(job.result.preset.id, 'beauty');

    const batches = (await mcp.call('list_batches')).structuredContent;
    assert.equal(batches.batches[0].runId, runId);
    assert.equal(batches.batches[0].products, 3);
    assert.ok(batches.batches[0].mains >= 1 && batches.batches[0].reviews >= 3);

    const plan = (await mcp.call('plan_cleanup', { runId })).structuredContent;
    assert.match(plan.planId, /^[0-9a-f]{32}$/);
    assert.equal(plan.counts.products, 3);

    // 처음 실행 요청: 지우지 않고 확인 화면만 연다
    const deletesBefore = () => mock.state.calls.filter((c) => c.method === 'DELETE').length;
    const ex1 = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(ex1.structuredContent.status, 'awaiting_confirmation');
    assert.equal(deletesBefore(), 0);
    const confirmUrl = fs.readFileSync(confirmFile, 'utf8');
    const token = /#t=([0-9a-f]{64})$/.exec(confirmUrl)[1];
    assert.ok(!mcp.lines.some((l) => l.includes(token)), '확인 토큰은 MCP 결과에 나오지 않음');
    // 모델이 다시 불러도 승인 전에는 지우지 않는다
    const ex2 = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(ex2.structuredContent.status, 'awaiting_confirmation');
    assert.equal(deletesBefore(), 0);

    // 확인 화면 (사람)
    const base = new URL(confirmUrl).origin;
    const hdr = { 'X-Confirm-Token': token };
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const shown = await (await fetch(`${base}/api/confirm`, { headers: hdr })).json();
    assert.equal(shown.plan.counts.products, 3);
    assert.equal(shown.plan.runId, runId);
    const post = (body, extra = {}) => fetch(`${base}/api/confirm`, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/confirm`, { headers: { 'X-Confirm-Token': 'f'.repeat(64) } })).status, 404, '다른 토큰');
    assert.equal((await post({ decision: 'approve' }, { Origin: 'https://evil.example' })).status, 403, '다른 출처');
    assert.equal((await post({ decision: 'approve' })).status, 400, '"되돌릴 수 없다" 확인 없이는 승인 불가');
    assert.equal((await post({ decision: 'approve', irreversible: true })).status, 200);
    assert.equal((await post({ decision: 'approve', irreversible: true })).status, 404, '한 번만 결정');

    const ex3 = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(ex3.structuredContent.status, 'started', JSON.stringify(ex3));
    const cj = await waitJob(mcp, ex3.structuredContent.jobId);
    assert.equal(cj.result.products, 3);
    assert.ok(cj.result.reviews >= 3);
    assert.ok(mock.state.products.has(1) && mock.state.products.has(3), '더미가 아닌 상품은 남음');
    // 지우는 순서: 후기 → 메인진열 → 상품
    const kind = (p) => (/\/articles\//.test(p) ? 'review' : /\/mains\//.test(p) ? 'main' : 'product');
    const order = mock.state.calls.filter((c) => c.method === 'DELETE').map((c) => kind(c.path));
    const lastOf = (k) => order.lastIndexOf(k);
    const firstOf = (k) => order.indexOf(k);
    assert.ok(firstOf('review') >= 0 && firstOf('main') >= 0 && firstOf('product') >= 0, order.join(','));
    assert.ok(lastOf('review') < firstOf('main') && lastOf('main') < firstOf('product'), order.join(','));
    // 같은 계획은 다시 쓸 수 없다
    const ex4 = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(ex4.isError, true);

    // 출력 어디에도 비밀값이 없다
    const all = mcp.lines.join('\n') + mcp.stderr();
    for (const s of ['secretvalue123', 'access-1', 'refresh-1', token]) assert.ok(!all.includes(s), s);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP 정리: 사용자가 거절하면 계획은 버려지고 아무것도 지우지 않는다', async () => {
  const mock = await startMockServer();
  const { env, confirmFile } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const seed = await mcp.call('start_seed', { preset: 'fashion', count: 2, categoryMode: 'none', withImage: false });
    await waitJob(mcp, seed.structuredContent.jobId);
    const plan = (await mcp.call('plan_cleanup', { scope: 'all' })).structuredContent;
    assert.equal(plan.runId, null);
    await mcp.call('execute_cleanup', { planId: plan.planId });
    const url = fs.readFileSync(confirmFile, 'utf8');
    const token = /#t=([0-9a-f]{64})$/.exec(url)[1];
    const r = await fetch(`${new URL(url).origin}/api/confirm`, { method: 'POST', headers: { 'X-Confirm-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) });
    assert.equal(r.status, 200);
    const ex = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(ex.isError, true);
    assert.match(ex.content[0].text, /없거나 만료/);
    assert.equal(mock.state.calls.filter((c) => c.method === 'DELETE').length, 0);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP 입력 검사: 형식·범위·조합이 틀리면 카페24에 아무것도 보내지 않고 고칠 수 있는 오류로 알린다', async () => {
  const mock = await startMockServer();
  const { env } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const bad = [
      ['start_seed', { preset: 'beauty', count: 3, categoryMode: 'none', extra: 1 }, /알 수 없는 항목/],
      ['start_seed', { preset: 'beauty', count: 0, categoryMode: 'none' }, /1 이상/],
      ['start_seed', { preset: 'beauty', count: '3', categoryMode: 'none' }, /integer 형식/],
      ['start_seed', { preset: 'pets', count: 3, categoryMode: 'none' }, /중 하나/],
      ['start_seed', { preset: 'beauty', count: 3, categoryMode: 'pick' }, /categoryNos가 필요/],
      ['start_seed', { preset: 'beauty', count: 3, categoryMode: 'spread', categoryNos: [1] }, /pick일 때만/],
      ['start_seed', { preset: 'beauty', count: 3, categoryMode: 'none', hidden: 'false' }, /boolean 형식/],
      ['start_seed', { preset: 'beauty', count: 3, categoryMode: 'none', reviewsMax: 11 }, /10 이하/],
      ['start_seed', { count: 3, categoryMode: 'none' }, /preset: 필요한 값/],
      ['plan_cleanup', {}, /하나만 주세요/],
      ['plan_cleanup', { runId: '261109120000123', scope: 'all' }, /하나만 주세요/],
      ['plan_cleanup', { runId: '' }, /형식이 올바르지 않습니다/],
      ['execute_cleanup', { planId: 'x' }, /형식이 올바르지 않습니다/],
      ['execute_cleanup', { planId: 'a'.repeat(32) }, /없거나 만료/],
      ['get_job', { jobId: '0123456789abcdef' }, /진행 중·최근 작업이 아닙니다/],
    ];
    for (const [name, args, re] of bad) {
      const r = await mcp.call(name, args);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(r.content[0].text, re, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(writes(mock), [], '쓰기 요청 없음');
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP: 로그인 전이면 로그인 방법을 안내하고, 다른 프로세스가 쓰기 작업 중이면 시작하지 않는다', async () => {
  const mock = await startMockServer();
  const { env, dir } = setup(mock.base, { login: false });
  const mcp = startMcp(env);
  try {
    const st = (await mcp.call('get_status')).structuredContent;
    assert.equal(st.login, null);
    assert.match(st.next, /ui. 또는 .*login.*로그인/);
    const r = await mcp.call('start_seed', { preset: 'beauty', count: 1, categoryMode: 'none' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /로그인/);

    // 로그인 후, 터미널 작업이 쓰기 잠금을 잡고 있으면 거부
    fs.writeFileSync(path.join(dir, '.cafe24-token.json'), JSON.stringify({ mall_id: 'testmall', access_token: 'access-1', refresh_token: 'refresh-1', access_expires_ms: Date.now() + 3600_000, scopes: [] }));
    const lockDir = path.join(dir, 'cafe24-dummy.write.lock.d');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `${process.pid}.held`), JSON.stringify({ pid: process.pid, label: 'delete', at: 'now' }));
    const busy = await mcp.call('start_seed', { preset: 'beauty', count: 1, categoryMode: 'none', withImage: false });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /다른 쓰기 작업이 실행 중입니다 \(delete/);
    assert.deepEqual(writes(mock), []);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP: 작업 중에 입력이 닫혀도 작업·기록·잠금 해제가 끝난 뒤에 종료한다', async () => {
  const mock = await startMockServer({ slowAdminMs: 40 });
  const { env, dir } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const seed = await mcp.call('start_seed', { preset: 'living', count: 4, categoryMode: 'none', withImage: false });
    assert.equal(seed.isError, false);
    mcp.close(); // 클라이언트가 바로 연결을 끊음
    assert.equal(await mcp.exited, 0);
    const made = [...mock.state.products.values()].filter((p) => /^DUMMY-\d{15}-\d{3}$/.test(p.custom_product_code || ''));
    assert.equal(made.length, 4, '작업을 끝까지 마침');
    const manifest = fs.readdirSync(path.join(dir, 'owned')).map((f) => fs.readFileSync(path.join(dir, 'owned', f), 'utf8')).join('');
    assert.equal((manifest.match(/"event":"created"/g) || []).length, 4, '소유 기록이 모두 남음');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'cafe24-dummy.write.lock.d')), [], '잠금 해제');
  } finally {
    await mock.close();
  }
});

test('MCP 회귀: 출력이 끊겨도(EPIPE) 죽지 않고, 진행 중인 작업·기록·잠금 해제를 마친 뒤 종료한다', async () => {
  const mock = await startMockServer({ slowAdminMs: 40 });
  const { env, dir } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const seed = await mcp.call('start_seed', { preset: 'digital', count: 4, categoryMode: 'none', withImage: false });
    assert.equal(seed.isError, false);
    mcp.child.stdout.destroy(); // 앱이 출력을 닫음
    mcp.raw('{"jsonrpc":"2.0","id":77,"method":"ping"}\n'); // 서버가 응답을 쓰려다 EPIPE
    assert.equal(await mcp.exited, 0, mcp.stderr());
    const made = [...mock.state.products.values()].filter((p) => /^DUMMY-\d{15}-\d{3}$/.test(p.custom_product_code || ''));
    assert.equal(made.length, 4);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'cafe24-dummy.write.lock.d')), []);
  } finally {
    await mock.close();
  }
});

test('MCP 회귀: 취소 알림은 처리 중인 읽기 요청에만 적용되고, 쓰기 도구 응답(jobId)은 숨기지 않는다', async () => {
  const mock = await startMockServer();
  const { env } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    // 처리 중이 아닌 id를 취소해도 나중 요청 응답은 그대로 온다
    mcp.raw('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}\n');
    const r = await mcp.request('ping', undefined, { id: 7 });
    assert.deepEqual(r.result, {});
    // 쓰기 도구는 시작 직후 취소가 와도 응답(jobId)을 돌려준다
    const p = mcp.waitId(500);
    mcp.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'start_seed', arguments: { preset: 'food', count: 1, categoryMode: 'none', withImage: false }, _meta: MODERN } })}\n`);
    mcp.raw('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":500}}\n');
    const started = await p;
    assert.match(started.result.structuredContent.jobId, /^[0-9a-f]{16}$/);
    await waitJob(mcp, started.result.structuredContent.jobId);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP 회귀: 1MB를 넘는 한 줄 메시지는 처리하지 않고, initialize 필수 값이 없으면 거부한다', async () => {
  const mock = await startMockServer();
  const { env } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const big = mcp.waitId(null);
    mcp.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'ping', params: { pad: '가'.repeat(400_000) } })}\n`); // 문자 수는 1M 미만, 바이트는 1.2MB
    const e = await big;
    assert.equal(e.error.code, -32600);
    assert.match(e.error.message, /too large/);
    // 줄바꿈 없이 계속 오는 큰 입력도 버리고, 다음 줄부터 정상 처리
    const big2 = mcp.waitId(null);
    mcp.raw('x'.repeat(1_100_000));
    await big2;
    mcp.raw('tail-of-oversized-line\n');
    assert.deepEqual((await mcp.request('ping')).result, {});
    const bad = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(bad.error.code, -32602);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP 회귀: 승인한 계획은 잠금 충돌로 실행하지 못해도 사라지지 않고, 잠금이 풀리면 실행된다', async () => {
  const mock = await startMockServer();
  const { env, dir, confirmFile } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const seed = await mcp.call('start_seed', { preset: 'fashion', count: 2, categoryMode: 'none', withImage: false });
    const { runId } = seed.structuredContent;
    await waitJob(mcp, seed.structuredContent.jobId);
    const plan = (await mcp.call('plan_cleanup', { runId })).structuredContent;
    await mcp.call('execute_cleanup', { planId: plan.planId });
    const url = fs.readFileSync(confirmFile, 'utf8');
    const token = /#t=([0-9a-f]{64})$/.exec(url)[1];
    const ok = await fetch(`${new URL(url).origin}/api/confirm`, { method: 'POST', headers: { 'X-Confirm-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', irreversible: true }) });
    assert.equal(ok.status, 200);
    // 터미널 작업이 잠금을 잡고 있음
    const lockDir = path.join(dir, 'cafe24-dummy.write.lock.d');
    fs.mkdirSync(lockDir, { recursive: true });
    const ticket = path.join(lockDir, `${process.pid}.held`);
    fs.writeFileSync(ticket, JSON.stringify({ pid: process.pid, label: 'create', at: 'now' }));
    const busy = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /다른 쓰기 작업이 실행 중입니다/);
    assert.equal(mock.state.calls.filter((c) => c.method === 'DELETE').length, 0);
    fs.rmSync(ticket);
    const started = await mcp.call('execute_cleanup', { planId: plan.planId });
    assert.equal(started.structuredContent.status, 'started', JSON.stringify(started));
    const done = await waitJob(mcp, started.structuredContent.jobId);
    assert.equal(done.result.products, 2);
  } finally {
    mcp.close();
    await mcp.exited;
    await mock.close();
  }
});

test('MCP 회귀: 앱이 입력·출력·오류 출력을 한꺼번에 닫아도(앱 종료) 작업·기록·잠금 해제를 마친 뒤 종료한다', async () => {
  const mock = await startMockServer({ slowAdminMs: 40 });
  const { env, dir } = setup(mock.base);
  const mcp = startMcp(env);
  try {
    const seed = await mcp.call('start_seed', { preset: 'beauty', count: 4, categoryMode: 'none', withImage: false });
    assert.equal(seed.isError, false);
    mcp.child.stdout.destroy();
    mcp.child.stderr.destroy();
    mcp.close(); // 종료 안내를 stderr에 쓰다가 EPIPE가 나도 죽지 않아야 한다
    assert.equal(await mcp.exited, 0);
    const made = [...mock.state.products.values()].filter((p) => /^DUMMY-\d{15}-\d{3}$/.test(p.custom_product_code || ''));
    assert.equal(made.length, 4);
    const manifest = fs.readdirSync(path.join(dir, 'owned')).map((f) => fs.readFileSync(path.join(dir, 'owned', f), 'utf8')).join('');
    assert.equal((manifest.match(/"event":"created"/g) || []).length, 4);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'cafe24-dummy.write.lock.d')), []);
  } finally {
    await mock.close();
  }
});

test('MCP 회귀: 같은 계획으로 정리 실행을 동시에 요청해도 확인 화면 주소는 하나만 만든다', async () => {
  const { createService } = await import('../src/service.js');
  const { createConfirmServer } = await import('../src/confirm.js');
  const { __setUrlSink } = await import('../src/http-guard.js');
  const urls = [];
  __setUrlSink((url, kind) => kind === 'confirm' && urls.push(url));
  const svc = createService({ source: 'mcp' });
  // 계획을 직접 넣는다 (카페24 조회 없이)
  svc.state.plans.set('p'.repeat(32), { plan: {}, view: {}, createdAt: Date.now(), mallId: 'm', shopNo: 1, requiresApproval: true, approval: 'pending' });
  const confirm = createConfirmServer(svc);
  try {
    const results = await Promise.all([confirm.openFor('p'.repeat(32)), confirm.openFor('p'.repeat(32)), confirm.openFor('p'.repeat(32))]);
    assert.deepEqual(results.sort(), ['already-open', 'already-open', 'opened']);
    assert.equal(urls.length, 1);
  } finally {
    __setUrlSink(null);
    await confirm.close();
  }
});
