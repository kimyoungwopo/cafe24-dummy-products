import fs from 'node:fs';
import path from 'node:path';

/**
 * 프로세스 사이 잠금 (같은 컴퓨터, 같은 설정 폴더) — "이름표" 방식.
 *
 * 잠금 하나는 폴더 하나(<lock>.d)다. 잠그려는 프로세스는
 *   1) 폴더에 자기 이름표 파일(<pid>.<무작위>)을 만들고
 *   2) 폴더를 다시 읽어, 살아 있는 다른 이름표가 하나도 없을 때만 잠금을 가진다.
 *   3) 다른 이름표가 있으면 자기 이름표를 지우고 물러난다 (잠시 뒤 다시 시도).
 * 잠금을 가진 동안 이름표는 남아 있으므로, 나중에 오는 프로세스는 2)에서 반드시 그 이름표를 보고 물러난다.
 * 동시에 온 두 프로세스는 서로의 이름표를 보고 둘 다 물러난 뒤 무작위 간격으로 다시 시도한다.
 *
 * 다른 프로세스의 이름표를 지우거나 넘겨받는 단계가 없다. 비정상 종료한 프로세스의 이름표는
 * pid가 죽었으므로 그냥 무시한다 (청소는 해가 없으므로 해도 되지만, 판단에는 쓰지 않는다).
 * 다른 컴퓨터에서 같은 쇼핑몰을 다루는 경우까지는 막지 못한다.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 다른 사용자의 살아 있는 프로세스
  }
}

const ticketPid = (name) => Number(/^(\d+)\./.exec(name)?.[1]);

function readTicket(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return { pid: ticketPid(name) };
  }
}

/**
 * 잠금을 한 번 시도한다. 성공하면 { release }, 실패하면 { holder }.
 * options.pid / options.isAlive / options.hooks 는 테스트용 (경쟁 순서를 일부러 재현하기 위해).
 */
export function tryLock(file, label, { pid = process.pid, isAlive = defaultIsAlive, hooks = {} } = {}) {
  const dir = `${file}.d`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${pid}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const mine = path.join(dir, name);
  // 내용까지 쓴 임시 파일을 link로 한 번에 만든다 (이름표는 항상 완전한 상태로만 보임)
  const tmp = path.join(path.dirname(dir), `.${path.basename(dir)}.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ pid, label, at: new Date().toISOString() }), { mode: 0o600 });
  try {
    fs.linkSync(tmp, mine);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  hooks.afterTicketCreated?.();

  const others = fs.readdirSync(dir).filter((n) => n !== name && !n.startsWith('.'));
  const liveOthers = others.filter((n) => isAlive(ticketPid(n)));
  for (const n of others) if (!liveOthers.includes(n)) fs.rmSync(path.join(dir, n), { force: true }); // 죽은 프로세스의 이름표 청소 (판단과 무관)

  if (liveOthers.length) {
    fs.rmSync(mine, { force: true }); // 물러남
    return { holder: readTicket(dir, liveOthers.sort()[0]) };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    fs.rmSync(mine, { force: true }); // 내 이름표만 지운다
  };
  process.once('exit', release);
  return { release };
}

/** 잠금을 잡고 fn을 실행한다. waitMs 동안(무작위 간격으로) 다시 시도해도 못 잡으면 오류. */
export async function withLock(file, label, fn, { waitMs = 0, busyMessage } = {}) {
  const r = await acquire(file, label, waitMs);
  if (!r.release) {
    const h = r.holder;
    throw Object.assign(
      new Error(busyMessage?.(h) ?? `다른 작업이 실행 중입니다${h ? ` (${h.label || '작업'}, pid ${h.pid}${h.at ? `, ${h.at} 시작` : ''})` : ''}. 끝난 뒤에 다시 시도하세요.`),
      { lockBusy: true },
    );
  }
  try {
    return await fn();
  } finally {
    r.release();
  }
}

/**
 * 두 프로세스가 동시에 이름표를 만들면 서로를 보고 둘 다 물러난다. 그래서 기다리지 않는 경우에도
 * 무작위 간격으로 최소 몇 번은 다시 시도한다 (살아 있는 주인이 있으면 몇 번 시도해도 계속 실패한다).
 */
const MIN_TRIES = 4;
const backoffMs = () => 20 + Math.floor(Math.random() * 80);

/** waitMs 동안 다시 시도하며 잠금을 잡는다. */
export async function acquire(file, label, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  for (let i = 1; ; i++) {
    const r = tryLock(file, label);
    if (r.release || (i >= MIN_TRIES && Date.now() >= deadline)) return r;
    await sleep(backoffMs());
  }
}

/** acquire의 동기 버전 (기다리지 않음). 요청 처리 중에 바로 잠가야 하는 곳(UI 작업 시작)에서 쓴다. */
export function acquireNow(file, label) {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 1; ; i++) {
    const r = tryLock(file, label);
    if (r.release || i >= MIN_TRIES) return r;
    Atomics.wait(waitCell, 0, 0, backoffMs());
  }
}
