// 文件信箱：几份 Markdown 文件 + 一个 wake()。
// 核心不认识引擎，不认识平台；换引擎只换 adapters 里那一层。

export { createMailbox, Mailbox } from './runner.js';
export {
  parseLetters,
  writerOf,
  isConflict,
  listBoxFiles,
  readStable,
  fingerprint,
  checkAttachment,
} from './mailbox.js';
export { acquireLock } from './lock.js';
export { SeenStore } from './seen.js';
export { createLogger } from './log.js';

/** 把一批信排成给人看的短文本。适配层拿它去弹、去说、去发。 */
export function formatLetters(letters, { max = 5, width = 120 } = {}) {
  const head = letters.slice(0, max).map((l) => {
    const lines = l.body.split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
    const att = (l.attachments ?? []).length
      ? ` 〔附件 ${l.attachments
          .map((a) => `${a.rel}${a.exists ? ` ${Math.max(1, Math.round(a.size / 1024))}K` : ' 丢了'}`)
          .join('、')}〕`
      : '';
    return `· ${lines.length > width ? `${lines.slice(0, width)}…` : lines}${att}`;
  });
  const more = letters.length > max ? `\n· 还有 ${letters.length - max} 条` : '';
  return `信箱有 ${letters.length} 条新信\n${head.join('\n')}${more}`;
}
