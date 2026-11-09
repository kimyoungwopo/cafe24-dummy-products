// 프리셋 도입 전 패션 결과를 기준으로 저장한다 (한 번만 실행해 fixture를 만든다).
// 이후 테스트는 프리셋 생략/fashion 명시 결과가 이 값과 정확히 같은지 비교한다.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { buildDummyProduct } from '../../src/dummy.js';
import { buildReviews } from '../../src/review.js';
import { makeDummyImage } from '../../src/image.js';

/** PNG 헤더(IHDR까지) + 압축 푼 IDAT의 sha256. 압축 방식(zlib 버전)과 상관없이 같은 그림이면 같다. */
export function pixelHash(png) {
  const idat = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.subarray(p + 4, p + 8).toString('ascii') === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  return crypto.createHash('sha256').update(png.subarray(0, 33)).update(zlib.inflateSync(Buffer.concat(idat))).digest('hex');
}

export const BASELINE_CASES = (() => {
  const cats = [
    undefined,
    { no: 24, names: ['Outerwear'], path: [24] },
    { no: 29, names: ['Outerwear', 'Jackets'], path: [24, 29] },
    { no: 39, names: ['Tops', 'Tees', 'Short Sleeve', 'Graphic Tees'], path: [25, 32, 36, 39] },
    { no: 34, names: ['Bottoms', 'Skirts'], path: [27, 34] },
    { no: 50, names: ['신발'], path: [50] },
    { no: 51, names: ['잡화'], path: [51] },
    { no: 52, names: ['리빙'], path: [52] },
    { no: 53, names: ['미분류 이름'], path: [53] },
  ];
  const out = [];
  for (const [ci, category] of cats.entries()) {
    for (const index of [1, 2, 3, 4, 5, 7, 12, 25, 99, 100, 101, 250, 500]) {
      out.push({ index, category, round: category ? (index + ci) % 5 : undefined, withOptions: index % 2 === 0, namePrefix: index === 7 ? '<테스트 & "접두어"> ' : undefined, display: index % 5 ? 'T' : 'F' });
    }
  }
  return out;
})();

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const runId = '261109120000123';
  const products = BASELINE_CASES.map((c) => buildDummyProduct(c.index, { runId, ...c, ...(c.namePrefix === undefined ? { namePrefix: undefined } : {}) }));
  const now = new Date('2026-11-09T03:00:00.000Z');
  const reviews = Array.from({ length: 30 }, (_, i) => buildReviews({ product_no: 1000 + i, list_image: i % 4 ? 'https://x/a.png' : undefined }, i, { maxPerProduct: 1 + (i % 4), now }));
  const imagePixels = Object.fromEntries([1, 2, 3, 10, 47, 360, 999].map((i) => [i, pixelHash(makeDummyImage(i, 600))]));
  imagePixels.small = pixelHash(makeDummyImage(5, 160));
  fs.writeFileSync(new URL('./fashion-baseline.json', import.meta.url), JSON.stringify({ runId, products, reviews, imagePixels }, null, 1));
  console.log('products', products.length, 'reviews', reviews.flat().length);
}
