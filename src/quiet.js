/**
 * Node 18에서 fetch를 처음 쓸 때 나오는 "Fetch API is an experimental feature" 경고만 숨긴다.
 * (처음 쓰는 사람에게 오류처럼 보이기 때문. 다른 경고는 그대로 보여 준다)
 * cli.js에서 가장 먼저 import해야 한다.
 */
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === 'string' ? warning : warning?.message;
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type ?? warning?.name;
  if (type === 'ExperimentalWarning' && /Fetch API/.test(String(text))) return;
  return emitWarning.call(process, warning, ...args);
};
