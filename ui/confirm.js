// MCP 정리 확인 화면. 서버가 준 값은 모두 textContent로만 넣는다 (innerHTML 사용 안 함).
const TOKEN = new URLSearchParams(location.hash.slice(1)).get('t') || '';
history.replaceState(null, '', location.pathname); // 주소창에서 토큰을 바로 지운다

const $ = (sel) => document.querySelector(sel);

function el(tag, text) {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
}

function banner(message, kind = 'err') {
  const b = $('#banner');
  b.hidden = !message;
  b.className = `banner ${kind}`;
  b.textContent = message || '';
}

async function api(method, body) {
  const res = await fetch('/api/confirm', {
    method,
    headers: { 'X-Confirm-Token': TOKEN, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function finish(title, text) {
  $('#plan-card').hidden = true;
  $('#done-card').hidden = false;
  $('#done-title').textContent = title;
  $('#done-text').textContent = text;
}

function render(plan) {
  const rows = [
    ['쇼핑몰', `${plan.mallId} (멀티쇼핑몰 ${plan.shopNo})`],
    ['범위', plan.runId ? `배치 ${plan.runId}` : '이 도구가 만든 전체'],
    ['지울 것', `상품후기 ${plan.counts.reviews}개 · 메인진열 ${plan.counts.mains}개 · 상품 ${plan.counts.products}개`],
    ['순서', '후기 → 메인진열 → 상품 (지우기 직전에 한 번 더 확인)'],
    ['확인 기한', new Date(plan.expiresAt).toLocaleString('ko-KR')],
  ];
  $('#plan-summary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
  $('#plan-samples').replaceChildren(...plan.samples.map((s) => el('li', `상품 ${s.productNo} · ${s.name}`)));
  const n = plan.notes;
  const notes = [
    !plan.withReviews && '게시판 권한이 없어 후기는 정리하지 않아요. 이 상품들에 달린 더미 후기는 남을 수 있어요.',
    n.changedProducts && `등록 뒤 바뀐 상품 ${n.changedProducts}개는 건너뛰어요.`,
    n.changedReviews && `내용이 바뀐 후기 ${n.changedReviews}개는 건너뛰어요.`,
    n.productChangedMains && `진짜 상품으로 바뀐 메인진열 ${n.productChangedMains}개는 건너뛰어요.`,
    n.missingReviews && `조회되지 않는 후기 ${n.missingReviews}개는 지우지 않고 기록을 남겨 다음에 다시 확인해요.`,
    n.missingMains && `목록에서 확인되지 않는 메인진열 ${n.missingMains}개는 빼지 않고 기록을 남겨 다음에 다시 확인해요.`,
    n.goneProducts && `이미 카페24에 없는 상품 ${n.goneProducts}개는 기록만 정리해요.`,
    n.unknown && `결과 불명 기록 ${n.unknown}개는 자동으로 지우지 않아요.`,
    n.legacy && `예전 버전 기록 ${n.legacy}개는 대상이 아니에요.`,
    n.invalidLines && `읽을 수 없는 기록 줄 ${n.invalidLines}개가 있어요.`,
  ].filter(Boolean);
  $('#plan-notes').replaceChildren(...notes.map((t) => el('li', t)));
  $('#plan-card').hidden = false;
}

$('#confirm-form').irreversible.addEventListener('change', (e) => {
  $('#approve').disabled = !e.target.checked;
});

$('#confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', { decision: 'approve', irreversible: e.currentTarget.irreversible.checked });
    finish('승인했어요', 'AI 도구로 돌아가 "정리 실행"을 다시 요청하면 지우기 시작해요. 이 창은 닫아도 돼요.');
  } catch (err) {
    banner(err.message);
  }
});

$('#reject').addEventListener('click', async () => {
  try {
    await api('POST', { decision: 'reject' });
    finish('거절했어요', '아무것도 지우지 않았어요. 이 정리 계획은 더 이상 쓸 수 없어요.');
  } catch (err) {
    banner(err.message);
  }
});

if (!TOKEN) banner('확인 정보가 없어요. AI에게 정리 계획을 다시 만들어 달라고 하세요.');
else
  api('GET')
    .then((d) => render(d.plan))
    .catch((err) => banner(err.message));
