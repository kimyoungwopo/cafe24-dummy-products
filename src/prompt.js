import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirm(question) {
  const answer = (await ask(`${question} (y/N): `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}
