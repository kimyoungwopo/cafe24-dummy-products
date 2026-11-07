import { getAccessToken } from './auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 문자열에서 비밀값(정확히 일치)과 토큰처럼 보이는 긴 영숫자 묶음을 가리고 200자로 자른다. */
export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '');
  // 비밀값은 길이와 상관없이 모두 가린다 (긴 것부터 가려서 일부만 남는 일이 없게)
  for (const v of [...secrets].filter((x) => typeof x === 'string' && x.length > 0).sort((a, b) => b.length - a.length)) {
    s = s.split(v).join('[가림]');
  }
  s = s.replace(/[A-Za-z0-9_-]{20,}/g, '[가림]');
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export class Cafe24ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * 카페24 Admin API 클라이언트.
 * - 호출 간격 최소 500ms (leaky bucket: 초당 2회 배출, 버킷 40)
 * - X-Api-Call-Limit 사용량이 높으면 추가로 쉰다
 * - 429는 1·2·4·8·16초 지수 백오프로 최대 5회 재시도
 * - 5xx·네트워크 오류는 GET/DELETE만 최대 3회 재시도 (POST는 중복 등록 위험 때문에 재시도 안 함)
 * - 401이면 토큰을 한 번 갱신하고 재시도
 * - 요청당 30초 타임아웃
 * - 같은 클라이언트의 요청은 한 줄로 세워 하나씩 보낸다 (동시에 불러도 간격·순서가 지켜짐)
 */
export class Cafe24Client {
  constructor(cfg, { minIntervalMs = Number(process.env.CAFE24_MIN_INTERVAL_MS) || 500, getToken = getAccessToken, timeoutMs = 30000 } = {}) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.getToken = getToken;
    this.lastCallAt = 0;
    this.extraWaitMs = 0;
    this._chain = Promise.resolve();
  }

  /** 직전 요청 시작 시각으로부터 최소 간격이 지날 때까지 기다린다. */
  async throttle() {
    const wait = this.lastCallAt + this.minIntervalMs + this.extraWaitMs - Date.now();
    if (wait > 0) await sleep(wait);
  }

  updateBucket(header) {
    const m = /^(\d+)\/(\d+)$/.exec(header || '');
    if (!m) return;
    const used = Number(m[1]);
    const cap = Number(m[2]);
    // 버킷이 75% 이상 차면 비워질 때까지 천천히 호출
    this.extraWaitMs = used / cap >= 0.75 ? 1500 : 0;
  }

  buildUrl(path, query) {
    const url = new URL(`${this.cfg.apiBase}/api/v2/admin${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return url;
  }

  /** 요청을 줄에 세운다: 앞 요청(재시도 포함)이 끝나야 다음 요청이 시작된다. */
  request(method, path, opts = {}) {
    const run = this._chain.then(() => this._requestNow(method, path, opts));
    this._chain = run.catch(() => {});
    return run;
  }

  async _requestNow(method, path, { query, body } = {}) {
    const url = this.buildUrl(path, query);
    // POST(상품 등록 등)는 서버에서 성공했는데 응답만 잃었을 수 있으므로,
    // 중복 생성을 막기 위해 429(처리 안 됨이 확실한 경우)만 재시도한다.
    const idempotent = method !== 'POST';
    let refreshed = false;
    let rateRetries = 0;
    let errorRetries = 0;
    for (;;) {
      await this.throttle();
      const token = await this.getToken(this.cfg, { forceRefresh: false });
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      if (this.cfg.apiVersion) headers['X-Cafe24-Api-Version'] = this.cfg.apiVersion;

      let res;
      this.lastCallAt = Date.now(); // 실제 요청을 보내는 시각 기준으로 간격을 잰다
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error', // 토큰이 다른 서버로 가지 않도록 리다이렉트를 따라가지 않는다
        });
      } catch (e) {
        if (idempotent && errorRetries < 3) {
          await sleep(1000 * 2 ** errorRetries++);
          continue;
        }
        throw new Cafe24ApiError(0, `네트워크 오류: ${e.message}${idempotent ? '' : ' (중복 등록 방지를 위해 재시도하지 않음)'}`);
      }
      this.updateBucket(res.headers.get('x-api-call-limit'));

      let text;
      try {
        text = await res.text();
      } catch (e) {
        // 응답 본문을 다 못 읽음 → 서버에서 처리됐는지 알 수 없음 (status 0 = 결과 불명)
        throw new Cafe24ApiError(0, `응답을 끝까지 받지 못했습니다: ${e.message}`);
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (res.ok) return data;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(this.cfg, { forceRefresh: true, staleToken: token });
        continue;
      }
      if (res.status === 429 && rateRetries < 5) {
        const delay = 1000 * 2 ** rateRetries++; // 1,2,4,8,16초
        process.stderr.write(`  ⏳ HTTP 429 — ${delay / 1000}초 후 재시도 (${rateRetries}/5)\n`);
        await sleep(delay);
        continue;
      }
      if (res.status >= 500 && idempotent && errorRetries < 3) {
        const delay = 1000 * 2 ** errorRetries++;
        process.stderr.write(`  ⏳ HTTP ${res.status} — ${delay / 1000}초 후 재시도 (${errorRetries}/3)\n`);
        await sleep(delay);
        continue;
      }
      // 카페24가 준 오류 문구는 그대로 쓰지 않는다: 현재 토큰·Secret과 토큰처럼 긴 문자열을 가리고, 길이를 줄인다.
      // (JSON이 아닌 응답 본문은 아예 싣지 않는다)
      const upstream = typeof data?.error?.message === 'string' ? data.error.message : data?.raw ? '(응답 본문 생략)' : res.statusText;
      const msg = redactSecrets(upstream, [token, this.cfg.clientSecret]);
      throw new Cafe24ApiError(res.status, `HTTP ${res.status} ${method} ${path}: ${msg}`, data);
    }
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body) {
    return this.request('POST', path, { body });
  }
  delete(path, query) {
    return this.request('DELETE', path, { query });
  }

  // ---- 상품 ----

  createProduct(request) {
    return this.post('/products', { shop_no: this.cfg.shopNo, request });
  }

  uploadProductImage(productNo, dataUri) {
    return this.post(`/products/${productNo}/images`, {
      shop_no: this.cfg.shopNo,
      request: { image_upload_type: 'A', detail_image: dataUri },
    });
  }

  deleteProduct(productNo) {
    return this.delete(`/products/${productNo}`, { shop_no: this.cfg.shopNo });
  }

  /**
   * 자체상품코드에 code가 포함된 상품을 가져온다.
   * offset 최대 5000 제한 때문에 끝까지 못 읽으면 truncated=true를 돌려준다 (전부 찾았다고 말하면 안 됨).
   */
  async findProductsByCustomCode(code) {
    const limit = 100;
    const items = [];
    for (let offset = 0; offset <= 5000; offset += limit) {
      const data = await this.get('/products', {
        shop_no: this.cfg.shopNo,
        custom_product_code: code,
        limit,
        offset,
      });
      const page = data?.products || [];
      items.push(...page);
      if (page.length < limit) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  /** 상품번호로 현재 상태를 조회한다. 없는 상품은 결과에서 빠진다. 목록 API 캐시로 빠진 건 하나씩 다시 확인한다. */
  async getProductsByNos(productNos) {
    const found = new Map();
    for (let i = 0; i < productNos.length; i += 100) {
      const part = productNos.slice(i, i + 100);
      const data = await this.get('/products', { shop_no: this.cfg.shopNo, product_no: part, limit: 100 });
      if (!Array.isArray(data?.products)) throw new Cafe24ApiError(0, '상품 조회 응답 형식이 올바르지 않습니다 (결과 불명)');
      for (const p of data.products) found.set(Number(p.product_no), p);
    }
    // 여러 건 조회에서 빠진 상품은 단건 조회로 확인한다. "없음"으로 인정하는 건
    // 빈 객체({"product":{}}, 카페24의 없는 상품 응답)나 404뿐이고, 그 밖의 이상한 응답은 오류(결과 불명)로 본다.
    for (const no of productNos) {
      if (found.has(no)) continue;
      let data;
      try {
        data = await this.get(`/products/${no}`, { shop_no: this.cfg.shopNo });
      } catch (e) {
        if (e.status === 404) continue;
        throw e;
      }
      const one = data?.product;
      if (!one || typeof one !== 'object' || Array.isArray(one)) throw new Cafe24ApiError(0, `상품 ${no} 조회 응답 형식이 올바르지 않습니다 (결과 불명)`);
      if (Object.keys(one).length === 0) continue; // 없음
      if (Number(one.product_no) !== no) throw new Cafe24ApiError(0, `상품 ${no} 조회 결과의 상품번호가 다릅니다 (결과 불명)`);
      found.set(no, one);
    }
    return found;
  }

  /** 게시물 번호로 현재 상태를 조회한다. 없는(또는 삭제된) 게시물은 결과에서 빠진다. */
  async getArticlesByNos(boardNo, articleNos) {
    const found = new Map();
    for (let i = 0; i < articleNos.length; i += 100) {
      const part = articleNos.slice(i, i + 100);
      const data = await this.get(`/boards/${boardNo}/articles`, { shop_no: this.cfg.shopNo, article_no: part, limit: 100 });
      if (!Array.isArray(data?.articles)) throw new Cafe24ApiError(0, '게시물 조회 응답 형식이 올바르지 않습니다 (결과 불명)');
      for (const a of data.articles) {
        if (a.deleted !== 'T') found.set(Number(a.article_no), a);
      }
    }
    // 여러 건 조회에서 빠진 글은 한 건씩 다시 확인한다 (목록이 불완전할 수 있으므로).
    for (const no of articleNos) {
      if (found.has(no)) continue;
      try {
        const data = await this.get(`/boards/${boardNo}/articles`, { shop_no: this.cfg.shopNo, article_no: no });
        if (!Array.isArray(data?.articles)) throw new Cafe24ApiError(0, `게시물 ${no} 조회 응답 형식이 올바르지 않습니다 (결과 불명)`);
        const a = data.articles.find((x) => Number(x.article_no) === no);
        if (a && a.deleted !== 'T') found.set(no, a);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return found;
  }

  // ---- 메인진열 (추천상품, 신상품 등) ----

  async listMains() {
    return (await this.get('/mains', { shop_no: this.cfg.shopNo }))?.mains || [];
  }

  async listMainProducts(displayGroup) {
    return (await this.get(`/mains/${displayGroup}/products`, { shop_no: this.cfg.shopNo }))?.products || [];
  }

  addMainProducts(displayGroup, productNos) {
    return this.post(`/mains/${displayGroup}/products`, {
      shop_no: this.cfg.shopNo,
      request: { product_no: productNos.map(Number) },
    });
  }

  removeMainProduct(displayGroup, productNo) {
    return this.delete(`/mains/${displayGroup}/products/${productNo}`, { shop_no: this.cfg.shopNo });
  }

  // ---- 게시판 (상품후기) ----

  async listBoards() {
    return (await this.get('/boards', { shop_no: this.cfg.shopNo }))?.boards || [];
  }

  /** 게시물 등록. 한 번에 최대 10건. 응답 본문을 그대로 돌려준다 (검증은 호출하는 쪽에서). */
  async createArticles(boardNo, requests) {
    if (requests.length > 10) throw new Error('게시물은 한 번에 10건까지 등록할 수 있습니다.');
    return this.post(`/boards/${boardNo}/articles`, { shop_no: this.cfg.shopNo, requests });
  }

  /** 게시물 검색 (offset 최대 8000). */
  async listArticles(boardNo, query = {}) {
    const limit = 100;
    const all = [];
    for (let offset = 0; offset <= 8000; offset += limit) {
      const data = await this.get(`/boards/${boardNo}/articles`, { shop_no: this.cfg.shopNo, ...query, limit, offset });
      const items = data?.articles || [];
      all.push(...items);
      if (items.length < limit) break;
    }
    return all;
  }

  deleteArticle(boardNo, articleNo) {
    return this.delete(`/boards/${boardNo}/articles/${articleNo}`, { shop_no: this.cfg.shopNo });
  }

  async listCategories() {
    const limit = 100;
    const all = [];
    for (let offset = 0; offset <= 5000; offset += limit) {
      const data = await this.get('/categories', { shop_no: this.cfg.shopNo, limit, offset });
      const items = data?.categories || [];
      all.push(...items);
      if (items.length < limit) break;
    }
    return all;
  }
}
