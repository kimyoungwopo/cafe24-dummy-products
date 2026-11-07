import http from 'node:http';

/**
 * 카페24 Admin API를 흉내 내는 테스트용 서버.
 * 요청 형식(Bearer 토큰, shop_no/request 래퍼, 필수 필드)을 검사한다.
 */
export function startMockServer({ fail429Once = false, fail500OnPostOnce = false, articlesResponse = 'full', mainsResponse = 'full' } = {}) {
  const state = {
    products: new Map(),
    nextNo: 100,
    calls: [],
    validToken: 'access-1',
    refreshCount: 0,
    sent429: !fail429Once,
    sent500: !fail500OnPostOnce,
    hideFromList: false, // true면 목록 API가 새 상품을 못 보여 줌 (캐시 흉내)
    hiddenMainNos: new Set(), // 메인진열 목록 조회에서 빠지는 상품 (캐시 흉내)
    malformedDetail: false, // true면 상품 단건 조회가 product 키 없는 이상한 응답을 줌
    mains: new Map([[2, new Set([1])], [3, new Set()]]), // 추천상품엔 진짜 상품 1이 이미 있음
    articles: new Map(),
    nextArticle: 500,
  };
  // 진짜 고객 후기 (지우면 안 됨): 제목은 [더미]로 시작하지만 작성자가 더미 목록에 없음
  state.articles.set(1, { article_no: 1, board_no: 4, writer: '실제고객', title: '[더미] 라고 쓴 진짜 후기', content: 'x' });
  state.articles.set(2, { article_no: 2, board_no: 4, writer: '김민지', title: '진짜 후기', content: 'x' });
  // 표시(제목 접두어 + 더미 작성자 이름)까지 똑같지만 이 도구가 만든 기록이 없는 진짜 후기
  state.articles.set(3, { article_no: 3, board_no: 4, writer: '김민지', title: '[더미] 정말 만족해요', content: 'x', product_no: 1 });
  // 더미가 아닌 기존 상품 (삭제되면 안 됨)
  state.products.set(1, { product_no: 1, product_name: '진짜 상품', custom_product_code: 'REAL-001', display: 'T' });
  state.products.set(2, { product_no: 2, product_name: '코드에 DUMMY- 포함', custom_product_code: 'X-DUMMY-1', display: 'T' });
  state.products.set(3, { product_no: 3, product_name: '사람이 붙인 코드', custom_product_code: 'DUMMY-SHIRT', display: 'T' });

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), raw });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Api-Call-Limit': '1/40', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/v2/oauth/token') {
      const params = new URLSearchParams(raw);
      if (!req.headers.authorization?.startsWith('Basic ')) return send(401, { error: 'invalid_client' });
      if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'refresh-1') {
        state.refreshCount++;
        state.validToken = `access-${state.refreshCount + 1}`;
        return send(200, {
          access_token: state.validToken,
          refresh_token: 'refresh-1',
          refresh_token_expires_at: '2026-11-21T12:00:00.000',
          mall_id: 'testmall',
          scopes: ['mall.read_product', 'mall.write_product', 'mall.read_category', 'mall.read_community', 'mall.write_community'],
          shop_no: '1',
        });
      }
      return send(400, { error: 'invalid_grant' });
    }

    if (req.headers.authorization !== `Bearer ${state.validToken}`) {
      return send(401, { error: { code: 401, message: 'Authority to access is not valid.' } });
    }

    const body = raw ? JSON.parse(raw) : null;
    const m = url.pathname.match(/^\/api\/v2\/admin\/products(?:\/(\d+))?(\/images)?$/);

    if (req.method === 'POST' && url.pathname === '/api/v2/admin/products') {
      if (!state.sent429) {
        state.sent429 = true;
        return send(429, { error: { code: 429, message: 'Too much requests occur.' } }, { 'X-Api-Call-Limit': '40/40' });
      }
      if (!state.sent500) {
        state.sent500 = true;
        return send(500, { error: { code: 500, message: 'A temporary server error occurs.' } });
      }
      const r = body?.request;
      if (!r || body.shop_no !== 1) return send(400, { error: { code: 400, message: 'bad wrapper' } });
      if (!r.product_name || r.price === undefined || r.supply_price === undefined) {
        return send(422, { error: { code: 422, message: 'missing required' } });
      }
      if (r.custom_product_code.length > 40) return send(422, { error: { code: 422, message: 'code too long' } });
      const no = state.nextNo++;
      state.products.set(no, { product_no: no, ...r });
      return send(201, { product: { shop_no: 1, product_no: no, ...r } });
    }

    if (req.method === 'POST' && m?.[2]) {
      const no = Number(m[1]);
      if (!state.products.has(no)) return send(404, { error: { code: 404, message: 'not found' } });
      const img = body?.request?.detail_image || '';
      if (body?.request?.image_upload_type !== 'A' || !img.startsWith('data:image/png;base64,')) {
        return send(422, { error: { code: 422, message: 'bad image' } });
      }
      state.products.get(no).image_bytes = Buffer.from(img.split(',')[1], 'base64').length;
      return send(201, { image: { shop_no: 1, product_no: no, detail_image: `https://x/web/product/big/${no}.png` } });
    }

    if (req.method === 'GET' && url.pathname === '/api/v2/admin/products') {
      const code = url.searchParams.get('custom_product_code') || '';
      const nos = url.searchParams.get('product_no')?.split(',').map(Number);
      const limit = Number(url.searchParams.get('limit') || 10);
      const offset = Number(url.searchParams.get('offset') || 0);
      const list = [...state.products.values()]
        .filter((p) => !(state.hideFromList && p.product_no >= 100)) // 목록 API 캐시 흉내
        .filter((p) => !nos || nos.includes(p.product_no))
        .filter((p) => (p.custom_product_code || '').includes(code));
      return send(200, { products: list.slice(offset, offset + limit) });
    }

    if (req.method === 'GET' && m?.[1] && !m[2]) {
      if (state.malformedDetail) return send(200, { something: 'else' });
      // 카페24처럼 없는 상품은 404가 아니라 빈 객체
      return send(200, { product: state.products.get(Number(m[1])) ?? {} });
    }

    if (req.method === 'DELETE' && m?.[1] && !m[2]) {
      const no = Number(m[1]);
      if (!state.products.delete(no)) return send(404, { error: { code: 404, message: 'not found' } });
      for (const set of state.mains.values()) set.delete(no); // 상품을 지우면 메인진열에서도 빠짐
      return send(200, { product: { product_no: no } });
    }

    // ---- 메인진열 ----
    if (req.method === 'GET' && url.pathname === '/api/v2/admin/mains') {
      return send(200, { mains: [...state.mains.keys()].map((g) => ({ display_group: g, group_name: g === 2 ? '추천상품' : '신상품', module_code: `product_listmain_${g - 1}` })) });
    }
    const mm = url.pathname.match(/^\/api\/v2\/admin\/mains\/(\d+)\/products(?:\/(\d+))?$/);
    if (mm) {
      const set = state.mains.get(Number(mm[1]));
      if (!set) return send(404, { error: { code: 404, message: 'no main' } });
      if (req.method === 'GET') return send(200, { products: [...set].filter((no) => !state.hiddenMainNos.has(no)).map((no) => ({ product_no: no, product_name: state.products.get(no)?.product_name })) });
      if (req.method === 'POST') {
        for (const no of body.request.product_no) set.add(Number(no));
        // mainsResponse='subset': 실제로는 다 넣었지만 응답에는 첫 번째만 실림
        const listed = mainsResponse === 'subset' ? body.request.product_no.slice(0, 1) : body.request.product_no;
        return send(201, { product: { product_no: listed } });
      }
      if (req.method === 'DELETE') {
        set.delete(Number(mm[2]));
        return send(200, { product: { product_no: Number(mm[2]) } });
      }
    }

    // ---- 게시판 ----
    if (req.method === 'GET' && url.pathname === '/api/v2/admin/boards') {
      return send(200, { boards: [{ board_no: 1, board_name: '공지사항' }, { board_no: 4, board_name: '상품 사용후기' }] });
    }
    const bm = url.pathname.match(/^\/api\/v2\/admin\/boards\/(\d+)\/articles(?:\/(\d+))?$/);
    if (bm) {
      const boardNo = Number(bm[1]);
      if (req.method === 'POST') {
        if (body.requests.length > 10) return send(422, { error: { code: 422, message: 'max 10' } });
        for (const r of body.requests) {
          if (!r.writer || !r.title || !r.content || !r.client_ip) return send(422, { error: { code: 422, message: 'missing' } });
        }
        const created = body.requests.map((r) => ({ article_no: state.nextArticle++, board_no: boardNo, ...r }));
        for (const a of created) state.articles.set(a.article_no, a);
        // articlesResponse: 'none' = 등록은 됐는데 응답 본문에 articles가 없음 / 'partial' = 일부만 실림
        if (articlesResponse === 'none') return send(201, {});
        if (articlesResponse === 'partial') return send(201, { articles: created.slice(0, 1) });
        return send(201, { articles: created });
      }
      if (req.method === 'GET') {
        const kw = url.searchParams.get('keyword') || '';
        const nos = url.searchParams.get('article_no')?.split(',').map(Number);
        const limit = Number(url.searchParams.get('limit') || 10);
        const offset = Number(url.searchParams.get('offset') || 0);
        const list = [...state.articles.values()].filter((a) => a.board_no === boardNo && a.title.includes(kw) && (!nos || nos.includes(a.article_no)));
        return send(200, { articles: list.slice(offset, offset + limit) });
      }
      if (req.method === 'DELETE') {
        if (!state.articles.delete(Number(bm[2]))) return send(404, { error: { code: 404, message: 'not found' } });
        return send(200, { article: { article_no: Number(bm[2]) } });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/v2/admin/categories') {
      const cat = (no, depth, parent, name, path, names, useDisplay = 'T') => ({
        category_no: no,
        category_depth: depth,
        parent_category_no: parent,
        category_name: name,
        use_display: useDisplay,
        full_category_no: Object.fromEntries([1, 2, 3, 4].map((d) => [d, path[d - 1] ? String(path[d - 1]) : null])),
        full_category_name: Object.fromEntries([1, 2, 3, 4].map((d) => [d, names[d - 1] ?? null])),
      });
      return send(200, {
        categories: [
          cat(25, 2, 24, '티셔츠', [24, 25], ['상의', '티셔츠']),
          cat(24, 1, 1, '상의', [24], ['상의']),
          cat(26, 2, 27, '스커트', [27, 26], ['하의', '스커트']),
          cat(27, 1, 1, '하의', [27], ['하의']),
          cat(28, 1, 1, '숨김분류', [28], ['숨김분류'], 'F'),
        ],
      });
    }

    send(404, { error: { code: 404, message: `no route ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
