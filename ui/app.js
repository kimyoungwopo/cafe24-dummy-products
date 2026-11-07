// 카페24 더미 데이터 — 로컬 UI
// 서버가 준 값은 모두 textContent로만 화면에 넣는다 (innerHTML 사용 안 함).

// ---------------------------------------------------------------- 세션 토큰
// 토큰은 URL의 # 뒤로 받아 메모리에만 두고, 주소창에서는 바로 지운다.
const TOKEN = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', location.pathname);

const $ = (sel) => document.querySelector(sel);
const banner = $('#banner');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function showBanner(message, kind = 'warn') {
  banner.hidden = !message;
  banner.className = `banner ${kind}`;
  banner.textContent = message || '';
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    // POST는 본문이 없어도 항상 JSON으로 보낸다 (서버는 JSON만 받음)
    headers: { 'X-Session-Token': TOKEN, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    cache: 'no-store',
    credentials: 'omit',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status, data });
  return data;
}

// ---------------------------------------------------------------- 대화상자

function ask({ title, body, ok = '확인', danger = false, requireCheck = null }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  const holder = $('#modal-body');
  holder.replaceChildren(...(Array.isArray(body) ? body : [body]));
  const okBtn = $('#modal-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'danger' : 'primary';
  okBtn.disabled = false;
  if (requireCheck) {
    const box = el('input', { type: 'checkbox' });
    okBtn.disabled = true;
    box.addEventListener('change', () => (okBtn.disabled = !box.checked));
    holder.append(el('label', { class: 'check' }, box, ` ${requireCheck}`));
  }
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ---------------------------------------------------------------- 탭

const tabs = [...document.querySelectorAll('.tabs button')];
function openTab(name) {
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  if (name === 'seed') loadCategories();
  if (name === 'status') loadBatches();
}
for (const b of tabs) b.addEventListener('click', () => openTab(b.dataset.tab));

// ---------------------------------------------------------------- 상태

let current = null;

async function refreshState() {
  current = await api('GET', '/api/state');
  const { config: c, login, job } = current;
  const badge = $('#shop-badge');
  if (login && !login.mismatch) {
    badge.textContent = `${login.mallId} 연결됨`;
    badge.className = 'badge ok';
  } else if (c.complete) {
    badge.textContent = '로그인 필요';
    badge.className = 'badge warn';
  } else {
    badge.textContent = '설정 필요';
    badge.className = 'badge warn';
  }

  const rows = [
    ['쇼핑몰', c.mallId || '(설정 안 됨)'],
    ['Client ID', c.clientId || '(설정 안 됨)'],
    ['Client Secret', { file: '설정 파일에 저장됨', env: '환경변수에서 읽음 (파일에는 없음)', none: '(설정 안 됨)' }[c.secret]],
    ['Redirect URI', c.redirectUri || '(설정 안 됨)'],
    ['로그인', login ? (login.mismatch ? `다른 쇼핑몰(${login.mallId})로 로그인됨 — 다시 로그인하세요` : `${login.mallId} · Access Token ${Math.max(0, login.accessLeftMin)}분 남음 (자동 갱신)`) : '안 됨'],
    ['권한', login ? login.scopes.join(', ') || '-' : '-'],
    ['설정 위치', `${current.dataDir} (${current.dataDirSource})`],
  ];
  $('#conn-summary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

  const f = $('#config-form');
  if (!f.dataset.touched) {
    f.mall.value = c.mallId;
    f.clientId.value = c.clientId;
    f.redirectUri.value = c.redirectUri;
  }
  f.clientSecret.placeholder = c.secret === 'none' ? '' : '비워 두면 저장된 값 유지';
  if (current.configError) showBanner(current.configError, 'err');
  else if (current.tokenError) showBanner(current.tokenError, 'err');
  if (job) watchJob(job);
  return current;
}

$('#config-form').addEventListener('input', (e) => (e.currentTarget.dataset.touched = '1'));

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const body = { mall: f.mall.value, clientId: f.clientId.value, clientSecret: f.clientSecret.value, redirectUri: f.redirectUri.value };
  try {
    let r = await api('POST', '/api/config', body);
    if (r.needsConfirm) {
      if (!(await ask({ title: '쇼핑몰을 찾을 수 없어요', body: el('p', {}, r.warning), ok: '그래도 저장' }))) return;
      r = await api('POST', '/api/config', { ...body, force: true });
    }
    f.clientSecret.value = '';
    delete f.dataset.touched;
    showBanner(['저장했어요.', ...r.warnings].join(' '), r.warnings.length ? 'warn' : 'ok');
    await refreshState();
  } catch (err) {
    showBanner(err.message, 'err');
  }
});

$('#login-open').addEventListener('click', async () => {
  try {
    const { authorizeUrl } = await api('POST', '/api/login/start');
    // 팝업 차단을 피하고, 새 창이 이 화면에 접근하지 못하도록(noopener) 사용자가 직접 누르는 링크로 연다.
    const link = $('#login-link');
    link.href = authorizeUrl;
    link.hidden = false;
    $('#login-link-hint').hidden = false;
    showBanner('"승인 화면 열기"를 눌러 새 창에서 승인한 뒤, 이동한 페이지의 주소창 URL 전체를 복사해 아래에 붙여넣으세요. 이 로그인 준비는 10분 동안 유효해요.', 'warn');
    link.focus();
  } catch (err) {
    showBanner(err.message, 'err');
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.currentTarget.url;
  try {
    const r = await api('POST', '/api/login/complete', { url: input.value });
    input.value = '';
    showBanner(`로그인했어요 (${r.mallId}).`, 'ok');
    await refreshState();
  } catch (err) {
    input.value = '';
    showBanner(err.message, 'err');
  }
});

// ---------------------------------------------------------------- 채우기

let categories = null;

async function loadCategories() {
  if (categories || !current?.login) return;
  try {
    categories = (await api('GET', '/api/categories')).categories;
    const list = $('#category-list');
    list.replaceChildren(
      ...categories.map((c) =>
        el(
          'label',
          { class: c.displayed ? '' : 'dim' },
          el('input', { type: 'checkbox', value: c.no, checked: c.leaf && c.displayed }),
          `${c.no} · ${c.label}${c.displayed ? '' : ' (진열 안 함)'}`,
        ),
      ),
    );
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

function updateSeedForm() {
  const f = $('#seed-form');
  $('#category-list').hidden = f.categoryMode.value !== 'pick';
  const n = Math.max(0, Number(f.count.value) || 0);
  const secs = Math.ceil(n * (f.withImage.checked ? 2 : 1) * 0.5);
  $('#seed-estimate').textContent = `카페24 호출 제한(초당 2회) 때문에 약 ${secs < 90 ? `${secs}초` : `${Math.ceil(secs / 60)}분`} 이상 걸려요.${f.hidden.checked ? '' : ' 진열 상태로 등록되어 손님 화면에도 보여요.'}`;
}
$('#seed-form').addEventListener('input', updateSeedForm);
updateSeedForm();

$('#seed-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const mode = f.categoryMode.value;
  const picked = [...document.querySelectorAll('#category-list input:checked')].map((i) => Number(i.value));
  if (mode === 'pick' && !picked.length) return showBanner('분류를 하나 이상 고르세요.', 'err');
  const body = { count: Number(f.count.value), categoryMode: mode, categoryNos: picked, withOptions: f.withOptions.checked, withImage: f.withImage.checked, hidden: f.hidden.checked };
  const ok = await ask({
    title: '더미 상품을 등록할까요?',
    body: el(
      'ul',
      {},
      el('li', {}, `쇼핑몰: ${current?.config.mallId}`),
      el('li', {}, `상품 ${body.count}개, ${{ spread: '진열 중인 분류 전체에 고르게', pick: `고른 분류 ${picked.length}곳`, none: '분류 없이' }[mode]}`),
      el('li', {}, body.hidden ? '진열안함·판매안함 (손님 화면에 안 보임)' : '진열함·판매함 (손님 화면에 보임)'),
      el('li', {}, '나중에 "현황·정리"에서 이 배치만 지울 수 있어요.'),
    ),
    ok: '등록 시작',
  });
  if (!ok) return;
  try {
    watchJob(await api('POST', '/api/jobs/seed', body));
  } catch (err) {
    showBanner(err.message, 'err');
  }
});

// ---------------------------------------------------------------- 현황·정리

async function loadBatches() {
  const box = $('#batches');
  try {
    const r = await api('GET', '/api/batches');
    if (!r.batches.length) {
      box.replaceChildren(el('p', { class: 'hint' }, '이 도구가 만든 더미 상품이 없어요.'));
    } else {
      box.replaceChildren(
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, '만든 시각'), el('th', {}, '배치 ID'), el('th', {}, '상품'), el('th', {}, '후기'), el('th', {}, ''))),
          el(
            'tbody',
            {},
            r.batches.map((b) =>
              el(
                'tr',
                {},
                el('td', {}, b.createdAt || '-'),
                el('td', {}, b.runId),
                el('td', { class: 'num' }, b.products),
                el('td', { class: 'num' }, b.reviews),
                el('td', {}, el('button', { type: 'button', onclick: () => previewCleanup(b.runId) }, '정리 미리보기…')),
              ),
            ),
          ),
        ),
      );
    }
    const notes = [];
    if (r.unknown) notes.push(`결과를 알 수 없는 요청 ${r.unknown}건은 자동으로 정리하지 않아요.`);
    if (r.legacy) notes.push(`예전 버전으로 만든 기록 ${r.legacy}줄은 소유로 인정하지 않아요. 터미널의 purge-legacy 명령으로 확인하세요.`);
    if (r.invalidLines) notes.push(`소유 기록 파일에서 읽을 수 없는 줄 ${r.invalidLines}개가 있어요.`);
    $('#batch-notes').replaceChildren(...notes.map((n) => el('li', {}, n)));
  } catch (err) {
    box.replaceChildren(el('p', { class: 'hint' }, err.message));
  }
}
$('#batches-refresh').addEventListener('click', loadBatches);
$('#cleanup-all').addEventListener('click', () => previewCleanup(undefined));

async function previewCleanup(runId) {
  showBanner('현재 상태를 확인하는 중이에요…', 'warn');
  let plan;
  try {
    plan = await api('POST', '/api/cleanup/plan', { runId });
  } catch (err) {
    return showBanner(err.message, 'err');
  }
  showBanner('');
  const { counts: c, notes: n } = plan;
  const total = c.reviews + c.mains + c.products;
  const skipped = [
    n.changedProducts && `기록과 달라진 상품 ${n.changedProducts}개`,
    n.changedReviews && `기록과 달라진 후기 ${n.changedReviews}개`,
    n.productChangedMains && `상품이 바뀐 메인진열 항목 ${n.productChangedMains}개`,
    n.missingReviews && `조회에서 안 보이는 후기 기록 ${n.missingReviews}개`,
    n.missingMains && `목록에 안 보이는 메인진열 기록 ${n.missingMains}개 (캐시일 수 있음)`,
    n.unknown && `결과 불명 요청 ${n.unknown}건`,
    n.legacy && `예전 버전 기록 ${n.legacy}줄`,
    n.invalidLines && `읽을 수 없는 기록 줄 ${n.invalidLines}개`,
  ].filter(Boolean);
  const body = [
    el('p', {}, `쇼핑몰 ${plan.mallId} · ${runId ? `배치 ${runId}` : '이 도구가 만든 전체'}`),
    el('ul', {}, el('li', {}, `후기 ${c.reviews}개${plan.withReviews ? '' : ' (게시판 권한이 없어 후기는 정리하지 않음)'}`), el('li', {}, `메인진열 항목 ${c.mains}개`), el('li', {}, `상품 ${c.products}개`)),
    plan.samples.length ? el('p', { class: 'hint' }, `예: ${plan.samples.map((s) => s.name).join(', ')}`) : null,
    skipped.length ? el('div', {}, el('p', {}, '자동으로 건드리지 않는 것:'), el('ul', {}, skipped.map((s) => el('li', {}, s)))) : null,
    el('p', { class: 'warn' }, '카페24에서 삭제하면 되돌릴 수 없어요. 지우기 직전에 한 번 더 확인하고, 그때 달라진 것은 건너뛰어요.'),
  ].filter(Boolean);
  if (!total) {
    await ask({ title: '정리할 것이 없어요', body: body.slice(0, -1), ok: '닫기' });
    return;
  }
  const ok = await ask({ title: `${total}개를 정리할까요?`, body, ok: '정리 시작', danger: true, requireCheck: '되돌릴 수 없다는 것을 이해했어요' });
  if (!ok) return;
  try {
    watchJob(await api('POST', '/api/jobs/cleanup', { planId: plan.planId }));
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 작업 진행

let polling = null;

function renderJob(job) {
  $('#job').hidden = false;
  $('#job-title').textContent = job.type === 'seed' ? '더미 상품 등록' : '정리';
  const st = $('#job-status');
  st.textContent = { running: '진행 중', done: '완료', failed: '멈춤' }[job.status];
  st.className = `badge ${{ running: 'warn', done: 'ok', failed: 'err' }[job.status]}`;
  const { done = 0, total = 0, label } = job.progress || {};
  $('#job-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  $('#job-progress').textContent = total ? `${done} / ${total}${label ? ` · ${label}` : ''}` : '';
  if (job.logs) {
    const log = $('#job-log');
    log.textContent = job.logs.slice(-200).join('\n');
    log.scrollTop = log.scrollHeight;
  }
  const r = job.result;
  let text = '';
  if (job.status === 'failed') text = `멈췄어요: ${job.error}`;
  else if (r && job.type === 'seed') text = `등록 ${r.created}개, 실패 ${r.failed}개${r.unknown ? `, 결과 불명 ${r.unknown}개` : ''} · 배치 ${r.runId}`;
  else if (r) text = `삭제: 상품 ${r.products}개, 후기 ${r.reviews}개, 메인진열 ${r.mains}개 · 실패 ${r.failed}개${r.skippedChanged ? ` · 달라져서 건너뜀 ${r.skippedChanged}개` : ''}${r.reappeared ? ` · 다시 나타나 건너뜀 ${r.reappeared}개` : ''}`;
  $('#job-result').textContent = text;
  for (const b of document.querySelectorAll('button.primary, button.danger')) {
    if (b.id !== 'modal-ok') b.disabled = job.status === 'running';
  }
}

function watchJob(job) {
  renderJob(job);
  if (job.status !== 'running' || polling) return;
  polling = setInterval(async () => {
    try {
      const { job: j } = await api('GET', '/api/job');
      if (!j) return;
      renderJob(j);
      if (j.status !== 'running') {
        clearInterval(polling);
        polling = null;
        categories = null;
        await refreshState();
        if (!$('#tab-status').hidden) loadBatches();
      }
    } catch (err) {
      clearInterval(polling);
      polling = null;
      showBanner(err.message, 'err');
    }
  }, 1000);
}

// ---------------------------------------------------------------- 시작

if (!TOKEN) {
  showBanner('세션 정보가 없어요. 터미널에서 `node src/cli.js ui`를 다시 실행해 열어 주세요.', 'err');
} else {
  refreshState()
    .then((s) => {
      if (s.login && !s.login.mismatch) openTab('seed');
    })
    .catch((err) => showBanner(err.message, 'err'));
}
