import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 설정·토큰·기록을 두는 폴더. 우선순위:
 * 1. CAFE24_HOME 환경변수
 * 2. 도구 폴더에 .env가 있으면 도구 폴더 (v0.1.0 사용자 호환 — 자동으로 옮기거나 덮어쓰지 않음)
 * 3. ~/.config/cafe24-dummy (npx로 실행해도 설정이 남도록)
 */
export function resolveDataDir({ env = process.env, rootDir = ROOT_DIR, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.CAFE24_HOME) return { dir: path.resolve(env.CAFE24_HOME), source: 'CAFE24_HOME 환경변수' };
  if (exists(path.join(rootDir, '.env'))) return { dir: rootDir, source: '도구 폴더 (예전 버전 호환)' };
  return { dir: path.join(homeDir, '.config', 'cafe24-dummy'), source: '사용자 폴더 기본 위치' };
}

const resolved = resolveDataDir();
export const DATA_DIR = resolved.dir;
export const DATA_DIR_SOURCE = resolved.source;
const fromEnv = (name, fallback) => (process.env[name] ? path.resolve(process.env[name]) : fallback);
export const ENV_FILE = fromEnv('CAFE24_ENV_FILE', path.join(DATA_DIR, '.env'));
export const TOKEN_FILE = fromEnv('CAFE24_TOKEN_FILE', path.join(DATA_DIR, '.cafe24-token.json'));
export const LOG_DIR = fromEnv('CAFE24_LOG_DIR', path.join(DATA_DIR, 'logs'));

export const NPX_CMD = 'npx github:kimyoungwopo/cafe24-dummy-products';
/**
 * 안내 문구에 보여 줄 실행 명령. 사용자가 실제로 실행한 방식과 같게 보여 준다.
 * npx로 실행 → npx 명령 / 전역 설치(cafe24-dummy) → cafe24-dummy / 소스 폴더에서 실행 → node src/cli.js
 */
export function commandName(script = process.argv[1] || '', cwd = process.cwd()) {
  if (/[\\/]_npx[\\/]/.test(script)) return NPX_CMD;
  if (path.basename(script) === 'cafe24-dummy') return 'cafe24-dummy';
  const rel = path.relative(cwd, script);
  if (!script || !/\.js$/.test(script)) return 'cafe24-dummy';
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : script;
  // 그대로 복사해 붙여도 안전하도록, 일반 문자가 아닌 것이 있으면 작은따옴표로 감싼다
  return `node ${/^[\w./@-]+$/.test(shown) ? shown : `'${shown.replace(/'/g, `'\\''`)}'`}`;
}
export const CMD = commandName();

// 더미 상품 식별용 자체상품코드 접두어
export const DUMMY_CODE_PREFIX = 'DUMMY-';

export const SCOPES = [
  'mall.read_product',
  'mall.write_product',
  'mall.read_category',
  'mall.read_community', // 상품후기 (게시판)
  'mall.write_community',
];

// 더미 후기 제목 접두어
export const DUMMY_REVIEW_PREFIX = '[더미] ';

// ---------------------------------------------------------------- 값 검증

export const MALL_ID_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const TOKENISH_RE = /^[A-Za-z0-9_-]{6,256}$/; // Client ID / Secret: 한 줄, 영문·숫자·_·- 만

const MALL_HELP =
  '쇼핑몰 ID는 쇼핑몰 관리자 주소 https://<쇼핑몰ID>.cafe24.com/admin 의 <쇼핑몰ID>입니다. ' +
  '카페24 개발자센터 계정 ID와 다를 수 있고, 직접 연결한 도메인(예: www.myshop.com)으로는 알 수 없어요.';

/** "myshop", "myshop.cafe24.com", "https://myshop.cafe24.com/admin" → "myshop" */
export function parseMallId(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error(`쇼핑몰 ID가 비어 있습니다. ${MALL_HELP}`);
  let id;
  if (/^[A-Za-z0-9-]+$/.test(s)) {
    id = s.toLowerCase();
  } else {
    let host;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
    } catch {
      throw new Error(`쇼핑몰 주소 형식을 알아볼 수 없습니다. ${MALL_HELP}`);
    }
    const m = /^([a-z0-9-]+)\.cafe24(?:api)?\.com$/.exec(host);
    if (!m) throw new Error(`카페24 주소(…cafe24.com)가 아닙니다: ${host}. ${MALL_HELP}`);
    id = m[1];
  }
  if (!MALL_ID_RE.test(id)) throw new Error(`쇼핑몰 ID 형식이 올바르지 않습니다. ${MALL_HELP}`);
  return id;
}

/** Redirect URI: https, 도메인(IP 불가), #없음. 개발자센터에 등록한 값과 글자 하나까지 같아야 한다. */
export function validateRedirectUri(input) {
  const s = String(input ?? '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Redirect URI가 올바른 주소가 아닙니다. 예: https://myshop.cafe24.com');
  }
  if (u.protocol !== 'https:') throw new Error('Redirect URI는 https 주소여야 합니다 (카페24 정책).');
  if (u.hash) throw new Error('Redirect URI에는 #이 들어갈 수 없습니다.');
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) throw new Error('Redirect URI에 IP 주소는 쓸 수 없습니다 (도메인만 가능).');
  if (/[\r\n\0]/.test(s)) throw new Error('Redirect URI에 줄바꿈을 넣을 수 없습니다.');
  return s;
}

const VALIDATORS = {
  CAFE24_MALL_ID: parseMallId,
  CAFE24_CLIENT_ID: (v) => {
    if (!TOKENISH_RE.test(String(v))) throw new Error('Client ID 형식이 올바르지 않습니다 (영문·숫자·_·- 한 줄).');
    return String(v);
  },
  CAFE24_CLIENT_SECRET: (v) => {
    if (!TOKENISH_RE.test(String(v))) throw new Error('Client Secret 형식이 올바르지 않습니다 (영문·숫자·_·- 한 줄).');
    return String(v);
  },
  CAFE24_REDIRECT_URI: validateRedirectUri,
  CAFE24_SHOP_NO: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('멀티쇼핑몰 번호는 1 이상의 정수여야 합니다.');
    return String(n);
  },
  CAFE24_API_VERSION: (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error('API 버전은 YYYY-MM-DD 형식이어야 합니다.');
    return String(v);
  },
};
export const CONFIG_KEYS = Object.keys(VALIDATORS);

let dnsLookup = (host) => dns.promises.lookup(host);
/** 테스트 전용: DNS 조회를 코드에서만 바꾼다 (test/run-cli.js). */
export function __setDnsLookup(fn) {
  dnsLookup = fn || ((host) => dns.promises.lookup(host));
}

/** 쇼핑몰 ID의 API 주소가 실제로 있는지 DNS로 확인한다. 진단용이며, 실패해도 저장 자체를 막지는 않는다. */
export async function checkMallDns(mallId, { lookup = dnsLookup } = {}) {
  try {
    await lookup(`${mallId}.cafe24api.com`);
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOTFOUND') {
      return { ok: false, kind: 'notfound', message: `"${mallId}" 쇼핑몰을 찾을 수 없습니다 (${mallId}.cafe24api.com 주소가 없음). ${MALL_HELP}` };
    }
    return { ok: false, kind: 'error', message: `쇼핑몰 주소를 확인하지 못했습니다 (${e.code || e.message}). 인터넷 연결을 확인하고 다시 시도하세요.` };
  }
}

// ---------------------------------------------------------------- 읽기

function parseEnvLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 0) {
      out.push({ raw });
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.push({ raw, key: line.slice(0, eq).trim(), value });
  }
  return out;
}

/** 설정 파일에 실제로 적혀 있는 키 목록 (환경변수와 구분할 때 사용). */
export function readEnvFileKeys(file = ENV_FILE) {
  if (!fs.existsSync(file)) return new Set();
  // loadEnvFile과 같은 규칙: 같은 키가 여러 번 있으면 첫 번째 값을 쓴다. 그 값이 비어 있으면 "없음".
  const first = new Map();
  for (const l of parseEnvLines(fs.readFileSync(file, 'utf8'))) if (l.key && !first.has(l.key)) first.set(l.key, l.value);
  return new Set([...first].filter(([, v]) => v).map(([k]) => k));
}

/** 설정 파일을 읽어 process.env에 없는 값만 채운다. 우선순위: 환경변수 > 설정 파일. */
export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const { key, value } of parseEnvLines(fs.readFileSync(file, 'utf8'))) {
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

let testApiBase = null;

/**
 * 테스트 전용: 목 서버 주소를 코드에서만 지정한다 (test/run-cli.js가 사용).
 * 환경변수나 설정 파일로는 켤 수 없어서, 실제 실행에서는 Secret·토큰이 카페24가 아닌 곳으로 가지 않는다.
 */
export function __setTestApiBase(url) {
  if (url === null) {
    testApiBase = null;
    return;
  }
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('테스트 API 주소는 localhost만 쓸 수 있습니다.');
  testApiBase = u.origin;
}

/** 카페24 API 주소: 항상 https://<쇼핑몰ID>.cafe24api.com (테스트 하네스에서만 목 서버) */
export function resolveApiBase(mallId) {
  if (testApiBase) return testApiBase;
  if (!mallId) return '';
  if (!MALL_ID_RE.test(mallId)) throw new Error(`CAFE24_MALL_ID 형식이 올바르지 않습니다. ${MALL_HELP}`);
  return `https://${mallId}.cafe24api.com`;
}

export function getConfig({ requireOAuth = true } = {}) {
  loadEnvFile();
  const cfg = {
    mallId: (process.env.CAFE24_MALL_ID || '').trim().toLowerCase(),
    clientId: process.env.CAFE24_CLIENT_ID || '',
    clientSecret: process.env.CAFE24_CLIENT_SECRET || '',
    redirectUri: process.env.CAFE24_REDIRECT_URI || '',
    shopNo: Number(process.env.CAFE24_SHOP_NO || 1),
    apiVersion: process.env.CAFE24_API_VERSION || '',
  };
  cfg.apiBase = resolveApiBase(cfg.mallId);
  if (!Number.isInteger(cfg.shopNo) || cfg.shopNo < 1) {
    throw new Error(`CAFE24_SHOP_NO는 1 이상의 정수여야 합니다.`);
  }
  if (requireOAuth) {
    const missing = [
      ['쇼핑몰 ID(CAFE24_MALL_ID)', cfg.mallId],
      ['Client ID(CAFE24_CLIENT_ID)', cfg.clientId],
      ['Client Secret(CAFE24_CLIENT_SECRET)', cfg.clientSecret],
      ['Redirect URI(CAFE24_REDIRECT_URI)', cfg.redirectUri],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`설정이 비어 있습니다: ${missing.join(', ')}\n\`${CMD} setup\`으로 입력하세요 (설정 파일: ${ENV_FILE}).`);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------- 저장

/**
 * 설정을 저장한다.
 * - 모든 값을 먼저 검증한다 (줄바꿈 등이 섞이면 저장하지 않음)
 * - 기존 파일의 다른 줄(주석, 모르는 설정)은 그대로 둔다
 * - 임시 파일(0600)에 쓰고 fsync 후 rename → 중간에 실패해도 기존 파일은 그대로
 * - 저장에 성공한 뒤에만 현재 프로세스의 값을 바꾼다
 * 반환값에 비밀값은 담지 않는다.
 */
export function saveConfig(values, { file = ENV_FILE } = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    if (!VALIDATORS[k]) throw new Error(`알 수 없는 설정: ${k}`);
    if (v === undefined || v === null || v === '') continue;
    clean[k] = VALIDATORS[k](v);
  }
  if (!Object.keys(clean).length) return { file, changed: [] };

  const lines = fs.existsSync(file) ? parseEnvLines(fs.readFileSync(file, 'utf8')) : [{ raw: '# cafe24-dummy-products 설정' }];
  const pending = { ...clean };
  const out = lines.map((l) => {
    if (l.key && l.key in pending) {
      const v = pending[l.key];
      delete pending[l.key];
      return `${l.key}=${v}`;
    }
    return l.raw;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`);

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, out.join('\n') + '\n', '설정');
  for (const [k, v] of Object.entries(clean)) process.env[k] = v;
  return { file, changed: Object.keys(clean) };
}

/**
 * 파일을 안전하게 바꾼다: 같은 폴더의 임시 파일에 내용을 끝까지 쓰고(fsync), 권한(600)까지 설정한 뒤
 * 마지막에 rename 한 번으로 교체한다. rename 전에 실패하면 기존 파일은 그대로이고, rename 뒤에는 할 일이 없다.
 */
export function writeFileAtomic(file, content, label = '파일') {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content); // 버퍼 전체를 쓴다 (부분 쓰기 없음)
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 무시 */
      }
    }
    fs.rmSync(tmp, { force: true });
    throw new Error(`${label} 파일 저장에 실패했습니다 (${e.code || e.message}). 기존 ${label} 파일은 바뀌지 않았습니다: ${file}`);
  }
}
