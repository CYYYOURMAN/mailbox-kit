// mailbox.js —— 只做三件事：找出哪些文件是本箱、把文件拆成条、给每条算指纹。
// 不认识引擎，不认识平台，不碰网络。纯 node: 内置。

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一条未办：`- [ ] 16:55 正文`，续行缩进两格。
const ITEM_RE = /^- \[([ xX])\]\s+(.*)$/;
const CONT_RE = /^\s{2,}(\S.*)$/;
// 附件行：`附件: 附件/x.png`，路径按信箱目录算，不写本机绝对路径（另一个平台读不到）。
const ATT_RE = /^附件\s*[:：]\s*(.+)$/;
// 收件人：`16:55 甲→乙：正文`。只认第一行、只取第一个箭头，正文里的箭头不算。
// 箭头三种写法都认，冒号全角半角都认。`from` / `to` 拿不到就留空，当广播。
const HEAD_RE = /^(?:\d{1,2}:\d{2}\s+)?([^\s→>⇒:：]{1,32})\s*(?:→|->|⇒)\s*([^\s→>⇒:：]{1,32})\s*[:：]\s*([\s\S]*)$/;

/** 名字归一化：去空格、全角转半角、转小写。两边算同一个名字用。 */
export function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 从一条信的第一行里认出「谁写的、写给谁」。认不出就返回空串。 */
export function parseHead(body) {
  const first = String(body || '').split('\n')[0] || '';
  const m = HEAD_RE.exec(first);
  if (!m) return { from: '', to: '' };
  return { from: m[1].trim(), to: m[2].trim() };
}

/**
 * 把一份信箱文本拆成条目。
 * @returns {{done:boolean, body:string, line:number, attachments:string[]}[]}
 */
export function parseLetters(text) {
  const out = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = ITEM_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { done: m[1] !== ' ', body: m[2].trim(), line: i + 1, attachments: [], from: '', to: '' };
      continue;
    }
    const c = CONT_RE.exec(line);
    if (c && cur) {
      cur.body += '\n' + c[1].trim();
      continue;
    }
    if (cur && line.trim() === '') continue;
    if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  for (const item of out) {
    const kept = [];
    for (const line of item.body.split('\n')) {
      const a = ATT_RE.exec(line.trim());
      if (a) item.attachments.push(a[1].trim());
      else kept.push(line);
    }
    item.body = kept.join('\n').trim();
    const h = parseHead(item.body);
    item.from = h.from;
    item.to = h.to;
  }
  return out;
}

/**
 * 看一眼附件在不在、多大。只在信箱目录底下找，穿出去的一律当没有。
 * @returns {Promise<{rel:string, exists:boolean, size:number}>}
 */
export async function checkAttachment(dir, rel) {
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { rel, exists: false, size: 0 };
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) return { rel, exists: false, size: 0 };
    return { rel, exists: true, size: s.size };
  } catch {
    return { rel, exists: false, size: 0 };
  }
}

/**
 * 文件名说方向：inbox-<写者>.md。
 * 加第三个人不用改代码，方向也不会在正文里抄错。
 * 同步工具的冲突文件（inbox-pc.sync-conflict-....md）也算同一写者。
 */
export function writerOf(fileName, { prefix = 'inbox-', ext = '.md' } = {}) {
  const base = path.basename(fileName);
  if (!base.startsWith(prefix)) return null;
  if (!base.includes(ext)) return null;
  const rest = base.slice(prefix.length);
  const m = /^([A-Za-z0-9_-]+)/.exec(rest);
  return m ? m[1] : null;
}

export function isConflict(fileName) {
  return /sync-conflict|\.conflict[-.]/i.test(path.basename(fileName));
}

/**
 * 列出本箱要读的文件。
 * 两种给法：
 *   一、按前缀扫目录，跳过自己写的那份（默认，适合「一写者一读者」对不上号之前的图省事）；
 *   二、直接写死要读哪几份（`read: ['信箱-手机.md']`），文件名不守约定也能用。
 * 冲突文件（sync-conflict）一并算进来，漏读就是丢信。
 */
export async function listBoxFiles(dir, { self, prefix = 'inbox-', ext = '.md', read = null } = {}) {
  let names = [];
  const listed = Array.isArray(read) && read.length > 0;
  if (listed) {
    const bases = read.map((n) => path.basename(n, ext));
    let all = [];
    try {
      all = await readdir(dir);
    } catch {}
    names = all.filter(
      (n) => bases.some((b) => n === `${b}${ext}` || (n.startsWith(b) && isConflict(n))),
    );
    if (!names.length) names = read.map((n) => path.basename(n));
  } else {
    try {
      names = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    names = names.filter((n) => writerOf(n, { prefix, ext }));
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, path.basename(name));
    const w = writerOf(name, { prefix, ext }) ?? path.basename(name).replace(new RegExp(`${ext}$`), '').replace(new RegExp(`^${prefix}`), '');
    if (!w) continue;
    if (!listed && w.toLowerCase() === String(self).toLowerCase()) continue;
    out.push({ file, writer: w, conflict: isConflict(name) });
  }
  return out;
}

/**
 * 读到一半被同步工具改写的文件会读成空串或半截。
 * 内容非空、字节数又跟文件大小对得上，就算读全了；对不上就等一下再读一次。
 */
export async function readStable(file, { tries = 3, delayMs = 250 } = {}) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const text = await readFile(file, 'utf8');
    const size = (await stat(file)).size;
    const whole = text.length > 0 && Buffer.byteLength(text, 'utf8') === size;
    if (whole && (prev === null || prev === text)) return text;
    if (text === '' && size > 0) {
      await sleep(delayMs);
      continue;
    }
    if (prev !== null && prev === text) return text;
    prev = text;
    if (i < tries - 1) await sleep(delayMs);
  }
  return prev ?? '';
}

/** 指纹：写者 + 正文。同样的正文换一天写也算同一条，所以不带时间。 */
export function fingerprint(writer, body) {
  const norm = String(body).replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${writer}\u0000${norm}`).digest('hex').slice(0, 16);
}

