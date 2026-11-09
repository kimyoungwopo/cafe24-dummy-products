import crypto from 'node:crypto';

/**
 * 로컬 화면 서버들(UI, MCP 정리 확인 화면)이 함께 쓰는 보안 도우미.
 * - Host가 정확히 이 서버여야 한다 (DNS 리바인딩 방지).
 * - 브라우저가 보낸 Origin·Sec-Fetch-Site가 같은 출처가 아니면 거부한다. CORS 헤더는 보내지 않는다.
 * - POST는 application/json만, 본문 64KB까지.
 * - 화면은 외부 자원 없이, 엄격한 CSP로만 제공한다.
 */

export const MAX_BODY = 64 * 1024;
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function baseHeaders(extra = {}) {
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

export function sendJson(res, status, body) {
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req) {
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

/** 127.0.0.1의 빈 포트에 연다. 허용할 Host·Origin 목록을 함께 돌려준다. */
export async function listenLoopback(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  return {
    port: actual,
    allowedHosts: new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]),
    allowedOrigins: new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]),
  };
}

/** Host가 맞지 않으면 421로 끝낸다. 계속 처리해도 되면 true. */
export function checkHost(req, res, allowedHosts) {
  if (allowedHosts.has(String(req.headers.host || ''))) return true;
  res.writeHead(421, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('Misdirected Request');
  return false;
}

/** API 요청: 같은 출처이고 세션 토큰이 맞아야 한다. */
export function checkApiRequest(req, { allowedOrigins, token, header = 'x-session-token', mismatchMessage }) {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, '허용되지 않은 출처의 요청입니다.');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') throw new HttpError(403, '허용되지 않은 출처의 요청입니다.');
  if (!sameToken(req.headers[header], token)) throw new HttpError(401, mismatchMessage);
}

let urlSink = null;
/** 테스트 전용: 토큰이 든 접속 주소를 코드에서만 받는다 (test/run-cli.js). 실제 실행에서는 주소를 어디에도 출력하지 않는다. */
export function __setUrlSink(fn) {
  urlSink = fn;
}
/** 접속 주소를 테스트 수신기에 넘긴다. 수신기가 있으면 true (그때는 브라우저를 열지 않는다). */
export function emitUrl(url, kind = 'ui') {
  if (!urlSink) return false;
  urlSink(url, kind);
  return true;
}
