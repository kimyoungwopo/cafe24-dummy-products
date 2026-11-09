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
import { startLogin, completeLogin } from './auth.js';
import { getPreset } from './presets.js';
import { createService, ServiceError, safeToken } from './service.js';
import { CSP, HttpError, baseHeaders, sendJson, readJsonBody, listenLoopback, checkHost, checkApiRequest, emitUrl } from './http-guard.js';

/** 요청 본문의 업종 id를 확인한다 (없으면 기본 패션) */
function presetOrThrow(id) {
  if (id !== undefined && typeof id !== 'string') throw new HttpError(400, '업종 값이 올바르지 않습니다.');
  try {
    return getPreset(id);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

/** 화면의 "함께 채우기" 값: 켜져 있으면 범위 안의 정수여야 한다 (0·문자 등은 꺼짐으로 바꾸지 않고 거부) */
function enabledCount(opt, key, fallback, [lo, hi], message) {
  if (!opt?.enabled) return 0;
  const v = Number(opt[key] ?? fallback);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, message);
  return v;
}

const STATUS_OF = { config: 400, invalid: 400, auth: 401, conflict: 409, notFound: 404 };

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
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

export { __setUrlSink } from './http-guard.js';

export async function startServer({ port = 0 } = {}) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const svc = createService({ source: 'ui' });
  const state = { attempt: null }; // 로그인 시도는 화면 전용

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof ServiceError) return sendJson(res, STATUS_OF[e.kind] ?? 400, { error: e.message, ...e.extra });
      // 입력 검증·카페24 오류 등은 이 도구가 만든 안내 문구이므로 그대로 보여 준다 (비밀값은 담기지 않음).
      const status = e?.isAuthError ? 401 : 400;
      sendJson(res, status, { error: String(e?.message || '처리 중 오류가 났습니다.') });
    });
  });
  const { port: actualPort, allowedHosts, allowedOrigins } = await listenLoopback(server, port);
  const { exclusive, configOrThrow } = svc;

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
        job: svc.currentJob(),
      };
    },

    'POST /api/config': exclusive(async (body) => {
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
      svc.resetClients(); // 바뀐 설정(Client ID·Secret 등)으로 새 연결을 만들도록
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

    'GET /api/categories': async () => ({ categories: await svc.listCategories() }),

    'GET /api/batches': async () => {
      const { mallId, shopNo, ...rest } = svc.listBatches();
      return rest;
    },

    'POST /api/cleanup/plan': async (body) => {
      // runId를 아예 보내지 않았을 때만 "전체". 빈 값·null 등은 거부한다 (실수로 전체 정리가 되지 않도록).
      const runId = body.runId === undefined ? undefined : String(body.runId);
      // 화면에서는 이 미리보기 뒤 "되돌릴 수 없다" 체크가 사람의 확인이다.
      return svc.createCleanupPlan({ runId });
    },

    'POST /api/jobs/cleanup': async (body) => svc.startCleanup({ planId: String(body.planId || '') }),

    'POST /api/jobs/seed': async (body) => {
      const preset = presetOrThrow(body.preset); // 작업을 시작하기 전에 한 번 정해 상품·후기에 같이 쓴다
      return svc.startSeed({
        preset,
        count: Number(body.count),
        categoryMode: body.categoryMode,
        categoryNos: body.categoryNos,
        hidden: Boolean(body.hidden),
        withOptions: Boolean(body.withOptions),
        withImage: body.withImage !== false,
        mainsPerGroup: enabledCount(body.mains, 'perGroup', 8, [1, 50], '메인진열 개수는 1~50 사이로 입력하세요.'),
        reviewsMax: enabledCount(body.reviews, 'maxPerProduct', 3, [1, 10], '상품당 후기 수는 1~10 사이로 입력하세요.'),
      });
    },

    'GET /api/job': async () => ({ job: svc.currentJob({ withLogs: true }) }),

    'GET /api/presets': async () => ({ presets: svc.listPresets() }),

    // 상품 하나 예시 (카페24에 요청하지 않음). 실제 등록과 같은 생성 함수를 쓴다.
    'POST /api/preview': async (body) => {
      const preset = presetOrThrow(body.preset);
      const names = body.categoryNames;
      if (names !== undefined && (!Array.isArray(names) || names.length > 6 || !names.every((n) => typeof n === 'string' && n.length <= 100))) {
        throw new HttpError(400, '분류 이름이 올바르지 않습니다.');
      }
      const no = body.categoryNo;
      if (no !== undefined && (!Number.isInteger(no) || no < 1 || no > 1e9)) throw new HttpError(400, '분류 번호가 올바르지 않습니다.');
      // 실제 등록과 같은 분류 번호를 써야 첫 상품과 같은 예시가 나온다 (상품 선택이 분류 번호에도 달려 있음)
      return svc.preview({ preset, withOptions: Boolean(body.withOptions), categoryNames: names, categoryNo: no });
    },
  };

  async function handle(req, res) {
    // DNS 리바인딩 방지: Host가 정확히 이 서버여야 한다.
    if (!checkHost(req, res, allowedHosts)) return;
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
    checkApiRequest(req, { allowedOrigins, token: sessionToken, mismatchMessage: '세션이 맞지 않습니다. 터미널에서 ui 명령을 다시 실행해 새로 열어 주세요.' });

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, '없는 API입니다.');
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    sendJson(res, 200, await route(body));
  }

  const launchUrl = `http://127.0.0.1:${actualPort}/#token=${sessionToken}`;
  emitUrl(launchUrl, 'ui');
  return {
    port: actualPort,
    url: launchUrl,
    close: () => new Promise((r) => server.close(r)),
    // 테스트용
    _state: svc.state,
  };
}
