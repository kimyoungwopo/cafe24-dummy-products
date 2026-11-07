import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { TOKEN_FILE, SCOPES, writeFileAtomic } from './config.js';
import { askHidden } from './prompt.js';

const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 카페24 Access Token 유효시간 2시간
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전에 미리 갱신
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000; // 로그인 시도 하나는 10분 동안만 받는다

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
    // 파싱 오류 문구에는 파일 내용(토큰 일부)이 섞일 수 있어 그대로 보여 주지 않는다.
    const why = e instanceof SyntaxError ? '내용이 깨져 있음' : e.code || '읽기 실패';
    throw new AuthError(`토큰 파일을 읽을 수 없습니다 (${why}): ${TOKEN_FILE}\n파일을 지우고 \`login\`을 다시 실행하세요.`);
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
  // 처음 설치해서 폴더가 없어도 저장되도록 만들고, 쓰다가 멈춰도 기존 파일이 깨지지 않게 임시 파일 → rename.
  // (카페24는 갱신할 때마다 refresh token을 새로 주므로 파일이 깨지면 다시 로그인해야 한다)
  try {
    writeFileAtomic(TOKEN_FILE, JSON.stringify(token, null, 2), '토큰');
  } catch (e) {
    throw new AuthError(e.message);
  }
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
      headers: { Authorization: basicAuth(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30000),
      redirect: 'error', // 리다이렉트를 따라가면 코드·토큰이 다른 서버로 갈 수 있으므로 따라가지 않는다
    });
  } catch {
    throw new AuthError('토큰 서버에 연결하지 못했습니다 (네트워크 오류 또는 예상하지 못한 리다이렉트).');
  }
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = {};
  }
  if (res.ok && !isCompleteTokenResponse(body)) {
    // 성공 응답이라도 필요한 값이 빠져 있으면 저장하지 않는다 (기존 refresh token을 잃지 않도록).
    throw new AuthError(
      '토큰 서버 응답에 필요한 값이 빠져 있어 저장하지 않았습니다. 내 컴퓨터의 토큰 파일은 바꾸지 않았지만, ' +
        '서버에서 이전 refresh token이 아직 유효한지는 알 수 없습니다. 문제가 계속되면 `login`을 다시 하세요.',
    );
  }
  if (!res.ok) {
    // 서버가 준 오류 문구는 그대로 보여 주지 않는다 (코드·토큰이 섞여 있을 수 있음). 알려진 오류 코드만 정해진 문구로.
    const code = typeof body.error === 'string' ? body.error : '';
    throw new AuthError(`토큰 발급 실패 (HTTP ${res.status}): ${TOKEN_ERRORS[code] || '카페24가 요청을 거부했습니다. 설정과 앱 권한을 확인하세요.'}`);
  }
  return saveToken(body, cfg.mallId);
}

// 토큰은 최소 8자 이상이어야 정상으로 본다 (너무 짧은 값은 응답 이상으로 보고 저장하지 않음)
const isCompleteTokenResponse = (b) =>
  typeof b?.access_token === 'string' && b.access_token.length >= 8 && typeof b.refresh_token === 'string' && b.refresh_token.length >= 8;

const TOKEN_ERRORS = {
  invalid_grant: '인증 코드나 refresh token이 만료됐거나 이미 사용됐습니다. 다시 로그인하세요 (인증 코드는 1분 안에, 한 번만).',
  invalid_client: 'Client ID 또는 Client Secret이 올바르지 않습니다. `setup`으로 다시 입력하세요.',
  invalid_request: '요청 값이 올바르지 않습니다. Redirect URI가 개발자센터 설정과 같은지 확인하세요.',
  unauthorized_client: '이 앱으로는 허용되지 않은 요청입니다. 개발자센터 앱 설정을 확인하세요.',
};

export function buildAuthorizeUrl(cfg, state) {
  const url = new URL(`${cfg.apiBase}/api/v2/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  return url.toString();
}

export function openBrowser(url) {
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

// ---------------------------------------------------------------- 로그인 시도

// 진행 중인 로그인 시도는 항상 하나뿐이다. 새로 시작하면 이전 시도는 끝난다.
let activeAttempt = null;

/** 로그인 1단계: 이번 시도 하나에만 쓰는 state와 승인 주소를 만든다 (10분 뒤 만료, 한 번만 사용, 새 시도가 시작되면 무효). */
export function startLogin(cfg, { now = Date.now() } = {}) {
  const state = crypto.randomBytes(16).toString('hex');
  activeAttempt = { state, url: buildAuthorizeUrl(cfg, state), expiresAt: now + LOGIN_ATTEMPT_TTL_MS, used: false, redirectUri: cfg.redirectUri };
  return activeAttempt;
}

const sameTarget = (a, b) => a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');

/**
 * 붙여넣은 리다이렉트 URL에서 code를 꺼낸다. 오류 메시지에 붙여넣은 값(코드 포함)을 다시 보여 주지 않는다.
 * - 주소창의 URL 전체만 받는다 (code 값만 붙여넣는 방식은 state를 확인할 수 없어 받지 않음)
 * - Redirect URI와 같은 주소여야 하고, 이번 시도의 state와 같아야 하며, 만료·재사용되지 않아야 한다
 */
export function parseRedirect(input, attempt, { now = Date.now() } = {}) {
  if (!attempt) throw new Error('진행 중인 로그인 시도가 없습니다. 로그인을 처음부터 다시 시작하세요.');
  if (attempt.used) throw new Error('이미 처리한 로그인 시도입니다. 다시 로그인하려면 처음부터 시작하세요.');
  if (attempt !== activeAttempt) throw new Error('새 로그인 시도가 시작돼서 이 시도는 끝났습니다. 가장 최근에 연 승인 창의 URL을 쓰세요.');
  if (now > attempt.expiresAt) throw new Error('로그인 시도가 만료됐습니다(10분). 로그인을 처음부터 다시 시작하세요.');
  const value = String(input ?? '').trim();
  if (!value) throw new Error('입력이 비어 있습니다.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('승인 후 이동한 페이지의 주소창 URL 전체를 붙여넣어 주세요 (https://로 시작).');
  }
  if (!sameTarget(url, new URL(attempt.redirectUri))) {
    throw new Error('설정한 Redirect URI와 다른 주소입니다. 방금 승인한 창의 주소창 URL인지 확인하세요.');
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error('카페24에서 승인이 거부되었거나 취소됐습니다. 앱 권한과 로그인한 계정을 확인하세요.');
  const state = url.searchParams.get('state');
  if (!state || state !== attempt.state) {
    throw new Error('지금 로그인 시도의 URL이 아닙니다 (state 불일치). 예전에 연 창이 아니라, 방금 연 승인 창의 URL을 붙여넣으세요.');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('URL에 인증 코드가 없습니다. 승인을 끝까지 진행한 뒤의 주소인지 확인하세요.');
  return code;
}

/** 로그인 2단계: 리다이렉트 URL로 토큰을 받아 저장한다. 성공하든 실패하든 이 시도는 다시 쓸 수 없다. */
export async function completeLogin(cfg, input, attempt, opts = {}) {
  const code = parseRedirect(input, attempt, opts);
  attempt.used = true; // 코드는 한 번만 쓸 수 있으므로, 토큰 요청을 보내는 순간 시도를 닫는다
  return requestToken(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
}

export async function login(cfg) {
  const attempt = startLogin(cfg);
  console.log('\n1) 브라우저에서 카페24 관리자로 로그인하고 앱 권한을 승인하세요.');
  console.log('   브라우저가 열리지 않으면 아래 주소를 직접 여세요:\n');
  console.log('   ' + attempt.url + '\n');
  console.log('2) 승인 후 이동한 페이지의 주소창 URL 전체를 복사해 아래에 붙여넣고 Enter.');
  console.log('   붙여넣은 내용(인증 코드 포함)은 화면에 표시되지 않습니다. (인증 코드는 1분, 이 로그인 시도는 10분 동안 유효)\n');
  openBrowser(attempt.url);

  for (let tries = 0; tries < 3; tries++) {
    const input = await askHidden('리다이렉트된 URL 붙여넣기: ');
    if (!input) throw new Error('입력이 없어 로그인을 취소했습니다.');
    try {
      parseRedirect(input, attempt); // 형식·state·만료를 먼저 확인 (틀리면 다시 붙여넣을 수 있게)
    } catch (e) {
      console.log(`⚠️  ${e.message}`);
      if (attempt.used || Date.now() > attempt.expiresAt) throw e;
      continue;
    }
    const token = await completeLogin(cfg, input, attempt);
    console.log(`\n✅ 로그인 완료 (mall: ${token.mall_id}, 권한: ${(token.scopes || []).join(', ')})`);
    return token;
  }
  throw new Error('세 번 모두 올바른 URL이 아니어서 로그인을 취소했습니다. 처음부터 다시 시작하세요.');
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
    throw new AuthError(`저장된 로그인은 ${token.mall_id} 쇼핑몰용입니다. 지금 설정(${cfg.mallId})으로 다시 login 하세요.`);
  }
  if (forceRefresh || !token.access_expires_ms || Date.now() > token.access_expires_ms - REFRESH_MARGIN_MS) {
    token = await refresh(cfg, token);
  }
  return token.access_token;
}
