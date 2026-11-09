#!/usr/bin/env node
// mailboxd：拿一份配置启动信箱守护。
//   node bin/mailboxd.js --config mailbox.config.json
// 配置里写 adapter：stdout / balloon，或者 "模块路径#导出名"。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMailbox } from '../src/index.js';
import { acquireLock } from '../src/lock.js';
import { stdoutAdapter } from '../adapters/stdout.js';
import { balloonAdapter } from '../adapters/balloon.js';

const args = process.argv.slice(2);
const ci = args.indexOf('--config');
const configPath = ci >= 0 ? args[ci + 1] : 'mailbox.config.json';
if (!configPath) {
  console.error('用法：node bin/mailboxd.js --config <配置文件>');
  process.exit(2);
}

const raw = JSON.parse(await readFile(configPath, 'utf8'));
const base = path.dirname(path.resolve(configPath));

function resolveOne(p) {
  return p ? path.resolve(base, p) : undefined;
}

async function pickAdapter(spec, opts) {
  if (!spec || spec === 'stdout') return stdoutAdapter(opts);
  if (spec === 'balloon') return balloonAdapter(opts);
  const [modPath, exportName = 'default'] = String(spec).split('#');
  const mod = await import(pathToFileURL(path.resolve(base, modPath)).href);
  const fn = mod[exportName];
  if (typeof fn !== 'function') throw new Error(`适配层 ${spec} 找不到导出 ${exportName}`);
  return fn(opts);
}

const adapterOpts = raw.adapterOptions ?? {};
const wake = await pickAdapter(raw.adapter, adapterOpts);

// 同一个信箱只让一个进程扫，两个抢同一份指纹会互相吞信。
const lockFile = resolveOne(raw.lockPath) ?? path.join(base, 'mailboxd.lock');
const lock = await acquireLock(lockFile);
if (!lock.ok) {
  console.error(`已经有一个在跑了（${lock.holder}），不重复起。`);
  process.exit(3);
}

const box = createMailbox({
  dir: resolveOne(raw.dir),
  self: raw.self,
  prefix: raw.prefix,
  ext: raw.ext,
  seenPath: resolveOne(raw.seenPath),
  logPath: resolveOne(raw.logPath),
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
    await wake(letters);
    ack();
  } catch (err) {
    nack(err.message);
  }
});

box.on('failed', ({ letters, why, gaveUp }) => {
  console.error(`投递失败（${why}），${letters.length} 条${gaveUp ? `，弃 ${gaveUp}` : '，下次重投'}`);
});

await box.start();

if (args.includes('--once')) {
  // 跑一轮就退，用来验配置
  box.stop();
  process.exit(0);
}

const bye = () => {
  box.stop();
  lock.release();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

console.log(`信箱守护起来了：${box.dir}（自己=${box.self}）`);


