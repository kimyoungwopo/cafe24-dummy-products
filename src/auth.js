import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { TOKEN_FILE, SCOPES } from './config.js';
import { ask } from './prompt.js';

const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 카페24 Access Token 유효시간 2시간
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전에 미리 갱신

/** 인증 실패(로그인 필요, 토큰 갱신 실패 등). 일괄 작업은 이 오류가 나면 즉시 멈춘다. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
    this.isAuthError = true;
  }
}

export function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    throw new AuthError(`토큰 파일을 읽을 수 없습니다 (${TOKEN_FILE}): ${e.message}\n파일을 지우고 \`login\`을 다시 실행하세요.`);
  }
}

function saveToken(data, mallId) {
  const token = {
    mall_id: data.mall_id || mallId,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scopes: data.scopes,
    shop_no: data.shop_no,
    // 카페24 응답의 expires_at은 시간대 표기가 없어서, 받은 시각 기준으로 직접 계산한다.
    access_expires_ms: Date.now() + ACCESS_TOKEN_TTL_MS,
    refresh_token_expires_at: data.refresh_token_expires_at,
    obtained_at: new Date().toISOString(),
  };
  // 카페24는 갱신할 때마다 refresh token을 새로 발급하므로, 쓰다가 죽어도 기존 파일이 깨지지 않게 임시 파일 → rename.
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, TOKEN_FILE);
  return token;
}

function basicAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

async function requestToken(cfg, params) {
  let res;
  try {
    res = await fetch(`${cfg.apiBase}/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(cfg),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new AuthError(`토큰 서버 연결 실패: ${e.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok || !body.access_token) {
    const msg = body.error_description || body.error?.message || body.error || body.raw || res.statusText;
    throw new AuthError(`토큰 발급 실패 (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return saveToken(body, cfg.mallId);
}

export function buildAuthorizeUrl(cfg, state) {
  const url = new URL(`${cfg.apiBase}/api/v2/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  return url.toString();
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 브라우저를 못 열어도 URL을 직접 열면 된다 */
  }
}

/** 붙여넣은 값(리다이렉트된 URL 전체 또는 code 값)에서 code를 꺼낸다. */
export function parseCodeInput(input, expectedState) {
  const value = input.trim();
  if (!value) throw new Error('입력이 비어 있습니다.');
  if (!/^https?:\/\//i.test(value)) return value; // code만 붙여넣은 경우
  const url = new URL(value);
  const error = url.searchParams.get('error');
  if (error) throw new Error(`카페24 인증 오류: ${error} ${url.searchParams.get('error_description') || ''}`.trim());
  const code = url.searchParams.get('code');
  if (!code) throw new Error('URL에 code 파라미터가 없습니다. 리다이렉트된 주소창의 URL 전체를 붙여넣어 주세요.');
  const state = url.searchParams.get('state');
  if (expectedState && state !== expectedState) {
    throw new Error('state 값이 일치하지 않습니다. login을 다시 실행해 주세요.');
  }
  return code;
}

export async function login(cfg) {
  const state = crypto.randomBytes(16).toString('hex');
  const url = buildAuthorizeUrl(cfg, state);
  console.log('\n1) 브라우저에서 카페24 관리자로 로그인하고 앱 권한을 승인하세요.');
  console.log('   브라우저가 열리지 않으면 아래 주소를 직접 여세요:\n');
  console.log('   ' + url + '\n');
  console.log('2) 승인 후 Redirect URI로 이동하면, 페이지가 안 열리더라도 주소창의 URL 전체를 복사하세요.');
  console.log('   (인증 코드는 1분 동안만 유효합니다)\n');
  openBrowser(url);
  const input = await ask('리다이렉트된 URL 붙여넣기: ');
  const code = parseCodeInput(input, state);
  const token = await requestToken(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  console.log(`\n✅ 로그인 완료 (mall: ${token.mall_id}, 권한: ${(token.scopes || []).join(', ')})`);
  return token;
}

export async function refresh(cfg, token) {
  if (!token?.refresh_token) throw new AuthError('저장된 refresh token이 없습니다. `login`을 먼저 실행하세요.');
  try {
    return await requestToken(cfg, { grant_type: 'refresh_token', refresh_token: token.refresh_token });
  } catch (e) {
    throw new AuthError(`${e.message}\nrefresh token이 만료됐을 수 있습니다(2주). \`login\`을 다시 실행하세요.`);
  }
}

/** 유효한 access token을 돌려준다. 만료가 가까우면 자동 갱신한다. */
export async function getAccessToken(cfg, { forceRefresh = false } = {}) {
  let token = readToken();
  if (!token) throw new AuthError('로그인 정보가 없습니다. 먼저 `login` 명령을 실행하세요.');
  if (token.mall_id && cfg.mallId && token.mall_id !== cfg.mallId) {
    throw new AuthError(`저장된 토큰은 ${token.mall_id} 쇼핑몰용입니다. .env의 CAFE24_MALL_ID(${cfg.mallId})로 다시 login 하세요.`);
  }
  if (forceRefresh || !token.access_expires_ms || Date.now() > token.access_expires_ms - REFRESH_MARGIN_MS) {
    token = await refresh(cfg, token);
  }
  return token.access_token;
}
