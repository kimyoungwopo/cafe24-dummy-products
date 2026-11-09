import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { readToken } from './auth.js';
import { Cafe24Client } from './api.js';
import { makeRunId } from './dummy.js';
import {
  createContext,
  seedWorkflow,
  resolveCategories,
  planCleanup,
  executeCleanup,
  toCategory,
  categoryLabel,
  validateRunId,
  acquireWriteLock,
  planProduct,
} from './core.js';
import { listPresets } from './presets.js';
import { makeDummyImage, toDataUri } from './image.js';

/**
 * 화면(UI 서버)과 MCP 서버가 함께 쓰는 작업 서비스.
 * 입력 범위 검사, 작업 하나씩 실행(쓰기 잠금 포함), 정리 계획(10분·1회용·쇼핑몰 결속)을 한 곳에서 처리한다.
 * 전송 방식(HTTP/MCP)에 묶이지 않도록 ServiceError(kind)로 실패를 알리고, 각 어댑터가 자기 형식으로 바꾼다.
 *
 * kind: config(설정 없음·잘못됨) / invalid(입력 오류) / auth(로그인 문제) / conflict(다른 작업 중·확인 대기 등) / notFound
 */
export class ServiceError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.extra = extra;
  }
}

export const PLAN_TTL_MS = 10 * 60 * 1000;
export const COMMUNITY = ['mall.read_community', 'mall.write_community'];
export const LIMITS = { count: [1, 500], mainsPerGroup: [1, 50], reviewsMax: [1, 10], categoryNos: 200 };
export const hasScopes = (token, scopes) => scopes.every((s) => (token?.scopes || []).includes(s));

export function safeToken() {
  try {
    return { token: readToken(), error: null };
  } catch (e) {
    return { token: null, error: e.message };
  }
}

export function runIdToDate(runId) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(runId || '');
  return m ? `20${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
}

/**
 * @param {object} opts
 * @param {string} opts.source 잠금 이름 앞에 붙는 출처 ('ui' | 'mcp')
 */
export function createService({ source = 'ui' } = {}) {
  const state = { job: null, busy: false, plans: new Map(), clients: new Map() };

  function configOrThrow() {
    try {
      return getConfig();
    } catch (e) {
      throw new ServiceError('config', e.message);
    }
  }

  function clientFor(cfg) {
    const key = `${cfg.apiBase}|${cfg.shopNo}`;
    if (!state.clients.has(key)) state.clients.set(key, new Cafe24Client(cfg));
    return state.clients.get(key);
  }
  const resetClients = () => state.clients.clear();

  /** 로그인되어 있고 지금 설정한 쇼핑몰의 토큰인지 확인한다. */
  function loggedIn(cfg) {
    const { token, error } = safeToken();
    if (error) throw new ServiceError('auth', error);
    if (!token) throw new ServiceError('auth', '먼저 카페24에 로그인하세요.');
    if (token.mall_id && token.mall_id !== cfg.mallId) {
      throw new ServiceError('auth', `저장된 로그인은 ${token.mall_id} 쇼핑몰용입니다. 지금 설정(${cfg.mallId})으로 다시 로그인하세요.`);
    }
    return token;
  }

  // 작업 중에는 카페24를 부르는 다른 요청을 받지 않는다 (호출 제한·기록 순서를 지키기 위해)
  function notDuringJob() {
    if (state.job?.status === 'running') throw new ServiceError('conflict', '작업이 진행 중입니다. 끝난 뒤에 다시 시도하세요.');
  }

  /**
   * 카페24를 부르거나 설정을 바꾸는 요청은 한 번에 하나만 처리한다.
   * (확인과 실행 사이에 다른 요청·작업이 끼어들지 않도록)
   */
  const exclusive = (fn) => async (...args) => {
    if (state.busy) throw new ServiceError('conflict', '다른 요청을 처리하는 중입니다. 잠시 후 다시 시도하세요.');
    notDuringJob();
    state.busy = true;
    try {
      return await fn(...args);
    } finally {
      state.busy = false;
    }
  };

  function jobView(job, { withLogs = false, logTail } = {}) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: job.progress,
      result: job.result,
      error: job.error,
      ...(job.runId ? { runId: job.runId } : {}),
      ...(withLogs ? { logs: logTail ? job.logs.slice(-logTail) : job.logs } : {}),
    };
  }

  /** 작업을 시작하고 바로 돌려준다. 쓰기 잠금을 못 잡으면(다른 프로세스가 작업 중) 시작하지 않는다. */
  function startJob(type, cfg, run, summarize, { runId, beforeStart } = {}) {
    notDuringJob();
    let release;
    try {
      release = acquireWriteLock(`${source}:${type}`);
    } catch (e) {
      throw new ServiceError('conflict', e.message);
    }
    try {
      beforeStart?.(); // 잠금을 잡은 뒤에만 계획·승인을 소비한다 (잠금 충돌로 계획이 사라지지 않도록)
    } catch (e) {
      release();
      throw e;
    }
    const job = { id: crypto.randomBytes(8).toString('hex'), type, runId, status: 'running', startedAt: new Date().toISOString(), progress: { done: 0, total: 0 }, logs: [] };
    state.job = job;
    const ctx = createContext(clientFor(cfg), cfg, {
      log: (m) => {
        job.logs.push(String(m));
        if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
      },
      progress: (done, total, label) => {
        job.progress = { done, total, label: label ? String(label) : undefined };
      },
    });
    job.promise = Promise.resolve()
      .then(() => run(ctx))
      .then((r) => {
        job.result = summarize(r);
        job.status = 'done';
      })
      .catch((e) => {
        job.error = String(e.message);
        job.status = 'failed';
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        release();
      });
    return jobView(job);
  }

  // ---------------------------------------------------------------- 조회

  const listCategories = exclusive(async () => {
    const cfg = configOrThrow();
    loggedIn(cfg);
    const all = await clientFor(cfg).listCategories();
    const parents = new Set(all.map((c) => Number(c.parent_category_no)));
    return all
      .map((c) => ({
        ...toCategory(c),
        depth: Number(c.category_depth || 1),
        displayed: (c.use_display ?? 'T') === 'T',
        leaf: !parents.has(Number(c.category_no)),
      }))
      .map((c) => ({ ...c, label: categoryLabel(c) }))
      .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true }));
  });

  /** 배치 목록. 상품이 먼저 정리돼 후기·메인진열 기록만 남은 배치도 보여 준다. */
  function listBatches() {
    const cfg = configOrThrow();
    const ctx = createContext(null, cfg);
    const s = ctx.manifest.load();
    const count = (values) => {
      const m = new Map();
      for (const v of values) m.set(v.runId, (m.get(v.runId) || 0) + 1);
      return m;
    };
    const products = count(s.products.values());
    const reviews = count(s.reviews.values());
    const mains = count(s.mains.values());
    const runIds = new Set([...products.keys(), ...reviews.keys(), ...mains.keys()].filter(Boolean));
    const batches = [...runIds]
      .map((runId) => ({ runId, products: products.get(runId) || 0, reviews: reviews.get(runId) || 0, mains: mains.get(runId) || 0, createdAt: runIdToDate(runId) }))
      .sort((a, b) => b.runId.localeCompare(a.runId));
    return { batches, unknown: s.unknown.length, legacy: s.legacy.length, invalidLines: s.invalidLines, manifest: ctx.manifest.file, mallId: cfg.mallId, shopNo: cfg.shopNo };
  }

  /** 상품 하나 예시 (카페24에 요청하지 않음). 실제 등록과 같은 생성 함수를 쓴다. */
  function preview({ preset, withOptions = false, categoryNames, categoryNo }) {
    const category = categoryNames?.length ? { no: categoryNo ?? 1, names: categoryNames, path: [categoryNo ?? 1] } : undefined;
    const { request } = planProduct(1, { runId: '000000000000000', categories: category ? [category] : [], prefix: '[더미] ', hidden: false, withOptions, preset });
    return {
      preset: { id: preset.id, label: preset.label },
      sample: {
        name: request.product_name,
        price: request.price,
        retailPrice: request.retail_price,
        summary: request.simple_description,
        options: (request.options ?? []).map((o) => ({ name: o.name, values: o.value })),
        image: toDataUri(makeDummyImage(1, 240, preset.image)),
      },
    };
  }

  // ---------------------------------------------------------------- 채우기

  const inRange = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

  /**
   * 채우기 작업 시작. 입력은 어댑터가 형식을 확인한 값이어야 한다 (여기서는 범위·조합을 확인).
   * @param {{ preset: object, count: number, categoryMode: 'spread'|'pick'|'none', categoryNos?: number[], hidden: boolean, withOptions: boolean, withImage: boolean, mainsPerGroup: number, reviewsMax: number }} input
   */
  const startSeed = exclusive(async (input) => {
    const { preset, count, categoryMode: mode, categoryNos, hidden, withOptions, withImage, mainsPerGroup: mains, reviewsMax } = input;
    const cfg = configOrThrow();
    const token = loggedIn(cfg);
    // 0이면 안 함, 그 밖에는 범위 안의 정수여야 한다 (NaN 등은 거부)
    if (mains !== 0 && !inRange(mains, LIMITS.mainsPerGroup)) throw new ServiceError('invalid', '메인진열 개수는 1~50 사이로 입력하세요.');
    if (reviewsMax !== 0 && !inRange(reviewsMax, LIMITS.reviewsMax)) throw new ServiceError('invalid', '상품당 후기 수는 1~10 사이로 입력하세요.');
    if (reviewsMax && !hasScopes(token, COMMUNITY)) throw new ServiceError('invalid', '후기를 달려면 게시판 권한이 필요합니다. 개발자센터에서 게시판(Community) 읽기+쓰기를 켜고 다시 로그인하세요.');
    if (!inRange(count, LIMITS.count)) throw new ServiceError('invalid', '상품 개수는 1~500 사이로 입력하세요.');
    if (!['spread', 'pick', 'none'].includes(mode)) throw new ServiceError('invalid', '분류 선택 방식이 올바르지 않습니다.');
    let nos;
    if (mode === 'pick') {
      if (!Array.isArray(categoryNos) || !categoryNos.length || categoryNos.length > LIMITS.categoryNos || !categoryNos.every((n) => Number.isInteger(n) && n > 0)) {
        throw new ServiceError('invalid', '분류를 하나 이상 고르세요.');
      }
      nos = categoryNos;
    }
    const categories = await resolveCategories(clientFor(cfg), { nos, spread: mode === 'spread' });
    const runId = makeRunId();
    return startJob(
      'seed',
      cfg,
      (ctx) => seedWorkflow(ctx, { count, categories, runId, hidden, withOptions, withImage, mainsPerGroup: mains, reviewsMax, preset }),
      (o) => ({
        runId: o.runId,
        preset: { id: preset.id, label: preset.label },
        stages: o.stages, // 단계별 상태: done | partial | stopped | skipped, counts, error(전체 메시지)
        created: o.stages.find((st) => st.key === 'products')?.counts?.created ?? 0, // 도중에 멈춰도 그때까지 등록한 수
      }),
      { runId },
    );
  });

  // ---------------------------------------------------------------- 정리

  /**
   * 정리 계획을 만든다 (카페24 데이터는 바꾸지 않음). runId가 undefined면 이 도구가 만든 전체.
   * requiresApproval: true면 실행 전에 사람이 따로 승인해야 한다 (MCP).
   */
  const createCleanupPlan = exclusive(async ({ runId, requiresApproval = false }) => {
    const cfg = configOrThrow();
    const token = loggedIn(cfg);
    validateRunId(runId);
    const withReviews = hasScopes(token, COMMUNITY);
    const ctx = createContext(clientFor(cfg), cfg);
    const plan = await planCleanup(ctx, { runId, reviews: withReviews });
    const planId = crypto.randomBytes(16).toString('hex');
    for (const [id, p] of state.plans) if (Date.now() - p.createdAt > PLAN_TTL_MS) state.plans.delete(id);
    const view = {
      planId,
      runId: runId ?? null,
      mallId: cfg.mallId,
      shopNo: cfg.shopNo,
      withReviews,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
      counts: { reviews: plan.reviews.ok.length, mains: plan.mains.ok.length, products: plan.products.ok.length },
      samples: plan.products.ok.slice(0, 5).map((p) => ({ productNo: p.product_no, name: p.current?.product_name ?? p.code })),
      notes: {
        changedProducts: plan.products.changed.length,
        changedReviews: plan.reviews.changed.length,
        productChangedMains: plan.mains.productChanged.length,
        missingReviews: plan.reviews.missing.length,
        missingMains: plan.mains.missing.length,
        goneProducts: plan.products.gone.length,
        unknown: plan.unknown.length,
        legacy: plan.legacyCount,
        invalidLines: plan.invalidLines,
      },
    };
    state.plans.set(planId, { plan, view, createdAt: Date.now(), mallId: cfg.mallId, shopNo: cfg.shopNo, requiresApproval, approval: 'pending' });
    return view;
  });

  /** 살아 있는 계획 (만료·다른 쇼핑몰이면 null) */
  function livePlan(planId, cfg) {
    const entry = typeof planId === 'string' ? state.plans.get(planId) : undefined;
    if (!entry) return null;
    if (Date.now() - entry.createdAt > PLAN_TTL_MS) {
      state.plans.delete(planId);
      return null;
    }
    if (cfg && (entry.mallId !== cfg.mallId || entry.shopNo !== cfg.shopNo)) return null;
    return entry;
  }

  /** 사람이 확인 화면에서 승인/거절한 결과를 기록한다 (MCP 확인 화면 전용). 거절하면 계획은 버린다. */
  function decideCleanupPlan(planId, decision) {
    const entry = livePlan(planId);
    if (!entry || !entry.requiresApproval || entry.approval !== 'pending') throw new ServiceError('notFound', '확인할 정리 계획이 없거나 만료됐습니다.');
    if (decision === 'approve') entry.approval = 'approved';
    else state.plans.delete(planId);
    return { decision };
  }

  /** 계획대로 정리 작업을 시작한다. 계획은 잠금을 잡은 뒤에 한 번만 쓰인다. */
  const startCleanup = exclusive(async ({ planId }) => {
    const cfg = configOrThrow();
    loggedIn(cfg);
    const entry = livePlan(planId, cfg);
    // 미리보기는 한 번만, 10분 안에, 같은 쇼핑몰에서만 실행할 수 있다.
    if (!entry) throw new ServiceError('invalid', '정리 미리보기가 없거나 만료됐습니다. 미리보기부터 다시 하세요.');
    if (entry.requiresApproval && entry.approval !== 'approved') {
      throw new ServiceError('conflict', '아직 사람이 확인 화면에서 승인하지 않았습니다.', { awaitingApproval: true });
    }
    notDuringJob();
    return startJob(
      'cleanup',
      cfg,
      (ctx) => executeCleanup(ctx, entry.plan),
      (d) => ({
        products: d.products,
        reviews: d.reviews,
        mains: d.mains,
        failed: d.failed,
        gone: d.gone,
        skippedChanged: d.skippedChanged,
        missing: d.missing,
        reappeared: d.reappeared,
        stoppedByAuth: d.stoppedByAuth,
      }),
      { runId: entry.view.runId ?? undefined, beforeStart: () => state.plans.delete(planId) },
    );
  });

  /** 끝나지 않은 작업이 있으면 끝날 때까지 기다린다 (프로세스를 닫기 전에) */
  const waitForJob = () => (state.job?.status === 'running' ? state.job.promise : Promise.resolve());

  return {
    state,
    configOrThrow,
    clientFor,
    resetClients,
    loggedIn,
    notDuringJob,
    exclusive,
    jobView,
    listCategories,
    listBatches,
    listPresets,
    preview,
    startSeed,
    createCleanupPlan,
    livePlan,
    decideCleanupPlan,
    startCleanup,
    currentJob: (opts) => jobView(state.job, opts),
    waitForJob,
  };
}
