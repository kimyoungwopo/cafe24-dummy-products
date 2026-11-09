import { DUMMY_REVIEW_PREFIX } from './config.js';
import { getPreset } from './presets.js';

// 더미 후기 작성자. 지울 때 "제목 접두어 + 이 목록의 작성자" 두 조건으로 더미 후기만 고른다.
export const REVIEW_WRITERS = ['김민지', '이서준', '박지우', '최하은', '정도윤', '강서연', '조예준', '윤지민', '장하준', '임수아', '한지호', '오유나'];

const RATINGS = [5, 5, 4, 5, 3, 4, 5, 2, 5, 4, 5, 1]; // 평균 4점 근처, 낮은 별점도 조금 섞음

// 후기 제목·본문 문구는 업종 프리셋(src/presets/*.json)에서 가져온다. 작성자·별점·제목 접두어는 정리 근거라 고정.

const pick = (arr, n) => arr[n % arr.length];

/** 한국 시간(+09:00) ISO 문자열 */
function kstIso(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().replace(/\.\d{3}Z$/, '+09:00');
}

export function isDummyReview(article) {
  return (
    typeof article?.title === 'string' &&
    article.title.startsWith(DUMMY_REVIEW_PREFIX) &&
    REVIEW_WRITERS.includes(article.writer)
  );
}

/**
 * 상품 하나에 달 후기 요청들을 만든다. 상품마다 1~maxPerProduct개로 개수가 달라진다.
 * @param {object} product { product_no, list_image?, detail_image? }
 * @param {number} productIndex 0부터
 */
export function buildReviews(product, productIndex, { maxPerProduct = 3, now = new Date(), preset = getPreset() } = {}) {
  const { titles: TITLES, bodies: BODIES } = preset.reviews;
  const count = 1 + (productIndex % Math.max(1, maxPerProduct));
  const image = product.list_image || product.detail_image || product.tiny_image;
  const reviews = [];
  for (let k = 0; k < count; k++) {
    const seed = productIndex * 7 + k * 3;
    const rating = pick(RATINGS, seed);
    const tone = rating >= 4 ? 'high' : rating === 3 ? 'mid' : 'low';
    const body = [pick(BODIES[tone], seed), pick(BODIES[tone], seed + 1)].filter((v, i, a) => a.indexOf(v) === i);
    const daysAgo = (seed * 5) % 60; // 최근 두 달 안에 흩어지게
    const created = new Date(now.getTime() - daysAgo * 86400000 - (seed % 12) * 3600000);
    const review = {
      writer: pick(REVIEW_WRITERS, seed),
      title: `${DUMMY_REVIEW_PREFIX}${pick(TITLES[rating], seed)}`,
      content: `<p>${body.join(' ')}</p>`,
      client_ip: '127.0.0.1',
      product_no: Number(product.product_no),
      rating,
      created_date: kstIso(created),
      secret: 'F',
    };
    // 세 개 중 하나는 포토후기 (상품 이미지 URL 첨부)
    if (image && seed % 3 === 0) review.attach_file_urls = [{ name: 'photo-review.png', url: image }];
    reviews.push(review);
  }
  return reviews;
}
