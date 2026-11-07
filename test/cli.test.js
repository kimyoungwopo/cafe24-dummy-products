import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { buildDummyProduct, dummyCode, makeRunId, isDummyCode } from '../src/dummy.js';
import { makeDummyImage } from '../src/image.js';
import { parseCodeInput, buildAuthorizeUrl } from '../src/auth.js';
import { buildReviews, isDummyReview } from '../src/review.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function setup(base, { expired = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-'));
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({
    mall_id: 'testmall',
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    access_expires_ms: expired ? Date.now() - 1000 : Date.now() + 3600_000,
  }));
  const env = {
    ...process.env,
    CAFE24_MALL_ID: 'testmall',
    CAFE24_CLIENT_ID: 'cid',
    CAFE24_CLIENT_SECRET: 'secret',
    CAFE24_REDIRECT_URI: 'https://example.com/callback',
    CAFE24_API_BASE: base,
    CAFE24_TOKEN_FILE: tokenFile,
    CAFE24_LOG_DIR: path.join(dir, 'logs'),
    CAFE24_MIN_INTERVAL_MS: '1',
    CAFE24_ENV_FILE: path.join(dir, 'no.env'), // 실제 .env를 읽지 않도록
  };
  return { env, tokenFile };
}

const cli = (args, env) => run('node', [CLI, ...args], { env });

test('더미 상품 데이터: 필수 필드와 길이 제한', () => {
  const runId = makeRunId(new Date(2026, 10, 7, 15, 30, 12, 45));
  assert.equal(runId, '261107153012045');
  assert.ok(isDummyCode(dummyCode(runId, 7)));
  assert.ok(isDummyCode(dummyCode(runId, 7), runId));
  assert.ok(!isDummyCode(dummyCode(runId, 7), '261107153012046'));
  for (const bad of ['DUMMY-SHIRT', 'DUMMY-', 'X-DUMMY-261107153012045-001', 'DUMMY-261107153012045-001-x', null]) {
    assert.ok(!isDummyCode(bad), bad);
  }
  for (let i = 1; i <= 50; i++) {
    const p = buildDummyProduct(i, { runId, category: { no: 24, names: [], path: [24] }, withOptions: true });
    assert.ok(p.product_name.length <= 250);
    assert.ok(p.custom_product_code.length <= 40);
    assert.ok(p.price > 0 && p.supply_price > 0 && p.supply_price < p.price);
    assert.ok(p.retail_price === 0 || p.retail_price > p.price);
    assert.ok(p.summary_description.length <= 255);
    assert.deepEqual(p.add_category_no, [{ category_no: 24, recommend: 'F', new: i % 4 === 0 ? 'T' : 'F' }]);
    assert.equal(p.has_option, 'T');
  }
  assert.equal(dummyCode(runId, 7), 'DUMMY-261107153012045-007');
});

test('더미 이미지: 올바른 PNG 시그니처와 크기', () => {
  const png = makeDummyImage(3, 600);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 600);
  assert.equal(png.readUInt32BE(20), 600);
  assert.ok(png.length < 200_000, `이미지가 너무 큼: ${png.length}`);
});

test('OAuth: 인증 URL과 붙여넣은 리다이렉트 URL 해석', () => {
  const url = new URL(buildAuthorizeUrl({ apiBase: 'https://m.cafe24api.com', clientId: 'cid', redirectUri: 'https://e.com/cb' }, 'st'));
  assert.equal(url.pathname, '/api/v2/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), 'mall.read_product mall.write_product mall.read_category mall.read_community mall.write_community');
  assert.equal(parseCodeInput('https://e.com/cb?code=abc&state=st', 'st'), 'abc');
  assert.equal(parseCodeInput('  rawcode  ', 'st'), 'rawcode');
  assert.throws(() => parseCodeInput('https://e.com/cb?code=abc&state=bad', 'st'), /state/);
  assert.throws(() => parseCodeInput('https://e.com/cb?error=access_denied', 'st'), /access_denied/);
});

test('create → list → delete 전체 흐름 (목 서버)', async () => {
  const mock = await startMockServer({ fail429Once: true });
  try {
    const { env } = setup(mock.base);

    const created = await cli(['create', '-n', '3', '-c', '24', '--options'], env);
    assert.match(created.stdout, /성공 3개, 실패 0개/);
    assert.match(created.stderr, /HTTP 429/); // 429 재시도 동작
    const dummies = [...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code));
    assert.equal(dummies.length, 3);
    assert.ok(dummies.every((p) => p.image_bytes > 100), '이미지 업로드됨');
    const runId = /배치 ID: (\d+)/.exec(created.stdout)[1];

    const listed = await cli(['list'], env);
    assert.match(listed.stdout, /총 3개/);
    assert.doesNotMatch(listed.stdout, /진짜 상품|X-DUMMY/);

    const categories = await cli(['categories'], env);
    assert.match(categories.stdout, /24\s+상의\n\s+25\s+ {2}티셔츠/);
    assert.match(categories.stdout, /27\s+하의\n\s+26\s+ {2}스커트/);

    const deleted = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(deleted.stdout, /삭제 완료: 3개, 실패 0개/);
    assert.ok([1, 2, 3].every((n) => mock.state.products.has(n)), '더미가 아닌 상품은 남아 있어야 함');
    assert.equal(mock.state.products.size, 3);
  } finally {
    await mock.close();
  }
});

test('만료된 토큰은 자동 갱신 후 호출', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base, { expired: true });
    const out = await cli(['create', '-n', '1', '--no-image', '--hidden'], env);
    assert.match(out.stdout, /성공 1개/);
    assert.equal(mock.state.refreshCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).access_token, 'access-2');
    const p = [...mock.state.products.values()].find((x) => isDummyCode(x.custom_product_code));
    assert.equal(p.display, 'F');
    assert.equal(p.selling, 'F');
  } finally {
    await mock.close();
  }
});

test('dry-run은 설정 없이도 동작', async () => {
  const out = await run('node', [CLI, 'create', '-n', '2', '--dry-run'], {
    env: { PATH: process.env.PATH, CAFE24_ENV_FILE: '/nonexistent/.env', CAFE24_TOKEN_FILE: '/nonexistent/token.json' },
  });
  assert.match(out.stdout, /"product_name": "\[더미\]/);
  assert.match(out.stdout, /\(dry-run\) 2개/);
});

test('-h/--help는 명령을 실행하지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    for (const args of [['create', '-h'], ['delete', '-y', '--help'], ['--help'], ['-h']]) {
      const out = await cli(args, env);
      assert.match(out.stdout, /사용법:/, args.join(' '));
    }
    assert.equal(mock.state.calls.length, 0, 'API 호출이 없어야 함');
  } finally {
    await mock.close();
  }
});

test('--run 빈 값/잘못된 값은 아무것도 지우지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '2', '--no-image'], env);
    const before = mock.state.products.size;
    for (const args of [['delete', '--run=', '--yes'], ['delete', '--run', '', '--yes'], ['delete', '--run', '2611', '--yes']]) {
      await assert.rejects(cli(args, env), /--run 값이 올바르지 않습니다/, args.join(' '));
    }
    assert.equal(mock.state.products.size, before);
    assert.ok(!mock.state.calls.some((c) => c.method === 'DELETE'));
  } finally {
    await mock.close();
  }
});

test('전체 delete는 DUMMY-SHIRT 같은 사람이 붙인 코드를 지우지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '2', '--no-image'], env);
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /삭제 완료: 2개/);
    assert.equal(mock.state.products.get(3)?.custom_product_code, 'DUMMY-SHIRT');
  } finally {
    await mock.close();
  }
});

test('토큰 갱신 실패 시 create는 첫 실패에서 멈춘다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base, { expired: true });
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    t.refresh_token = 'revoked';
    fs.writeFileSync(tokenFile, JSON.stringify(t));
    const out = await cli(['create', '-n', '5', '--no-image'], env);
    assert.match(out.stdout, /권한 오류로 중단/);
    assert.match(out.stdout, /성공 0개, 실패 1개/);
    assert.equal(mock.state.calls.filter((c) => c.path === '/api/v2/oauth/token').length, 1);
  } finally {
    await mock.close();
  }
});

test('상품 등록 POST는 500에서 재시도하지 않는다 (중복 등록 방지)', async () => {
  const mock = await startMockServer({ fail500OnPostOnce: true });
  try {
    const { env } = setup(mock.base);
    const out = await cli(['create', '-n', '2', '--no-image'], env);
    assert.match(out.stdout, /성공 1개, 실패 1개/);
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, 2);
  } finally {
    await mock.close();
  }
});

test('목록 API 캐시로 안 보이는 상품도 배치 로그로 지운다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const created = await cli(['create', '-n', '3', '--no-image'], env);
    const runId = /배치 ID: (\d+)/.exec(created.stdout)[1];
    mock.state.hideFromList = true;
    const out = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(out.stdout, /삭제 완료: 3개/);
    assert.equal(mock.state.products.size, 3); // 시드 상품 3개만 남음
  } finally {
    await mock.close();
  }
});

test('토큰 파일은 600 권한으로 저장되고 깨진 파일은 원인을 알려 준다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base, { expired: true });
    fs.chmodSync(tokenFile, 0o644);
    await cli(['create', '-n', '1', '--no-image'], env);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    fs.writeFileSync(tokenFile, '{broken');
    const out = await cli(['create', '-n', '1', '--no-image'], env);
    assert.match(out.stdout, /토큰 파일을 읽을 수 없습니다/);
  } finally {
    await mock.close();
  }
});

test('분류 이름에 맞는 상품명과 옵션을 고른다', () => {
  const runId = makeRunId();
  const cases = [
    [['(대분류) Outerwear', '(중분류) Jackets'], /자켓|블루종/],
    [['(대분류) Tops', '(중분류) Tees', '(소분류) Short Sleeve', '(상세분류) Cropped'], /티셔츠/],
    [['(대분류) Bottoms', '(중분류) Skirts'], /스커트/],
    [['(대분류) Dresses'], /원피스/],
    [['(대분류) Accessories'], /볼캡|에코백|파우치|비니/],
  ];
  for (const [names, re] of cases) {
    for (let i = 1; i <= 8; i++) {
      const p = buildDummyProduct(i, { runId, category: { no: 1, names, path: [1] }, withOptions: true });
      assert.match(p.product_name, re, `${names.at(-1)}: ${p.product_name}`);
      if (/Accessories/.test(names[0])) assert.equal(p.options.length, 1, '잡화는 사이즈 옵션 없음');
    }
  }
});

test('--spread는 진열 중인 맨 아래 분류에 번갈아 넣고 상위 분류도 함께 등록', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const out = await cli(['create', '-n', '4', '--spread', '--no-image'], env);
    assert.match(out.stdout, /상품분류 2곳에 나눠 등록/);
    assert.doesNotMatch(out.stdout, /숨김분류/);
    const made = [...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code));
    assert.equal(made.length, 4);
    const cats = made.map((p) => p.add_category_no.map((c) => c.category_no).join('>'));
    assert.deepEqual(cats.sort(), ['24>25', '24>25', '27>26', '27>26']);
    for (const p of made) {
      const leaf = p.add_category_no.at(-1).category_no;
      assert.match(p.product_name, leaf === 25 ? /티셔츠/ : /스커트/);
    }
  } finally {
    await mock.close();
  }
});

test('-c 여러 개는 번갈아 배정하고, 없는 번호는 등록 전에 거부', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '3', '-c', '25,26', '--no-image'], env);
    const leafs = [...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code)).map((p) => p.add_category_no.at(-1).category_no);
    assert.deepEqual(leafs, [25, 26, 25]);
    await assert.rejects(cli(['create', '-n', '1', '-c', '25,999', '--no-image'], env), /없는 상품분류 번호: 999/);
    await assert.rejects(cli(['create', '-n', '1', '-c', '25,,x', '--no-image'], env), /쉼표로 구분한 숫자/);
    await assert.rejects(cli(['create', '-n', '1', '-c', '25', '--spread'], env), /함께 쓸 수 없습니다/);
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, 3, '거부된 요청은 등록하지 않음');
  } finally {
    await mock.close();
  }
});

test('후기 생성기: 상품마다 1~n개, 별점 1~5, 더미 판별', () => {
  const counts = [0, 1, 2, 3, 4, 5].map((i) => buildReviews({ product_no: 10 + i, list_image: 'https://x/a.png' }, i, { maxPerProduct: 3 }).length);
  assert.deepEqual(counts, [1, 2, 3, 1, 2, 3]);
  const all = Array.from({ length: 20 }, (_, i) => buildReviews({ product_no: i, list_image: 'https://x/a.png' }, i)).flat();
  assert.ok(all.every((r) => r.rating >= 1 && r.rating <= 5 && isDummyReview(r) && r.client_ip));
  assert.ok(all.some((r) => r.attach_file_urls), '포토후기 포함');
  assert.ok(all.every((r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(r.created_date)));
  assert.ok(!isDummyReview({ title: '[더미] 진짜', writer: '실제고객' }));
  assert.ok(!isDummyReview({ title: '진짜 후기', writer: '김민지' }));
});

test('fill-mains / clear-mains: 메인분류마다 다른 더미 상품을 넣고 더미만 뺀다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '6', '--no-image'], env);
    const out = await cli(['fill-mains', '-n', '3'], env);
    assert.match(out.stdout, /추천상품\(2\) ← 더미 상품 3개/);
    assert.match(out.stdout, /신상품\(3\) ← 더미 상품 3개/);
    const g2 = [...mock.state.mains.get(2)];
    const g3 = [...mock.state.mains.get(3)];
    assert.equal(g2.filter((n) => n >= 100).length, 3);
    assert.ok(!g3.some((n) => g2.includes(n)), '두 메인분류의 더미 상품이 겹치지 않음');
    const again = await cli(['fill-mains', '-n', '3', '--group', '2'], env);
    assert.match(again.stdout, /추천상품\(2\) ← 더미 상품 3개/);
    assert.equal(mock.state.mains.get(2).size, 7); // 진짜 상품 1 + 더미 6
    await assert.rejects(cli(['fill-mains', '--group', '9'], env), /없는 메인분류 번호: 9/);

    const cleared = await cli(['clear-mains'], env);
    assert.match(cleared.stdout, /메인진열에서 뺀 더미 상품: 9개/);
    assert.deepEqual([...mock.state.mains.get(2)], [1], '진짜 상품은 남음');
    assert.equal(mock.state.mains.get(3).size, 0);
    assert.equal([...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code)).length, 6, '상품 자체는 그대로');
  } finally {
    await mock.close();
  }
});

test('reviews / clear-reviews: 후기 게시판을 찾아 10건씩 등록하고 더미 후기만 지운다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_product', 'mall.write_product'] }));
    await cli(['create', '-n', '7', '--no-image'], env);
    await assert.rejects(cli(['reviews'], env), /login`을 다시/, '권한 없으면 안내');

    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
    const out = await cli(['reviews', '-n', '3'], env);
    // 7개 상품 → 1,2,3,1,2,3,1 = 13개
    assert.match(out.stdout, /상품 사용후기\(4\) — 더미 상품 7개에 후기 13개/);
    assert.match(out.stdout, /후기 13개 등록/);
    const posts = mock.state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/articles'));
    assert.deepEqual(posts.map((c) => JSON.parse(c.raw).requests.length), [10, 3]);
    assert.equal(mock.state.articles.size, 15);

    const cleared = await cli(['clear-reviews', '-y'], env);
    assert.match(cleared.stdout, /삭제 완료: 13개/);
    assert.deepEqual([...mock.state.articles.keys()].sort(), [1, 2], '진짜 후기 2개는 남음');
  } finally {
    await mock.close();
  }
});
