import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 업종 프리셋: 상품명 재료·가격대·분류 규칙·옵션·후기 문구·이미지 색과 글자를 담은 "데이터".
 * 프리셋은 코드를 실행하지 않는다. 불러올 때 형식을 엄격하게 검사하고, 틀리면 상품을 만들기 전에 한국어 오류를 낸다.
 *
 * 바뀌지 않는 것 (정리 기능의 근거라 프리셋으로 바꿀 수 없음):
 *  - 자체상품코드 형식(DUMMY-…), 후기 제목 접두어와 작성자 목록, 별점 분포
 */

const PRESET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export const BUILTIN_PRESET_IDS = ['fashion', 'beauty', 'food', 'living', 'digital'];
export const DEFAULT_PRESET_ID = 'fashion';
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const LABEL_RE = /^[A-Z0-9 #-]{1,7}$/; // 이미지 글꼴이 그릴 수 있는 글자만 (가운데 패널 폭 안에 들어가는 길이)
const PLACEHOLDERS = new Set(['adj', 'variant', 'item', 'variantLabel']);
const RATING_KEYS = ['5', '4', '3', '2', '1'];
const TONES = ['high', 'mid', 'low'];

class PresetError extends Error {}
const fail = (where, msg) => {
  throw new PresetError(`프리셋 형식 오류 (${where}): ${msg}`);
};

// 참조 확인은 객체 자신의 항목만 본다 (toString 같은 상속 속성을 상품 종류로 착각하지 않도록)
const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function onlyKeys(obj, where, required, optional = []) {
  if (!isObj(obj)) fail(where, '객체여야 합니다');
  for (const k of required) if (!(k in obj)) fail(where, `"${k}" 항목이 없습니다`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(where, `알 수 없는 항목 "${k}"`);
}
function str(v, where, max = 60) {
  if (typeof v !== 'string' || !v.trim()) fail(where, '비어 있지 않은 문자열이어야 합니다');
  if (v.length > max) fail(where, `${max}자 이하여야 합니다`);
  if (/[<>]/.test(v)) fail(where, '< > 문자는 쓸 수 없습니다');
  return v;
}
function strList(v, where, { min = 1, max = 50, len = 60 } = {}) {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(where, `문자열 ${min}~${max}개 목록이어야 합니다`);
  v.forEach((s, i) => str(s, `${where}[${i}]`, len));
  return v;
}
function template(v, where) {
  str(v, where, 80);
  for (const m of v.matchAll(/\{([^}]*)\}/g)) if (!PLACEHOLDERS.has(m[1])) fail(where, `모르는 자리표시자 {${m[1]}}`);
  if (/[{}]/.test(v.replace(/\{(adj|variant|item|variantLabel)\}/g, ''))) fail(where, '중괄호 짝이 맞지 않습니다');
  return v;
}

/** 프리셋 객체를 검사하고, 분류 규칙을 미리 준비한 읽기 전용 객체로 돌려준다. builtin만 정규식 규칙을 쓸 수 있다. */
export function validatePreset(raw, { builtin = false, where = '프리셋' } = {}) {
  onlyKeys(raw, where, ['version', 'id', 'label', 'description', 'adjectives', 'kinds', 'groups', 'categoryRules', 'text', 'reviews', 'image']);
  if (raw.version !== 1) fail(`${where}.version`, '1이어야 합니다');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) fail(`${where}.id`, '영문 소문자로 시작하는 2~32자(소문자·숫자·-)여야 합니다');
  str(raw.label, `${where}.label`, 20);
  str(raw.description, `${where}.description`, 80);
  strList(raw.adjectives, `${where}.adjectives`);

  // 상품 종류: 이름 재료(variants)와 옵션
  if (!isObj(raw.kinds) || !Object.keys(raw.kinds).length) fail(`${where}.kinds`, '상품 종류가 하나 이상 있어야 합니다');
  for (const [k, kind] of Object.entries(raw.kinds)) {
    const w = `${where}.kinds.${k}`;
    if (!KEY_RE.test(k)) fail(w, '이름은 영문 소문자로 시작해야 합니다');
    onlyKeys(kind, w, ['variantLabel', 'variants', 'options']);
    str(kind.variantLabel, `${w}.variantLabel`, 20);
    strList(kind.variants, `${w}.variants`);
    if (!Array.isArray(kind.options) || kind.options.length > 2) fail(`${w}.options`, '옵션은 0~2개 목록이어야 합니다');
    kind.options.forEach((o, i) => {
      const ow = `${w}.options[${i}]`;
      onlyKeys(o, ow, ['name', 'values'], ['take']);
      str(o.name, `${ow}.name`, 20);
      strList(o.values, `${ow}.values`, { max: 20, len: 30 });
      if (o.take !== undefined) {
        // take개를 (번호 % take) 위치부터 고른다 → 값이 적어도 2*take-1개 있어야 항상 take개가 나온다
        if (!Number.isInteger(o.take) || o.take < 1 || o.values.length < 2 * o.take - 1) fail(`${ow}.take`, `1 이상이고 값 개수(${o.values.length})가 2×take-1 이상이어야 합니다`);
      }
    });
  }

  // 상품군
  if (!isObj(raw.groups) || !Object.keys(raw.groups).length) fail(`${where}.groups`, '상품군이 하나 이상 있어야 합니다');
  for (const [g, items] of Object.entries(raw.groups)) {
    const w = `${where}.groups.${g}`;
    if (!KEY_RE.test(g)) fail(w, '이름은 영문 소문자로 시작해야 합니다');
    if (!Array.isArray(items) || !items.length || items.length > 50) fail(w, '상품 1~50개 목록이어야 합니다');
    items.forEach((it, i) => {
      const iw = `${w}[${i}]`;
      onlyKeys(it, iw, ['name', 'min', 'max', 'kind']);
      str(it.name, `${iw}.name`, 40);
      if (!Number.isInteger(it.min) || !Number.isInteger(it.max) || it.min < 1000 || it.max < it.min || it.max > 10_000_000) {
        fail(iw, '가격은 1,000 ≤ min ≤ max ≤ 10,000,000 정수여야 합니다');
      }
      if (!has(raw.kinds, it.kind)) fail(`${iw}.kind`, `없는 상품 종류 "${String(it.kind).slice(0, 40)}"`);
    });
  }

  // 분류 이름 → 상품군 규칙 (위에서부터 먼저 맞는 것)
  if (!Array.isArray(raw.categoryRules) || raw.categoryRules.length > 50) fail(`${where}.categoryRules`, '50개 이하 목록이어야 합니다');
  const rules = raw.categoryRules.map((r, i) => {
    const w = `${where}.categoryRules[${i}]`;
    onlyKeys(r, w, ['groups'], ['match', 'regex']);
    if (!Array.isArray(r.groups) || !r.groups.length) fail(`${w}.groups`, '상품군 1개 이상');
    for (const g of r.groups) if (!has(raw.groups, g)) fail(`${w}.groups`, `없는 상품군 "${String(g).slice(0, 40)}"`);
    if ((r.match === undefined) === (r.regex === undefined)) fail(w, 'match와 regex 중 하나만 있어야 합니다');
    if (r.regex !== undefined) {
      if (!builtin) fail(`${w}.regex`, '정규식 규칙은 내장 프리셋에서만 쓸 수 있습니다. match(글자 포함 목록)를 쓰세요');
      let re;
      try {
        re = new RegExp(str(r.regex, `${w}.regex`, 200), 'i');
      } catch {
        fail(`${w}.regex`, '정규식이 올바르지 않습니다');
      }
      return { test: (name) => re.test(name), groups: r.groups };
    }
    const words = strList(r.match, `${w}.match`, { len: 30 }).map((s) => s.toLowerCase());
    return { test: (name) => words.some((s) => name.toLowerCase().includes(s)), groups: r.groups };
  });

  onlyKeys(raw.text, `${where}.text`, ['name', 'simple', 'styleLabel']);
  template(raw.text.name, `${where}.text.name`);
  template(raw.text.simple, `${where}.text.simple`);
  str(raw.text.styleLabel, `${where}.text.styleLabel`, 20);

  onlyKeys(raw.reviews, `${where}.reviews`, ['titles', 'bodies']);
  onlyKeys(raw.reviews.titles, `${where}.reviews.titles`, RATING_KEYS);
  for (const k of RATING_KEYS) strList(raw.reviews.titles[k], `${where}.reviews.titles.${k}`, { len: 40 });
  onlyKeys(raw.reviews.bodies, `${where}.reviews.bodies`, TONES);
  for (const k of TONES) strList(raw.reviews.bodies[k], `${where}.reviews.bodies.${k}`, { min: 2, len: 120 });

  onlyKeys(raw.image, `${where}.image`, ['label', 'hueStart', 'hueSpan']);
  if (typeof raw.image.label !== 'string' || !LABEL_RE.test(raw.image.label)) fail(`${where}.image.label`, '영문 대문자·숫자·공백·#·- 1~7자여야 합니다');
  if (!Number.isInteger(raw.image.hueStart) || raw.image.hueStart < 0 || raw.image.hueStart > 359) fail(`${where}.image.hueStart`, '0~359 정수');
  if (!Number.isInteger(raw.image.hueSpan) || raw.image.hueSpan < 1 || raw.image.hueSpan > 360) fail(`${where}.image.hueSpan`, '1~360 정수');

  const preset = structuredCloneSafe(raw);
  preset.rules = rules;
  preset.allItems = Object.values(raw.groups).flat(); // 분류를 모를 때 쓰는 전체 목록 (상품군 순서대로)
  return deepFreeze(preset);
}

// Node 18.3에도 있는 JSON 복사 (프리셋은 JSON 데이터만 담는다)
const structuredCloneSafe = (v) => JSON.parse(JSON.stringify(v));
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

const cache = new Map();
/** 내장 프리셋을 id로 불러온다. 없는 id면 고를 수 있는 목록과 함께 오류. */
export function getPreset(id = DEFAULT_PRESET_ID) {
  if (id === undefined || id === null) id = DEFAULT_PRESET_ID; // 빈 문자열 등 다른 값은 기본값으로 바꾸지 않고 거부
  if (typeof id !== 'string' || !BUILTIN_PRESET_IDS.includes(id)) {
    throw new PresetError(`없는 업종 프리셋입니다: ${String(id).slice(0, 40)} (고를 수 있는 것: ${BUILTIN_PRESET_IDS.join(', ')})`);
  }
  if (!cache.has(id)) {
    const raw = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, `${id}.json`), 'utf8'));
    const p = validatePreset(raw, { builtin: true, where: `${id}.json` });
    if (p.id !== id) throw new PresetError(`프리셋 형식 오류 (${id}.json): id가 파일 이름과 다릅니다`);
    cache.set(id, p);
  }
  return cache.get(id);
}

/** 목록 표시용 요약 */
export const listPresets = () => BUILTIN_PRESET_IDS.map((id) => {
  const p = getPreset(id);
  return { id: p.id, label: p.label, description: p.description, default: id === DEFAULT_PRESET_ID };
});

/** 분류 경로 이름(상위 → 하위)에서 가장 구체적인 이름부터 맞춰 상품 후보를 고른다. 맞는 게 없으면 전체. */
export function itemsForCategory(preset, names = []) {
  for (const name of [...names].reverse()) {
    for (const rule of preset.rules) if (rule.test(String(name))) return rule.groups.flatMap((g) => preset.groups[g]);
  }
  return preset.allItems;
}

export const fillTemplate = (tpl, vars) => tpl.replace(/\{(adj|variant|item|variantLabel)\}/g, (_, k) => vars[k]);
export { PresetError };
