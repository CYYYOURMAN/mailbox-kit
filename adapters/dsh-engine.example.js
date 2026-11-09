// dsh-engine.example.js —— 在 DeepSeek Harness（DSH）里接 mailbox-kit 的骨架。
//
// 这不是一个能直接跑的文件，是一份照着抄的模板：把下面几个函数填成你那边的
// 「拿会话、塞消息、看醒没醒」，别的全交给核心。四个坑都标了，踩过。
//
// 装法（DSH）：
//   1. 建一个插件包，package.json 里写
//        "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
//      cordis.patch.yml 写：
//        - insert:
//            - id: my-mailbox
//              name: my-mailbox
//   2. 依赖里写 "mailbox-kit": "file:<路径>"，装进 profile：
//        dsh plugin --profile <名字> add <包目录>
//   3. 重启引擎（命令行 dump-config 不行，profile 归 Electron 管）。
//
// 选窗口和「醒没醒」这两件事，核心不管——那是引擎侧的事，就在这里做。
//
// 第五个坑（2026-11-09 两边同时踩到）：热重载。
//   改完代码想不重启就换上，常见做法是「写个标记文件 → 掐掉旧实例 → 重新 import → 再挂一次」。
//   问题在「再挂一次」：apply 会在同一个进程里跑第二遍，里面那个
//     setTimeout(() => box.start(), 10000)
//   如果没清，十秒后旧的那个照样触发，于是同一进程里起了第二个守护，两个 watcher 抢同一份文件。
//   光在自唤醒那里加个 globalThis 开关不够——那只挡住「重复叫醒」，挡不住重复 start。
//   正确做法：把定时器句柄挂到 globalThis（如 __mailboxBootTimer），新一轮 apply 的第一句就 clearTimeout 掉。
//   验法：热重载后日志里「启动 …」只该出现一行，watcher 只该有一份。

import { readFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createMailbox, formatLetters } from 'mailbox-kit';

export const name = 'my-mailbox';
export const inject = [];

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh');
const CONFIG_PATH = join(HOME, 'my-mailbox.json');
const LOG_PATH = join(HOME, 'my-mailbox.log');
const SESSIONS_DIR = join(HOME, 'sessions');

function log(text) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {}
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 选窗口
//
// 坑四：别用文件 mtime 挑「最近用的窗口」。同步工具会碰 mtime，备份也会，
// 结果挑出来的是别人刚碰过的那个，不是人正在说话的那个。
// 真正的信号在会话记录里：最后一条「人说」的消息。插件自己投进去的不算，
// 否则它自己把自己越投越热。
// ---------------------------------------------------------------------------

const lastUserCache = new Map();

function lastUserTime(file) {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return 0;
  }
  const hit = lastUserCache.get(file);
  if (hit && hit.mtime === mtime) return hit.time;

  let time = 0;
  try {
    const text = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.includes('"user/message"')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.data?.source?.kind === 'schedule') continue;
        time = Number(obj?.time) || 0;
        break
      } catch {}
    }
  } catch {
    // 解不开就当没有，退回文件时间
  }
  if (!time) time = mtime;
  lastUserCache.set(file, { mtime, time });
  return time;
}

/** 有 sessionIds 名单就只在名单里挑，没有就全部里挑。 */
function pickSession(config) {
  const want = Array.isArray(config.sessionIds) && config.sessionIds.length ? new Set(config.sessionIds) : null;
  let best = '';
  let bestTime = 0;
  let scopes = [];
  try {
    scopes = readdirSync(SESSIONS_DIR);
  } catch {
    return '';
  }
  for (const scope of scopes) {
    let inner = [];
    try {
      inner = readdirSync(join(SESSIONS_DIR, scope));
    } catch {
      continue;
    }
    for (const folder of inner) {
      if (want && !want.has(folder) && !want.has(folder.replace(/^session-/, ''))) continue;
      const t = lastUserTime(join(SESSIONS_DIR, scope, folder, 'session.v4.jsonl.zstd'));
      if (t > bestTime) {
        bestTime = t;
        best = folder;
      }
    }
  }
  return best;
}

function findSessionFile(id) {
  let scopes = [];
  try {
    scopes = readdirSync(SESSIONS_DIR);
  } catch {
    return '';
  }
  for (const scope of scopes) {
    const file = join(SESSIONS_DIR, scope, id, 'session.v4.jsonl.zstd');
    try {
      statSync(file);
      return file;
    } catch {}
  }
  return '';
}

async function resolveAgent(ctx, config) {
  // 坑一：插件加载那一瞬，服务表还没挂全，ctx.get 会返回空。多试几拍，别一次就认输。
  let controller;
  for (let i = 0; i < 6; i += 1) {
    controller = ctx.get('sessionController');
    if (controller && typeof controller.resolveAgent === 'function') break;
    await new Promise((r) => setTimeout(r, 300));
    controller = undefined;
  }
  if (!controller) {
    log('拿不到 sessionController');
    return {};
  }

  const fixed = config.sessionId && config.sessionId !== 'auto' ? config.sessionId : '';
  const id = fixed || pickSession(config);
  if (!id) {
    log('找不到会话号');
    return {};
  }
  // 带不带 session- 前缀两种都试，各版本叫法不一
  for (const key of [...new Set([id, id.replace(/^session-/, ''), `session-${id}`])]) {
    try {
      const found = await controller.resolveAgent(key);
      if (found && !('error' in found) && found.agent) return { agent: found.agent, id: key };
      if (found && 'error' in found) {
        log(`会话 ${key} 解析失败：${found.error?.message ?? found.error}`);
      }
    } catch (error) {
      log(`会话 ${key} 解析抛错：${error?.message ?? error}`);
    }
  }
  return {};
}

/**
 * 醒没醒。
 *
 * followup 成功只代表消息进了队列——会话正忙时它排队，看着像成了，其实还没递到眼前。
 * 最硬的信号是会话状态；拿不到就退一步看文件长没长（只能说明引擎在写，不等于它看见了）。
 */
function watchWake(ctx, config, id, sizeBefore) {
  const check = async (tag) => {
    const again = await resolveAgent(ctx, { ...config, sessionId: id });
    const agent = again.agent;
    const status = agent?.status ? String(agent.status) : '';
    if (status) {
      log(`投递确认（${tag}）会话=${id} status=${status}`);
      return status === 'running';
    }
    let grew = -1;
    try {
      const file = findSessionFile(id);
      if (file) grew = statSync(file).size !== sizeBefore ? 1 : 0;
    } catch {}
    log(`投递确认（${tag}）会话=${id} 没拿到状态，文件${grew === 1 ? '动过' : grew === 0 ? '没动' : '找不到'}`);
    return grew === 1;
  };
  setTimeout(() => check('一分钟'), 60 * 1000).unref?.();
  setTimeout(() => check('三分钟'), 180 * 1000).unref?.();
}

export function apply(ctx) {
  // 坑三：热重载时旧实例的定时器和目录监听还挂着，两个实例会抢同一份指纹。
  // 用 globalThis 留个把手，新实例上来先把旧的掐掉。
  const prev = globalThis.__myMailbox;
  if (prev && typeof prev.stop === 'function') {
    try {
      prev.stop();
    } catch {}
  }

  const config = readConfig();
  const box = createMailbox({
    dir: config.dir,
    self: config.self,
    read: config.read,
    seenPath: config.seenPath,
    logPath: LOG_PATH,
    quietFrom: config.quietFrom,
    quietTo: config.quietTo,
    maxRetries: config.maxRetries ?? 10,
  });
  globalThis.__myMailbox = box;

  box.on('letters', async ({ letters, ack, nack }) => {
    const { agent, id } = await resolveAgent(ctx, config);
    if (!agent) {
      nack('没有可投递的会话');
      return;
    }
    const text = `${formatLetters(letters, { max: 8 })}\n办完把原行改成 [x]。`;
    // 手搓一条 user 消息：DSH 的 createUserMessage 就是加 role，其余字段照 shape 给
    const message = structuredClone({
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'schedule' },
      id: randomUUID(),
    });
    const file = findSessionFile(id);
    let sizeBefore = 0;
    try {
      sizeBefore = file ? statSync(file).size : 0;
    } catch {}
    await agent.followup(message);
    try {
      await ctx.sessions?.flush?.(agent.session);
    } catch {}
    log(`投了 ${letters.length} 条 会话=${agent.session?.id ?? id} 已入队`);
    ack();
    watchWake(ctx, config, id, sizeBefore);
  });

  box.on('failed', ({ letters, why, gaveUp }) => {
    log(`投递失败（${why}），${letters.length} 条${gaveUp ? `，弃 ${gaveUp}` : '，下次重投'}`);
  });

  // 坑二：start 立刻跑第一轮，那时服务还没齐。延后十秒，别省这一下。
  setTimeout(() => {
    box.start().catch((error) => log(`起不来：${error?.message ?? error}`));
  }, 10000);

  log(`插件加载 目录=${config.dir} 自己=${config.self}`);
}
