#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getConfig, LOG_DIR, DUMMY_CODE_PREFIX, DUMMY_REVIEW_PREFIX } from './config.js';
import { buildReviews, isDummyReview } from './review.js';
import { login, readToken } from './auth.js';
import { Cafe24Client } from './api.js';
import { buildDummyProduct, makeRunId, isDummyCode, RUN_ID_PATTERN } from './dummy.js';
import { makeDummyImage, toDataUri } from './image.js';
import { confirm } from './prompt.js';

const HELP = `카페24 테스트용 더미 상품 등록 도구

사용법: node src/cli.js <명령> [옵션]

명령:
  login                 카페24 OAuth 로그인 (토큰 저장)
  status                저장된 토큰 상태 확인
  categories            상품분류(카테고리) 번호 목록 보기
  create                더미 상품 등록
  list                  등록된 더미 상품 목록
  delete                더미 상품 삭제

  mains                 메인진열(추천상품·신상품 등) 목록과 상품 수
  fill-mains            메인진열마다 더미 상품 채우기 (-n 개수, 기본 8 / --group 2,3 / --run)
  clear-mains           메인진열에서 더미 상품만 빼기 (상품은 그대로)

  boards                게시판 목록
  reviews               더미 상품에 상품후기 달기 (-n 상품당 최대 개수, 기본 3 / --board / --run)
  clear-reviews         더미 후기만 삭제 (--board)

create 옵션:
  -n, --count <수>       등록할 개수 (기본 10, 최대 500)
  -c, --category <번호>  진열할 상품분류 번호. 여러 개는 쉼표로: -c 29,30,32
                         (categories 명령으로 확인, 여러 개면 번갈아 배정)
      --spread           진열 중인 맨 아래 분류 전체에 고르게 나눠 등록
      --options          색상·사이즈 옵션 추가
      --hidden           진열안함·판매안함으로 등록
      --no-image         이미지 업로드 생략
      --prefix <문자열>  상품명 앞에 붙일 문구 (기본 "[더미] ")
      --dry-run          API 호출 없이 보낼 내용만 출력

list / delete 옵션:
      --run <배치ID>     특정 배치만 (create 결과에 표시됨)
  -y, --yes              삭제 확인 질문 생략

더미 상품의 자체상품코드는 "${DUMMY_CODE_PREFIX}<15자리 배치ID>-<번호>" 형식이며,
list/delete는 정확히 이 형식인 상품만 다룹니다.
`;

function writeLog(runId, data) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `run-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** API 분류 객체 → { no, names, path } (상위 → 하위 순) */
function toCategory(c) {
  const levels = [1, 2, 3, 4];
  const path = levels.map((d) => c.full_category_no?.[d]).filter((v) => v !== null && v !== undefined && v !== '').map(Number);
  const names = levels.map((d) => c.full_category_name?.[d]).filter(Boolean);
  return {
    no: Number(c.category_no),
    names: names.length ? names : [c.category_name],
    path: path.length ? path : [Number(c.category_no)],
  };
}

const categoryLabel = (cat) => (cat.names.length ? cat.names.join(' > ') : `분류 ${cat.no}`);

/**
 * -c 29,30,32 또는 --spread 로 등록할 분류 목록을 정한다.
 * --spread: 진열 중(use_display=T)인 맨 아래 분류 전체.
 */
async function resolveCategories(values, client) {
  if (values.spread && values.category !== undefined) throw new Error('--spread와 --category는 함께 쓸 수 없습니다.');
  if (!values.spread && values.category === undefined) return [];

  let requested = [];
  if (values.category !== undefined) {
    requested = values.category.split(',').map((s) => s.trim());
    if (!requested.length || requested.some((s) => !/^\d+$/.test(s))) {
      throw new Error('--category는 숫자 또는 쉼표로 구분한 숫자여야 합니다. 예: -c 29,30,32');
    }
  }

  if (!client) {
    // dry-run이고 로그인 전: 이름·상위 분류 정보 없이 번호만 쓴다.
    if (values.spread) throw new Error('--spread는 분류 목록을 조회해야 해서 login이 필요합니다.');
    return requested.map((no) => ({ no: Number(no), names: [], path: [Number(no)] }));
  }

  const all = await client.listCategories();
  if (values.spread) {
    const parents = new Set(all.map((c) => Number(c.parent_category_no)));
    const leaves = all.filter((c) => !parents.has(Number(c.category_no)) && (c.use_display ?? 'T') === 'T');
    if (!leaves.length) throw new Error('진열 중인 상품분류가 없습니다. `categories` 명령으로 확인하세요.');
    return leaves.map(toCategory).sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
  }
  const byNo = new Map(all.map((c) => [Number(c.category_no), c]));
  const missing = requested.filter((no) => !byNo.has(Number(no)));
  if (missing.length) throw new Error(`없는 상품분류 번호: ${missing.join(', ')} (\`categories\` 명령으로 확인하세요)`);
  return requested.map((no) => toCategory(byNo.get(Number(no))));
}

async function cmdCreate(values) {
  const count = Number(values.count ?? 10);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error('--count는 1~500 사이 정수여야 합니다.');
  }
  const runId = makeRunId();
  const opts = {
    runId,
    namePrefix: values.prefix ?? '[더미] ',
    display: values.hidden ? 'F' : 'T',
    selling: values.hidden ? 'F' : 'T',
    withOptions: Boolean(values.options),
  };
  const withImage = !values['no-image'];
  const dryRun = Boolean(values['dry-run']);

  // dry-run이라도 로그인돼 있으면 분류 이름을 조회해 실제와 같은 상품명을 보여 준다.
  const cfg = dryRun ? getConfig({ requireOAuth: false }) : getConfig();
  const client = !dryRun || (cfg.apiBase && readToken()) ? new Cafe24Client(cfg) : null;
  const categories = await resolveCategories(values, client);
  // 분류를 번갈아 배정해서, 개수가 적어도 모든 분류에 고르게 들어가게 한다.
  const categoryFor = (i) => (categories.length ? categories[(i - 1) % categories.length] : undefined);
  const productOpts = (i) => ({
    ...opts,
    category: categoryFor(i),
    round: categories.length ? Math.floor((i - 1) / categories.length) : undefined,
  });

  if (categories.length > 1) {
    console.log(`상품분류 ${categories.length}곳에 나눠 등록합니다 (분류당 약 ${Math.ceil(count / categories.length)}개):`);
    for (const c of categories) console.log(`  ${String(c.no).padStart(5)}  ${categoryLabel(c)}`);
    console.log('');
  }

  if (dryRun) {
    for (let i = 1; i <= count; i++) {
      console.log(JSON.stringify(buildDummyProduct(i, productOpts(i)), null, 2));
    }
    console.log(`\n(dry-run) ${count}개 — 실제로는 등록하지 않았습니다. 이미지 업로드: ${withImage ? '함' : '안 함'}`);
    return;
  }

  if (!values.hidden) {
    console.log('⚠️  진열함·판매함 상태로 등록합니다. 운영 중인 쇼핑몰이라면 --hidden 옵션을 쓰세요.');
  }
  const perItem = withImage ? 2 : 1;
  console.log(`배치 ${runId}: 더미 상품 ${count}개 등록 시작 (예상 소요 약 ${Math.ceil((count * perItem * 0.5) / 60)}분 이상)\n`);

  const log = { runId, mallId: cfg.mallId, startedAt: new Date().toISOString(), created: [], failed: [] };
  let logFile = writeLog(runId, log);
  for (let i = 1; i <= count; i++) {
    const category = categoryFor(i);
    const request = buildDummyProduct(i, productOpts(i));
    const label = `[${i}/${count}] ${request.product_name}${category && categories.length > 1 ? `  (${category.names.at(-1) ?? category.no})` : ''}`;
    try {
      const res = await client.createProduct(request);
      const productNo = res?.product?.product_no;
      if (!productNo) throw new Error(`응답에 product_no가 없습니다: ${JSON.stringify(res).slice(0, 200)}`);
      const entry = {
        index: i,
        product_no: productNo,
        custom_product_code: request.custom_product_code,
        product_name: request.product_name,
        category_no: category?.no,
      };
      if (withImage) {
        try {
          await client.uploadProductImage(productNo, toDataUri(makeDummyImage(i)));
          entry.image = true;
        } catch (e) {
          entry.image = false;
          entry.image_error = e.message;
        }
      }
      log.created.push(entry);
      console.log(`✅ ${label} → 상품번호 ${productNo}${entry.image === false ? ` (이미지 실패: ${entry.image_error})` : ''}`);
    } catch (e) {
      log.failed.push({ index: i, product_name: request.product_name, error: e.message });
      console.log(`❌ ${label} — ${e.message}`);
      if (e.isAuthError || e.status === 401 || e.status === 403) {
        console.log('\n권한 오류로 중단합니다. 앱 권한(mall.write_product)과 로그인 상태를 확인하세요.');
        break;
      }
    }
    logFile = writeLog(runId, log);
  }
  log.finishedAt = new Date().toISOString();
  logFile = writeLog(runId, log);
  console.log(`\n완료: 성공 ${log.created.length}개, 실패 ${log.failed.length}개`);
  console.log(`배치 ID: ${runId}  (이 배치만 지우기: node src/cli.js delete --run ${runId})`);
  console.log(`로그: ${logFile}`);
}

function validateRunId(runId) {
  // --run= 처럼 빈 값이 들어오면 "전체 삭제"가 되지 않도록 undefined가 아닌 모든 값을 검사한다.
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`--run 값이 올바르지 않습니다: "${runId}" (create 결과에 나온 15자리 배치 ID)`);
  }
}

function readRunLog(runId) {
  const file = path.join(LOG_DIR, `run-${runId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).created || [];
  } catch {
    return [];
  }
}

async function findDummies(client, runId) {
  validateRunId(runId);
  const code = runId !== undefined ? `${DUMMY_CODE_PREFIX}${runId}-` : DUMMY_CODE_PREFIX;
  const found = await client.findProductsByCustomCode(code);
  // API 검색은 "포함" 조건이라, 이 도구가 만든 코드 형식(DUMMY-<15자리>-<3자리>)만 다시 거른다.
  const items = found.filter((p) => isDummyCode(p.custom_product_code, runId));

  // 상품 목록 API는 캐시가 있어 방금 만든 상품이 빠질 수 있으므로, 배치 로그의 상품번호로 보완한다.
  if (runId !== undefined) {
    const seen = new Set(items.map((p) => Number(p.product_no)));
    for (const e of readRunLog(runId)) {
      if (!seen.has(Number(e.product_no)) && isDummyCode(e.custom_product_code, runId)) {
        items.push({ ...e, fromLog: true });
      }
    }
  }
  return items;
}

async function cmdList(values) {
  const cfg = getConfig();
  const client = new Cafe24Client(cfg);
  const items = await findDummies(client, values.run);
  if (!items.length) {
    console.log('더미 상품이 없습니다.');
    return;
  }
  for (const p of items) {
    const state = p.fromLog ? '(로그)' : p.display === 'T' ? '진열' : '미진열';
    console.log(`${String(p.product_no).padStart(6)}  ${p.custom_product_code.padEnd(25)}  ${state}  ${p.product_name}`);
  }
  console.log(`\n총 ${items.length}개`);
}

async function cmdDelete(values) {
  const cfg = getConfig();
  const client = new Cafe24Client(cfg);
  const items = await findDummies(client, values.run);
  if (!items.length) {
    console.log('삭제할 더미 상품이 없습니다.');
    return;
  }
  console.log(`삭제 대상 ${items.length}개 (쇼핑몰: ${cfg.mallId}${values.run ? `, 배치: ${values.run}` : ', 모든 더미 배치'})`);
  for (const p of items.slice(0, 5)) console.log(`  - ${p.product_no} ${p.custom_product_code} ${p.product_name}`);
  if (items.length > 5) console.log(`  ... 외 ${items.length - 5}개`);

  if (!values.yes) {
    const ok = await confirm('\n카페24에서 삭제하면 복구할 수 없습니다. 삭제할까요?');
    if (!ok) {
      console.log('취소했습니다.');
      return;
    }
  }
  let done = 0;
  let gone = 0;
  let failed = 0;
  for (const p of items) {
    try {
      await client.deleteProduct(p.product_no);
      done++;
      console.log(`🗑  ${p.product_no} ${p.product_name}`);
    } catch (e) {
      if (e.status === 404) {
        gone++; // 이미 지워진 상품 (주로 로그로 보완한 항목)
        continue;
      }
      failed++;
      console.log(`❌ ${p.product_no} — ${e.message}`);
      if (e.isAuthError || e.status === 401 || e.status === 403) {
        console.log('\n권한 오류로 중단합니다.');
        break;
      }
    }
  }
  console.log(`\n삭제 완료: ${done}개, 실패 ${failed}개${gone ? `, 이미 없음 ${gone}개` : ''}`);
  console.log('참고: 상품후기는 상품과 함께 지워지지 않습니다. 후기도 지우려면 `node src/cli.js clear-reviews`');
}

// ---------------------------------------------------------------- 공통 도우미

function parseNumberList(value, flag) {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((s) => s.trim());
  if (!parts.length || parts.some((s) => !/^\d+$/.test(s))) {
    throw new Error(`${flag}는 숫자 또는 쉼표로 구분한 숫자여야 합니다. 예: ${flag} 2,3`);
  }
  return parts.map(Number);
}

function parseCount(value, def, max, flag = '-n') {
  const n = Number(value ?? def);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag}는 1~${max} 사이 정수여야 합니다.`);
  return n;
}

/** 저장된 토큰에 필요한 권한이 있는지 확인한다 (권한은 login 때 정해짐). */
function requireScopes(scopes, what) {
  const t = readToken();
  const have = new Set(t?.scopes || []);
  const missing = scopes.filter((s) => !have.has(s));
  if (t?.scopes && missing.length) {
    throw new Error(
      `${what}에 필요한 권한(${missing.join(', ')})이 현재 로그인에 없습니다.\n` +
        '개발자센터 앱 권한에 추가했는지 확인하고 `node src/cli.js login`을 다시 실행하세요.',
    );
  }
}

const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

// ---------------------------------------------------------------- 메인진열

async function cmdMains() {
  const client = new Cafe24Client(getConfig());
  const mains = await client.listMains();
  const dummyNos = new Set((await findDummies(client)).map((p) => Number(p.product_no)));
  for (const m of mains) {
    const products = await client.listMainProducts(m.display_group);
    const dummy = products.filter((p) => dummyNos.has(Number(p.product_no))).length;
    console.log(`${String(m.display_group).padStart(4)}  ${m.group_name.padEnd(12)}  상품 ${products.length}개 (더미 ${dummy}개)  ${m.module_code || ''}`);
  }
}

async function cmdFillMains(values) {
  const perGroup = parseCount(values.count, 8, 200);
  const client = new Cafe24Client(getConfig());
  const mains = await client.listMains();
  const wanted = parseNumberList(values.group, '--group');
  const groups = wanted ? mains.filter((m) => wanted.includes(Number(m.display_group))) : mains;
  if (wanted) {
    const missing = wanted.filter((g) => !mains.some((m) => Number(m.display_group) === g));
    if (missing.length) throw new Error(`없는 메인분류 번호: ${missing.join(', ')} (\`mains\` 명령으로 확인하세요)`);
  }
  if (!groups.length) throw new Error('메인분류가 없습니다.');

  // 진열 중인 더미 상품만 메인에 올린다.
  const dummies = (await findDummies(client, values.run))
    .filter((p) => p.fromLog || p.display === 'T')
    .sort((a, b) => Number(b.product_no) - Number(a.product_no));
  if (!dummies.length) throw new Error('메인에 올릴 더미 상품이 없습니다. 먼저 `create`로 등록하세요.');

  for (const [gi, m] of groups.entries()) {
    const existing = new Set((await client.listMainProducts(m.display_group)).map((p) => Number(p.product_no)));
    // 메인분류마다 다른 상품이 보이도록 시작 위치를 밀어서 고른다.
    const picked = [];
    for (let k = 0; k < dummies.length && picked.length < perGroup; k++) {
      const p = dummies[(gi * perGroup + k) % dummies.length];
      const no = Number(p.product_no);
      if (!existing.has(no) && !picked.includes(no)) picked.push(no);
    }
    if (!picked.length) {
      console.log(`- ${m.group_name}(${m.display_group}): 추가할 새 더미 상품 없음`);
      continue;
    }
    if (values['dry-run']) {
      console.log(`(dry-run) ${m.group_name}(${m.display_group}) ← ${picked.length}개: ${picked.join(', ')}`);
      continue;
    }
    for (const part of chunk(picked, 20)) await client.addMainProducts(m.display_group, part);
    console.log(`✅ ${m.group_name}(${m.display_group}) ← 더미 상품 ${picked.length}개 추가`);
  }
}

async function cmdClearMains(values) {
  const client = new Cafe24Client(getConfig());
  const mains = await client.listMains();
  const wanted = parseNumberList(values.group, '--group');
  const groups = wanted ? mains.filter((m) => wanted.includes(Number(m.display_group))) : mains;
  // 이 도구가 만든 더미 상품만 뺀다 (상품 자체는 지우지 않음).
  const dummyNos = new Set((await findDummies(client)).map((p) => Number(p.product_no)));
  let removed = 0;
  for (const m of groups) {
    const targets = (await client.listMainProducts(m.display_group)).filter((p) => dummyNos.has(Number(p.product_no)));
    for (const p of targets) {
      try {
        await client.removeMainProduct(m.display_group, p.product_no);
        removed++;
      } catch (e) {
        if (e.status !== 404) console.log(`❌ ${m.group_name} ${p.product_no} — ${e.message}`);
      }
    }
    console.log(`- ${m.group_name}(${m.display_group}): 더미 상품 ${targets.length}개 뺌`);
  }
  console.log(`\n메인진열에서 뺀 더미 상품: ${removed}개 (상품 자체는 그대로 있어요)`);
}

// ---------------------------------------------------------------- 상품후기

async function resolveReviewBoard(client, boardOpt) {
  const boards = await client.listBoards();
  if (boardOpt !== undefined) {
    const no = parseCount(boardOpt, undefined, 1e9, '--board');
    const b = boards.find((x) => Number(x.board_no) === no);
    if (!b) throw new Error(`없는 게시판 번호: ${no} (\`boards\` 명령으로 확인하세요)`);
    return b;
  }
  const candidates = boards.filter((b) => /후기|review/i.test(b.board_name || ''));
  if (!candidates.length) {
    throw new Error('상품후기 게시판을 찾지 못했습니다. `boards` 명령으로 번호를 확인하고 --board <번호>를 주세요.');
  }
  return candidates[0];
}

async function cmdBoards() {
  requireScopes(['mall.read_community'], '게시판 조회');
  const client = new Cafe24Client(getConfig());
  for (const b of await client.listBoards()) {
    console.log(`${String(b.board_no).padStart(4)}  ${b.board_name}${b.use_board === 'F' ? '  (사용안함)' : ''}`);
  }
}

async function cmdReviews(values) {
  const maxPerProduct = parseCount(values.count, 3, 20);
  requireScopes(['mall.read_community', 'mall.write_community'], '상품후기 등록');
  const client = new Cafe24Client(getConfig());
  const board = await resolveReviewBoard(client, values.board);
  const products = (await findDummies(client, values.run)).sort((a, b) => Number(a.product_no) - Number(b.product_no));
  if (!products.length) throw new Error('후기를 달 더미 상품이 없습니다. 먼저 `create`로 등록하세요.');

  const requests = products.flatMap((p, i) => buildReviews(p, i, { maxPerProduct }));
  console.log(`게시판: ${board.board_name}(${board.board_no}) — 더미 상품 ${products.length}개에 후기 ${requests.length}개 (상품당 1~${maxPerProduct}개)`);

  if (values['dry-run']) {
    for (const r of requests.slice(0, 5)) console.log(JSON.stringify(r));
    console.log(`\n(dry-run) 실제로는 등록하지 않았습니다.`);
    return;
  }

  const runId = makeRunId();
  const log = { runId, board_no: board.board_no, created: [], failed: [] };
  const logFile = path.join(LOG_DIR, `reviews-${runId}.json`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (const [ci, part] of chunk(requests, 10).entries()) {
    try {
      const articles = await client.createArticles(board.board_no, part);
      for (const a of articles) log.created.push({ article_no: a.article_no, product_no: a.product_no });
      process.stdout.write(`\r  등록 중… ${Math.min((ci + 1) * 10, requests.length)}/${requests.length}`);
    } catch (e) {
      log.failed.push({ chunk: ci, error: e.message });
      console.log(`\n❌ ${ci * 10 + 1}~${ci * 10 + part.length}번째 — ${e.message}`);
      if (e.isAuthError || e.status === 401 || e.status === 403) {
        console.log('권한 오류로 중단합니다. 게시판 쓰기 권한과 로그인 상태를 확인하세요.');
        break;
      }
    }
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
  }
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
  console.log(`\n\n완료: 후기 ${log.created.length}개 등록, 실패 묶음 ${log.failed.length}개`);
  console.log('지우기: node src/cli.js clear-reviews');
}

async function cmdClearReviews(values) {
  requireScopes(['mall.read_community', 'mall.write_community'], '상품후기 삭제');
  const client = new Cafe24Client(getConfig());
  const board = await resolveReviewBoard(client, values.board);
  const found = await client.listArticles(board.board_no, { search: 'subject', keyword: DUMMY_REVIEW_PREFIX.trim() });
  // 제목 검색은 "포함" 조건이라, 제목 접두어 + 더미 작성자 두 조건을 모두 만족하는 글만 지운다.
  const targets = found.filter(isDummyReview);
  if (!targets.length) {
    console.log(`${board.board_name}(${board.board_no})에 더미 후기가 없습니다.`);
    return;
  }
  console.log(`삭제 대상: ${board.board_name}(${board.board_no})의 더미 후기 ${targets.length}개`);
  for (const a of targets.slice(0, 5)) console.log(`  - ${a.article_no} [${a.writer}] ${a.title}`);
  if (targets.length > 5) console.log(`  ... 외 ${targets.length - 5}개`);
  if (!values.yes && !(await confirm('\n삭제하면 복구할 수 없습니다. 삭제할까요?'))) {
    console.log('취소했습니다.');
    return;
  }
  let done = 0;
  let failed = 0;
  for (const a of targets) {
    try {
      await client.deleteArticle(board.board_no, a.article_no);
      done++;
    } catch (e) {
      if (e.status === 404) continue;
      failed++;
      console.log(`❌ ${a.article_no} — ${e.message}`);
      if (e.isAuthError || e.status === 401 || e.status === 403) break;
    }
  }
  console.log(`\n삭제 완료: ${done}개, 실패 ${failed}개`);
}

async function cmdCategories() {
  const cfg = getConfig();
  const client = new Cafe24Client(cfg);
  const cats = await client.listCategories();
  if (!cats.length) {
    console.log('상품분류가 없습니다.');
    return;
  }
  // 응답은 트리 순서가 아니므로 대분류 > 중분류 > ... 경로 순으로 정렬한다.
  const pathKey = (c) => [1, 2, 3, 4].map((d) => String(c.full_category_no?.[d] ?? '').padStart(8, '0')).join('/');
  cats.sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
  for (const c of cats) {
    const indent = '  '.repeat(Math.max(0, Number(c.category_depth || 1) - 1));
    console.log(`${String(c.category_no).padStart(5)}  ${indent}${c.category_name}`);
  }
}

function cmdStatus() {
  const cfg = getConfig({ requireOAuth: false });
  const t = readToken();
  if (!t) {
    console.log('로그인 정보 없음 — `node src/cli.js login`을 실행하세요.');
    return;
  }
  const accessLeft = Math.round((t.access_expires_ms - Date.now()) / 60000);
  console.log(`쇼핑몰: ${t.mall_id}${cfg.mallId && cfg.mallId !== t.mall_id ? ` (⚠️ .env는 ${cfg.mallId})` : ''}`);
  console.log(`권한: ${(t.scopes || []).join(', ')}`);
  console.log(`Access Token: ${accessLeft > 0 ? `${accessLeft}분 남음` : '만료 (다음 호출 때 자동 갱신)'}`);
  console.log(`Refresh Token 만료: ${t.refresh_token_expires_at || '알 수 없음'} (만료되면 login 다시)`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      count: { type: 'string', short: 'n' },
      category: { type: 'string', short: 'c' },
      spread: { type: 'boolean' },
      options: { type: 'boolean' },
      hidden: { type: 'boolean' },
      'no-image': { type: 'boolean' },
      prefix: { type: 'string' },
      'dry-run': { type: 'boolean' },
      run: { type: 'string' },
      group: { type: 'string' },
      board: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  // -h/--help가 어디에 있든 명령을 실행하지 않고 도움말만 보여 준다.
  if (values.help || command === '-h' || command === '--help') return console.log(HELP);

  switch (command) {
    case 'login':
      return void (await login(getConfig()));
    case 'status':
      return cmdStatus();
    case 'categories':
      return cmdCategories();
    case 'create':
      return cmdCreate(values);
    case 'list':
      return cmdList(values);
    case 'delete':
      return cmdDelete(values);
    case 'mains':
      return cmdMains();
    case 'fill-mains':
      return cmdFillMains(values);
    case 'clear-mains':
      return cmdClearMains(values);
    case 'boards':
      return cmdBoards();
    case 'reviews':
      return cmdReviews(values);
    case 'clear-reviews':
      return cmdClearReviews(values);
    case undefined:
    case 'help':
      return console.log(HELP);
    default:
      throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`\n오류: ${e.message}`);
  process.exitCode = 1;
});
