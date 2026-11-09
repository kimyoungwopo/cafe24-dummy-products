import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR } from './config.js';
import { openBrowser } from './auth.js';
import { CSP, HttpError, baseHeaders, sendJson, readJsonBody, listenLoopback, checkHost, checkApiRequest, emitUrl } from './http-guard.js';
import { ServiceError } from './service.js';

/**
 * MCP 정리 확인 화면.
 *
 * AI(모델)가 정리 계획과 실행을 연달아 호출해도, 사람이 이 화면에서 직접 승인하기 전에는 지우지 않는다.
 * - 계획마다 따로 만든 무작위 확인 토큰을 URL의 # 뒤로만 넘긴다 (MCP 결과·로그에는 넣지 않음).
 * - 이 컴퓨터(127.0.0.1)에서만 열리고, UI 서버와 같은 Host·Origin·JSON·CSP 검사를 한다.
 * - 승인은 "되돌릴 수 없다" 확인이 있어야 하고, 한 계획에 한 번만 결정할 수 있다 (거절하면 계획은 버림).
 * 같은 사용자 계정으로 실행 중인 다른 프로그램(악성코드 등)까지 막지는 못한다.
 */

const UI_DIR = path.join(ROOT_DIR, 'ui');
const STATIC = {
  '/': ['confirm.html', 'text/html; charset=utf-8'],
  '/confirm.js': ['confirm.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

/** @param {{ now?: () => number }} [opts] now: 시계 (테스트에서 바꿀 수 있게) */
export function createConfirmServer(svc, { now = () => Date.now() } = {}) {
  let server = null;
  let ready = null;
  let hosts;
  /** 확인 토큰 → { planId, openedAt } (결정하거나 만료되면 지움) */
  const tokens = new Map();
  const REOPEN_AFTER_MS = 3 * 60 * 1000;

  async function ensureStarted() {
    if (ready) return ready;
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        if (res.headersSent) return res.end();
        if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
        if (e instanceof ServiceError) return sendJson(res, e.kind === 'notFound' ? 404 : 400, { error: e.message });
        sendJson(res, 400, { error: String(e?.message || '처리 중 오류가 났습니다.') });
      });
    });
    ready = listenLoopback(server, 0).then(
      (h) => {
        hosts = h;
        return h;
      },
      (e) => {
        ready = null; // 시작에 실패하면 다음 요청에서 다시 시도할 수 있게
        server = null;
        throw e;
      },
    );
    return ready;
  }

  /** 이미 결정됐거나 만료·삭제된 계획의 주소를 모두 지운다 */
  function sweep() {
    for (const [t, v] of tokens) {
      const entry = svc.livePlan(v.planId);
      if (!entry || entry.approval !== 'pending') tokens.delete(t);
    }
  }

  function planFor(req) {
    sweep();
    const token = String(req.headers['x-confirm-token'] || '');
    const planId = token && tokens.get(token)?.planId;
    const entry = planId && svc.livePlan(planId);
    if (!entry || entry.approval !== 'pending') {
      if (token) tokens.delete(token);
      throw new HttpError(404, '확인할 정리 계획이 없거나 이미 결정됐거나 만료됐습니다. AI에게 정리 계획을 다시 만들어 달라고 하세요.');
    }
    return { token, planId, entry };
  }

  async function handle(req, res) {
    if (!checkHost(req, res, hosts.allowedHosts)) return;
    const url = new URL(req.url, `http://127.0.0.1:${hosts.port}`);
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Content-Security-Policy': CSP }));
      return res.end(fs.readFileSync(path.join(UI_DIR, file)));
    }
    if (url.pathname !== '/api/confirm') {
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      return res.end('Not Found');
    }
    // 토큰 값 비교는 맵 조회로 한다 (토큰마다 계획이 다르므로). 출처 검사는 UI 서버와 같다.
    checkApiRequest(req, { allowedOrigins: hosts.allowedOrigins, token: String(req.headers['x-confirm-token'] || ''), header: 'x-confirm-token', mismatchMessage: '' });
    if (req.method === 'GET') {
      const { entry } = planFor(req);
      return sendJson(res, 200, { plan: entry.view });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { token, planId } = planFor(req);
      if (body.decision === 'approve') {
        if (body.irreversible !== true) throw new HttpError(400, '"되돌릴 수 없다"에 체크해야 승인할 수 있습니다.');
      } else if (body.decision !== 'reject') {
        throw new HttpError(400, '승인 또는 거절만 할 수 있습니다.');
      }
      svc.decideCleanupPlan(planId, body.decision);
      forget(planId); // 한 번 결정하면 이 계획의 모든 주소는 더 쓸 수 없다
      return sendJson(res, 200, { decision: body.decision });
    }
    throw new HttpError(405, '허용되지 않는 요청입니다.');
  }

  /**
   * 이 계획의 확인 화면을 연다 (이미 열려 있으면 다시 열지 않음). 주소는 브라우저에만 넘기고 어디에도 출력하지 않는다.
   * @returns {Promise<'opened'|'already-open'>}
   */
  // 같은 계획에 동시에 요청이 와도 확인 주소(토큰)는 하나만 만든다
  let chain = Promise.resolve();
  const openFor = (planId) => {
    const run = chain.then(() => openForNow(planId));
    chain = run.catch(() => {});
    return run;
  };

  async function openForNow(planId) {
    sweep();
    // 최근 3분 안에 열었으면 다시 열지 않는다. 그보다 오래됐으면(창을 닫았거나 못 열었을 수 있음) 새 주소로 다시 연다.
    // 이전 주소도 계획이 결정되기 전까지는 그대로 쓸 수 있다 (읽는 중에 무효가 되지 않도록). 승인은 계획당 한 번만 된다.
    const opened = [...tokens.values()].filter((v) => v.planId === planId);
    if (opened.some((v) => now() - v.openedAt < REOPEN_AFTER_MS)) return 'already-open';
    const { port } = await ensureStarted();
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { planId, openedAt: now() });
    const url = `http://127.0.0.1:${port}/#t=${token}`;
    if (!emitUrl(url, 'confirm')) openBrowser(url);
    return 'opened';
  }

  /** 다시 열기 (사용자가 창을 닫았을 때): 이전 주소는 무효 */
  function forget(planId) {
    for (const [t, v] of tokens) if (v.planId === planId) tokens.delete(t);
  }

  /** 테스트용: 살아 있는 확인 주소 수 */
  const _tokenCount = () => tokens.size;

  const close = () => (server ? new Promise((r) => server.close(() => r())) : Promise.resolve());
  return { openFor, forget, close, _tokenCount };
}
