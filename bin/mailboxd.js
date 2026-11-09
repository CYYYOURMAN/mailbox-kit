#!/usr/bin/env node
// mailboxd：拿一份配置启动信箱守护。
//   node bin/mailboxd.js --config mailbox.config.json
//   node bin/mailboxd.js --config mailbox.config.json --once     跑一轮就退（验配置）
//   node bin/mailboxd.js --config mailbox.config.json --ui       顺便起本机网页
//   node bin/mailboxd.js --setup                                 问答式生成配置
// 配置里写 adapter：stdout / balloon，或者 "模块路径#导出名"。
//
// 路径一律按「配置文件所在目录」解析，不按 cwd——双击跑的时候 cwd 是随机的。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createMailbox } from '../src/index.js';
import { rm } from 'node:fs/promises';
import { acquireLock } from '../src/lock.js';
import { createUiServer } from '../src/ui.js';
import { stdoutAdapter } from '../adapters/stdout.js';
import { balloonAdapter } from '../adapters/balloon.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// ---------- --setup：问答生成配置 ----------
// 两条路：终端里逐条问；管道喂进来就一次性读完按行取（管道给 readline 会卡住）。
async function askAll(prompts) {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    const out = [];
    try {
      for (const p of prompts) out.push((await rl.question(p)).trim());
    } finally {
      rl.close();
    }
    return out;
  }
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return prompts.map((_, i) => (lines[i] ?? '').trim());
}

if (has('--setup')) {
  {
    console.log('问答式配置。一路回车用默认值，最后写成一个 json。\n');
    const [dirInRaw, selfRaw, peerRaw, prefixRaw, outRaw] = await askAll([
      '信箱目录（放 md 文件的文件夹）: ',
      '自己叫什么（很短，比如 pc、phone、电脑）: ',
      '对面叫什么（同上，留空就只用前缀扫）: ',
      '文件名前缀 [inbox-]: ',
      '配置写到哪 [mailbox.config.json]: ',
    ]);
    const dirIn = dirInRaw;
    if (!dirIn) {
      console.error('没有目录，算了。');
      process.exit(2);
    }
    const self = selfRaw || 'me';
    const peer = peerRaw;
    // 前缀留空就从目录里已有的文件名反推，别硬塞 inbox-（目录里叫「信箱-手机.md」就全对不上）
    let guessed = 'inbox-';
    try {
      const names = readdirSync(path.resolve(dirIn)).filter(
        (n) => n.endsWith('.md') && !/sync-conflict/.test(n)
      );
      if (names.length) {
        const cut = names[0].indexOf('-');
        const pre = cut > 0 ? names[0].slice(0, cut + 1) : '';
        if (pre && names.every((n) => n.startsWith(pre))) guessed = pre;
      }
    } catch {}
    const prefix = prefixRaw || guessed;
    if (!prefixRaw && guessed !== 'inbox-') console.log('据目录里的文件名，前缀用「' + guessed + '」。不对就重跑，手动填。');
    const outIn = outRaw || 'mailbox.config.json';

    const cfg = {
      dir: path.resolve(dirIn),
      self,
      prefix,
      ext: '.md',
      adapter: 'stdout',
      pollMs: 60000,
      debounceMs: 3000,
      minGapMs: 5000,
      quietFrom: '00:30',
      quietTo: '08:30',
      firstRunSilent: false,
    };
    if (peer) cfg.read = [prefix + peer + '.md'];
    // 目录可能还不存在：先建，别让人看到一屏 Node 堆栈。
    try {
      await mkdir(cfg.dir, { recursive: true });
    } catch (e) {
      console.error('目录建不起来：' + e.message);
      process.exit(2);
    }

    // 自己那份要拼得出来。拼错的话软件能跑，但一条信也读不到，而且不报错——所以在这儿拦一次。
    const selfName = cfg.selfFile || prefix + self + cfg.ext;
    const selfPath = path.join(cfg.dir, selfName);
    if (!existsSync(selfPath)) {
      let cands = [];
      try {
        cands = readdirSync(cfg.dir).filter((n) => n.endsWith(cfg.ext));
      } catch {}
      console.log('\n注意：' + selfPath + ' 现在不存在。');
      if (cands.length) console.log('这个目录里现有：' + cands.join('、'));
      console.log('要是文件名不按「前缀+自己+后缀」拼，请在配置里加一项 selfFile（自己那份的完整文件名）。');
      console.log('不然写信会写进一个没人读的新文件，界面也看不到自己那几条。');
    }

    const outFile = path.resolve(outIn);
    await writeFile(outFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('\n写好了：' + outFile);
    console.log('跑起来：mailboxd --config "' + outFile + '"');
    console.log('想用网页看信，加一个 --ui。');
  }
  process.exit(0);
}

// ---------- 正常启动 ----------
const configPath = val('--config', 'mailbox.config.json');
let absConfig = path.resolve(configPath);
// 不带任何参数、目录里又没有配置：直接进问答，别让人先学再跑
if (!existsSync(absConfig) && args.length === 0) {
  console.log('第一次跑，先问几个问题。');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [process.argv[1], '--setup'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 2);
  absConfig = path.resolve(configPath);
}
if (!existsSync(absConfig)) {
  console.error('找不到配置：' + absConfig);
  console.error('用法：直接 node bin/mailboxd.js（第一次会问你几个问题），或者 --setup 单独生成一份配置。');
  process.exit(2);
}

const raw = JSON.parse(await readFile(absConfig, 'utf8'));
const base = path.dirname(absConfig);

// ---------- --reset-seen：清掉指纹库，让旧信重新投一遍 ----------
// 改名、加别名之后用。只清指纹，不碰信箱文件本身。
if (has('--reset-seen')) {
  const seenAbs = path.resolve(base, raw.seenPath ?? `.mailbox-seen-${raw.self}.json`);
  if (existsSync(seenAbs)) {
    await rm(seenAbs, { force: true });
    console.log('清掉了：' + seenAbs);
    console.log('下次启动会把信箱里没办的信重新看一遍；已经标 [x] 的不会投。');
  } else {
    console.log('本来就没有指纹库：' + seenAbs);
  }
  process.exit(0);
}

function resolveOne(p) {
  return p ? path.resolve(base, p) : undefined;
}

async function pickAdapter(spec, opts) {
  if (!spec || spec === 'stdout') return stdoutAdapter(opts);
  if (spec === 'balloon') return balloonAdapter(opts);
  const [modPath, exportName = 'default'] = String(spec).split('#');
  const mod = await import(pathToFileURL(path.resolve(base, modPath)).href);
  const fn = mod[exportName];
  if (typeof fn !== 'function') throw new Error('适配层 ' + spec + ' 找不到导出 ' + exportName);
  return fn(opts);
}

const adapterOpts = raw.adapterOptions ?? {};
const wake = await pickAdapter(raw.adapter, adapterOpts);

// 同一个信箱只让一个进程扫，两个抢同一份指纹会互相吞信。
const lockFile = resolveOne(raw.lockPath) ?? path.join(base, 'mailboxd.lock');
const lock = await acquireLock(lockFile);
if (!lock.ok) {
  console.error('已经有一个在跑了（' + lock.holder + '），不重复起。');
  process.exit(3);
}

const box = createMailbox({
  dir: resolveOne(raw.dir),
  self: raw.self,
  prefix: raw.prefix,
  ext: raw.ext,
  seenPath: resolveOne(raw.seenPath),
  logPath: resolveOne(val('--log', raw.logPath)),
  debounceMs: raw.debounceMs,
  minGapMs: raw.minGapMs,
  pollMs: raw.pollMs,
  quietFrom: raw.quietFrom,
  quietTo: raw.quietTo,
  maxRetries: raw.maxRetries,
  seenLimit: raw.seenLimit,
  firstRunSilent: raw.firstRunSilent,
  read: raw.read,
});

box.on('letters', async ({ letters, ack, nack }) => {
  try {
    const ok = await wake(letters);
    // 适配层明确说没送到（返回 false），就别记指纹，让核心重投。
    // 返回 undefined 或 true 都算送到了。
    if (ok === false) nack('适配层返回 false，没送到');
    else ack();
  } catch (err) {
    nack(err.message);
  }
});

box.on('failed', ({ letters, why, gaveUp }) => {
  console.error('投递失败（' + why + '），' + letters.length + ' 条' + (gaveUp ? '，弃 ' + gaveUp : '，下次重投'));
});

await box.start();

if (has('--once')) {
  box.stop();
  process.exit(0);
}

// ---------- 可选：本机网页 ----------
let ui = null;
if (has('--ui')) {
  ui = createUiServer({
    dir: box.dir,
    self: box.self,
    prefix: raw.prefix,
    ext: raw.ext,
    read: raw.read,
    selfFile: raw.selfFile,
    port: Number(val('--port', raw.uiPort || 7654)),
    log: (s) => console.log(s),
  });
  const { url } = await ui.listen();
  console.log('网页：' + url);
  console.log('（这个地址带口令，别贴出去。只在本机能开。）');
}

const bye = async () => {
  box.stop();
  if (ui) await ui.close();
  lock.release();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

console.log('信箱守护起来了：' + box.dir + '（自己=' + box.self + '）');

