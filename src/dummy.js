import { DUMMY_CODE_PREFIX } from './config.js';

import { getPreset, itemsForCategory as presetItems, fillTemplate } from './presets.js';

// 스킨 테스트용으로 그럴듯한 한국어 상품명을 조합한다.
// 상품군·이름 재료·옵션·가격대는 업종 프리셋(src/presets/*.json)에서 가져온다. 기본은 패션.

/** 분류 경로 이름에 맞는 상품 후보 (프리셋을 생략하면 패션) */
export function itemsForCategory(names = [], preset = getPreset()) {
  return presetItems(preset, names);
}

/** 상품 설명 HTML에 넣는 글자는 이스케이프한다 (접두어 등 사용자 입력이 섞일 수 있음) */
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pick(arr, n) {
  return arr[n % arr.length];
}

function roundTo(value, unit) {
  return Math.round(value / unit) * unit;
}

/** 배치 ID 형식: 15자리 숫자 (YYMMDDHHmmss + 밀리초 3자리) */
export const RUN_ID_PATTERN = /^\d{15}$/;

/**
 * 실행 단위 ID (예: 261107153012345 = 26년 11월 7일 15:30:12.345)
 * 자체상품코드에 들어가서 배치별 삭제에 쓰인다.
 */
export function makeRunId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${String(date.getFullYear()).slice(2)}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`;
}

export function dummyCode(runId, index) {
  return `${DUMMY_CODE_PREFIX}${runId}-${String(index).padStart(3, '0')}`;
}

/**
 * 이 도구가 만든 자체상품코드인지 판별한다. (예: DUMMY-261107153012345-007)
 * 사람이 직접 붙인 "DUMMY-SHIRT" 같은 코드는 해당하지 않는다.
 */
export function isDummyCode(code, runId) {
  if (typeof code !== 'string') return false;
  const m = new RegExp(`^${DUMMY_CODE_PREFIX}(\\d{15})-\\d{3}$`).exec(code);
  return Boolean(m) && (runId === undefined || m[1] === runId);
}

/**
 * 더미 상품 요청 본문(request 객체)을 만든다.
 * @param {number} index 1부터 시작하는 번호
 * @param {object} [opts.category] { no, names: [상위..하위 이름], path: [상위..하위 번호] }
 */
export function buildDummyProduct(index, {
  runId,
  namePrefix = '[더미] ',
  category,
  round, // 같은 분류에 몇 번째로 들어가는지 (0부터). 분류 안에서 종류가 돌아가며 바뀌게 한다.
  display = 'T',
  selling = 'T',
  withOptions = false,
  preset = getPreset(),
} = {}) {
  // 번호마다 다른 조합이 나오도록 서로 다른 보폭으로 섞는다.
  const pool = presetItems(preset, category?.names);
  const item = pick(pool, round !== undefined ? round + Number(category?.no ?? 0) : index * 5 + 3);
  const kind = preset.kinds[item.kind];
  const adj = pick(preset.adjectives, index * 7 + (round ?? 0) * 5);
  const material = pick(kind.variants, index * 3 + 1 + (round ?? 0));
  const vars = { adj, variant: material, item: item.name, variantLabel: kind.variantLabel };
  const spread = ((index * 37) % 100) / 100;
  const price = roundTo(item.min + (item.max - item.min) * spread, 1000) - 100; // 예: 28,900원
  const supply = roundTo(price * 0.6, 100);
  const retail = index % 3 === 0 ? roundTo(price * 1.25, 1000) : 0; // 3개 중 1개는 할인가 표시용 소비자가

  const productName = `${namePrefix}${fillTemplate(preset.text.name, vars)} ${String(index).padStart(3, '0')}`;

  const request = {
    product_name: productName.slice(0, 250),
    custom_product_code: dummyCode(runId, index),
    price,
    supply_price: supply,
    retail_price: retail,
    display,
    selling,
    product_condition: 'N',
    summary_description: `스킨 테스트용 더미 상품 #${index}`,
    simple_description: fillTemplate(preset.text.simple, vars),
    description: [
      `<h3>${escapeHtml(productName)}</h3>`,
      '<p>이 상품은 쇼핑몰 스킨/디자인 테스트를 위해 자동 생성된 <strong>더미 상품</strong>입니다.</p>',
      '<ul>',
      `<li>${escapeHtml(kind.variantLabel)}: ${escapeHtml(material)}</li>`,
      `<li>${escapeHtml(preset.text.styleLabel)}: ${escapeHtml(adj)}</li>`,
      `<li>배치 ID: ${escapeHtml(runId)}</li>`,
      '</ul>',
    ].join('\n'),
  };

  if (category) {
    // 하위 분류에 넣을 때 상위 분류 목록에도 보이도록 경로 전체에 등록한다.
    const path = category.path?.length ? category.path : [category.no];
    request.add_category_no = [...new Set(path.map(Number))].map((no) => ({
      category_no: no,
      recommend: 'F',
      new: no === Number(category.no) && index % 4 === 0 ? 'T' : 'F',
    }));
  }

  if (withOptions && kind.options.length) {
    request.has_option = 'T';
    // take가 있으면 (번호 % take) 위치부터 take개, 없으면 전부
    request.options = kind.options.map((o) => ({ name: o.name, value: o.take ? o.values.slice(index % o.take, (index % o.take) + o.take) : [...o.values] }));
  }

  return request;
}
