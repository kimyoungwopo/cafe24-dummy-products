import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 설정·토큰·로그를 두는 폴더.
 * - CAFE24_HOME 환경변수가 있으면 그 폴더
 * - 예전처럼 도구 폴더에 .env가 있으면 도구 폴더 (기존 사용자 호환)
 * - 그 외에는 ~/.config/cafe24-dummy (npx로 실행해도 설정이 남도록)
 */
export const DATA_DIR =
  process.env.CAFE24_HOME ||
  (fs.existsSync(path.join(ROOT_DIR, '.env')) ? ROOT_DIR : path.join(os.homedir(), '.config', 'cafe24-dummy'));
export const ENV_FILE = process.env.CAFE24_ENV_FILE || path.join(DATA_DIR, '.env');
export const TOKEN_FILE = process.env.CAFE24_TOKEN_FILE || path.join(DATA_DIR, '.cafe24-token.json');
export const LOG_DIR = process.env.CAFE24_LOG_DIR || path.join(DATA_DIR, 'logs');

// 더미 상품 식별용 자체상품코드 접두어. 삭제는 이 접두어가 붙은 상품만 대상으로 한다.
export const DUMMY_CODE_PREFIX = 'DUMMY-';

export const SCOPES = [
  'mall.read_product',
  'mall.write_product',
  'mall.read_category',
  'mall.read_community', // 상품후기 (게시판)
  'mall.write_community',
];

// 더미 후기 식별: 제목 접두어 + 정해진 작성자 이름 두 조건이 모두 맞아야 지운다.
export const DUMMY_REVIEW_PREFIX = '[더미] ';

/** .env 파일을 읽어 process.env에 없는 값만 채운다 (외부 의존성 없이). */
export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getConfig({ requireOAuth = true } = {}) {
  loadEnvFile();
  const cfg = {
    mallId: process.env.CAFE24_MALL_ID || '',
    clientId: process.env.CAFE24_CLIENT_ID || '',
    clientSecret: process.env.CAFE24_CLIENT_SECRET || '',
    redirectUri: process.env.CAFE24_REDIRECT_URI || '',
    shopNo: Number(process.env.CAFE24_SHOP_NO || 1),
    apiVersion: process.env.CAFE24_API_VERSION || '',
    // 테스트용: 목 서버 등 다른 주소로 보낼 때만 사용
    apiBase: process.env.CAFE24_API_BASE || '',
  };
  if (!cfg.apiBase && cfg.mallId) cfg.apiBase = `https://${cfg.mallId}.cafe24api.com`;
  if (!Number.isInteger(cfg.shopNo) || cfg.shopNo < 1) {
    throw new Error(`CAFE24_SHOP_NO는 1 이상의 정수여야 합니다: "${process.env.CAFE24_SHOP_NO}"`);
  }

  if (requireOAuth) {
    const missing = [
      ['CAFE24_MALL_ID', cfg.mallId],
      ['CAFE24_CLIENT_ID', cfg.clientId],
      ['CAFE24_CLIENT_SECRET', cfg.clientSecret],
      ['CAFE24_REDIRECT_URI', cfg.redirectUri],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `설정에 다음 값이 비어 있습니다: ${missing.join(', ')}\n` +
          `${ENV_FILE} 파일을 만들고 채워 주세요 (.env.example 참고).`,
      );
    }
  }
  return cfg;
}
