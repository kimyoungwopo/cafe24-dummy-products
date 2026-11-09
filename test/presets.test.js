import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildDummyProduct } from '../src/dummy.js';
import { buildReviews, isDummyReview, REVIEW_WRITERS } from '../src/review.js';
import { makeDummyImage } from '../src/image.js';
import { getPreset, listPresets, validatePreset, itemsForCategory, BUILTIN_PRESET_IDS } from '../src/presets.js';
import { DUMMY_REVIEW_PREFIX } from '../src/config.js';
import { BASELINE_CASES, pixelHash } from './fixtures/make-fashion-baseline.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/fashion-baseline.json', import.meta.url), 'utf8'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('패션 호환: 프리셋 생략과 fashion 명시 모두 프리셋 도입 전 결과와 정확히 같다 (상품 요청·후기·이미지 픽셀)', () => {
  const fashion = getPreset('fashion');
  BASELINE_CASES.forEach((c, i) => {
    const opts = { runId: baseline.runId, ...c, ...(c.namePrefix === undefined ? { namePrefix: undefined } : {}) };
    let expected = baseline.products[i];
    if (c.namePrefix && /[&<>"']/.test(c.namePrefix)) {
      // 의도한 변경: 설명 HTML에 넣는 상품명은 이제 이스케이프한다 (다른 필드는 그대로)
      expected = { ...expected, description: expected.description.replace(`<h3>${expected.product_name}</h3>`, `<h3>${escapeHtml(expected.product_name)}</h3>`) };
    }
    assert.deepEqual(buildDummyProduct(c.index, opts), expected, `case ${i} (생략)`);
    assert.deepEqual(buildDummyProduct(c.index, { ...opts, preset: fashion }), expected, `case ${i} (fashion)`);
  });
  const now = new Date('2026-11-09T03:00:00.000Z');
  for (let i = 0; i < 30; i++) {
    const product = { product_no: 1000 + i, list_image: i % 4 ? 'https://x/a.png' : undefined };
    assert.deepEqual(buildReviews(product, i, { maxPerProduct: 1 + (i % 4), now }), baseline.reviews[i]);
    assert.deepEqual(buildReviews(product, i, { maxPerProduct: 1 + (i % 4), now, preset: fashion }), baseline.reviews[i]);
  }
  // 이미지는 픽셀 단위로 같아야 한다 (PNG 압축 바이트는 Node의 zlib 버전마다 다를 수 있음)
  for (const [k, hash] of Object.entries(baseline.imagePixels)) {
    const png = k === 'small' ? makeDummyImage(5, 160) : makeDummyImage(Number(k), 600);
    assert.equal(pixelHash(png), hash, `image ${k}`);
    if (k !== 'small') assert.equal(pixelHash(makeDummyImage(Number(k), 600, fashion.image)), hash, `image ${k} (fashion)`);
  }
});

test('프리셋 목록: 다섯 업종이 한국어 이름과 함께 있고, 없는 업종은 이름을 알려 주며 거부', () => {
  const list = listPresets();
  assert.deepEqual(list.map((p) => p.id), ['fashion', 'beauty', 'food', 'living', 'digital']);
  assert.deepEqual(list.map((p) => p.label), ['패션', '뷰티', '식품', '리빙', '디지털']);
  assert.equal(list.filter((p) => p.default).map((p) => p.id).join(), 'fashion');
  assert.throws(() => getPreset('pets'), /없는 업종 프리셋입니다: pets \(고를 수 있는 것: fashion, beauty, food, living, digital\)/);
  assert.throws(() => getPreset('../fashion'), /없는 업종 프리셋/);
  assert.equal(getPreset(undefined).id, 'fashion');
  assert.throws(() => getPreset(''), /없는 업종 프리셋/, '빈 값은 기본값으로 바꾸지 않음');
});

test('모든 프리셋: 여러 번호·분류에서 유효한 상품 요청 (가격·옵션·분류 경로·설명)', () => {
  const cats = [undefined, { no: 1, names: ['아무 분류'], path: [1] }, { no: 9, names: ['상위', '하위'], path: [3, 9] }];
  for (const id of BUILTIN_PRESET_IDS) {
    const preset = getPreset(id);
    const names = new Set(preset.allItems.map((x) => x.name));
    for (const category of cats) {
      for (let i = 1; i <= 60; i++) {
        for (const withOptions of [false, true]) {
          const p = buildDummyProduct(i, { runId: '261109120000123', preset, category, round: category ? i % 7 : undefined, withOptions });
          const w = `${id} #${i} ${category?.no ?? '-'} opt=${withOptions}`;
          assert.ok(Number.isInteger(p.price) && p.price > 0, w);
          assert.ok(p.supply_price > 0 && p.supply_price < p.price, w);
          assert.ok(p.retail_price === 0 || p.retail_price > p.price, w);
          assert.ok([...names].some((n) => p.product_name.includes(n)), `${w}: ${p.product_name}`);
          assert.match(p.product_name, new RegExp(`${String(i).padStart(3, '0')}$`));
          assert.match(p.custom_product_code, /^DUMMY-261109120000123-\d{3}$/);
          assert.doesNotMatch(p.description, /\{|\}/, '자리표시자가 남지 않음');
          if (withOptions) {
            assert.equal(p.has_option, 'T', w);
            assert.ok(p.options.length >= 1 && p.options.every((o) => o.name && o.value.length >= 1), w);
          } else {
            assert.equal(p.options, undefined, w);
          }
          if (category) assert.deepEqual(p.add_category_no.map((c) => c.category_no), category.path);
        }
      }
    }
  }
});

test('업종별 분류 이름 규칙: 가장 아래 분류 이름부터 맞추고, 맞는 게 없으면 전체 상품', () => {
  const names = (id, path) => new Set(itemsForCategory(getPreset(id), path).map((x) => x.name));
  assert.ok(names('beauty', ['Makeup', 'Lip']).has('립스틱'));
  assert.ok(names('beauty', ['Skincare']).has('세럼'));
  assert.ok(names('food', ['신선식품', '과일']).has('사과'));
  assert.ok(names('food', ['Coffee & Tea']).has('콜드브루 커피'));
  assert.ok(names('living', ['주방용품']).has('머그컵'));
  assert.ok(names('living', ['Bedding']).has('이불 커버'));
  assert.ok(names('digital', ['Audio', '이어폰']).has('무선 이어폰'));
  assert.ok(names('digital', ['충전기']).has('충전기'));
  assert.equal(names('beauty', ['전혀 관계없는 분류']).size, getPreset('beauty').allItems.length);
  // 하위 분류가 먼저: Tops > Jackets 처럼 상위가 다른 규칙이어도 하위를 따른다 (패션)
  assert.ok(names('fashion', ['Tops', 'Jackets']).has('데님 자켓'));
});

test('모든 프리셋의 후기: 제목 접두어와 작성자는 고정이라 더미 후기 판별·정리 기준이 그대로', () => {
  const now = new Date('2026-11-09T03:00:00.000Z');
  for (const id of BUILTIN_PRESET_IDS) {
    const preset = getPreset(id);
    const all = Array.from({ length: 24 }, (_, i) => buildReviews({ product_no: 10 + i, list_image: 'https://x/a.png' }, i, { maxPerProduct: 3, now, preset })).flat();
    for (const r of all) {
      assert.ok(r.title.startsWith(DUMMY_REVIEW_PREFIX), id);
      assert.ok(REVIEW_WRITERS.includes(r.writer), id);
      assert.ok(isDummyReview(r), id);
      assert.ok(r.rating >= 1 && r.rating <= 5);
      assert.ok(preset.reviews.titles[String(r.rating)].some((t) => r.title === `${DUMMY_REVIEW_PREFIX}${t}`), `${id}: 별점에 맞는 제목`);
    }
    // 같은 시각이면 항상 같은 결과
    assert.deepEqual(buildReviews({ product_no: 5 }, 3, { now, preset }), buildReviews({ product_no: 5 }, 3, { now, preset }));
  }
  assert.notDeepEqual(
    buildReviews({ product_no: 5 }, 3, { now, preset: getPreset('food') }).map((r) => r.content),
    buildReviews({ product_no: 5 }, 3, { now, preset: getPreset('fashion') }).map((r) => r.content),
    '업종마다 문구가 다름',
  );
});

test('업종별 이미지: 프리셋 글자와 색으로 그리고, 올바른 PNG', () => {
  const hashes = new Set();
  for (const id of BUILTIN_PRESET_IDS) {
    const png = makeDummyImage(3, 600, getPreset(id).image);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    hashes.add(sha(png));
  }
  assert.equal(hashes.size, BUILTIN_PRESET_IDS.length);
});

test('프리셋 검사: 잘못된 데이터는 상품을 만들기 전에 어디가 틀렸는지 한국어로 알린다', () => {
  const good = JSON.parse(fs.readFileSync(new URL('../src/presets/beauty.json', import.meta.url), 'utf8'));
  const bad = (mutate) => {
    const p = JSON.parse(JSON.stringify(good));
    mutate(p);
    return () => validatePreset(p, { where: 'my.json' });
  };
  assert.doesNotThrow(bad(() => {}));
  assert.throws(bad((p) => (p.extra = 1)), /my\.json\): 알 수 없는 항목 "extra"/);
  assert.throws(bad((p) => (p.groups.skincare[0].kind = 'nope')), /groups\.skincare\[0\]\.kind\): 없는 상품 종류 "nope"/);
  assert.throws(bad((p) => (p.groups.skincare[0].min = 90000)), /가격은 1,000 ≤ min ≤ max/);
  assert.throws(bad((p) => (p.groups.skincare[0].min = 500)), /가격은 1,000/);
  assert.throws(bad((p) => (p.categoryRules[0].groups = ['ghost'])), /없는 상품군 "ghost"/);
  // 상속 속성 이름도 없는 참조로 거부
  assert.throws(bad((p) => (p.groups.skincare[0].kind = 'toString')), /없는 상품 종류 "toString"/);
  assert.throws(bad((p) => (p.categoryRules[0].groups = ['constructor'])), /없는 상품군 "constructor"/);
  assert.throws(bad((p) => (p.groups.skincare[0].kind = '__proto__')), /없는 상품 종류/);
  assert.throws(bad((p) => (p.categoryRules[0] = { regex: 'lip', groups: ['makeup'] })), /정규식 규칙은 내장 프리셋에서만/);
  assert.throws(bad((p) => (p.text.name = '{adj} {brand}')), /모르는 자리표시자 \{brand\}/);
  assert.throws(bad((p) => (p.image.label = '뷰티')), /image\.label\): 영문 대문자/);
  assert.throws(bad((p) => (p.image.label = 'TOOLONGX')), /image\.label/);
  assert.throws(bad((p) => (p.kinds.makeup.options[0].take = 4)), /2×take-1 이상/);
  assert.throws(bad((p) => (p.adjectives = [])), /adjectives\): 문자열 1~50개/);
  assert.throws(bad((p) => (p.adjectives[0] = '<script>')), /< > 문자는 쓸 수 없습니다/);
  assert.throws(bad((p) => delete p.reviews.bodies.low), /"low" 항목이 없습니다/);
  assert.throws(bad((p) => (p.version = 2)), /version\): 1이어야/);
  // 내장 프리셋에서도 잘못된 정규식은 거부
  assert.throws(() => validatePreset({ ...JSON.parse(JSON.stringify(good)), categoryRules: [{ regex: '(', groups: ['makeup'] }] }, { builtin: true }), /정규식이 올바르지 않습니다/);
  // 검사를 통과한 프리셋은 바꿀 수 없다
  assert.throws(() => {
    'use strict';
    getPreset('food').adjectives.push('x');
  });
});
