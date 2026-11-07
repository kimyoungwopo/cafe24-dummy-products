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
    CAFE24_HOME: dir, // 소유 기록도 임시 폴더에
  };
  return { env, tokenFile };
}

const cli = (args, env) => {
  // 입력(stdin)을 바로 닫아서, 확인 질문이 나오면 "답 없음 = 취소"로 끝나게 한다 (멈추지 않도록).
  const p = run('node', [CLI, ...args], { env, timeout: 60_000 });
  p.child.stdin.end();
  return p;
};

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
    assert.match(deleted.stdout, /삭제 완료: 상품 3개, 후기 0개, 메인진열 항목 0개, 실패 0개/);
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
      await assert.rejects(cli(args, env), /배치 ID가 올바르지 않습니다/, args.join(' '));
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
    assert.match(out.stdout, /삭제 완료: 상품 2개/);
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
    assert.match(out.stdout, /성공 1개, 실패 0개, 결과 불명 1개/);
    assert.equal(mock.state.calls.filter((c) => c.method === 'POST').length, 2);
    // 결과 불명은 자동 삭제 대상이 아니다
    const del = await cli(['delete', '--yes'], env);
    assert.match(del.stdout, /결과 불명 요청 1건은 자동으로 정리하지 않습니다/);
  } finally {
    await mock.close();
  }
});

test('목록 API 캐시로 안 보이는 상품도 소유 기록과 단건 조회로 확인해서 지운다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const created = await cli(['create', '-n', '3', '--no-image'], env);
    const runId = /배치 ID: (\d+)/.exec(created.stdout)[1];
    mock.state.hideFromList = true;
    const out = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(out.stdout, /삭제 완료: 상품 3개/);
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

    const cleared = await cli(['clear-mains', '-y'], env);
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
    assert.equal(mock.state.articles.size, 16);

    const cleared = await cli(['clear-reviews', '-y'], env);
    assert.match(cleared.stdout, /삭제 완료: 13개/);
    assert.deepEqual([...mock.state.articles.keys()].sort(), [1, 2, 3], '진짜 후기 3개는 남음');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- 소유 기록 안전 테스트

test('안전: 형식이 똑같은 더미 코드라도 소유 기록에 없으면 지우지 않고 "기록에 없음"으로만 보여 준다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    mock.state.products.set(4, { product_no: 4, product_name: '사람이 만든 같은 형식', custom_product_code: 'DUMMY-261107143028344-001', display: 'T' });
    await cli(['create', '-n', '2', '--no-image'], env);
    const listed = await cli(['list'], env);
    assert.match(listed.stdout, /총 2개/);
    assert.match(listed.stdout, /기록에 없는 더미 형식 상품 1개/);
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /삭제 완료: 상품 2개/);
    assert.ok(mock.state.products.has(4), '기록에 없는 상품은 남아야 함');
  } finally {
    await mock.close();
  }
});

test('안전: 등록 뒤 자체상품코드가 바뀐 상품은 지우지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '2', '--no-image'], env);
    const [first] = [...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code));
    first.custom_product_code = 'MY-REAL-PRODUCT';
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /기록과 달라진 상품 1개는 건드리지 않습니다/);
    assert.match(out.stdout, /삭제 완료: 상품 1개/);
    assert.ok(mock.state.products.has(first.product_no), '코드가 바뀐 상품은 남아야 함');
  } finally {
    await mock.close();
  }
});

test('안전: 다른 쇼핑몰 기록이나 다른 쇼핑몰 줄이 섞인 기록으로는 지우지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const owned = path.join(env.CAFE24_HOME, 'owned');
    fs.mkdirSync(owned, { recursive: true });
    const rec = (mall, no) => JSON.stringify({ v: 1, ts: 'x', mall, shop: 1, kind: 'product', event: 'created', product_no: no, code: 'DUMMY-261107143028344-001', runId: '261107143028344' });
    mock.state.products.set(4, { product_no: 4, product_name: 'p4', custom_product_code: 'DUMMY-261107143028344-001' });
    // 다른 쇼핑몰 파일
    fs.writeFileSync(path.join(owned, 'othermall-shop1.jsonl'), rec('othermall', 4) + '\n');
    // 이 쇼핑몰 파일 안에 다른 쇼핑몰 줄 + 깨진 줄
    fs.writeFileSync(path.join(owned, 'testmall-shop1.jsonl'), rec('othermall', 4) + '\n{broken\n');
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /삭제할 더미 상품이 없습니다/);
    assert.ok(mock.state.products.has(4));
    assert.ok(!mock.state.calls.some((c) => c.method === 'DELETE'));
  } finally {
    await mock.close();
  }
});

test('안전: 표시가 똑같은 진짜 후기, 원래 있던 메인진열은 정리하지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
    await cli(['create', '-n', '4', '--no-image'], env);
    const dummyNos = [...mock.state.products.values()].filter((p) => isDummyCode(p.custom_product_code)).map((p) => p.product_no);
    // 사용자가 직접 메인(신상품)에 올려 둔 더미 상품 하나
    mock.state.mains.get(3).add(dummyNos[0]);
    await cli(['fill-mains', '-n', '2'], env);
    await cli(['reviews', '-n', '1'], env);

    // 상품은 남기고 메인진열·후기만 정리
    await cli(['clear-mains', '-y'], env);
    assert.ok(mock.state.mains.get(3).has(dummyNos[0]), '사용자가 올린 메인진열은 남아야 함');
    assert.ok(mock.state.mains.get(2).has(1), '원래 있던 진짜 상품 진열도 남아야 함');
    const cr = await cli(['clear-reviews', '-y'], env);
    assert.match(cr.stdout, /삭제 완료: 4개/);
    assert.deepEqual([...mock.state.articles.keys()].sort(), [1, 2, 3], '표시가 같은 진짜 후기(3번)도 남아야 함');
  } finally {
    await mock.close();
  }
});

test('전체 정리는 후기 → 메인진열 → 상품 순서로 하고 기록을 비운다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
    await cli(['create', '-n', '3', '--no-image'], env);
    await cli(['fill-mains', '-n', '2', '--group', '3'], env);
    await cli(['reviews', '-n', '1'], env);
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /삭제 완료: 상품 3개, 후기 3개, 메인진열 항목 2개, 실패 0개/);
    const deletes = mock.state.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.split('/')[4]);
    const firstProduct = deletes.indexOf('products');
    assert.ok(deletes.lastIndexOf('boards') < deletes.indexOf('mains') && deletes.lastIndexOf('mains') < firstProduct, `순서: ${deletes.join(',')}`);
    const again = await cli(['delete', '--yes'], env);
    assert.match(again.stdout, /삭제할 더미 상품이 없습니다/);
  } finally {
    await mock.close();
  }
});

test('예전 버전에서 가져온 기록(legacy-log)은 소유로 인정하지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const owned = path.join(env.CAFE24_HOME, 'owned');
    fs.mkdirSync(owned, { recursive: true });
    mock.state.products.set(11, { product_no: 11, product_name: 'a', custom_product_code: 'DUMMY-261107143028344-001' });
    fs.writeFileSync(path.join(owned, 'testmall-shop1.jsonl'), JSON.stringify({ v: 1, ts: 'x', mall: 'testmall', shop: 1, kind: 'product', event: 'created', product_no: 11, code: 'DUMMY-261107143028344-001', runId: '261107143028344', source: 'legacy-log' }) + '\n');
    const out = await cli(['delete', '--yes'], env);
    assert.match(out.stdout, /삭제할 더미 상품이 없습니다/);
    assert.match(out.stdout, /예전 버전에서 가져온 기록 1줄은 소유로 인정하지 않습니다/);
    assert.ok(mock.state.products.has(11));
  } finally {
    await mock.close();
  }
});

test('purge-legacy: 같은 쇼핑몰 로그 + 지금 상태가 같은 것만, 쇼핑몰 ID를 직접 입력해야 지운다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const run = '261107143028344';
    const code = (n) => `DUMMY-${run}-00${n}`;
    mock.state.products.set(11, { product_no: 11, product_name: 'a', custom_product_code: code(1) });
    mock.state.products.set(12, { product_no: 12, product_name: 'b', custom_product_code: 'CHANGED' });
    mock.state.articles.set(70, { article_no: 70, board_no: 4, writer: '김민지', title: '[더미] 정말 만족해요', content: 'x', product_no: 11 });
    mock.state.articles.set(71, { article_no: 71, board_no: 4, writer: '김민지', title: '[더미] 정말 만족해요', content: 'x', product_no: 1 });
    fs.mkdirSync(env.CAFE24_LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.CAFE24_LOG_DIR, `run-${run}.json`), JSON.stringify({
      runId: run, mallId: 'testmall',
      created: [{ product_no: 11, custom_product_code: code(1) }, { product_no: 12, custom_product_code: code(2) }, { product_no: 13, custom_product_code: code(3) }],
    }));
    fs.writeFileSync(path.join(env.CAFE24_LOG_DIR, 'run-261107143028345.json'), JSON.stringify({
      runId: '261107143028345', mallId: 'othermall', created: [{ product_no: 2, custom_product_code: 'DUMMY-261107143028345-001' }],
    }));
    fs.writeFileSync(path.join(env.CAFE24_LOG_DIR, 'reviews-261107145409393.json'), JSON.stringify({
      runId: '261107145409393', board_no: 4, created: [{ article_no: 70, product_no: 11 }, { article_no: 71, product_no: 1 }],
    }));
    const dry = await cli(['purge-legacy', '--dry-run'], env);
    assert.match(dry.stdout, /상품: 로그와 지금 자체상품코드가 같은 1개 \(달라짐 1, 이미 없음 1\)/);
    assert.match(dry.stdout, /후기: 위 상품에 달려 있고 더미 표시가 그대로인 1개/);
    assert.match(dry.stdout, /다른 쇼핑몰\(othermall\)/);
    assert.match(dry.stdout, /증거가 완전하지 않습니다/);

    const wrong = await cli(['purge-legacy', '--confirm-mall', 'othermall'], env);
    assert.match(wrong.stdout, /일치하지 않아 취소/);
    assert.ok(mock.state.products.has(11));

    const ok = await cli(['purge-legacy', '--confirm-mall', 'testmall', '-y'], env);
    assert.match(ok.stdout, /삭제 완료: 후기 1개, 상품 1개, 실패 0개/);
    assert.ok(!mock.state.products.has(11) && !mock.state.articles.has(70));
    assert.ok(mock.state.products.has(12) && mock.state.products.has(2) && mock.state.articles.has(71), '근거 없는 것은 남아야 함');
  } finally {
    await mock.close();
  }
});

test('실패 경우: 후기 등록 응답이 비거나 일부만 오면 확인된 것만 기록하고 나머지는 결과 불명', async () => {
  for (const mode of ['none', 'partial']) {
    const mock = await startMockServer({ articlesResponse: mode });
    try {
      const { env, tokenFile } = setup(mock.base);
      const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
      await cli(['create', '-n', '3', '--no-image'], env);
      const out = await cli(['reviews', '-n', '1'], env);
      const expectCreated = mode === 'none' ? 0 : 1;
      assert.match(out.stdout, new RegExp(`후기 ${expectCreated}개 등록, 실패 0개, 결과 불명 ${3 - expectCreated}개`), mode);
      const cr = await cli(['clear-reviews', '-y'], env);
      assert.match(cr.stdout, /결과 불명 요청 1건은 자동으로 정리하지 않습니다/);
      // 실제로는 3개가 다 등록됐지만, 확인된 것만 지운다
      assert.equal([...mock.state.articles.values()].filter((a) => a.article_no >= 500).length, 3 - expectCreated, mode);
    } finally {
      await mock.close();
    }
  }
});

test('실패 경우: 메인진열 응답에 일부만 실리면 그것만 소유로 기록한다', async () => {
  const mock = await startMockServer({ mainsResponse: 'subset' });
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '3', '--no-image'], env);
    const out = await cli(['fill-mains', '-n', '3', '--group', '3'], env);
    assert.match(out.stdout, /신상품\(3\) ← 더미 상품 1개 추가 \(결과 불명 2개\)/);
    await cli(['clear-mains', '-y'], env);
    assert.equal(mock.state.mains.get(3).size, 2, '확인 안 된 2개는 빼지 않음');
  } finally {
    await mock.close();
  }
});

test('실패 경우: 내용이 바뀐 후기(표시는 그대로)와 목록 캐시로 안 보이는 메인진열은 건드리지 않고 기록도 유지', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
    await cli(['create', '-n', '2', '--no-image'], env);
    await cli(['reviews', '-n', '1'], env);
    await cli(['fill-mains', '-n', '2', '--group', '3'], env);
    // 사람이 후기 제목을 고침 (접두어·작성자는 그대로)
    const mine = [...mock.state.articles.values()].filter((a) => a.article_no >= 500);
    mine[0].title = '[더미] 제가 직접 고친 진짜 후기';
    // 메인진열 목록 캐시에서 하나가 빠짐
    const [hidden] = [...mock.state.mains.get(3)];
    mock.state.hiddenMainNos.add(hidden);

    await cli(['clear-mains', '-y'], env);
    assert.ok(mock.state.mains.get(3).has(hidden), '목록에 안 보이는 항목은 빼지 않음');
    const cr = await cli(['clear-reviews', '-y'], env);
    assert.match(cr.stdout, /기록과 달라진 후기 1개는 건드리지 않습니다/);
    assert.ok(mock.state.articles.has(mine[0].article_no));

    // 캐시가 풀리면 다음 정리 때 빠진다 (기록이 유지됐으므로)
    mock.state.hiddenMainNos.clear();
    const again = await cli(['clear-mains', '-y'], env);
    assert.match(again.stdout, /메인진열에서 뺀 더미 상품: 1개/);
  } finally {
    await mock.close();
  }
});

test('실패 경우: 미리보기 뒤 실행 직전에 바뀐 상품은 건너뛴다 (단계별 재확인)', async () => {
  const mock = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-core-'));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  try {
    const { Cafe24Client } = await import('../src/api.js');
    const core = await import('../src/core.js');
    const cfg = { apiBase: mock.base, mallId: 'testmall', shopNo: 1, apiVersion: '' };
    const client = new Cafe24Client(cfg, { minIntervalMs: 1, getToken: async () => 'access-1' });
    const ctx = core.createContext(client, cfg);
    await core.createProducts(ctx, { count: 2, withImage: false });
    const plan = await core.planCleanup(ctx, { reviews: false });
    assert.equal(plan.products.ok.length, 2);
    const victim = plan.products.ok[0].product_no;
    mock.state.products.get(victim).custom_product_code = 'NOW-A-REAL-PRODUCT';
    const done = await core.executeCleanup(ctx, plan);
    assert.equal(done.products, 1);
    assert.equal(done.skippedChanged, 1);
    assert.ok(mock.state.products.has(victim));
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

// ---------------------------------------------------------------- Codex 재검수 회귀 테스트

const withCommunity = (tokenFile) => {
  const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_community', 'mall.write_community'] }));
};
const ownedLines = (env) => {
  const f = path.join(env.CAFE24_HOME, 'owned', 'testmall-shop1.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('회귀: 진짜 상품으로 바뀐 상품의 메인진열은 clear-mains와 delete 모두 빼지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '2', '--no-image'], env);
    await cli(['fill-mains', '-n', '2', '--group', '3'], env);
    const [converted, other] = [...mock.state.mains.get(3)];
    mock.state.products.get(converted).custom_product_code = 'NOW-REAL';

    const cm = await cli(['clear-mains', '-y'], env);
    assert.match(cm.stdout, /진열된 상품이 기록과 달라진 메인진열 항목 1개는 건드리지 않습니다/);
    assert.ok(mock.state.mains.get(3).has(converted), '바뀐 상품의 진열은 남아야 함');
    assert.ok(!mock.state.mains.get(3).has(other));

    await cli(['fill-mains', '-n', '1', '--group', '3'], env);
    const del = await cli(['delete', '--yes'], env);
    assert.match(del.stdout, /기록과 달라진 상품 1개는 건드리지 않습니다/);
    assert.ok(mock.state.products.has(converted) && mock.state.mains.get(3).has(converted));
  } finally {
    await mock.close();
  }
});

test('회귀: 제목·작성자는 그대로 두고 본문만 진짜 후기로 바꾼 글은 지우지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    withCommunity(tokenFile);
    await cli(['create', '-n', '2', '--no-image'], env);
    await cli(['reviews', '-n', '1'], env);
    const mine = [...mock.state.articles.values()].filter((a) => a.article_no >= 500);
    assert.equal(mine.length, 2);
    assert.ok(ownedLines(env).filter((r) => r.kind === 'review' && r.event === 'created').every((r) => /^[0-9a-f]{64}$/.test(r.content_sha256)));
    mine[0].content = '<p>실제로 써 보니 정말 좋아서 직접 남기는 후기예요.</p>';
    const cr = await cli(['clear-reviews', '-y'], env);
    assert.match(cr.stdout, /기록과 달라진 후기 1개는 건드리지 않습니다/);
    assert.match(cr.stdout, /삭제 완료: 1개/);
    assert.ok(mock.state.articles.has(mine[0].article_no));
  } finally {
    await mock.close();
  }
});

test('회귀: 이상한 단건 조회 응답은 "없음"으로 보지 않고 기록을 유지한다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '1', '--no-image'], env);
    mock.state.hideFromList = true; // 여러 건 조회에서 빠짐 → 단건 조회로 확인
    mock.state.malformedDetail = true;
    await assert.rejects(cli(['delete', '--yes'], env), /응답 형식이 올바르지 않습니다/);
    assert.ok(!ownedLines(env).some((r) => r.kind === 'product' && r.event === 'deleted'), '기록을 지우면 안 됨');
    mock.state.malformedDetail = false;
    const ok = await cli(['delete', '--yes'], env);
    assert.match(ok.stdout, /삭제 완료: 상품 1개/);
  } finally {
    await mock.close();
  }
});

test('회귀: 상품을 지운 뒤에도 그 배치의 결과 불명 후기는 delete --run에서 계속 보인다', async () => {
  const mock = await startMockServer({ articlesResponse: 'none' });
  try {
    const { env, tokenFile } = setup(mock.base);
    withCommunity(tokenFile);
    const created = await cli(['create', '-n', '1', '--no-image'], env);
    const runId = /배치 ID: (\d+)/.exec(created.stdout)[1];
    await cli(['reviews', '-n', '1'], env);
    const first = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(first.stdout, /결과 불명 요청 1건/);
    const again = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(again.stdout, /삭제할 더미 상품이 없습니다/);
    assert.match(again.stdout, /결과 불명 요청 1건/);
  } finally {
    await mock.close();
  }
});

test('회귀: 예전 데이터 정리 중 근거 상품이 바뀌면 그 상품의 후기도 지우지 않는다', async () => {
  const mock = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-legacy-'));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  try {
    const run = '261107143028344';
    mock.state.products.set(11, { product_no: 11, product_name: 'a', custom_product_code: `DUMMY-${run}-001` });
    mock.state.articles.set(70, { article_no: 70, board_no: 4, writer: '김민지', title: '[더미] 정말 만족해요', content: 'x', product_no: 11 });
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, `run-${run}.json`), JSON.stringify({ runId: run, mallId: 'testmall', created: [{ product_no: 11, custom_product_code: `DUMMY-${run}-001` }] }));
    fs.writeFileSync(path.join(logDir, 'reviews-261107145409393.json'), JSON.stringify({ runId: '261107145409393', board_no: 4, created: [{ article_no: 70, product_no: 11 }] }));

    const { Cafe24Client } = await import('../src/api.js');
    const core = await import('../src/core.js');
    const cfg = { apiBase: mock.base, mallId: 'testmall', shopNo: 1, apiVersion: '' };
    const ctx = core.createContext(new Cafe24Client(cfg, { minIntervalMs: 1, getToken: async () => 'access-1' }), cfg);
    const plan = await core.planLegacyPurge(ctx, { logDir });
    assert.equal(plan.products.ok.length, 1);
    assert.equal(plan.reviews.ok.length, 1);
    mock.state.products.get(11).custom_product_code = 'NOW-REAL'; // 미리보기 뒤에 바뀜
    const done = await core.executeLegacyPurge(ctx, plan);
    assert.equal(done.reviews, 0);
    assert.equal(done.products, 0);
    assert.ok(mock.state.articles.has(70) && mock.state.products.has(11));
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

// ---------------------------------------------------------------- Codex 3차 검수 회귀 테스트

test('회귀: 상품 기록 줄이 깨져 소유 상태가 불확실하면 그 상품의 메인진열 기록을 정리하지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '1', '--no-image'], env);
    await cli(['fill-mains', '-n', '1', '--group', '3'], env);
    const file = path.join(env.CAFE24_HOME, 'owned', 'testmall-shop1.jsonl');
    // 상품 'created' 줄을 깨뜨림 → 진열 기록은 남았는데 상품 기록이 안 보이는 상태
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, lines.map((l) => (JSON.parse(l).kind === 'product' ? '{damaged' : l)).join('\n') + '\n');
    const out = await cli(['clear-mains', '-y'], env);
    assert.match(out.stdout, /읽을 수 없는 줄 1개/);
    assert.match(out.stdout, /메인진열에서 뺀 더미 상품: 0개/);
    assert.ok(!ownedLines2(file).some((r) => r.kind === 'main' && r.event === 'removed'), '진열 기록을 지우면 안 됨');
    assert.equal(mock.state.mains.get(3).size, 1);
  } finally {
    await mock.close();
  }
});
const ownedLines2 = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

test('회귀: 미리보기 때 없던 상품이 실행 때 다시 보이면 지우지 않고 알린다 (확인 없는 경로 포함)', async () => {
  const mock = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-reappear-'));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  try {
    const { Cafe24Client } = await import('../src/api.js');
    const core = await import('../src/core.js');
    const cfg = { apiBase: mock.base, mallId: 'testmall', shopNo: 1, apiVersion: '' };
    const ctx = core.createContext(new Cafe24Client(cfg, { minIntervalMs: 1, getToken: async () => 'access-1' }), cfg);
    const r = await core.createProducts(ctx, { count: 2, withImage: false });
    const [a, b] = r.created.map((c) => c.product_no);
    const saved = mock.state.products.get(a);
    mock.state.products.delete(a); // 미리보기 때는 a가 없음
    const plan = await core.planCleanup(ctx, { reviews: false });
    assert.deepEqual(plan.products.gone.map((p) => p.product_no), [a]);
    mock.state.products.set(a, saved); // 실행 전에 다시 나타남

    // 확인 없는 경로: 기록 정리만
    const t = await core.tombstoneGoneProducts(ctx, plan.products.gone);
    assert.equal(t.reappeared, 1);
    assert.equal(t.gone, 0);
    // 일반 경로: 확인받은 b만 지우고 a는 건드리지 않음
    const done = await core.executeCleanup(ctx, plan);
    assert.equal(done.products, 1);
    assert.equal(done.reappeared, 1);
    assert.ok(mock.state.products.has(a) && !mock.state.products.has(b));
    assert.ok(!mock.state.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(`/products/${a}`)));
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

test('회귀: 상품을 지운 뒤에도 같은 배치의 남은 후기 기록은 delete --run 보고에 나오고, 권한 경고도 빠지지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { env, tokenFile } = setup(mock.base);
    withCommunity(tokenFile);
    const created = await cli(['create', '-n', '1', '--no-image'], env);
    const runId = /배치 ID: (\d+)/.exec(created.stdout)[1];
    await cli(['reviews', '-n', '1'], env);
    const [mine] = [...mock.state.articles.values()].filter((a) => a.article_no >= 500);
    mine.content = '<p>직접 고친 진짜 후기</p>';
    const first = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(first.stdout, /기록과 달라진 후기 1개/);
    assert.match(first.stdout, /삭제 완료: 상품 1개, 후기 0개/);
    const again = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(again.stdout, /삭제할 더미 상품이 없습니다/);
    assert.match(again.stdout, /기록과 달라진 후기 1개/, '상품 기록이 정리된 뒤에도 보여야 함');

    // 게시판 권한이 없을 때, 지울 게 없어도 경고가 나와야 함
    const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...t, scopes: ['mall.read_product', 'mall.write_product'] }));
    const noScope = await cli(['delete', '--run', runId, '--yes'], env);
    assert.match(noScope.stdout, /게시판 권한이 없어 후기는 정리하지 않습니다/);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- Codex 4차 검수 회귀 테스트

test('회귀: clear-mains는 대상을 보여 주고 확인을 받는다 (입력이 닫혀 있으면 취소)', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    await cli(['create', '-n', '2', '--no-image'], env);
    await cli(['fill-mains', '-n', '2', '--group', '3'], env);
    const out = await cli(['clear-mains'], env); // execFile의 stdin은 바로 닫힘 → 답 없음
    assert.match(out.stdout, /뺄 대상: 이 도구가 넣은 메인진열 항목 2개/);
    assert.match(out.stdout, /취소했습니다/);
    assert.equal(mock.state.mains.get(3).size, 2);
    assert.ok(!mock.state.calls.some((c) => c.method === 'DELETE'));
  } finally {
    await mock.close();
  }
});

async function coreCtx(mock, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  const { Cafe24Client } = await import('../src/api.js');
  const core = await import('../src/core.js');
  const cfg = { apiBase: mock.base, mallId: 'testmall', shopNo: 1, apiVersion: '' };
  const ctx = core.createContext(new Cafe24Client(cfg, { minIntervalMs: 1, getToken: async () => 'access-1' }), cfg);
  return { core, ctx, file: ctx.manifest.file };
}

test('회귀: 미리보기 때 "상품 없음"이던 진열은 실행 때 상품이 다시 보여도 빼지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-mg-');
    const [p] = (await core.createProducts(ctx, { count: 1, withImage: false })).created;
    await core.fillMains(ctx, { perGroup: 1, groups: [3] });
    const saved = mock.state.products.get(p.product_no);
    mock.state.products.delete(p.product_no); // 미리보기 때는 상품이 없음 (진열 기록은 남음)
    const plan = await core.planCleanup(ctx, { products: false, reviews: false });
    assert.equal(plan.mains.ok.length, 0);
    assert.equal(plan.mains.productGone.length, 1);
    mock.state.products.set(p.product_no, saved); // 실행 전에 다시 나타남
    const done = await core.executeCleanup(ctx, plan);
    assert.equal(done.mains, 0);
    assert.equal(done.reappeared, 1);
    assert.ok(mock.state.mains.get(3).has(p.product_no));
    assert.ok(!mock.state.calls.some((c) => c.method === 'DELETE'));
    assert.equal(ctx.manifest.load().mains.size, 1, '진열 기록 유지');
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

test('회귀: 예전 삭제 기록이 있어도 상품이 지금 다시 있으면 진열 기록을 정리하지 않는다', async () => {
  const mock = await startMockServer();
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-ot-');
    const [p] = (await core.createProducts(ctx, { count: 1, withImage: false })).created;
    await core.fillMains(ctx, { perGroup: 1, groups: [3] });
    const saved = mock.state.products.get(p.product_no);
    mock.state.products.delete(p.product_no);
    // 상품만 "없음"으로 기록 정리 (진열 기록은 남음)
    const t = await core.tombstoneGoneProducts(ctx, [{ product_no: p.product_no, code: p.code, runId: undefined }]);
    assert.equal(t.gone, 1);
    mock.state.products.set(p.product_no, saved); // 나중에 다시 나타남
    const plan = await core.planCleanup(ctx, { products: false, reviews: false });
    assert.equal(plan.mains.productGone.length, 0, '다시 조회해서 있으면 "상품 없음"이 아님');
    assert.equal(plan.mains.productChanged.length, 1);
    const done = await core.executeCleanup(ctx, plan);
    assert.equal(done.gone, 0);
    assert.equal(ctx.manifest.load().mains.size, 1, '진열 기록 유지');
    assert.ok(mock.state.mains.get(3).has(p.product_no));
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

// ---------------------------------------------------------------- Codex 5차 검수 회귀 테스트

test('회귀: 기록 파일 마지막 줄에 줄바꿈이 없거나 중간에 끊겨 있어도, 새 기록과 앞의 정상 기록이 모두 읽힌다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-nl-'));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  try {
    const { Manifest } = await import('../src/manifest.js');
    const run = '261107143028344';
    const m = new Manifest('testmall', 1);
    assert.equal(m.file, path.join(dir, 'owned', 'testmall-shop1.jsonl'), '환경변수로 바꾼 위치를 매번 따라감');
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    const rec = (no) => JSON.stringify({ v: 1, ts: 'x', mall: 'testmall', shop: 1, kind: 'product', event: 'created', product_no: no, code: `DUMMY-${run}-00${no}`, runId: run });

    // 1) 정상 기록인데 마지막 줄바꿈만 없음
    fs.writeFileSync(m.file, rec(1));
    m.append('product', 'created', { product_no: 2, code: `DUMMY-${run}-002`, runId: run });
    let st = m.load();
    assert.deepEqual([...st.products.keys()].sort(), [1, 2]);
    assert.equal(st.invalidLines, 0);

    // 2) 마지막 줄이 쓰다가 끊김 → 끊긴 줄만 "읽을 수 없는 줄"이 되고 새 기록은 살아 있어야 함
    fs.appendFileSync(m.file, '{"v":1,"ts":"x","mall":"testm');
    m.append('product', 'created', { product_no: 3, code: `DUMMY-${run}-003`, runId: run });
    st = m.load();
    assert.deepEqual([...st.products.keys()].sort(), [1, 2, 3]);
    assert.equal(st.invalidLines, 1);
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
  }
});

// ---------------------------------------------------------------- Codex 최종 확인 회귀 테스트

test('회귀: 기록 파일을 읽고 쓸 수 없으면 카페24에 아무것도 만들지 않고 멈춘다', async () => {
  const mock = await startMockServer();
  try {
    const { env } = setup(mock.base);
    const file = path.join(env.CAFE24_HOME, 'owned', 'testmall-shop1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o200); // 쓰기만 되고 읽기 안 됨
    await assert.rejects(cli(['create', '-n', '2', '--no-image'], env), /읽고 쓸 수 없어 작업을 시작하지 않았습니다/);
    assert.ok(!mock.state.calls.some((c) => c.method === 'POST'), '상품 등록 요청이 나가면 안 됨');
    fs.chmodSync(file, 0o600);
  } finally {
    await mock.close();
  }
});

test('회귀: 기록 쓰기에 실패하면 어떤 항목이었는지(ID 포함) 알리고 멈춘다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c24-wf-'));
  process.env.CAFE24_OWNED_DIR = path.join(dir, 'owned');
  try {
    const { Manifest } = await import('../src/manifest.js');
    const m = new Manifest('testmall', 1);
    m.ensureWritable();
    fs.chmodSync(m.file, 0o400); // 이후 쓰기 실패
    assert.throws(
      () => m.append('product', 'created', { product_no: 777, code: 'DUMMY-261107143028344-001', runId: '261107143028344' }),
      (e) => e.manifestWrite === true && /"product_no":777/.test(e.message) && /직접 확인/.test(e.message),
    );
    fs.chmodSync(m.file, 0o600);
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
  }
});

// ---------------------------------------------------------------- Codex 6차 확인 회귀 테스트

test('회귀: 후기 묶음 기록 중 쓰기가 실패하면 못 쓴 항목을 전부(ID 포함) 알리고 멈춘다', async () => {
  const mock = await startMockServer();
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-ba-');
    await core.createProducts(ctx, { count: 3, withImage: false });
    const board = await core.resolveReviewBoard(ctx.client);
    const { requests } = await core.planReviews(ctx, { maxPerProduct: 1 });
    const realAppend = ctx.manifest.append.bind(ctx.manifest);
    let n = 0;
    ctx.manifest.append = (...args) => {
      if (args[0] === 'review' && ++n === 1) throw Object.assign(new Error('disk full'), { manifestWrite: true });
      return realAppend(...args);
    };
    await assert.rejects(core.postReviews(ctx, board, requests), (e) => {
      const ids = [...mock.state.articles.values()].filter((a) => a.article_no >= 500).map((a) => a.article_no);
      assert.equal(ids.length, 3);
      return e.manifestWrite && /기록하지 못한 항목 3개/.test(e.message) && ids.every((id) => e.message.includes(`"article_no":${id}`));
    });
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

test('회귀: 정리 중 기록 쓰기가 실패하면 다음 삭제로 넘어가지 않고 멈춘다', async () => {
  const mock = await startMockServer();
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-cs-');
    await core.createProducts(ctx, { count: 2, withImage: false });
    const board = await core.resolveReviewBoard(ctx.client);
    const { requests } = await core.planReviews(ctx, { maxPerProduct: 1 });
    await core.postReviews(ctx, board, requests);
    const plan = await core.planCleanup(ctx);
    assert.equal(plan.reviews.ok.length, 2);
    const realAppend = ctx.manifest.append.bind(ctx.manifest);
    ctx.manifest.append = (...args) => {
      if (args[0] === 'review' && args[1] === 'deleted') throw Object.assign(new Error('disk full'), { manifestWrite: true });
      return realAppend(...args);
    };
    await assert.rejects(core.executeCleanup(ctx, plan), (e) => e.manifestWrite === true);
    const deletes = mock.state.calls.filter((c) => c.method === 'DELETE');
    assert.equal(deletes.length, 1, '첫 삭제 뒤 기록 실패 → 더 지우지 않음');
    assert.equal([...mock.state.articles.values()].filter((a) => a.article_no >= 500).length, 1);
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

test('후속: 묶음 기록 중 두 번째에서 실패하면 첫 번째는 기록되고, 나머지 전부가 오류에 나온다', async () => {
  const mock = await startMockServer();
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-b2-');
    await core.createProducts(ctx, { count: 3, withImage: false });
    const board = await core.resolveReviewBoard(ctx.client);
    const { requests } = await core.planReviews(ctx, { maxPerProduct: 1 });
    const realAppend = ctx.manifest.append.bind(ctx.manifest);
    let n = 0;
    ctx.manifest.append = (...args) => {
      if (args[0] === 'review' && ++n === 2) throw Object.assign(new Error('disk full'), { manifestWrite: true });
      return realAppend(...args);
    };
    const ids = () => [...mock.state.articles.values()].filter((a) => a.article_no >= 500).map((a) => a.article_no).sort();
    await assert.rejects(core.postReviews(ctx, board, requests), (e) => {
      const [first, ...rest] = ids();
      return /기록하지 못한 항목 2개/.test(e.message) && !e.message.includes(`"article_no":${first},`) && rest.every((id) => e.message.includes(`"article_no":${id}`));
    });
    assert.equal(ctx.manifest.load().reviews.size, 1, '첫 번째는 기록됨');
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});

test('후속: 메인진열 응답에 확인된 것과 결과 불명이 섞였을 때 기록 실패하면 둘 다 오류에 나온다', async () => {
  const mock = await startMockServer({ mainsResponse: 'subset' });
  try {
    const { core, ctx } = await coreCtx(mock, 'c24-mm-');
    await core.createProducts(ctx, { count: 3, withImage: false });
    const realAppend = ctx.manifest.append.bind(ctx.manifest);
    ctx.manifest.append = (...args) => {
      if (args[0] === 'main') throw Object.assign(new Error('disk full'), { manifestWrite: true });
      return realAppend(...args);
    };
    await assert.rejects(core.fillMains(ctx, { perGroup: 3, groups: [3] }), (e) =>
      /기록하지 못한 항목 2개/.test(e.message) && /main\/added/.test(e.message) && /main\/unknown/.test(e.message) && /"product_nos":\[\d+,\d+\]/.test(e.message));
  } finally {
    delete process.env.CAFE24_OWNED_DIR;
    await mock.close();
  }
});
