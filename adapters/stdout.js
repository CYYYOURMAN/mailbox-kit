// 最简适配层：叫醒的方式就是把信打印出来。
// 拿它跑测试、接 cron、或者给还没写适配层的引擎兜底。

import { formatLetters } from '../src/index.js';

export function stdoutAdapter({ out = console.log, max = 5 } = {}) {
  return async function wake(letters) {
    out(formatLetters(letters, { max }));
    return true; // 打印出来就算送到，核心据此记指纹
  };
}

export default stdoutAdapter;
