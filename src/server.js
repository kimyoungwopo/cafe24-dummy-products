import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROOT_DIR,
  DATA_DIR,
  DATA_DIR_SOURCE,
  ENV_FILE,
  getConfig,
  saveConfig,
  parseMallId,
  checkMallDns,
  loadEnvFile,
  readEnvFileKeys,
} from './config.js';
import { readToken, startLogin, completeLogin } from './auth.js';
import { Cafe24Client } from './api.js';
import { makeRunId } from './dummy.js';
import {
  createContext,
  createProducts,
  resolveCategories,
  planCleanup,
  executeCleanup,
  toCategory,
  categoryLabel,
  validateRunId,
} from './core.js';

/**
 * 로컬 UI 서버.
 *
 * 보안 (다른 웹사이트가 이 서버에 몰래 요청하지 못하게):
 * - 127.0.0.1에만, 매번 다른 포트로 연다.
 * - 실행할 때마다 무작위 세션 토큰을 만들고 URL의 # 뒤(서버로 전송되지 않는 부분)로만 화면에 넘긴다.
 *   모든 API 요청은 X-Session-Token 헤더에 이 토큰이 있어야 한다.
 * - Host가 정확히 127.0.0.1:포트 / localhost:포트여야 한다 (DNS 리바인딩 방지).
 * - 브라우저가 보낸 Origin·Sec-Fetch-Site가 같은 출처가 아니면 거부한다. CORS 헤더는 보내지 않는다.
 * - POST는 application/json만, 본문 64KB까지.
 * - 화면은 외부 자원 없이, 엄격한 CSP로만 제공한다.
 * - Client Secret·토큰·인증 코드는 어떤 응답에도 담지 않는다.
 * 같은 사용자 계정으로 실행 중인 다른 프로그램(악성코드 등)까지 막지는 못한다.
 */

const UI_DIR = path.join(ROOT_DIR, 'ui');
const MAX_BODY = 64 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1000;
const COMMUNITY = ['mall.read_community', 'mall.write_community'];
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'JSON 요청만 받습니다.');
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
}

const hasScopes = (token, scopes) => scopes.every((s) => (token?.scopes || []).includes(s));

function safeToken() {
  try {
    return { token: readToken(), error: null };
  } catch (e) {
    return { token: null, error: e.message };
  }
}

let urlSink = null;
/** 테스트 전용: 토큰이 든 접속 주소를 코드에서만 받는다 (test/run-cli.js). 실제 실행에서는 주소를 어디에도 출력하지 않는다. */
export function __setUrlSink(fn) {
  urlSink = fn;
}

export async function startServer({ port = 0 } = {}) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const state = { job: null, busy: false, plans: new Map(), attempt: null, clients: new Map() };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      // 입력 검증·카페24 오류 등은 이 도구가 만든 안내 문구이므로 그대로 보여 준다 (비밀값은 담기지 않음).
      const status = e?.isAuthError ? 401 : 400;
      sendJson(res, status, { error: String(e?.message || '처리 중 오류가 났습니다.') });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);

  // ---------------------------------------------------------------- 공통

  function configOrThrow() {
    try {
      return getConfig();
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  function clientFor(cfg) {
    const key = `${cfg.apiBase}|${cfg.shopNo}`;
    if (!state.clients.has(key)) state.clients.set(key, new Cafe24Client(cfg));
    return state.clients.get(key);
  }

  /** 로그인되어 있고 지금 설정한 쇼핑몰의 토큰인지 확인한다. */
  function loggedIn(cfg) {
    const { token, error } = safeToken();
    if (error) throw new HttpError(401, error);
    if (!token) throw new HttpError(401, '먼저 카페24에 로그인하세요.');
    if (token.mall_id && token.mall_id !== cfg.mallId) {
      throw new HttpError(401, `저장된 로그인은 ${token.mall_id} 쇼핑몰용입니다. 지금 설정(${cfg.mallId})으로 다시 로그인하세요.`);
    }
    return token;
  }

  // 작업 중에는 카페24를 부르는 다른 요청을 받지 않는다 (호출 제한·기록 순서를 지키기 위해)
  function notDuringJob() {
    if (state.job?.status === 'running') throw new HttpError(409, '작업이 진행 중입니다. 끝난 뒤에 다시 시도하세요.');
  }

  /**
   * 카페24를 부르거나 설정을 바꾸는 요청은 한 번에 하나만 처리한다.
   * (확인과 실행 사이에 다른 요청·작업이 끼어들지 않도록. 작업을 시작하는 요청이면 작업이 끝날 때까지 이어서 막힌다)
   */
  const exclusive = (fn) => async (body) => {
    if (state.busy) throw new HttpError(409, '다른 요청을 처리하는 중입니다. 잠시 후 다시 시도하세요.');
    notDuringJob();
    state.busy = true;
    try {
      return await fn(body);
    } finally {
      state.busy = false;
    }
  };

  function jobView(job, { withLogs = false } = {}) {
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
      ...(withLogs ? { logs: job.logs } : {}),
    };
  }

  function startJob(type, cfg, run, summarize) {
    notDuringJob();
    const job = { id: crypto.randomBytes(8).toString('hex'), type, status: 'running', startedAt: new Date().toISOString(), progress: { done: 0, total: 0 }, logs: [] };
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
    Promise.resolve()
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
      });
    return jobView(job);
  }

  // ---------------------------------------------------------------- API

  const routes = {
    'GET /api/state': async () => {
      loadEnvFile();
      let cfg = null;
      let configError = null;
      try {
        cfg = getConfig({ requireOAuth: false });
      } catch (e) {
        configError = e.message;
      }
      const fileKeys = readEnvFileKeys();
      const secret = fileKeys.has('CAFE24_CLIENT_SECRET') ? 'file' : process.env.CAFE24_CLIENT_SECRET ? 'env' : 'none';
      const { token, error: tokenError } = safeToken();
      return {
        dataDir: DATA_DIR,
        dataDirSource: DATA_DIR_SOURCE,
        envFile: ENV_FILE,
        configError,
        config: {
          mallId: cfg?.mallId || '',
          clientId: cfg?.clientId || '',
          redirectUri: cfg?.redirectUri || '',
          secret, // 'file' | 'env' | 'none' — 값은 절대 보내지 않음
          complete: Boolean(cfg?.mallId && cfg?.clientId && cfg?.redirectUri && secret !== 'none'),
        },
        login: token
          ? {
              mallId: token.mall_id,
              scopes: token.scopes || [],
              accessLeftMin: Math.round(((token.access_expires_ms || 0) - Date.now()) / 60000),
              refreshExpiresAt: token.refresh_token_expires_at || null,
              mismatch: Boolean(cfg?.mallId && token.mall_id && token.mall_id !== cfg.mallId),
            }
          : null,
        tokenError,
        job: jobView(state.job),
      };
    },

    'POST /api/config': exclusive(async (body) => {
      notDuringJob();
      loadEnvFile();
      const mallId = parseMallId(body.mall);
      const warnings = [];
      const dns = await checkMallDns(mallId);
      if (!dns.ok) {
        if (dns.kind === 'notfound' && !body.force) return { saved: false, needsConfirm: true, warning: dns.message };
        warnings.push(dns.message);
      }
      const fileKeys = readEnvFileKeys();
      const hasStoredSecret = fileKeys.has('CAFE24_CLIENT_SECRET') || Boolean(process.env.CAFE24_CLIENT_SECRET);
      if (!body.clientSecret && !hasStoredSecret) throw new HttpError(400, 'Client Secret을 입력하세요.');
      const redirect = String(body.redirectUri || `https://${mallId}.cafe24.com`).trim();
      try {
        if (new URL(redirect).hostname !== `${mallId}.cafe24.com`) {
          warnings.push(`로그인할 때 인증 코드가 ${new URL(redirect).hostname} 으로 전달됩니다. 직접 관리하는 주소가 아니라면 https://${mallId}.cafe24.com 을 쓰세요.`);
        }
      } catch {
        /* 형식 오류는 saveConfig가 안내 */
      }
      const before = process.env.CAFE24_MALL_ID;
      saveConfig({
        CAFE24_MALL_ID: mallId,
        CAFE24_CLIENT_ID: body.clientId,
        CAFE24_CLIENT_SECRET: body.clientSecret || undefined,
        CAFE24_REDIRECT_URI: redirect,
      });
      if (!body.clientSecret && !fileKeys.has('CAFE24_CLIENT_SECRET') && process.env.CAFE24_CLIENT_SECRET) {
        warnings.push('Client Secret은 환경변수에만 있어 설정 파일에는 저장하지 않았습니다.');
      }
      if (before && before !== mallId) warnings.push('쇼핑몰이 바뀌었습니다. 다시 로그인하세요.');
      state.attempt = null;
      state.clients.clear(); // 바뀐 설정(Client ID·Secret 등)으로 새 연결을 만들도록
      return { saved: true, warnings };
    }),

    'POST /api/login/start': exclusive(async () => {
      const cfg = configOrThrow();
      state.attempt = startLogin(cfg);
      return { authorizeUrl: state.attempt.url, expiresAt: state.attempt.expiresAt };
    }),

    'POST /api/login/complete': exclusive(async (body) => {
      const cfg = configOrThrow();
      if (!state.attempt) throw new HttpError(400, '진행 중인 로그인 시도가 없습니다. "카페24 로그인 열기"부터 다시 하세요.');
      try {
        const token = await completeLogin(cfg, body.url, state.attempt);
        return { ok: true, mallId: token.mall_id, scopes: token.scopes || [] };
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    }),

    'GET /api/categories': exclusive(async () => {
      const cfg = configOrThrow();
      loggedIn(cfg);
      const all = await clientFor(cfg).listCategories();
      const parents = new Set(all.map((c) => Number(c.parent_category_no)));
      return {
        categories: all
          .map((c) => ({
            ...toCategory(c),
            depth: Number(c.category_depth || 1),
            displayed: (c.use_display ?? 'T') === 'T',
            leaf: !parents.has(Number(c.category_no)),
          }))
          .map((c) => ({ ...c, label: categoryLabel(c) }))
          .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/'), undefined, { numeric: true })),
      };
    }),

    'GET /api/batches': async () => {
      const cfg = configOrThrow();
      const ctx = createContext(null, cfg);
      const s = ctx.manifest.load();
      const byRun = new Map();
      for (const p of s.products.values()) byRun.set(p.runId, (byRun.get(p.runId) || 0) + 1);
      const reviewsByRun = new Map();
      for (const r of s.reviews.values()) reviewsByRun.set(r.runId, (reviewsByRun.get(r.runId) || 0) + 1);
      const batches = [...byRun]
        .map(([runId, products]) => ({ runId, products, reviews: reviewsByRun.get(runId) || 0, createdAt: runIdToDate(runId) }))
        .sort((a, b) => b.runId.localeCompare(a.runId));
      return { batches, unknown: s.unknown.length, legacy: s.legacy.length, invalidLines: s.invalidLines, manifest: ctx.manifest.file };
    },

    'POST /api/cleanup/plan': exclusive(async (body) => {
      const cfg = configOrThrow();
      const token = loggedIn(cfg);
      // runId를 아예 보내지 않았을 때만 "전체". 빈 값·null 등은 거부한다 (실수로 전체 정리가 되지 않도록).
      const runId = body.runId === undefined ? undefined : String(body.runId);
      validateRunId(runId);
      const withReviews = hasScopes(token, COMMUNITY);
      const ctx = createContext(clientFor(cfg), cfg);
      const plan = await planCleanup(ctx, { runId, reviews: withReviews });
      const planId = crypto.randomBytes(12).toString('hex');
      for (const [id, p] of state.plans) if (Date.now() - p.createdAt > PLAN_TTL_MS) state.plans.delete(id);
      state.plans.set(planId, { plan, createdAt: Date.now(), mallId: cfg.mallId, shopNo: cfg.shopNo });
      return {
        planId,
        runId: runId ?? null,
        mallId: cfg.mallId,
        withReviews,
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
    }),

    'POST /api/jobs/cleanup': exclusive(async (body) => {
      const cfg = configOrThrow();
      loggedIn(cfg);
      const entry = state.plans.get(String(body.planId || ''));
      // 미리보기는 한 번만, 10분 안에, 같은 쇼핑몰에서만 실행할 수 있다.
      if (!entry || Date.now() - entry.createdAt > PLAN_TTL_MS || entry.mallId !== cfg.mallId || entry.shopNo !== cfg.shopNo) {
        throw new HttpError(400, '정리 미리보기가 없거나 만료됐습니다. 미리보기부터 다시 하세요.');
      }
      notDuringJob();
      state.plans.delete(String(body.planId));
      return startJob('cleanup', cfg, (ctx) => executeCleanup(ctx, entry.plan), (d) => ({
        products: d.products,
        reviews: d.reviews,
        mains: d.mains,
        failed: d.failed,
        gone: d.gone,
        skippedChanged: d.skippedChanged,
        missing: d.missing,
        reappeared: d.reappeared,
        stoppedByAuth: d.stoppedByAuth,
      }));
    }),

    'POST /api/jobs/seed': exclusive(async (body) => {
      const cfg = configOrThrow();
      loggedIn(cfg);
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > 500) throw new HttpError(400, '상품 개수는 1~500 사이로 입력하세요.');
      const mode = body.categoryMode;
      if (!['spread', 'pick', 'none'].includes(mode)) throw new HttpError(400, '분류 선택 방식이 올바르지 않습니다.');
      let nos;
      if (mode === 'pick') {
        if (!Array.isArray(body.categoryNos) || !body.categoryNos.length || body.categoryNos.length > 200 || !body.categoryNos.every((n) => Number.isInteger(n) && n > 0)) {
          throw new HttpError(400, '분류를 하나 이상 고르세요.');
        }
        nos = body.categoryNos;
      }
      const client = clientFor(cfg);
      const categories = await resolveCategories(client, { nos, spread: mode === 'spread' });
      const runId = makeRunId();
      return startJob(
        'seed',
        cfg,
        (ctx) =>
          createProducts(ctx, {
            count,
            categories,
            runId,
            hidden: Boolean(body.hidden),
            withOptions: Boolean(body.withOptions),
            withImage: body.withImage !== false,
          }),
        (r) => ({ runId: r.runId, created: r.created.length, failed: r.failed.length, unknown: r.unknown.length, stoppedByAuth: r.stoppedByAuth }),
      );
    }),

    'GET /api/job': async () => ({ job: jobView(state.job, { withLogs: true }) }),
  };

  async function handle(req, res) {
    // DNS 리바인딩 방지: Host가 정확히 이 서버여야 한다.
    if (!allowedHosts.has(String(req.headers.host || ''))) {
      res.writeHead(421, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      return res.end('Misdirected Request');
    }
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Content-Security-Policy': CSP }));
      return res.end(fs.readFileSync(path.join(UI_DIR, file)));
    }

    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      return res.end('Not Found');
    }

    // 다른 출처(웹사이트)에서 온 요청은 거부한다.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, '허용되지 않은 출처의 요청입니다.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, '허용되지 않은 출처의 요청입니다.');
    if (!sameToken(req.headers['x-session-token'], sessionToken)) {
      throw new HttpError(401, '세션이 맞지 않습니다. 터미널에서 ui 명령을 다시 실행해 새로 열어 주세요.');
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, '없는 API입니다.');
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    sendJson(res, 200, await route(body));
  }

  const launchUrl = `http://127.0.0.1:${actualPort}/#token=${sessionToken}`;
  if (urlSink) urlSink(launchUrl);
  return {
    port: actualPort,
    url: launchUrl,
    close: () => new Promise((r) => server.close(r)),
    // 테스트용
    _state: state,
  };
}

function runIdToDate(runId) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(runId || '');
  return m ? `20${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
}
