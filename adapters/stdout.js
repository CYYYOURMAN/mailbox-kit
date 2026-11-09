// 最简适配层：叫醒的方式就是把信打印出来。
// 拿它跑测试、接 cron、或者给还没写适配层的引擎兜底。

import { formatLetters } from '../src/index.js';

export function stdoutAdapter({ out = console.log, max = 5 } = {}) {
  return async function wake(letters) {
    out(formatLetters(letters, { max }));
  };
}

export default stdoutAdapter;
