import { DUMMY_CODE_PREFIX } from './config.js';

// 스킨 테스트용으로 그럴듯한 한국어 상품명을 조합한다.
// kind: wear(의류) / shoes(신발) / goods(잡화·리빙) — 소재와 옵션을 종류에 맞게 고른다.
const it = (name, min, max, kind = 'wear') => ({ name, min, max, kind });
const GROUPS = {
  jacket: [it('데님 자켓', 59000, 149000), it('블루종', 69000, 159000), it('트러커 자켓', 79000, 169000)],
  coat: [it('싱글 코트', 129000, 299000), it('트렌치 코트', 119000, 259000), it('하프 코트', 99000, 219000)],
  blazer: [it('싱글 블레이저', 79000, 189000), it('더블 블레이저', 89000, 199000)],
  outer: [it('후드 집업', 39000, 99000), it('가디건', 39000, 89000), it('바람막이', 49000, 119000)],
  tee: [it('반팔 티셔츠', 15000, 39000), it('긴팔 티셔츠', 19000, 45000), it('그래픽 티셔츠', 19000, 42000), it('크롭 티셔츠', 17000, 39000)],
  shirt: [it('옥스포드 셔츠', 39000, 79000), it('스트라이프 셔츠', 35000, 69000), it('블라우스', 35000, 75000)],
  knit: [it('라운드 니트', 39000, 99000), it('브이넥 니트', 39000, 95000)],
  dress: [it('플레어 원피스', 49000, 129000), it('셔츠 원피스', 45000, 119000), it('슬립 원피스', 39000, 99000)],
  skirt: [it('데님 스커트', 29000, 59000), it('플리츠 스커트', 35000, 69000), it('롱 스커트', 39000, 79000)],
  pants: [it('와이드 팬츠', 32000, 79000), it('슬랙스', 35000, 79000), it('데님 팬츠', 39000, 89000)],
  shoes: [it('캔버스 스니커즈', 45000, 129000, 'shoes'), it('로퍼', 59000, 149000, 'shoes')],
  acc: [it('볼캡', 15000, 39000, 'goods'), it('에코백', 12000, 35000, 'goods'), it('패브릭 파우치', 9000, 29000, 'goods'), it('니트 비니', 15000, 35000, 'goods')],
  living: [it('머그컵', 9000, 25000, 'goods'), it('쿠션 커버', 12000, 32000, 'goods'), it('향초', 15000, 45000, 'goods'), it('텀블러', 18000, 49000, 'goods')],
};
const ITEMS = Object.values(GROUPS).flat(); // 분류를 모를 때 쓰는 전체 목록

// 분류 이름 → 상품군. 위에서부터 먼저 맞는 규칙을 쓴다 (구체적인 것 먼저).
const CATEGORY_RULES = [
  [/jacket|자켓|재킷|점퍼|jumper/i, ['jacket']],
  [/coat|코트/i, ['coat']],
  [/blazer|블레이저/i, ['blazer']],
  [/\btees?\b|t-?shirt|티셔츠|sleeve|반팔|긴팔/i, ['tee']],
  [/shirt|셔츠|blouse|블라우스/i, ['shirt']],
  [/knit|니트|sweater|스웨터/i, ['knit']],
  [/dress|원피스/i, ['dress']],
  [/skirt|스커트|치마/i, ['skirt']],
  [/pant|팬츠|바지|trouser|slacks|슬랙스|jean|denim|데님/i, ['pants']],
  [/shoe|신발|sneaker|스니커즈/i, ['shoes']],
  [/outer|아우터/i, ['jacket', 'coat', 'outer']],
  [/top|상의/i, ['tee', 'shirt', 'knit']],
  [/bottom|하의/i, ['pants', 'skirt']],
  [/acc|잡화|bag|가방|hat|모자|cap/i, ['acc']],
  [/living|리빙|home|홈|kitchen|주방/i, ['living']],
];

/** 분류 경로 이름(상위 → 하위)에서 가장 구체적인 이름부터 맞춰 상품군을 고른다. */
export function itemsForCategory(names = []) {
  for (const name of [...names].reverse()) {
    for (const [re, groups] of CATEGORY_RULES) {
      if (re.test(name)) return groups.flatMap((g) => GROUPS[g]);
    }
  }
  return ITEMS;
}

const ADJECTIVES = ['데일리', '베이직', '오버핏', '슬림', '빈티지', '모던', '심플', '클래식', '내추럴', '프리미엄', '썸머', '윈터'];
const MATERIALS = {
  wear: ['코튼', '린넨', '울', '캐시미어 블렌드', '데님', '나일론', '폴리', '리넨 블렌드'],
  shoes: ['레더', '스웨이드', '캔버스', '니트'],
  goods: ['코튼', '캔버스', '세라믹', '스테인리스', '레더', '린넨'],
};
const COLORS = ['블랙', '화이트', '베이지', '네이비', '그레이', '카키'];
const SIZES = { wear: ['S', 'M', 'L', 'XL'], shoes: ['230', '240', '250', '260', '270'] };

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
} = {}) {
  // 번호마다 다른 조합이 나오도록 서로 다른 보폭으로 섞는다.
  const pool = itemsForCategory(category?.names);
  const item = pick(pool, round !== undefined ? round + Number(category?.no ?? 0) : index * 5 + 3);
  const adj = pick(ADJECTIVES, index * 7 + (round ?? 0) * 5);
  const material = pick(MATERIALS[item.kind], index * 3 + 1 + (round ?? 0));
  const spread = ((index * 37) % 100) / 100;
  const price = roundTo(item.min + (item.max - item.min) * spread, 1000) - 100; // 예: 28,900원
  const supply = roundTo(price * 0.6, 100);
  const retail = index % 3 === 0 ? roundTo(price * 1.25, 1000) : 0; // 3개 중 1개는 할인가 표시용 소비자가

  const productName = `${namePrefix}${adj} ${material} ${item.name} ${String(index).padStart(3, '0')}`;

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
    simple_description: `${adj} 무드의 ${material} ${item.name}`,
    description: [
      `<h3>${productName}</h3>`,
      '<p>이 상품은 쇼핑몰 스킨/디자인 테스트를 위해 자동 생성된 <strong>더미 상품</strong>입니다.</p>',
      '<ul>',
      `<li>소재: ${material}</li>`,
      `<li>스타일: ${adj}</li>`,
      `<li>배치 ID: ${runId}</li>`,
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

  if (withOptions) {
    request.has_option = 'T';
    request.options = [{ name: '색상', value: COLORS.slice(index % 3, (index % 3) + 3) }];
    if (SIZES[item.kind]) request.options.push({ name: '사이즈', value: SIZES[item.kind] });
  }

  return request;
}
