import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { LOG_DIR, DUMMY_CODE_PREFIX, TOKEN_FILE } from './config.js';
import { withLock, acquireNow } from './lock.js';
import { Manifest } from './manifest.js';
import { buildDummyProduct, makeRunId, isDummyCode, RUN_ID_PATTERN } from './dummy.js';
import { buildReviews, isDummyReview } from './review.js';
import { makeDummyImage, toDataUri } from './image.js';
import { getPreset } from './presets.js';

/**
 * CLI와 UI가 함께 쓰는 실제 작업들.
 *
 * 안전 원칙
 * 1. 이 도구가 만든 것은 성공 응답을 받은 즉시 소유 기록(manifest)에 남긴다.
 * 2. 지우거나 빼는 작업은 소유 기록에 있는 것만, 그리고 바로 직전에 현재 상태를 다시 조회해
 *    기록과 일치하는 것만 한다. (기록과 다르면 건너뛰고 알린다)
 * 3. 응답을 못 받아 결과를 알 수 없는 요청은 'unknown'으로 기록하고 자동 삭제하지 않는다.
 * 4. 자체상품코드·제목 같은 표시만 맞는 데이터(기록 없음)는 "확인 안 됨"으로 보여 주기만 한다.
 *
 * 남는 한계: 확인과 삭제 사이에 다른 사람이 같은 데이터를 바꾸는 경우는 카페24에 조건부 삭제가 없어 막을 수 없다.
 */

const noop = () => {};
const isPosInt = (v) => Number.isInteger(v) && v > 0;
export const contentDigest = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/**
 * 쓰기 작업 잠금: 같은 설정 폴더를 쓰는 다른 프로세스(UI와 터미널 명령 등)가 동시에
 * 카페24 데이터를 바꾸거나 소유 기록을 쓰지 못하게 한다.
 */
export const writeLockFile = () => path.join(path.dirname(TOKEN_FILE), 'cafe24-dummy.write.lock');
const busyMessage = (h) =>
  `다른 쓰기 작업이 실행 중입니다${h ? ` (${h.label || '작업'}, pid ${h.pid}, ${h.at} 시작)` : ''}. 끝난 뒤에 다시 시도하세요.`;
export const withWriteLock = (label, fn) => withLock(writeLockFile(), label, fn, { waitMs: 0, busyMessage });
/** 잠금을 바로 잡아 해제 함수를 돌려준다. 못 잡으면 오류. (UI 작업처럼 요청이 끝난 뒤에도 이어지는 작업용) */
export function acquireWriteLock(label) {
  const r = acquireNow(writeLockFile(), label);
  if (!r.release) throw Object.assign(new Error(busyMessage(r.holder)), { lockBusy: true });
  return r.release;
}

/**
 * fn이 도중에 예외를 던지면, 그때까지 쌓인 결과(result)를 오류의 partial로 붙여 다시 던진다.
 * (예: 세 번째 상품의 소유 기록 쓰기가 실패해도 앞의 두 개가 등록됐다는 숫자가 사라지지 않도록)
 */
export async function keepPartial(result, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && typeof e === 'object' && e.partial === undefined) e.partial = result;
    throw e;
  }
}

export const isAuthFailure = (e) => Boolean(e?.isAuthError || e?.status === 401 || e?.status === 403);
/** 응답을 못 받았거나 서버 오류라 실제로 처리됐는지 알 수 없는 경우 */
export const isAmbiguous = (e) => !isAuthFailure(e) && (e?.status === 0 || e?.status >= 500);

/**
 * 한 번의 카페24 응답으로 생긴 기록 여러 개를 차례로 쓴다.
 * 중간에 쓰기가 실패하면, 아직 못 쓴 기록 전부를(ID 포함) 오류에 담아 바로 멈춘다.
 * @param {Array<[string, string, object]>} records [kind, event, fields]
 */
export function appendAll(manifest, records) {
  for (let i = 0; i < records.length; i++) {
    try {
      manifest.append(...records[i]);
    } catch (e) {
      const rest = records.slice(i).map(([k, ev, f]) => `${k}/${ev} ${JSON.stringify(f)}`);
      const err = new Error(
        `🚨 카페24 작업은 끝났지만 소유 기록을 쓰지 못해 작업을 멈춥니다.\n` +
          `   기록하지 못한 항목 ${rest.length}개:\n   - ${rest.join('\n   - ')}\n` +
          `   이 항목들은 자동 정리 대상이 아니니 카페24 관리자에서 직접 확인해 주세요. 기록 파일: ${manifest.file}\n` +
          `   (원인: ${String(e.message).split('\n')[0]})`,
      );
      err.manifestWrite = true;
      throw err;
    }
  }
}

export function createContext(client, cfg, { log = noop, progress = noop, manifest } = {}) {
  return { client, cfg, manifest: manifest ?? new Manifest(cfg.mallId, cfg.shopNo), log, progress };
}

export function validateRunId(runId) {
  // --run= 처럼 빈 값이 들어와도 "전체"가 되지 않도록 undefined가 아닌 모든 값을 검사한다.
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`배치 ID가 올바르지 않습니다: "${runId}" (등록 결과에 나온 15자리 숫자)`);
  }
}

// ---------------------------------------------------------------- 상품분류

/** API 분류 객체 → { no, names, path } (상위 → 하위 순) */
export function toCategory(c) {
  const levels = [1, 2, 3, 4];
  const p = levels.map((d) => c.full_category_no?.[d]).filter((v) => v !== null && v !== undefined && v !== '').map(Number);
  const names = levels.map((d) => c.full_category_name?.[d]).filter(Boolean);
  return { no: Number(c.category_no), names: names.length ? names : [c.category_name], path: p.length ? p : [Number(c.category_no)] };
}

export const categoryLabel = (cat) => (cat.names.length ? cat.names.join(' > ') : `분류 ${cat.no}`);

/** 등록할 분류 목록. spread: 진열 중인 맨 아래 분류 전체 / nos: 지정한 번호들. client가 없으면 번호만 쓴다. */
export async function resolveCategories(client, { nos, spread }) {
  if (!spread && !nos?.length) return [];
  if (!client) {
    if (spread) throw new Error('분류 전체에 나눠 넣으려면 분류 목록을 조회해야 해서 로그인이 필요합니다.');
    return nos.map((no) => ({ no, names: [], path: [no] }));
  }
  const all = await client.listCategories();
  if (spread) {
    const parents = new Set(all.map((c) => Number(c.parent_category_no)));
    const leaves = all.filter((c) => !parents.has(Number(c.category_no)) && (c.use_display ?? 'T') === 'T');
    if (!leaves.length) throw new Error('진열 중인 상품분류가 없습니다.');
    return leaves.map(toCategory).sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
  }
  const byNo = new Map(all.map((c) => [Number(c.category_no), c]));
  const missing = nos.filter((no) => !byNo.has(no));
  if (missing.length) throw new Error(`없는 상품분류 번호: ${missing.join(', ')} (\`categories\` 명령으로 확인하세요)`);
  return nos.map((no) => toCategory(byNo.get(no)));
}

/** i번째(1부터) 상품의 요청 본문. dry-run과 실제 등록이 같은 결과를 내도록 한 곳에서 만든다. */
export function planProduct(i, { runId, categories, prefix, hidden, withOptions, preset = getPreset() }) {
  const category = categories.length ? categories[(i - 1) % categories.length] : undefined;
  return {
    category,
    request: buildDummyProduct(i, {
      runId,
      namePrefix: prefix,
      display: hidden ? 'F' : 'T',
      selling: hidden ? 'F' : 'T',
      withOptions,
      preset,
      category,
      round: categories.length ? Math.floor((i - 1) / categories.length) : undefined,
    }),
  };
}

// ---------------------------------------------------------------- 상품 등록

export async function createProducts(ctx, { count, categories = [], prefix = '[더미] ', hidden = false, withOptions = false, withImage = true, runId = makeRunId(), preset = getPreset() }) {
  const { client, manifest, log, progress } = ctx;
  manifest.ensureWritable();
  const result = { runId, created: [], failed: [], unknown: [], stoppedByAuth: false };
  await keepPartial(result, () => createProductsLoop(ctx, result, { count, categories, prefix, hidden, withOptions, withImage, runId, preset }));
  progress(result.created.length + result.failed.length + result.unknown.length, count);
  return result;
}

async function createProductsLoop(ctx, result, { count, categories, prefix, hidden, withOptions, withImage, runId, preset }) {
  const { client, manifest, log, progress } = ctx;
  for (let i = 1; i <= count; i++) {
    const { category, request } = planProduct(i, { runId, categories, prefix, hidden, withOptions, preset });
    const code = request.custom_product_code;
    const label = `[${i}/${count}] ${request.product_name}${category && categories.length > 1 ? `  (${category.names.at(-1) ?? category.no})` : ''}`;
    progress(i - 1, count, request.product_name);

    let productNo;
    try {
      const res = await client.createProduct(request);
      productNo = Number(res?.product?.product_no);
      if (!isPosInt(productNo)) throw Object.assign(new Error('응답에 상품번호가 없습니다'), { status: 0 });
    } catch (e) {
      if (isAmbiguous(e)) {
        // 기록 쓰기가 실패해도 "결과 불명" 숫자는 남도록 먼저 센다
        result.unknown.push({ index: i, code, product_name: request.product_name, error: e.message });
        manifest.append('product', 'unknown', { code, runId, reason: String(e.message).slice(0, 200) });
        log(`⚠️ ${label} — 결과를 알 수 없습니다 (${e.message}). 실제로 등록됐을 수 있어 "결과 불명"으로 기록했고, 자동 삭제하지 않습니다.`);
      } else {
        result.failed.push({ index: i, product_name: request.product_name, error: e.message });
        log(`❌ ${label} — ${e.message}`);
      }
      if (isAuthFailure(e)) {
        result.stoppedByAuth = true;
        log('\n권한 오류로 중단합니다. 앱 권한(mall.write_product)과 로그인 상태를 확인하세요.');
        break;
      }
      continue;
    }

    // 카페24에는 이미 등록됐으므로 먼저 센다 (기록 쓰기가 실패해도 숫자는 실제 상태를 따름).
    const entry = { index: i, product_no: productNo, code, product_name: request.product_name, category_no: category?.no };
    result.created.push(entry);
    // 성공 응답을 받은 즉시 기록한다 (이미지 업로드 중에 멈춰도 소유 기록은 남도록).
    manifest.append('product', 'created', { product_no: productNo, code, runId });

    if (withImage) {
      try {
        await client.uploadProductImage(productNo, toDataUri(makeDummyImage(i, 600, preset.image)));
        entry.image = true;
      } catch (e) {
        entry.image = false;
        entry.image_error = e.message;
        if (isAuthFailure(e)) {
          log(`✅ ${label} → 상품번호 ${productNo} (이미지 실패: ${e.message})`);
          result.stoppedByAuth = true;
          log('\n권한 오류로 중단합니다. 앱 권한과 로그인 상태를 확인하세요.');
          break;
        }
      }
    }
    log(`✅ ${label} → 상품번호 ${productNo}${entry.image === false ? ` (이미지 실패: ${entry.image_error})` : ''}`);
  }
}

/** 등록은 됐지만 대표 이미지 업로드가 실패한 상품 수 */
export const imageFailedCount = (r) => r.created.filter((e) => e.image === false).length;

// ---------------------------------------------------------------- 소유 확인

/** 소유 기록의 상품들 (runId로 거르기). 예전 로그에서 가져온 기록은 포함하지 않는다. */
export function ownedProducts(ctx, runId) {
  validateRunId(runId);
  const { products } = ctx.manifest.load();
  return [...products.values()].filter((p) => runId === undefined || p.runId === runId);
}

/**
 * 기록된 상품을 지금 상태와 비교한다.
 * ok: 코드가 기록과 같음 / gone: 단건 조회까지 해도 없음 / changed: 코드가 바뀜(건드리지 않음)
 */
export async function verifyProducts(ctx, entries) {
  const out = { ok: [], gone: [], changed: [] };
  if (!entries.length) return out;
  const current = await ctx.client.getProductsByNos(entries.map((e) => e.product_no));
  for (const e of entries) {
    const { current: _old, ...rec } = e;
    const cur = current.get(e.product_no);
    if (!cur) out.gone.push(rec);
    else if (cur.custom_product_code === e.code && isDummyCode(cur.custom_product_code)) out.ok.push({ ...rec, current: cur });
    else out.changed.push({ ...rec, current: cur });
  }
  return out;
}

/**
 * 기록된 후기를 지금 상태와 비교한다. 상품번호·제목·작성자·본문(해시)이 기록과 정확히 같아야 ok.
 * 조회에서 안 보이는 글(missing)은 "없음"의 확실한 증거가 아니므로 기록을 지우지 않는다.
 */
export async function verifyReviews(ctx, entries) {
  const out = { ok: [], missing: [], changed: [] };
  const byBoard = new Map();
  for (const e of entries) byBoard.set(e.board_no, [...(byBoard.get(e.board_no) || []), e]);
  for (const [boardNo, list] of byBoard) {
    const current = await ctx.client.getArticlesByNos(boardNo, list.map((e) => e.article_no));
    for (const e of list) {
      const { current: _old, ...rec } = e;
      const cur = current.get(e.article_no);
      if (!cur) out.missing.push(rec);
      else if (
        Number(cur.product_no) === e.product_no &&
        cur.title === e.title &&
        cur.writer === e.writer &&
        contentDigest(cur.content) === e.content_sha256
      ) out.ok.push({ ...rec, current: cur });
      else out.changed.push({ ...rec, current: cur });
    }
  }
  return out;
}

/**
 * 기록된 메인진열 항목을 확인한다. 진열된 상품이 지금도 이 도구의 더미 상품(기록된 코드 그대로)일 때만 ok.
 * - productChanged: 상품이 기록과 달라졌거나 소유 기록에 없음 → 건드리지 않음
 * - productGone: 상품이 확실히 없음 → 진열도 의미가 없으므로 기록만 정리
 * - missing: 메인진열 목록에 안 보임 → 목록 캐시일 수 있어 기록 유지
 */
export async function verifyMains(ctx, entries) {
  const out = { ok: [], missing: [], productChanged: [], productGone: [] };
  if (!entries.length) return out;
  const state = ctx.manifest.load();
  const owned = state.products;
  const productNos = [...new Set(entries.map((e) => e.product_no))];
  const pv = await verifyProducts(ctx, productNos.filter((no) => owned.has(no)).map((no) => owned.get(no)));
  const okProducts = new Set(pv.ok.map((p) => p.product_no));
  const goneProducts = new Set(pv.gone.map((p) => p.product_no));
  // 예전에 삭제 기록을 남긴 상품도 "지금" 없는지 다시 조회한다 (그사이 다시 생겼을 수 있음). 이상한 응답이면 오류로 멈춘다.
  const tombstoned = productNos.filter((no) => !owned.has(no) && state.deletedProducts.has(no));
  const presentAgain = tombstoned.length ? await ctx.client.getProductsByNos(tombstoned) : new Map();
  const candidates = [];
  for (const e of entries) {
    // "상품이 없다"는 판단은 방금 단건 조회로 없음을 확인했거나, 기록에 명시적인 삭제 기록이 있을 때만 한다.
    // 소유 기록에서 그냥 안 보이는 경우(기록 파일 일부가 깨진 경우 등)는 확인 불가로 보고 건드리지 않는다.
    if (okProducts.has(e.product_no)) candidates.push(e);
    else if (goneProducts.has(e.product_no) || (tombstoned.includes(e.product_no) && !presentAgain.has(e.product_no))) out.productGone.push(e);
    else out.productChanged.push(e);
  }
  for (const g of [...new Set(candidates.map((e) => e.display_group))]) {
    const present = new Set((await ctx.client.listMainProducts(g)).map((p) => Number(p.product_no)));
    for (const e of candidates.filter((x) => x.display_group === g)) (present.has(e.product_no) ? out.ok : out.missing).push(e);
  }
  return out;
}

/** 표시(자체상품코드 형식)는 더미인데 소유 기록에 없는 상품 — 자동 삭제하지 않고 보여 주기만 한다. */
export async function findUnverifiedProducts(ctx, runId) {
  validateRunId(runId);
  const owned = new Set([...ctx.manifest.load().products.keys()]);
  const code = runId !== undefined ? `${DUMMY_CODE_PREFIX}${runId}-` : DUMMY_CODE_PREFIX;
  const { items, truncated } = await ctx.client.findProductsByCustomCode(code);
  return {
    items: items.filter((p) => isDummyCode(p.custom_product_code, runId) && !owned.has(Number(p.product_no))),
    truncated,
  };
}

// ---------------------------------------------------------------- 정리 (후기 → 메인진열 → 상품)

/**
 * 정리 계획(미리보기). runId가 있으면 그 배치 상품과, 그 상품에 달린 소유 후기·메인진열만.
 * groups가 있으면 그 메인분류의 항목만. 여기서 한 확인은 미리보기용이고,
 * executeCleanup이 단계마다 지우기 직전에 다시 확인한다.
 */
export async function planCleanup(ctx, { runId, groups, products = true, reviews = true, mains = true } = {}) {
  validateRunId(runId);
  const state = ctx.manifest.load();
  const targetProducts = [...state.products.values()].filter((p) => runId === undefined || p.runId === runId);
  const productSet = new Set(targetProducts.map((p) => p.product_no));
  // 상품 기록이 이미 정리된 뒤에도 같은 배치의 후기·진열 기록을 찾을 수 있도록, 각 기록의 배치 ID로도 고른다.
  const inScope = (rec) => runId === undefined || productSet.has(rec.product_no) || rec.runId === runId;
  const inGroups = (g) => !groups || groups.includes(g);

  const unknown = state.unknown.filter((u) => {
    if (runId === undefined) return true;
    if (u.runId === runId || (u.runIds || []).includes(runId)) return true;
    return (u.product_nos || []).some((no) => productSet.has(no));
  });

  return {
    runId,
    reviews: reviews ? await verifyReviews(ctx, [...state.reviews.values()].filter((r) => inScope(r))) : { ok: [], missing: [], changed: [] },
    mains: mains
      ? await verifyMains(ctx, [...state.mains.values()].filter((m) => inScope(m) && inGroups(m.display_group)))
      : { ok: [], missing: [], productChanged: [], productGone: [] },
    products: products ? await verifyProducts(ctx, targetProducts) : { ok: [], gone: [], changed: [] },
    unknown,
    legacyCount: state.legacy.length,
    invalidLines: state.invalidLines,
  };
}

/**
 * 정리 실행. 단계(후기 → 메인진열 → 상품)마다 지우기 직전에 현재 상태를 다시 조회해서
 * 그때도 기록과 같은 것만 지운다. 권한 오류가 나면 즉시 멈추고, 진행된 만큼은 기록에 남는다.
 */
export async function executeCleanup(ctx, plan) {
  const { client, manifest, log, progress } = ctx;
  manifest.ensureWritable();
  const done = {
    reviews: 0,
    mains: 0,
    products: 0,
    reappeared: 0, // 미리보기 때 없던 상품이 다시 보임 → 확인받지 않았으므로 지우지 않음
    failed: 0,
    skippedChanged: 0, // 실행 직전 확인에서 기록과 달라져 건너뜀
    missing: 0, // 실행 직전 조회에서 안 보여 건너뜀 (기록 유지)
    gone: 0, // 확실히 없어서 기록만 정리
    stoppedByAuth: false,
  };
  const total = plan.reviews.ok.length + plan.mains.ok.length + plan.products.ok.length;
  let step = 0;

  const attempt = async (fn, onOk, label) => {
    try {
      await fn();
      onOk();
      return true;
    } catch (e) {
      if (e.manifestWrite) throw e; // 기록을 못 쓰면 다음 삭제로 넘어가지 않고 즉시 멈춘다
      if (e.status === 404) {
        onOk();
        return true;
      }
      done.failed++;
      log(`❌ ${label} — ${e.message}`);
      if (isAuthFailure(e)) {
        done.stoppedByAuth = true;
        log('\n권한 오류로 중단합니다.');
      }
      return false;
    } finally {
      progress(++step, total);
    }
  };

  // 1) 후기 — 지우기 직전에 다시 확인 (본문 해시까지)
  const rv = await verifyReviews(ctx, plan.reviews.ok);
  done.skippedChanged += rv.changed.length;
  done.missing += rv.missing.length;
  for (const r of rv.ok) {
    await attempt(
      () => client.deleteArticle(r.board_no, r.article_no),
      () => {
        manifest.append('review', 'deleted', { board_no: r.board_no, article_no: r.article_no });
        done.reviews++;
      },
      `후기 ${r.article_no}`,
    );
    if (done.stoppedByAuth) return done;
  }

  // 2) 메인진열 — 빼는 건 미리보기에서 확인받은 항목(ok)만. 진열된 상품이 지금도 이 도구의 더미 상품인지 다시 확인한다.
  const mv = await verifyMains(ctx, plan.mains.ok);
  done.skippedChanged += mv.productChanged.length;
  done.missing += mv.missing.length;
  const tombstoneMain = (m) => {
    manifest.append('main', 'removed', { display_group: m.display_group, product_no: m.product_no, note: 'product-gone' });
    done.gone++;
  };
  mv.productGone.forEach(tombstoneMain); // 방금 조회로 상품이 없음을 확인함
  // 미리보기 때 "상품 없음"이던 진열은 다시 확인해서 여전히 없을 때 기록만 정리. 상품이 다시 보이면 건드리지 않는다.
  const mg = await verifyMains(ctx, plan.mains.productGone);
  mg.productGone.forEach(tombstoneMain);
  done.reappeared += mg.ok.length + mg.missing.length + mg.productChanged.length;
  for (const m of mv.ok) {
    await attempt(
      () => client.removeMainProduct(m.display_group, m.product_no),
      () => {
        manifest.append('main', 'removed', { display_group: m.display_group, product_no: m.product_no });
        done.mains++;
      },
      `메인진열 ${m.display_group}의 상품 ${m.product_no}`,
    );
    if (done.stoppedByAuth) return done;
  }

  // 3) 상품 — 미리보기 때 "없음"이던 것은 다시 확인해서 여전히 없을 때만 기록에서 정리한다.
  //    그사이 다시 보이게 됐다면 사용자가 확인한 목록에 없던 것이므로 지우지 않고 알린다.
  await tombstoneGoneProducts(ctx, plan.products.gone, done);
  const pv = await verifyProducts(ctx, plan.products.ok);
  done.skippedChanged += pv.changed.length;
  for (const p of pv.gone) {
    manifest.append('product', 'deleted', { product_no: p.product_no, note: 'gone' });
    done.gone++;
  }
  for (const p of pv.ok) {
    const ok = await attempt(
      () => client.deleteProduct(p.product_no),
      () => {
        manifest.append('product', 'deleted', { product_no: p.product_no });
        done.products++;
      },
      `상품 ${p.product_no}`,
    );
    if (ok) log(`🗑  ${p.product_no} ${p.current?.product_name ?? p.code}`);
    if (done.stoppedByAuth) return done;
  }
  return done;
}

/**
 * 미리보기에서 "없음"이던 상품을 다시 확인해서, 여전히 없을 때만 기록에서 정리한다 (삭제 요청은 보내지 않음).
 * 확인 질문 없이 불러도 안전하다.
 */
export async function tombstoneGoneProducts(ctx, entries, done = { gone: 0, reappeared: 0 }) {
  if (!entries.length) return done;
  ctx.manifest.ensureWritable();
  const v = await verifyProducts(ctx, entries);
  for (const p of v.gone) {
    ctx.manifest.append('product', 'deleted', { product_no: p.product_no, note: 'gone' });
    done.gone++;
  }
  done.reappeared += v.ok.length + v.changed.length;
  return done;
}

// ---------------------------------------------------------------- 메인진열

export async function fillMains(ctx, { perGroup = 8, groups: wanted, runId, dryRun = false } = {}) {
  const { client, manifest, log } = ctx;
  if (!dryRun) manifest.ensureWritable();
  const mains = await client.listMains();
  if (wanted) {
    const missing = wanted.filter((g) => !mains.some((m) => Number(m.display_group) === g));
    if (missing.length) throw new Error(`없는 메인분류 번호: ${missing.join(', ')} (\`mains\` 명령으로 확인하세요)`);
  }
  const groups = wanted ? mains.filter((m) => wanted.includes(Number(m.display_group))) : mains;
  if (!groups.length) throw new Error('메인분류가 없습니다.');

  // 소유 기록에 있고 지금도 그대로인, 진열 중인 더미 상품만 메인에 올린다.
  const { ok } = await verifyProducts(ctx, ownedProducts(ctx, runId));
  const candidates = ok.filter((p) => p.current.display === 'T').sort((a, b) => b.product_no - a.product_no);
  if (!candidates.length) throw new Error('메인에 올릴 더미 상품이 없습니다. 먼저 상품을 등록하세요.');
  const runOf = new Map(candidates.map((p) => [p.product_no, p.runId]));

  const summary = [];
  await keepPartial(summary, () => fillMainsLoop(ctx, { groups, candidates, runOf, perGroup, dryRun, summary }));
  return summary;
}

async function fillMainsLoop(ctx, { groups, candidates, runOf, perGroup, dryRun, summary }) {
  const { client, manifest, log } = ctx;
  for (const [gi, m] of groups.entries()) {
    const g = Number(m.display_group);
    const existing = new Set((await client.listMainProducts(g)).map((p) => Number(p.product_no)));
    const picked = [];
    for (let k = 0; k < candidates.length && picked.length < perGroup; k++) {
      const no = candidates[(gi * perGroup + k) % candidates.length].product_no;
      if (!existing.has(no) && !picked.includes(no)) picked.push(no);
    }
    if (!picked.length) {
      log(`- ${m.group_name}(${g}): 추가할 새 더미 상품 없음`);
      summary.push({ display_group: g, added: 0, unknown: 0 });
      continue;
    }
    if (dryRun) {
      log(`(dry-run) ${m.group_name}(${g}) ← ${picked.length}개: ${picked.join(', ')}`);
      continue;
    }
    // 그룹 결과를 먼저 summary에 넣고 채워 간다 (도중에 예외가 나도 그때까지의 숫자가 남도록)
    const entry = { display_group: g, added: 0, unknown: 0, failed: 0 };
    summary.push(entry);
    for (const part of chunk(picked, 20)) {
      let confirmed = [];
      let unresolved = part;
      try {
        const res = await client.addMainProducts(g, part);
        // 응답에 실린 상품번호만 "추가됨"으로 인정한다. 응답이 비었거나 일부만 오면 나머지는 결과 불명.
        const listed = res?.product?.product_no;
        if (Array.isArray(listed)) {
          const set = new Set(listed.map(Number));
          confirmed = part.filter((no) => set.has(no));
          unresolved = part.filter((no) => !set.has(no));
        }
      } catch (e) {
        if (!isAmbiguous(e)) {
          log(`❌ ${m.group_name}(${g}) — ${e.message}`);
          if (isAuthFailure(e)) throw e;
          entry.failed += part.length;
          continue;
        }
        log(`⚠️ ${m.group_name}(${g}) — 결과를 알 수 없습니다 (${e.message})`);
      }
      const records = confirmed.map((no) => ['main', 'added', { display_group: g, product_no: no, runId: runOf.get(no) }]);
      if (unresolved.length) {
        const runIds = [...new Set(unresolved.map((no) => runOf.get(no)).filter(Boolean))];
        records.push(['main', 'unknown', { display_group: g, product_nos: unresolved, runIds }]);
      }
      // 카페24에는 이미 반영됐으므로 기록 쓰기 전에 센다 (기록 쓰기가 실패해도 숫자는 실제 상태를 따름)
      entry.added += confirmed.length;
      entry.unknown += unresolved.length;
      appendAll(manifest, records);
    }
    log(`✅ ${m.group_name}(${g}) ← 더미 상품 ${entry.added}개 추가${entry.unknown ? ` (결과 불명 ${entry.unknown}개)` : ''}${entry.failed ? ` (실패 ${entry.failed}개)` : ''}`);
  }
}

// ---------------------------------------------------------------- 한 번에 채우기 (상품 → 메인진열 → 후기)

/**
 * 한 배치를 상품 → 메인진열 → 후기 순서로 채운다.
 * - 메인진열·후기는 이번 배치(runId)의 상품에만 붙는다.
 * - 뒤 단계가 실패해도 앞 단계 결과(소유 기록 포함)는 그대로 두고, 단계별 상태를 그대로 돌려준다.
 * - 오류 메시지는 자르지 않는다 (기록하지 못한 항목의 ID 등 복구 정보가 들어 있을 수 있음).
 * - 권한 오류나 소유 기록 쓰기 실패가 나면 다음 단계로 넘어가지 않는다.
 */
export async function seedWorkflow(ctx, { count, categories = [], runId = makeRunId(), hidden = false, withOptions = false, withImage = true, mainsPerGroup = 0, reviewsMax = 0, preset = getPreset() }) {
  // 프리셋은 작업을 시작할 때 한 번 정하고, 상품과 후기에 같은 것을 쓴다
  const { log } = ctx;
  const requested = [['products', '상품 등록'], ...(mainsPerGroup ? [['mains', '메인진열 채우기']] : []), ...(reviewsMax ? [['reviews', '상품후기 달기']] : [])];
  const total = requested.length;
  const out = { runId, stages: [] };
  let n = 0;
  const stage = async (key, name, fn, judge) => {
    log(`── ${++n}/${total} ${name}`);
    const st = { key, name, status: 'done' };
    out.stages.push(st);
    try {
      const r = await fn();
      Object.assign(st, judge(r));
      return r;
    } catch (e) {
      // 도중에 멈춰도 그때까지 한 일의 숫자는 남긴다 (keepPartial이 붙인 e.partial)
      if (e?.partial !== undefined) st.counts = judge(e.partial).counts;
      st.status = 'stopped';
      st.error = String(e.message); // 전체 메시지 (복구 정보 포함)
      st.stopsWorkflow = Boolean(isAuthFailure(e) || e.manifestWrite); // 권한 오류·소유 기록 쓰기 실패면 다음 단계로 가지 않는다
      log(`❌ ${name} 단계가 멈췄습니다:\n${e.message}`);
      return undefined;
    }
  };
  // 요청했지만 실행하지 않은 단계도 결과에 "건너뜀"과 이유로 남긴다
  const finish = (reason) => {
    for (const [key, name] of requested) if (!out.stages.some((s) => s.key === key)) out.stages.push({ key, name, status: 'skipped', note: reason });
    return out;
  };
  const stopped = () => out.stages.some((s) => s.stopsWorkflow);
  const STOP_NOTE = '앞 단계가 멈춰서 실행하지 않았어요';

  out.products = await stage(
    'products',
    '상품 등록',
    () => createProducts(ctx, { count, categories, runId, hidden, withOptions, withImage, preset }),
    (r) => {
      const imageFailed = imageFailedCount(r);
      return {
        status: r.stoppedByAuth ? 'stopped' : r.failed.length || r.unknown.length || imageFailed ? 'partial' : 'done',
        stopsWorkflow: r.stoppedByAuth,
        counts: { created: r.created.length, failed: r.failed.length, unknown: r.unknown.length, ...(imageFailed ? { imageFailed } : {}) },
      };
    },
  );
  if (stopped()) return finish(STOP_NOTE);
  if (!out.products?.created.length) return finish('등록된 상품이 없어서 실행하지 않았어요');

  if (mainsPerGroup) {
    if (hidden) {
      log('── 메인진열은 건너뜁니다 (숨김으로 등록한 상품은 메인에 올리지 않아요)');
      out.stages.push({ key: 'mains', name: '메인진열 채우기', status: 'skipped', note: '숨김 상품' });
    } else {
      out.mains = await stage('mains', '메인진열 채우기', () => fillMains(ctx, { perGroup: mainsPerGroup, runId }), (r) => {
        const counts = r.reduce((a, g) => ({ added: a.added + (g.added || 0), unknown: a.unknown + (g.unknown || 0), failed: a.failed + (g.failed || 0) }), { added: 0, unknown: 0, failed: 0 });
        return { status: counts.failed || counts.unknown ? 'partial' : 'done', counts };
      });
      if (stopped()) return finish(STOP_NOTE);
    }
  }
  if (reviewsMax) {
    out.reviews = await stage(
      'reviews',
      '상품후기 달기',
      async () => {
        const board = await resolveReviewBoard(ctx.client);
        const { requests } = await planReviews(ctx, { maxPerProduct: reviewsMax, runId, preset });
        log(`게시판: ${board.board_name}(${board.board_no}) — 후기 ${requests.length}개`);
        return postReviews(ctx, board, requests);
      },
      (r) => ({
        status: r.stoppedByAuth ? 'stopped' : r.failed || r.unknown ? 'partial' : 'done',
        stopsWorkflow: r.stoppedByAuth,
        error: r.stoppedByAuth ? '권한 오류로 중간에 멈췄습니다. 게시판 쓰기 권한과 로그인 상태를 확인하세요.' : undefined,
        counts: { created: r.created, failed: r.failed, unknown: r.unknown },
      }),
    );
  }
  return finish(STOP_NOTE);
}

// ---------------------------------------------------------------- 상품후기

export async function resolveReviewBoard(client, boardNo) {
  const boards = await client.listBoards();
  if (boardNo !== undefined) {
    const b = boards.find((x) => Number(x.board_no) === boardNo);
    if (!b) throw new Error(`없는 게시판 번호: ${boardNo} (\`boards\` 명령으로 확인하세요)`);
    return b;
  }
  const candidates = boards.filter((b) => /후기|review/i.test(b.board_name || ''));
  if (!candidates.length) throw new Error('상품후기 게시판을 찾지 못했습니다. 게시판 번호를 직접 지정하세요.');
  return candidates[0];
}

export async function planReviews(ctx, { maxPerProduct = 3, runId, preset = getPreset() } = {}) {
  const { ok } = await verifyProducts(ctx, ownedProducts(ctx, runId));
  const products = ok.sort((a, b) => a.product_no - b.product_no);
  if (!products.length) throw new Error('후기를 달 더미 상품이 없습니다. 먼저 상품을 등록하세요.');
  const requests = products.flatMap((p, i) => buildReviews({ ...p.current, product_no: p.product_no }, i, { maxPerProduct, preset }));
  return { products, requests };
}

const reviewKey = (productNo, title, writer, content) => `${productNo}\u0000${title}\u0000${writer}\u0000${contentDigest(content)}`;

export async function postReviews(ctx, board, requests) {
  const { client, manifest, log, progress } = ctx;
  manifest.ensureWritable();
  const boardNo = Number(board.board_no);
  const runOf = new Map(ownedProducts(ctx).map((p) => [p.product_no, p.runId]));
  const runIdsOf = (reqs) => [...new Set(reqs.map((r) => runOf.get(r.product_no)).filter(Boolean))];
  const result = { created: 0, failed: 0, unknown: 0, stoppedByAuth: false };
  const parts = chunk(requests, 10);

  await keepPartial(result, () => postReviewsLoop(ctx, { boardNo, runOf, runIdsOf, result, parts, total: requests.length }));
  return result;
}

async function postReviewsLoop(ctx, { boardNo, runOf, runIdsOf, result, parts, total }) {
  const { client, manifest, log, progress } = ctx;
  for (const [ci, part] of parts.entries()) {
    const range = `${ci * 10 + 1}~${ci * 10 + part.length}번째`;
    // 응답의 각 글을 (상품번호, 제목, 작성자)로 우리가 보낸 요청과 짝지어서, 짝이 맞는 것만 "등록됨"으로 기록한다.
    const pending = new Map();
    for (const r of part) {
      const k = reviewKey(r.product_no, r.title, r.writer, r.content);
      pending.set(k, (pending.get(k) || 0) + 1);
    }
    let data;
    try {
      data = await client.createArticles(boardNo, part);
    } catch (e) {
      if (isAmbiguous(e)) {
        result.unknown += part.length; // 기록 쓰기 전에 센다
        manifest.append('review', 'unknown', { board_no: boardNo, product_nos: part.map((r) => r.product_no), runIds: runIdsOf(part), reason: String(e.message).slice(0, 200) });
        log(`\n⚠️ ${range} — 결과를 알 수 없습니다 (${e.message}). 자동 삭제하지 않습니다.`);
      } else {
        result.failed += part.length;
        log(`\n❌ ${range} — ${e.message}`);
      }
      if (isAuthFailure(e)) {
        result.stoppedByAuth = true;
        log('권한 오류로 중단합니다. 게시판 쓰기 권한과 로그인 상태를 확인하세요.');
        break;
      }
      continue;
    }

    // 이 묶음의 기록을 먼저 모두 만든 뒤 한꺼번에 쓴다 (쓰다 실패하면 남은 항목 전부를 알리도록).
    const records = [];
    for (const a of Array.isArray(data?.articles) ? data.articles : []) {
      const articleNo = Number(a?.article_no);
      const productNo = Number(a?.product_no);
      if (typeof a?.content !== 'string') continue; // 본문이 응답에 없으면 나중에 비교할 수 없으므로 결과 불명
      const k = reviewKey(productNo, a.title, a.writer, a.content);
      if (!isPosInt(articleNo) || !pending.get(k)) continue;
      pending.set(k, pending.get(k) - 1);
      records.push(['review', 'created', {
        board_no: boardNo,
        article_no: articleNo,
        product_no: productNo,
        title: a.title,
        writer: a.writer,
        content_sha256: contentDigest(a.content),
        runId: runOf.get(productNo),
      }]);
    }
    const unresolved = part.filter((r) => {
      const k = reviewKey(r.product_no, r.title, r.writer, r.content);
      if (!pending.get(k)) return false;
      pending.set(k, pending.get(k) - 1);
      return true;
    });
    if (unresolved.length) {
      records.push(['review', 'unknown', { board_no: boardNo, product_nos: unresolved.map((r) => r.product_no), runIds: runIdsOf(unresolved), reason: '응답에서 확인되지 않음' }]);
    }
    // 카페24에는 이미 반영됐으므로 기록 쓰기 전에 센다
    result.created += records.filter(([, ev]) => ev === 'created').length;
    result.unknown += unresolved.length;
    appendAll(manifest, records);
    if (unresolved.length) log(`\n⚠️ ${range} — ${unresolved.length}개는 응답에서 확인되지 않아 "결과 불명"으로 기록했습니다.`);
    progress(Math.min((ci + 1) * 10, total), total);
  }
}

// ---------------------------------------------------------------- 예전 버전 데이터 (소유 기록 도입 전)

function readJsonFiles(prefix, logDir = LOG_DIR) {
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => {
      try {
        return { file: f, data: JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')) };
      } catch {
        return { file: f, data: null };
      }
    });
}

/**
 * 예전 버전 로그로 만든 데이터의 정리 계획.
 * 예전 로그에는 멀티쇼핑몰 번호(후기 로그는 쇼핑몰 ID까지)가 없어서 "이 쇼핑몰에서 만들었다"는 증거가 완전하지 않다.
 * 그래서 이 데이터는 소유로 인정하지 않고, 사용자가 근거를 보고 쇼핑몰 ID를 직접 입력해 확인할 때만 지운다.
 *
 * 그래도 지울 후보는 최대한 좁힌다:
 * - 상품: 로그의 쇼핑몰 ID가 지금 쇼핑몰과 같고, 지금 자체상품코드가 로그와 정확히 같은 것
 * - 후기: 위 상품에 달려 있고, 지금 글이 더미 후기 표시(제목 접두어 + 더미 작성자)와 로그의 상품번호와 같은 것
 * - 메인진열: 예전에는 기록하지 않아 후보에 넣지 않는다.
 */
export async function planLegacyPurge(ctx, { logDir = LOG_DIR } = {}) {
  const { cfg } = ctx;
  const evidence = { productLogs: [], reviewLogs: [], skipped: [] };
  const productCandidates = [];
  for (const { file, data } of readJsonFiles('run-', logDir)) {
    if (!data || !RUN_ID_PATTERN.test(String(data.runId)) || !Array.isArray(data.created)) {
      evidence.skipped.push(`${file}: 형식 오류`);
      continue;
    }
    if (data.mallId !== cfg.mallId) {
      evidence.skipped.push(`${file}: 다른 쇼핑몰(${data.mallId})`);
      continue;
    }
    evidence.productLogs.push(file);
    for (const e of data.created) {
      const no = Number(e.product_no);
      if (isPosInt(no) && isDummyCode(e.custom_product_code, data.runId)) productCandidates.push({ product_no: no, code: e.custom_product_code, runId: data.runId });
    }
  }
  const products = await verifyProducts(ctx, productCandidates);
  const productSet = new Set(products.ok.map((p) => p.product_no));

  const reviewCandidates = [];
  for (const { file, data } of readJsonFiles('reviews-', logDir)) {
    if (!data || !isPosInt(Number(data.board_no)) || !Array.isArray(data.created)) {
      evidence.skipped.push(`${file}: 형식 오류`);
      continue;
    }
    evidence.reviewLogs.push(file);
    for (const e of data.created) {
      const article = Number(e.article_no);
      const product = Number(e.product_no);
      if (isPosInt(article) && productSet.has(product)) reviewCandidates.push({ board_no: Number(data.board_no), article_no: article, product_no: product });
    }
  }
  const reviews = await verifyLegacyReviews(ctx, reviewCandidates);
  return { products, reviews, evidence };
}

async function verifyLegacyReviews(ctx, entries) {
  const out = { ok: [], gone: [], changed: [] }; // gone: 보고용 (예전 데이터는 기록을 쓰지 않음)
  const byBoard = new Map();
  for (const e of entries) byBoard.set(e.board_no, [...(byBoard.get(e.board_no) || []), e]);
  for (const [boardNo, list] of byBoard) {
    const current = await ctx.client.getArticlesByNos(boardNo, list.map((e) => e.article_no));
    for (const e of list) {
      const { current: _old, ...rec } = e;
      const cur = current.get(e.article_no);
      if (!cur) out.gone.push(rec);
      else if (Number(cur.product_no) === e.product_no && isDummyReview(cur)) out.ok.push({ ...rec, current: cur });
      else out.changed.push({ ...rec, current: cur });
    }
  }
  return out;
}

/**
 * 예전 데이터 정리 실행. 소유 기록은 바꾸지 않는다.
 * 후기를 지우기 전에, 그 후기의 근거인 상품부터 다시 확인해서 지금도 자격이 있는 상품의 후기만 지운다.
 */
export async function executeLegacyPurge(ctx, plan) {
  const { client, log, progress } = ctx;
  const done = { reviews: 0, products: 0, failed: 0, skippedChanged: 0, stoppedByAuth: false };
  const total = plan.reviews.ok.length + plan.products.ok.length;
  let step = 0;
  const run = async (fn, label) => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e.status === 404) return true;
      done.failed++;
      log(`❌ ${label} — ${e.message}`);
      if (isAuthFailure(e)) done.stoppedByAuth = true;
      return false;
    } finally {
      progress(++step, total);
    }
  };
  // 1) 근거 상품 재확인
  const pv1 = await verifyProducts(ctx, plan.products.ok);
  done.skippedChanged += pv1.changed.length;
  const stillQualified = new Set(pv1.ok.map((p) => p.product_no));
  const reviews = plan.reviews.ok.filter((r) => stillQualified.has(r.product_no));
  done.skippedChanged += plan.reviews.ok.length - reviews.length;
  // 2) 후기 재확인 후 삭제
  const rv = await verifyLegacyReviews(ctx, reviews);
  done.skippedChanged += rv.changed.length;
  for (const r of rv.ok) {
    if (await run(() => client.deleteArticle(r.board_no, r.article_no), `후기 ${r.article_no}`)) done.reviews++;
    if (done.stoppedByAuth) return done;
  }
  // 3) 상품 재확인 후 삭제
  const pv2 = await verifyProducts(ctx, pv1.ok);
  done.skippedChanged += pv2.changed.length;
  for (const p of pv2.ok) {
    if (await run(() => client.deleteProduct(p.product_no), `상품 ${p.product_no}`)) done.products++;
    if (done.stoppedByAuth) return done;
  }
  return done;
}
