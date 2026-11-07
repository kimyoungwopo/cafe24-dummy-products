import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { isDummyCode } from './dummy.js';

/**
 * 소유 기록 (ownership manifest)
 *
 * 이 도구가 "확실히 만들었다"고 확인한 것만 기록한다. 삭제는 이 기록에 있고,
 * 지우기 직전에 현재 상태를 다시 확인해서 기록과 일치하는 것만 한다.
 *
 * - 쇼핑몰(mall) + 멀티쇼핑몰 번호(shop)별로 파일을 나눈다: owned/<mall>-shop<shop>.jsonl
 * - 줄 단위 추가 전용(JSONL) + 매 줄 fsync → 중간에 죽어도 이미 쓴 기록은 남는다
 * - 결과를 알 수 없는 요청(응답 유실 등)은 'unknown'으로 남기고 자동 삭제 대상에서 뺀다
 */

export const MANIFEST_VERSION = 1;
// 호출할 때마다 계산한다 (테스트 등에서 환경변수로 위치를 바꿀 수 있도록).
const ownedDir = () => process.env.CAFE24_OWNED_DIR || path.join(DATA_DIR, 'owned');

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const MALL_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

const SCHEMAS = {
  product: {
    created: (r) => isPosInt(r.product_no) && isDummyCode(r.code, r.runId),
    unknown: (r) => isDummyCode(r.code, r.runId),
    deleted: (r) => isPosInt(r.product_no),
  },
  main: {
    added: (r) => isPosInt(r.display_group) && isPosInt(r.product_no),
    unknown: (r) => isPosInt(r.display_group) && Array.isArray(r.product_nos) && r.product_nos.every(isPosInt),
    removed: (r) => isPosInt(r.display_group) && isPosInt(r.product_no),
  },
  review: {
    // 도구가 만든 후기는 지울 때 정확히 비교할 수 있도록 제목·작성자를 함께 기록한다.
    created: (r) =>
      isPosInt(r.board_no) &&
      isPosInt(r.article_no) &&
      isPosInt(r.product_no) &&
      (r.source === 'legacy-log' || (typeof r.title === 'string' && typeof r.writer === 'string' && /^[0-9a-f]{64}$/.test(r.content_sha256 || ''))),
    unknown: (r) => isPosInt(r.board_no) && Array.isArray(r.product_nos) && r.product_nos.every(isPosInt),
    deleted: (r) => isPosInt(r.board_no) && isPosInt(r.article_no),
  },
};

function validate(rec, mall, shop) {
  if (!rec || rec.v !== MANIFEST_VERSION) return false;
  if (rec.mall !== mall || rec.shop !== shop) return false; // 다른 쇼핑몰 기록은 절대 섞지 않는다
  const check = SCHEMAS[rec.kind]?.[rec.event];
  return Boolean(check && check(rec));
}

export function manifestPath(mall, shop) {
  return path.join(ownedDir(), `${mall}-shop${shop}.jsonl`);
}

export class Manifest {
  constructor(mall, shop) {
    if (!MALL_RE.test(String(mall))) throw new Error(`쇼핑몰 ID가 올바르지 않습니다: ${mall}`);
    if (!isPosInt(shop)) throw new Error(`멀티쇼핑몰 번호가 올바르지 않습니다: ${shop}`);
    this.mall = mall;
    this.shop = shop;
    this.file = manifestPath(mall, shop);
  }

  /**
   * 카페24에 무언가를 만들기 전에 부른다. 기록 파일을 읽고 쓸 수 없으면 여기서 멈춰서,
   * "만들었는데 기록은 못 남긴" 데이터가 생기지 않게 한다.
   */
  ensureWritable() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(this.file, 'a+', 0o600));
    } catch (e) {
      throw new Error(`소유 기록 파일을 읽고 쓸 수 없어 작업을 시작하지 않았습니다: ${this.file} (${e.code || e.message})`);
    }
  }

  /** 기록 한 줄 추가. 검증에 실패하면 쓰지 않고 오류를 낸다. 쓰기에 실패하면 어떤 기록이었는지(ID 포함) 오류에 담는다. */
  append(kind, event, fields) {
    const rec = { v: MANIFEST_VERSION, ts: new Date().toISOString(), mall: this.mall, shop: this.shop, kind, event, ...fields };
    if (!validate(rec, this.mall, this.shop)) throw new Error(`소유 기록 형식 오류: ${kind}/${event} ${JSON.stringify(fields)}`);
    try {
      this.#write(rec);
    } catch (e) {
      const err = new Error(
        `🚨 카페24 작업은 끝났지만 소유 기록을 쓰지 못해 작업을 멈춥니다 (${e.code || e.message}).\n` +
          `   기록하지 못한 항목: ${kind}/${event} ${JSON.stringify(fields)}\n` +
          `   이 항목은 자동 정리 대상이 아니니 카페24 관리자에서 직접 확인해 주세요. 기록 파일: ${this.file}`,
      );
      err.manifestWrite = true;
      throw err;
    }
    return rec;
  }

  #write(rec) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.file, 'a+', 0o600);
    try {
      // 마지막 줄이 줄바꿈 없이 끝나 있으면(중간에 끊긴 쓰기, 손으로 고친 파일 등) 새 기록이 그 줄에 붙어
      // 둘 다 읽을 수 없게 되므로, 먼저 줄을 끊어 둔다. 끊긴 앞줄은 읽을 때 "읽을 수 없는 줄"로 따로 보고된다.
      const { size } = fs.fstatSync(fd);
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) fs.writeSync(fd, '\n');
      }
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 기록을 읽어 현재 소유 상태를 만든다. 깨지거나 다른 쇼핑몰 줄은 세기만 하고 쓰지 않는다. */
  load() {
    const state = {
      products: new Map(), // product_no → { code, runId, source }
      mains: new Map(), // "group:product" → { display_group, product_no, runId }
      reviews: new Map(), // "board:article" → { board_no, article_no, product_no, runId }
      unknown: [], // 결과를 알 수 없는 요청들 (자동 삭제 안 함)
      deletedProducts: new Set(), // 이 도구가 지웠거나 없음을 확인해 기록에서 정리한 상품 (명시적 증거)
      legacy: [], // 예전 버전 로그에서 가져온 기록 — 쇼핑몰/멀티쇼핑몰 출처를 증명할 수 없어 소유로 인정하지 않음
      invalidLines: 0,
    };
    if (!fs.existsSync(this.file)) return state;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        state.invalidLines++;
        continue;
      }
      if (!validate(rec, this.mall, this.shop)) {
        state.invalidLines++;
        continue;
      }
      const { kind, event } = rec;
      if (rec.source === 'legacy-log') {
        state.legacy.push(rec);
      } else if (event === 'unknown') {
        state.unknown.push(rec);
      } else if (kind === 'product') {
        if (event === 'created') {
          state.products.set(rec.product_no, { product_no: rec.product_no, code: rec.code, runId: rec.runId });
          state.deletedProducts.delete(rec.product_no);
        } else {
          state.products.delete(rec.product_no);
          state.deletedProducts.add(rec.product_no);
        }
      } else if (kind === 'main') {
        const key = `${rec.display_group}:${rec.product_no}`;
        if (event === 'added') state.mains.set(key, { display_group: rec.display_group, product_no: rec.product_no, runId: rec.runId });
        else state.mains.delete(key);
      } else if (kind === 'review') {
        const key = `${rec.board_no}:${rec.article_no}`;
        if (event === 'created') {
          state.reviews.set(key, {
            board_no: rec.board_no,
            article_no: rec.article_no,
            product_no: rec.product_no,
            title: rec.title,
            writer: rec.writer,
            content_sha256: rec.content_sha256,
            runId: rec.runId,
          });
        }
        else state.reviews.delete(key);
      }
    }
    return state;
  }
}
