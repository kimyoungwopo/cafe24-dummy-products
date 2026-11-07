import { getAccessToken } from './auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 */
export class Cafe24Client {
  constructor(cfg, { minIntervalMs = Number(process.env.CAFE24_MIN_INTERVAL_MS) || 500, getToken = getAccessToken, timeoutMs = 30000 } = {}) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.getToken = getToken;
    this.lastCallAt = 0;
    this.extraWaitMs = 0;
  }

  async throttle() {
    const wait = this.lastCallAt + this.minIntervalMs + this.extraWaitMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
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

  async request(method, path, { query, body } = {}) {
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
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (idempotent && errorRetries < 3) {
          await sleep(1000 * 2 ** errorRetries++);
          continue;
        }
        throw new Cafe24ApiError(0, `네트워크 오류: ${e.message}${idempotent ? '' : ' (중복 등록 방지를 위해 재시도하지 않음)'}`);
      }
      this.updateBucket(res.headers.get('x-api-call-limit'));

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (res.ok) return data;

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(this.cfg, { forceRefresh: true });
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
      const msg = data?.error?.message || data?.raw || res.statusText;
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

  /** 자체상품코드에 code가 포함된 상품을 전부 가져온다 (offset 최대 5000 제한 내). */
  async findProductsByCustomCode(code) {
    const limit = 100;
    const all = [];
    for (let offset = 0; offset <= 5000; offset += limit) {
      const data = await this.get('/products', {
        shop_no: this.cfg.shopNo,
        custom_product_code: code,
        limit,
        offset,
      });
      const items = data?.products || [];
      all.push(...items);
      if (items.length < limit) break;
    }
    return all;
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

  /** 게시물 등록. 한 번에 최대 10건. */
  async createArticles(boardNo, requests) {
    if (requests.length > 10) throw new Error('게시물은 한 번에 10건까지 등록할 수 있습니다.');
    return (await this.post(`/boards/${boardNo}/articles`, { shop_no: this.cfg.shopNo, requests }))?.articles || [];
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
