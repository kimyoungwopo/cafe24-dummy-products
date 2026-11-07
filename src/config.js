import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN_FILE = process.env.CAFE24_TOKEN_FILE || path.join(ROOT_DIR, '.cafe24-token.json');
export const LOG_DIR = process.env.CAFE24_LOG_DIR || path.join(ROOT_DIR, 'logs');

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
export function loadEnvFile(file = process.env.CAFE24_ENV_FILE || path.join(ROOT_DIR, '.env')) {
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
      throw new Error(`.env에 다음 값이 비어 있습니다: ${missing.join(', ')}\n.env.example을 복사해 .env를 만들고 채워 주세요.`);
    }
  }
  return cfg;
}
