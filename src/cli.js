#!/usr/bin/env node
import './quiet.js'; // Node 18의 fetch 실험 기능 경고 숨김 (가장 먼저)
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import {
  getConfig,
  saveConfig,
  parseMallId,
  checkMallDns,
  loadEnvFile,
  readEnvFileKeys,
  DUMMY_CODE_PREFIX,
  DATA_DIR,
  DATA_DIR_SOURCE,
  ENV_FILE,
  TOKEN_FILE,
  CMD,
} from './config.js';
import { login, readToken, openBrowser } from './auth.js';
import { Cafe24Client } from './api.js';
import { makeRunId } from './dummy.js';
import { ask, askHidden, confirm } from './prompt.js';
import {
  categoryLabel,
  createContext,
  createProducts,
  executeCleanup,
  executeLegacyPurge,
  fillMains,
  findUnverifiedProducts,
  tombstoneGoneProducts,
  ownedProducts,
  planCleanup,
  planLegacyPurge,
  planProduct,
  planReviews,
  postReviews,
  resolveCategories,
  resolveReviewBoard,
  validateRunId,
  verifyProducts,
  withWriteLock,
} from './core.js';
import { getPreset, listPresets } from './presets.js';

const HELP = `카페24 테스트용 더미 데이터 도구

사용법: ${CMD} <명령> [옵션]

명령:
  ui                    브라우저 화면으로 쓰기 (연결 · 채우기 · 현황·정리)
  setup                 연결 설정 입력 (쇼핑몰 주소, Client ID/Secret, Redirect URI)
  login                 카페24 OAuth 로그인 (토큰 저장)
  status                저장된 토큰 상태 확인
  categories            상품분류(카테고리) 번호 목록 보기

  create                더미 상품 등록
  list                  이 도구가 등록한 더미 상품 목록 (+ 기록에 없는 더미 형식 상품)
  delete                이 도구가 만든 후기 → 메인진열 → 상품 순서로 정리

  mains                 메인진열(추천상품·신상품 등) 목록과 상품 수
  fill-mains            메인진열마다 더미 상품 채우기 (-n 개수, 기본 8 / --group 2,3 / --run)
  clear-mains           이 도구가 넣은 메인진열 항목만 빼기 (상품은 그대로, -y로 확인 생략)

  presets               업종 프리셋 목록 (상품명·옵션·후기 문구·이미지를 업종에 맞춤)

  boards                게시판 목록
  reviews               더미 상품에 상품후기 달기 (-n 상품당 최대 개수, 기본 3 / --board / --run / --preset)
  clear-reviews         이 도구가 단 후기만 삭제

  purge-legacy          예전 버전(소유 기록 도입 전)으로 만든 데이터를 근거와 함께 보여 주고,
                        쇼핑몰 ID를 직접 입력해 확인하면 지우기 (--dry-run)

create 옵션:
  -n, --count <수>       등록할 개수 (기본 10, 최대 500)
  -p, --preset <업종>    업종 프리셋: fashion(기본) · beauty · food · living · digital
  -c, --category <번호>  진열할 상품분류 번호. 여러 개는 쉼표로: -c 29,30,32 (번갈아 배정)
      --spread           진열 중인 맨 아래 분류 전체에 고르게 나눠 등록
      --options          업종에 맞는 옵션 추가 (패션은 색상·사이즈, 뷰티는 용량·컬러 등)
      --hidden           진열안함·판매안함으로 등록
      --no-image         이미지 업로드 생략
      --prefix <문자열>  상품명 앞에 붙일 문구 (기본 "[더미] ")
      --dry-run          등록하지 않고 보낼 내용만 출력 (조회만 함)

list / delete 옵션:
      --run <배치ID>     특정 배치만 (create 결과에 표시됨)
  -y, --yes              삭제 확인 질문 생략

안전 장치: 지우거나 빼는 작업은 이 도구가 만들었다고 소유 기록에 남긴 것만,
지우기 직전에 현재 상태가 기록과 같은지 확인한 뒤에 합니다.
자체상품코드가 "${DUMMY_CODE_PREFIX}…" 형식이어도 기록에 없으면 지우지 않습니다.
`;

// ---------------------------------------------------------------- 공통

function parseNumberList(value, flag) {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((s) => s.trim());
  if (!parts.length || parts.some((s) => !/^\d+$/.test(s))) {
    throw new Error(`${flag}는 숫자 또는 쉼표로 구분한 숫자여야 합니다. 예: ${flag} 29,30`);
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
        `개발자센터 앱 권한에 추가했는지 확인하고 \`${CMD} login\`을 다시 실행하세요.`,
    );
  }
}

const hasScopes = (scopes) => {
  const have = new Set(readToken()?.scopes || []);
  return scopes.every((s) => have.has(s));
};

function context(extra = {}) {
  const cfg = getConfig();
  return createContext(new Cafe24Client(cfg), cfg, { log: (m) => console.log(m), ...extra });
}

// ---------------------------------------------------------------- 상품

async function cmdCreate(values) {
  const preset = getPreset(values.preset); // 잘못된 업종이면 아무것도 조회·등록하기 전에 멈춘다
  const count = parseCount(values.count, 10, 500, '--count');
  if (values.spread && values.category !== undefined) throw new Error('--spread와 --category는 함께 쓸 수 없습니다.');
  const nos = parseNumberList(values.category, '--category');
  const dryRun = Boolean(values['dry-run']);
  const withImage = !values['no-image'];
  const opts = { prefix: values.prefix ?? '[더미] ', hidden: Boolean(values.hidden), withOptions: Boolean(values.options), preset };
  console.log(`업종: ${preset.label} (${preset.id})`);

  // dry-run이라도 로그인돼 있으면 분류 이름을 조회해 실제와 같은 상품명을 보여 준다.
  const cfg = dryRun ? getConfig({ requireOAuth: false }) : getConfig();
  const client = !dryRun || (cfg.apiBase && readToken()) ? new Cafe24Client(cfg) : null;
  const categories = await resolveCategories(client, { nos, spread: Boolean(values.spread) });

  if (categories.length > 1) {
    console.log(`상품분류 ${categories.length}곳에 나눠 등록합니다 (분류당 약 ${Math.ceil(count / categories.length)}개):`);
    for (const c of categories) console.log(`  ${String(c.no).padStart(5)}  ${categoryLabel(c)}`);
    console.log('');
  }

  if (dryRun) {
    const runId = makeRunId();
    for (let i = 1; i <= count; i++) console.log(JSON.stringify(planProduct(i, { runId, categories, ...opts }).request, null, 2));
    console.log(`\n(dry-run) ${count}개 — 실제로는 등록하지 않았습니다. 이미지 업로드: ${withImage ? '함' : '안 함'}`);
    return;
  }

  const ctx = createContext(client, cfg, { log: (m) => console.log(m) });
  if (!opts.hidden) console.log('⚠️  진열함·판매함 상태로 등록합니다. 운영 중인 쇼핑몰이라면 --hidden 옵션을 쓰세요.');
  const runId = makeRunId();
  console.log(`배치 ${runId}: 더미 상품 ${count}개 등록 시작 (예상 소요 약 ${Math.ceil((count * (withImage ? 2 : 1) * 0.5) / 60)}분 이상)\n`);
  const r = await createProducts(ctx, { count, categories, withImage, runId, ...opts });
  console.log(`\n완료: 성공 ${r.created.length}개, 실패 ${r.failed.length}개${r.unknown.length ? `, 결과 불명 ${r.unknown.length}개` : ''}`);
  console.log(`배치 ID: ${runId}  (이 배치만 지우기: ${CMD} delete --run ${runId})`);
  console.log(`소유 기록: ${ctx.manifest.file}`);
}

async function cmdList(values) {
  validateRunId(values.run);
  const ctx = context();
  const owned = ownedProducts(ctx, values.run);
  const v = await verifyProducts(ctx, owned);
  if (!owned.length) console.log('이 도구가 등록한 더미 상품이 없습니다.');
  for (const p of v.ok) {
    console.log(`${String(p.product_no).padStart(6)}  ${p.code.padEnd(25)}  ${p.current.display === 'T' ? '진열' : '미진열'}  ${p.current.product_name}`);
  }
  if (owned.length) console.log(`\n총 ${v.ok.length}개`);
  if (v.changed.length) console.log(`⚠️  기록과 자체상품코드가 달라진 상품 ${v.changed.length}개 (건드리지 않음): ${v.changed.map((p) => p.product_no).join(', ')}`);
  if (v.gone.length) console.log(`(이미 없는 상품 ${v.gone.length}개)`);

  const un = await findUnverifiedProducts(ctx, values.run);
  if (un.items.length) {
    console.log(`\n기록에 없는 더미 형식 상품 ${un.items.length}개 — 이 도구가 만들었다는 근거가 없어 자동으로 지우지 않습니다.`);
    console.log(`  예전 버전으로 만든 상품이라면 \`${CMD} purge-legacy --dry-run\`으로 근거를 확인할 수 있어요.`);
    for (const p of un.items.slice(0, 5)) console.log(`  - ${p.product_no} ${p.custom_product_code} ${p.product_name}`);
  }
  if (un.truncated) console.log('⚠️  상품이 많아 끝까지 조회하지 못했습니다. 위 목록이 전부가 아닐 수 있습니다.');
}

/** 정리 계획에서 자동으로 건드리지 않는 것들을 빠짐없이 알린다 (delete / clear-mains / clear-reviews 공통). */
function reportPlanNotes(ctx, plan, { withReviews = true } = {}) {
  const n = (x) => x?.length || 0;
  if (n(plan.products.changed)) console.log(`⚠️  기록과 달라진 상품 ${n(plan.products.changed)}개는 건드리지 않습니다.`);
  if (n(plan.reviews.changed)) console.log(`⚠️  기록과 달라진 후기 ${n(plan.reviews.changed)}개는 건드리지 않습니다.`);
  if (n(plan.mains.productChanged)) console.log(`⚠️  진열된 상품이 기록과 달라진 메인진열 항목 ${n(plan.mains.productChanged)}개는 건드리지 않습니다.`);
  if (n(plan.reviews.missing)) console.log(`(조회에서 안 보이는 후기 기록 ${n(plan.reviews.missing)}개는 그대로 둡니다)`);
  if (n(plan.mains.missing)) console.log(`(메인진열 목록에 안 보이는 기록 ${n(plan.mains.missing)}개는 조회 캐시일 수 있어 그대로 둡니다)`);
  if (n(plan.unknown)) console.log(`⚠️  결과 불명 요청 ${n(plan.unknown)}건은 자동으로 정리하지 않습니다 (소유 기록 파일: ${ctx.manifest.file}).`);
  if (plan.invalidLines) console.log(`⚠️  소유 기록 파일에서 읽을 수 없는 줄 ${plan.invalidLines}개가 있습니다. 그 줄과 관련된 항목은 확인할 수 없어 건드리지 않습니다 (${ctx.manifest.file}).`);
  if (plan.legacyCount) console.log(`(예전 버전에서 가져온 기록 ${plan.legacyCount}줄은 소유로 인정하지 않습니다. 예전 데이터는 \`purge-legacy\`로 정리하세요)`);
  if (!withReviews) console.log('⚠️  게시판 권한이 없어 후기는 정리하지 않습니다. 상품을 지워도 후기는 남습니다.');
}

/** 실행 직전 재확인에서 건너뛴 것들을 알린다. */
function reportDoneNotes(d) {
  if (d.reappeared) console.log(`⚠️  미리보기 때 없던 상품 ${d.reappeared}개가 다시 보여서 지우지 않았습니다. 다시 실행해서 확인하세요.`);
  if (d.skippedChanged) console.log(`⚠️  실행 직전 확인에서 기록과 달라진 ${d.skippedChanged}개는 건너뛰었습니다.`);
  if (d.missing) console.log(`(실행 직전 조회에서 안 보인 ${d.missing}개는 건너뛰고 기록을 그대로 뒀습니다)`);
}

async function cmdDelete(values) {
  validateRunId(values.run);
  const ctx = context();
  const withReviews = hasScopes(['mall.read_community', 'mall.write_community']);
  const plan = await planCleanup(ctx, { runId: values.run, reviews: withReviews });
  const total = plan.reviews.ok.length + plan.mains.ok.length + plan.products.ok.length;

  if (!total) {
    console.log('삭제할 더미 상품이 없습니다.');
    reportPlanNotes(ctx, plan, { withReviews });
    const un = await findUnverifiedProducts(ctx, values.run);
    if (un.items.length) console.log(`(기록에 없는 더미 형식 상품 ${un.items.length}개는 지우지 않습니다. \`list\`로 확인하세요)`);
    if (un.truncated) console.log('⚠️  상품이 많아 끝까지 조회하지 못했습니다.');
    // 이미 없는 상품은 다시 확인해서 기록에서만 정리한다 (삭제 요청은 보내지 않음).
    if (plan.products.gone.length) reportDoneNotes(await tombstoneGoneProducts(ctx, plan.products.gone));
    return;
  }
  console.log(`정리 대상 (쇼핑몰: ${ctx.cfg.mallId}${values.run ? `, 배치: ${values.run}` : ', 모든 배치'}):`);
  console.log(`  후기 ${plan.reviews.ok.length}개 → 메인진열 항목 ${plan.mains.ok.length}개 → 상품 ${plan.products.ok.length}개`);
  for (const p of plan.products.ok.slice(0, 5)) console.log(`  - ${p.product_no} ${p.code} ${p.current.product_name}`);
  if (plan.products.ok.length > 5) console.log(`  ... 외 ${plan.products.ok.length - 5}개`);
  console.log('  (사용자가 직접 메인에 올린 이 더미 상품의 진열도 상품과 함께 의미가 없어집니다. 남아 있으면 카페24 관리자에서 빼 주세요)');
  reportPlanNotes(ctx, plan, { withReviews });

  if (!values.yes && !(await confirm('\n카페24에서 삭제하면 복구할 수 없습니다. 삭제할까요?'))) {
    console.log('취소했습니다.');
    return;
  }
  const d = await executeCleanup(ctx, plan);
  console.log(`\n삭제 완료: 상품 ${d.products}개, 후기 ${d.reviews}개, 메인진열 항목 ${d.mains}개, 실패 ${d.failed}개${d.gone ? `, 이미 없음 ${d.gone}개` : ''}`);
  reportDoneNotes(d);
}

// ---------------------------------------------------------------- 메인진열

async function cmdMains() {
  const ctx = context();
  const owned = ctx.manifest.load().mains;
  for (const m of await ctx.client.listMains()) {
    const g = Number(m.display_group);
    const products = await ctx.client.listMainProducts(g);
    const mine = products.filter((p) => owned.has(`${g}:${Number(p.product_no)}`)).length;
    console.log(`${String(g).padStart(4)}  ${m.group_name.padEnd(12)}  상품 ${products.length}개 (이 도구가 넣은 것 ${mine}개)  ${m.module_code || ''}`);
  }
}

async function cmdFillMains(values) {
  const perGroup = parseCount(values.count, 8, 200);
  const groups = parseNumberList(values.group, '--group');
  validateRunId(values.run);
  await fillMains(context(), { perGroup, groups, runId: values.run, dryRun: Boolean(values['dry-run']) });
}

async function cmdClearMains(values) {
  const groups = parseNumberList(values.group, '--group');
  const ctx = context();
  const plan = await planCleanup(ctx, { groups, products: false, reviews: false });
  reportPlanNotes(ctx, plan);
  if (plan.mains.ok.length) {
    console.log(`뺄 대상: 이 도구가 넣은 메인진열 항목 ${plan.mains.ok.length}개`);
    for (const m of plan.mains.ok.slice(0, 5)) console.log(`  - 메인분류 ${m.display_group} / 상품 ${m.product_no}`);
    if (plan.mains.ok.length > 5) console.log(`  ... 외 ${plan.mains.ok.length - 5}개`);
    if (!values.yes && !(await confirm('\n메인진열에서 뺄까요?'))) {
      console.log('취소했습니다.');
      return;
    }
  }
  const d = await executeCleanup(ctx, plan);
  console.log(`\n메인진열에서 뺀 더미 상품: ${d.mains}개 (상품 자체는 그대로 있어요. 원래 있던 진열은 건드리지 않아요)`);
  reportDoneNotes(d);
}

// ---------------------------------------------------------------- 상품후기

async function cmdBoards() {
  requireScopes(['mall.read_community'], '게시판 조회');
  const ctx = context();
  for (const b of await ctx.client.listBoards()) {
    console.log(`${String(b.board_no).padStart(4)}  ${b.board_name}${b.use_board === 'F' ? '  (사용안함)' : ''}`);
  }
}

function cmdPresets() {
  console.log('업종 프리셋 (create --preset <업종>, reviews --preset <업종>, 화면의 "업종" 선택)\n');
  for (const p of listPresets()) console.log(`  ${p.id.padEnd(8)} ${p.label}${p.default ? ' (기본)' : ''} — ${p.description}`);
  console.log('\n상품명 재료·가격대·옵션·후기 문구·이미지 색과 글자가 업종에 맞게 바뀝니다.');
  console.log('자체상품코드(DUMMY-…)와 후기 표시는 업종과 상관없이 같아서, 정리 방법은 똑같습니다.');
}

async function cmdReviews(values) {
  const preset = getPreset(values.preset); // 생략하면 패션 문구. 배치마다 업종을 기억하지 않으므로 필요하면 직접 지정
  const maxPerProduct = parseCount(values.count, 3, 20);
  const boardNo = values.board === undefined ? undefined : parseCount(values.board, undefined, 1e9, '--board');
  validateRunId(values.run);
  requireScopes(['mall.read_community', 'mall.write_community'], '상품후기 등록');
  const ctx = context({ progress: (d, t) => process.stdout.write(`\r  등록 중… ${d}/${t}`) });
  const board = await resolveReviewBoard(ctx.client, boardNo);
  const { products, requests } = await planReviews(ctx, { maxPerProduct, runId: values.run, preset });
  console.log(`게시판: ${board.board_name}(${board.board_no}) — 더미 상품 ${products.length}개에 후기 ${requests.length}개 (상품당 1~${maxPerProduct}개, ${preset.label} 문구)`);
  if (values['dry-run']) {
    for (const r of requests.slice(0, 5)) console.log(JSON.stringify(r));
    console.log('\n(dry-run) 실제로는 등록하지 않았습니다.');
    return;
  }
  const r = await postReviews(ctx, board, requests);
  console.log(`\n\n완료: 후기 ${r.created}개 등록, 실패 ${r.failed}개${r.unknown ? `, 결과 불명 ${r.unknown}개` : ''}`);
  console.log(`지우기: ${CMD} clear-reviews`);
}

async function cmdClearReviews(values) {
  requireScopes(['mall.read_community', 'mall.write_community'], '상품후기 삭제');
  const ctx = context();
  const plan = await planCleanup(ctx, { products: false, mains: false });
  reportPlanNotes(ctx, plan);
  if (!plan.reviews.ok.length) {
    console.log('이 도구가 단 더미 후기가 없습니다.');
    return;
  }
  console.log(`삭제 대상: 이 도구가 단 더미 후기 ${plan.reviews.ok.length}개`);
  for (const a of plan.reviews.ok.slice(0, 5)) console.log(`  - ${a.article_no} [${a.current.writer}] ${a.current.title}`);
  if (plan.reviews.ok.length > 5) console.log(`  ... 외 ${plan.reviews.ok.length - 5}개`);
  if (!values.yes && !(await confirm('\n삭제하면 복구할 수 없습니다. 삭제할까요?'))) {
    console.log('취소했습니다.');
    return;
  }
  const d = await executeCleanup(ctx, plan);
  console.log(`\n삭제 완료: ${d.reviews}개, 실패 ${d.failed}개`);
  reportDoneNotes(d);
}

// ---------------------------------------------------------------- 기타

async function cmdPurgeLegacy(values) {
  const ctx = context({ progress: () => {} });
  const plan = await planLegacyPurge(ctx);
  const { products, reviews, evidence } = plan;
  console.log('예전 버전(소유 기록 도입 전)으로 만든 데이터');
  console.log(`  근거: 상품 로그 ${evidence.productLogs.length}개, 후기 로그 ${evidence.reviewLogs.length}개 (${ctx.cfg.mallId} 쇼핑몰 로그만 사용)`);
  for (const sk of evidence.skipped) console.log(`  건너뜀: ${sk}`);
  console.log(`  상품: 로그와 지금 자체상품코드가 같은 ${products.ok.length}개 (달라짐 ${products.changed.length}, 이미 없음 ${products.gone.length})`);
  console.log(`  후기: 위 상품에 달려 있고 더미 표시가 그대로인 ${reviews.ok.length}개 (달라짐 ${reviews.changed.length}, 이미 없음 ${reviews.gone.length})`);
  console.log('\n⚠️  예전 로그에는 멀티쇼핑몰 번호가 없고, 후기 로그에는 쇼핑몰 ID도 없습니다.');
  console.log('   그래서 "이 쇼핑몰에서 이 도구가 만들었다"는 증거가 완전하지 않습니다. 직접 판단해서 확인해 주세요.');
  console.log('   메인진열 항목은 예전에 기록하지 않아 대상에 없습니다. 상품을 지운 뒤 메인에 남아 있으면 카페24 관리자에서 빼 주세요.');
  if (!products.ok.length && !reviews.ok.length) {
    console.log('\n지울 예전 데이터가 없습니다.');
    return;
  }
  if (values['dry-run']) {
    console.log('\n(dry-run) 실제로는 지우지 않았습니다.');
    return;
  }
  // 쇼핑몰 ID를 직접 입력해야만 진행한다 (-y로 건너뛸 수 없음).
  const typed = values['confirm-mall'] ?? (await ask(`\n지우려면 쇼핑몰 ID(${ctx.cfg.mallId})를 그대로 입력하세요: `));
  if (String(typed).trim() !== ctx.cfg.mallId) {
    console.log('쇼핑몰 ID가 일치하지 않아 취소했습니다.');
    return;
  }
  const d = await executeLegacyPurge(ctx, plan);
  console.log(`\n삭제 완료: 후기 ${d.reviews}개, 상품 ${d.products}개, 실패 ${d.failed}개`);
  if (d.skippedChanged) console.log(`⚠️  실행 직전 확인에서 달라진 ${d.skippedChanged}개는 건너뛰었습니다.`);
}

async function cmdSetup(values) {
  // 환경변수로만 들어온 Secret과 설정 파일에 저장된 Secret을 구분한다.
  const secretInEnvBeforeFile = Boolean(process.env.CAFE24_CLIENT_SECRET);
  const fileKeys = readEnvFileKeys();
  loadEnvFile();
  const cur = {
    mall: process.env.CAFE24_MALL_ID || '',
    clientId: process.env.CAFE24_CLIENT_ID || '',
    secretInFile: fileKeys.has('CAFE24_CLIENT_SECRET'),
    secretEnvOnly: secretInEnvBeforeFile && !fileKeys.has('CAFE24_CLIENT_SECRET'),
    redirect: process.env.CAFE24_REDIRECT_URI || '',
  };
  console.log(`설정 파일: ${ENV_FILE}`);
  console.log(`(위치 기준: ${DATA_DIR_SOURCE})\n`);
  console.log('카페24 개발자센터(https://developers.cafe24.com) > 앱 > 개발 정보에서 값을 확인하세요.\n');

  const mallInput = values.mall ?? ((await ask(`쇼핑몰 주소 또는 ID${cur.mall ? ` [${cur.mall}]` : ''}: `)) || cur.mall);
  const mallId = parseMallId(mallInput);
  if (!values['no-dns-check']) {
    const d = await checkMallDns(mallId);
    if (!d.ok) {
      console.log(`⚠️  ${d.message}`);
      if (!values.force && !(await confirm('그래도 이 쇼핑몰 ID로 저장할까요?'))) {
        console.log('저장하지 않았습니다.');
        return;
      }
    }
  }
  const clientId = values['client-id'] ?? ((await ask(`Client ID${cur.clientId ? ` [${cur.clientId}]` : ''}: `)) || cur.clientId);
  const keepHint = cur.secretInFile ? ' [Enter = 저장된 값 유지]' : cur.secretEnvOnly ? ' [Enter = 환경변수 값 사용, 파일에는 저장 안 함]' : '';
  const secret = await askHidden(`Client Secret (입력해도 화면에 안 보여요)${keepHint}: `);
  if (!secret && !cur.secretInFile && !cur.secretEnvOnly) throw new Error('Client Secret이 필요합니다.');
  const defaultRedirect = cur.redirect && mallId === cur.mall ? cur.redirect : `https://${mallId}.cafe24.com`;
  const redirect = values['redirect-uri'] ?? ((await ask(`Redirect URI [${defaultRedirect}]: `)) || defaultRedirect);
  // 인증 코드는 카페24가 브라우저를 이 주소로 보내면서 전달된다 (OAuth 방식). 쇼핑몰 자신의 주소가 가장 안전하다.
  try {
    if (new URL(redirect).hostname !== `${mallId}.cafe24.com`) {
      console.log(`⚠️  로그인할 때 인증 코드가 ${new URL(redirect).hostname} 으로 전달됩니다. 직접 관리하는 주소가 아니라면 https://${mallId}.cafe24.com 을 쓰세요.`);
    }
  } catch {
    /* 형식 오류는 아래 저장 단계에서 안내 */
  }

  const { file } = saveConfig({
    CAFE24_MALL_ID: mallId,
    CAFE24_CLIENT_ID: clientId,
    CAFE24_CLIENT_SECRET: secret || undefined, // 비우면 기존 값 유지
    CAFE24_REDIRECT_URI: redirect,
  });
  console.log(`\n✅ 저장했습니다: ${file} (나만 읽을 수 있는 권한 600)`);
  if (!secret && cur.secretEnvOnly) {
    console.log('   ⚠️  Client Secret은 환경변수(CAFE24_CLIENT_SECRET)에만 있어 설정 파일에는 저장하지 않았습니다.');
    console.log('      환경변수 없이 쓰려면 setup을 다시 실행해 Secret을 입력하세요.');
  }
  console.log(`   쇼핑몰: ${mallId} / Redirect URI: ${redirect}`);
  console.log('   개발자센터 앱의 Redirect URI가 위 값과 글자 하나까지 같은지 확인하세요.');
  const token = readToken();
  if (token?.mall_id && token.mall_id !== mallId) console.log(`   쇼핑몰이 바뀌었습니다(${token.mall_id} → ${mallId}). \`login\`을 다시 하세요.`);
  else console.log(`   다음: ${CMD} login`);
}

function copyToClipboard(text) {
  const tools = { darwin: [['pbcopy', []]], win32: [['clip', []]], linux: [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]] }[process.platform] || [];
  return (async () => {
    for (const [cmd, args] of tools) {
      const ok = await new Promise((resolve) => {
        try {
          const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
          child.on('error', () => resolve(false));
          child.on('close', (code) => resolve(code === 0));
          child.stdin.end(text);
        } catch {
          resolve(false);
        }
      });
      if (ok) return true;
    }
    return false;
  })();
}

async function cmdUi(values) {
  const { startServer } = await import('./server.js');
  const port = values.port === undefined ? 0 : parseCount(values.port, undefined, 65535, '--port');
  const s = await startServer({ port });
  // 접속 주소에는 이번 실행에만 쓰는 비밀 토큰이 들어 있어 화면·로그에 출력하지 않는다.
  if (!values['no-open']) openBrowser(s.url);
  console.log(`UI 서버를 열었습니다: http://127.0.0.1:${s.port} (이 컴퓨터에서만 접속 가능)`);
  if (values['copy-url']) {
    console.log((await copyToClipboard(s.url)) ? '접속 주소를 클립보드에 복사했습니다. 브라우저 주소창에 붙여넣으세요 (다른 사람과 공유하지 마세요).' : '클립보드에 복사하지 못했습니다.');
  } else {
    console.log('브라우저가 안 열리면 --copy-url 옵션으로 다시 실행해 클립보드의 주소를 여세요.');
  }
  console.log('끝내려면 Ctrl+C');
  await new Promise((resolve) => {
    const stop = () => s.close().then(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function cmdCategories() {
  const ctx = context();
  const cats = await ctx.client.listCategories();
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
  console.log(`설정 위치: ${DATA_DIR} (${DATA_DIR_SOURCE})`);
  console.log(`설정 파일: ${ENV_FILE}${process.env.CAFE24_CLIENT_SECRET ? ' (Client Secret 설정됨)' : ''}`);
  console.log(`토큰 파일: ${TOKEN_FILE}`);
  console.log(`설정된 쇼핑몰: ${cfg.mallId || '(없음)'}\n`);
  const t = readToken();
  if (!t) {
    console.log(`로그인 정보 없음 — \`${CMD} login\`을 실행하세요.`);
    return;
  }
  const accessLeft = Math.round((t.access_expires_ms - Date.now()) / 60000);
  console.log(`쇼핑몰: ${t.mall_id}${cfg.mallId && cfg.mallId !== t.mall_id ? ` (⚠️ 설정은 ${cfg.mallId})` : ''}`);
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
      preset: { type: 'string', short: 'p' },
      'dry-run': { type: 'boolean' },
      run: { type: 'string' },
      group: { type: 'string' },
      board: { type: 'string' },
      'confirm-mall': { type: 'string' },
      mall: { type: 'string' },
      'client-id': { type: 'string' },
      'redirect-uri': { type: 'string' },
      'no-dns-check': { type: 'boolean' },
      force: { type: 'boolean' },
      port: { type: 'string' },
      'copy-url': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  // -h/--help가 어디에 있든 명령을 실행하지 않고 도움말만 보여 준다.
  if (values.help || command === '-h' || command === '--help') return console.log(HELP);

  const commands = {
    setup: cmdSetup,
    ui: cmdUi,
    login: async () => void (await login(getConfig())),
    status: cmdStatus,
    categories: cmdCategories,
    create: cmdCreate,
    list: cmdList,
    delete: cmdDelete,
    mains: cmdMains,
    'fill-mains': cmdFillMains,
    'clear-mains': cmdClearMains,
    boards: cmdBoards,
    reviews: cmdReviews,
    presets: cmdPresets,
    'clear-reviews': cmdClearReviews,
    'purge-legacy': cmdPurgeLegacy,
    help: () => console.log(HELP),
  };
  if (command === undefined) return console.log(HELP);
  const fn = commands[command];
  if (!fn) throw new Error(`알 수 없는 명령: ${command}\n\n${HELP}`);
  // 카페24 데이터나 소유 기록을 바꾸는 명령은 쓰기 잠금을 잡고 실행한다 (UI 작업·다른 터미널과 동시에 못 돌게)
  const WRITE_COMMANDS = new Set(['create', 'delete', 'fill-mains', 'clear-mains', 'reviews', 'clear-reviews', 'purge-legacy']);
  // 실제로 아무것도 바꾸지 않는 미리보기를 지원하는 명령만 --dry-run을 받는다 (그때만 잠금 없이 실행)
  const DRY_RUN_COMMANDS = new Set(['create', 'fill-mains', 'reviews', 'purge-legacy']);
  if (values['dry-run'] && !DRY_RUN_COMMANDS.has(command)) {
    throw new Error(`${command} 명령은 --dry-run을 지원하지 않습니다. (지우기 전에 대상을 보여 주고 확인을 받으니, --yes 없이 실행해 확인하세요)`);
  }
  if (values.preset !== undefined && !['create', 'reviews'].includes(command)) {
    throw new Error(`${command} 명령은 --preset을 받지 않습니다. (create, reviews에서 씁니다)`);
  }
  if (WRITE_COMMANDS.has(command) && !values['dry-run']) return withWriteLock(command, () => fn(values));
  return fn(values);
}

main().catch((e) => {
  console.error(`\n오류: ${e.message}`);
  process.exitCode = 1;
});
