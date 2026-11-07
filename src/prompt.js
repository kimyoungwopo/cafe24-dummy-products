import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

/**
 * 한 줄 입력을 받는다. 입력이 닫혀 있으면(파이프·스크립트 등) 빈 문자열로 끝난다 — 멈추지 않는다.
 * options.signal로 중단하면 null을 돌려준다.
 */
export function ask(question, { signal } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => finish(null);
    if (signal?.aborted) return finish(null);
    signal?.addEventListener?.('abort', onAbort);
    rl.on('close', () => finish(''));
    rl.question(question, (answer) => finish(answer));
  });
}

/** y/yes일 때만 true. 입력이 없거나 닫혀 있으면 false(취소). */
export async function confirm(question) {
  const answer = String((await ask(`${question} (y/N): `)) ?? '').trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** 입력 내용이 화면에 보이지 않게 받는다 (Client Secret 등). 터미널이 아니면 일반 입력과 같다. */
export function askHidden(question) {
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    let muted = false;
    let settled = false;
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s);
    };
    const finish = (v) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(v);
    };
    rl.on('close', () => finish(''));
    rl.question(question, (answer) => {
      rl.output.write('\n');
      finish(answer);
    });
    muted = true;
  });
}
