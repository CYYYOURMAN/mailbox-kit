// log.js —— 一行一轮，追加写。日志挂了不许把主流程带翻。
// 超过 maxBytes 就改名成 .1（旧的顺次挪），最多留 keep 份，免得跑几个月变成几兆。

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export function createLogger(file, { maxBytes = 1024 * 1024, keep = 2 } = {}) {
  if (!file) {
    return () => {};
  }
  let ready = null;
  let size = null;
  let lastCheck = 0;

  async function rotateIfNeeded() {
    if (size === null) {
      try {
        size = (await stat(file)).size;
      } catch {
        size = 0;
      }
    }
    if (size < maxBytes) return;
    // 从最老的一份开始往后挪：x.2 覆盖，x.1 挪成 x.2，x 挪成 x.1
    for (let i = keep - 1; i >= 1; i -= 1) {
      try {
        await rename(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {}
    }
    try {
      await rename(file, `${file}.1`);
    } catch {}
    size = 0;
  }

  // 本地时间，不带时区。原来用 toISOString() 是 UTC，跟对面机器对时间会差好几个小时，
  // 排「谁说晚了」这种问题时能把人绕死。
  return async function log(line) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const text = `[${stamp}] ${line}\n`;
    try {
      if (!ready) ready = mkdir(path.dirname(file), { recursive: true });
      await ready;
      // 一秒查一次大小就够，别每行都 stat
      const now = Date.now();
      if (now - lastCheck > 1000) {
        lastCheck = now;
        await rotateIfNeeded();
      }
      await appendFile(file, text, 'utf8');
      if (size !== null) size += Buffer.byteLength(text, 'utf8');
    } catch {
      // 写不进日志就算了，别把投递拦住
    }
  };
}
