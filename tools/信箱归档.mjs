#!/usr/bin/env node
// 信箱归档：把办完的条子从主文件搬到按月文件，主文件不再越攒越大。
//
// 四条硬规矩（跟手机那头说定的）：
//   1. 只搬 [x]。扫到 [ ] 在要搬的那段里，直接停手，一个字都不写。
//   2. 触发看行数，不看时间。两边时钟对不齐。
//   3. 各清各的。谁的信箱谁搬，不碰对面那份。
//   4. 搬走不删。按月一个文件，接在后面写。
//
// 用法：
//   node tools/信箱归档.mjs notes/pc/信箱-电脑.md
//   node tools/信箱归档.mjs notes/pc/信箱-电脑.md --max-lines 600 --max-open 150
//   node tools/信箱归档.mjs notes/pc/信箱-电脑.md --dry      // 只看会搬几条，不动手
//   node tools/信箱归档.mjs notes/pc/信箱-电脑.md --keep-recent 0  // 连最新的已办也搬（默认留 30 条）

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MARK = '<!-- 归档指路 -->';

function parseArgs(argv) {
  const out = { file: null, maxLines: 600, maxOpen: 150, keepRecent: 30, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--max-lines') out.maxLines = Number(argv[++i]);
    else if (a === '--max-open') out.maxOpen = Number(argv[++i]);
    else if (a === '--keep-recent') out.keepRecent = Number(argv[++i]);
    else if (!a.startsWith('--')) out.file = a;
  }
  return out;
}

// 把文本切成「头（整篇的标题、说明、指路行）」和「一条条」。
// 一条的判定：行首是 "- [ ]" 或 "- [x]"，往下的缩进行算这条的续行。
function split(text) {
  const lines = text.split(/\r?\n/);
  const head = [];
  const items = [];
  let cur = null;
  for (const line of lines) {
    if (/^- \[[ xX]\]/.test(line)) {
      if (cur) items.push(cur);
      cur = { lines: [line], done: /^- \[[xX]\]/.test(line) };
    } else if (/^\s+\S/.test(line) && cur) {
      cur.lines.push(line);
    } else if (cur) {
      items.push(cur);
      cur = null;
      head.push(line);
    } else {
      head.push(line);
    }
  }
  if (cur) items.push(cur);
  return { head, items };
}

function countLines(items) {
  return items.reduce((n, it) => n + it.lines.length, 0);
}

function todayMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.file) {
    console.error('要一个信箱文件：node tools/信箱归档.mjs <信箱.md> [--dry]');
    process.exit(2);
  }
  const file = path.resolve(opt.file);
  if (!existsSync(file)) {
    console.error(`没有这个文件：${file}`);
    process.exit(2);
  }

  const raw = await readFile(file, 'utf8');
  const { head, items } = split(raw);
  const totalLines = raw.split(/\r?\n/).length;
  const done = items.filter((it) => it.done).length;
  const open = items.length - done;
  const itemLines = countLines(items);

  console.log(`文件 ${path.basename(file)}：${totalLines} 行，${items.length} 条（已办 ${done}、未办 ${open}）`);
  console.log(`阈值：${opt.maxLines} 行 / 未办 ${opt.maxOpen} 条`);

  if (totalLines <= opt.maxLines && open <= opt.maxOpen) {
    console.log('没到线，不搬。');
    return;
  }
  if (open > opt.maxOpen) {
    console.error(`未办 ${open} 条，超过 ${opt.maxOpen}——先把没办的办掉再归档，不然搬走的全是没动的。`);
    process.exit(1);
  }

  // 保住最新的 30 条已办不搬，其余从最老的开始搬，搬到主文件回落到阈值一半为止。
  const keepRecent = opt.keepRecent;
  const doneIdx = items.map((it, i) => (it.done ? i : -1)).filter((i) => i >= 0);
  const movable = doneIdx.slice(0, Math.max(0, doneIdx.length - keepRecent));
  const target = Math.max(1, Math.floor(opt.maxLines / 2));

  const move = [];
  let remainLines = totalLines;
  for (const i of movable) {
    if (remainLines <= target) break;
    move.push(i);
    remainLines -= items[i].lines.length;
  }

  if (move.length === 0) {
    console.log(`没有能搬的（已办里扣掉最近 ${keepRecent} 条之后是空的）。`);
    return;
  }

  // 规矩 1 的兜底断言：move 只由 [x] 的索引构成，这里再核一遍。
  // 真出问题时（done 判定错、文件被手改），宁可停手也不静默搬走没办的。
  const bad = move.filter((i) => !items[i].done);
  if (bad.length) {
    console.error(`要搬的 ${bad.length} 条里混着未办，停手，什么都没写。`);
    process.exit(1);
  }

  const archiveName = `${path.basename(file, '.md')}-归档-${todayMonth()}.md`;
  const archivePath = path.join(path.dirname(file), archiveName);

  if (opt.dry) {
    console.log(`[dry] 会搬 ${move.length} 条到 ${archiveName}，主文件剩 ${totalLines - countLines(move.map((i) => items[i]))} 行左右。`);
    return;
  }

  const moved = new Set(move);
  const archiveLines = move.map((i) => items[i].lines.join('\n'));

  // 归档文件：第一次建时写个抬头；之后接在后面。
  let headOfArchive = '';
  if (!existsSync(archivePath)) {
    headOfArchive = `# ${path.basename(file, '.md')} 归档 ${todayMonth()}\n\n只追加，不删。旧的已办条目从主信箱搬到这里。\n\n`;
  }
  const oldArchive = existsSync(archivePath) ? await readFile(archivePath, 'utf8') : '';
  const sep = oldArchive && !oldArchive.endsWith('\n') ? '\n' : '';
  await atomicWrite(archivePath, `${oldArchive}${sep}${headOfArchive}${archiveLines.join('\n')}\n`);

  // 主文件：头部留着，指路行幂等（每次整行重写，不追加），条目去掉搬走的。
  const cleanHead = head.filter((l) => !l.startsWith(MARK));
  cleanHead.push(`${MARK} 更早的已办见 ${archiveName}`);
  const body = items.filter((_, i) => !moved.has(i)).map((it) => it.lines.join('\n'));
  const out = [...cleanHead, ...body].join('\n').replace(/\n{3,}/g, '\n\n');
  await atomicWrite(file, out.endsWith('\n') ? out : `${out}\n`);

  console.log(`搬了 ${move.length} 条 → ${archiveName}`);
  console.log(`主文件现在 ${out.split(/\r?\n/).length} 行、${items.length - move.length} 条。`);
  console.log(`条目一共 ${itemLines} 行，搬走 ${countLines(move.map((i) => items[i]))} 行。`);
}

main().catch((e) => {
  console.error(`出错：${e.message}`);
  process.exit(1);
});


