// runner.js —— 主循环：扫、筛、防抖、冷却、静默、投、失败重投。
// 只管「什么时候把哪几条交给谁」，不管怎么叫醒。

import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import path from 'node:path';
import { checkAttachment, fingerprint, listBoxFiles, normName, parseLetters, readStable } from './mailbox.js';
import { SeenStore } from './seen.js';
import { createLogger } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 静默时段支持 `"00:30"` 这种写法，也认老的小时数字 `0–23`。 */
function toMinutes(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 60);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return fallback;
}

export class Mailbox extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts?.dir) throw new Error('mailbox: 少了 dir');
    if (!opts?.self) throw new Error('mailbox: 少了 self（我自己叫什么，用来决定不读哪份）');
    this.dir = path.resolve(opts.dir);
    this.self = opts.self;
    this.prefix = opts.prefix ?? 'inbox-';
    this.ext = opts.ext ?? '.md';
    this.seenPath = path.resolve(opts.seenPath ?? path.join(this.dir, `.mailbox-seen-${this.self}.json`));
    this.debounceMs = opts.debounceMs ?? 3000;
    this.minGapMs = opts.minGapMs ?? 5000;
    this.pollMs = opts.pollMs ?? 300000;
    // quietFrom / quietTo 都不填，或者明确给 null，就表示「不设静默」。
    // 注意不能用 ?? 兜底：null 会被当成 0 和 8，反而天天半夜静默。
    this.quietFrom = opts.quietFrom ?? null;
    this.quietTo = opts.quietTo ?? null;
    const noQuiet = opts.quietFrom == null && opts.quietTo == null;
    this.quietFromMin = noQuiet ? 0 : toMinutes(opts.quietFrom, 0);
    this.quietToMin = noQuiet ? 0 : toMinutes(opts.quietTo, 8 * 60);
    this.maxRetries = opts.maxRetries ?? 3;
    this.firstRunSilent = opts.firstRunSilent ?? true;

    this.read = opts.read ?? null;
    // 收件人过滤：只有箭头后面写着自己（或别名、或大家）的才投。
    this.recipientFilter = opts.recipientFilter !== false;
    this.aliases = Array.isArray(opts.aliases) ? opts.aliases.map(normName) : [];
    this.selfKey = normName(opts.self);
    this.seen = new SeenStore(this.seenPath, { limit: opts.seenLimit ?? 500 });
    this.log = createLogger(opts.logPath);    this.retries = new Map(); // fp -> 次数（内存，重启清零没关系，会再投）
    this.abandoned = new Set();
    this.timer = null;
    this.watcher = null;
    this.busy = false;
    this.stopped = false;
    this.lastDelivered = 0;
    this.round = 0;
    // EventEmitter 的 'error' 没人接会直接抛，兜一个空的
    this.on('error', () => {});
  }

  async start() {
    await this.seen.load();
    this.firstRun = !this.seen.existed;
    this.log(`启动 目录=${this.dir} 自己=${this.self} 首跑=${this.firstRun}`);
    if (this.firstRun) {
      const fresh = await this.collect();
      if (!fresh.length) {
        await this.seen.save();
        this.log('首跑 0 条，建了档');
      } else if (this.firstRunSilent) {
        // 首跑不逐条吵，但也不能当没有——积压要让人知道一次，不然新装的人旧信就没了。
        const summary = {
          fp: `firstrun:${Date.now()}`,
          writer: '首跑',
          body: `首跑扫到 ${fresh.length} 条没办的积压，逐条见信箱。`,
          file: '',
          line: 0,
          attachments: [],
        };
        let ok = false;
        try {
          ok = await this.deliver([summary]);
        } catch (err) {
          this.log(`首跑汇总出错：${err.message}`);
        }
        if (ok) {
          for (const l of fresh) this.seen.add(l.fp);
          await this.seen.save();
          this.log(`首跑 ${fresh.length} 条积压，投了一条汇总`);
        } else {
          this.log(`首跑汇总没投出去，${fresh.length} 条按新信投`);
        }
      } else {
        this.log(`首跑建档 ${fresh.length} 条，照常投`);
      }
    }

    try {
      this.watcher = watch(this.dir, { persistent: true }, (_ev, name) => {
        if (name && !this.nameMatches(String(name))) return;
        this.schedule(this.debounceMs);
      });
      this.log(`盯上了目录 ${this.dir}`);
    } catch (err) {
      this.log(`目录盯不上，改用轮询：${err.message}`);
    }

    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.log(`轮次出错：${err.message}`);
        this.emit('error', err);
      }
      if (!this.stopped) {
        const t = setTimeout(loop, this.pollMs);
        if (t.unref) t.unref();
      }
    };
    // 第一次跑完再返回，调用方拿到手就是「已经扫过一遍」的状态
    await loop();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watcher) this.watcher.close();
    return this;
  }

  schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((err) => {
        this.log(`轮次出错：${err.message}`);
        this.emit('error', err);
      });
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  /** 目录事件里这个文件名，是不是本箱要关心的。
   *  按前缀扫时看 prefix；点名读时看名单，否则被点名的文件改名落地会被一律丢掉，监听等于白装。 */
  nameMatches(name) {
    const base = path.basename(name);
    if (Array.isArray(this.read) && this.read.length) {
      return this.read.some((n) => base.startsWith(path.basename(n, this.ext)));
    }
    return base.includes(this.prefix);
  }

  /** 这条是不是写给我的。认不出收件人就当广播（老格式兼容）。 */
  isMine(item) {
    if (!this.recipientFilter) return true;
    const to = normName(item.to);
    if (!to) return true;                       // 没写收件人：老格式，当广播
    if (to === 'all' || to === '大家' || to === '所有人' || to === '全体') return true;
    if (to === this.selfKey) return true;
    if (this.aliases.includes(to)) return true;
    return false;
  }
  isQuiet(now = new Date()) {
    const m = now.getHours() * 60 + now.getMinutes();
    const a = this.quietFromMin;
    const b = this.quietToMin;
    if (a === b) return false;
    return a < b ? m >= a && m < b : m >= a || m < b;
  }

  /** 扫一遍，返回还没投过的未办条。 */
  async collect() {
    this.skipped = 0;
    this.lastSkipped = '';
    const files = await listBoxFiles(this.dir, { self: this.self, prefix: this.prefix, ext: this.ext, read: this.read });
    const out = [];
    const seenThisRound = new Set();
    for (const f of files) {
      let text;
      try {
        text = await readStable(f.file);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // 同步工具改名换姓，下一轮再来
        throw err;
      }
      for (const item of parseLetters(text)) {
        if (item.done) continue;
        const fp = fingerprint(f.writer, item.body);
        if (this.seen.has(fp) || this.abandoned.has(fp) || seenThisRound.has(fp)) continue;
        // 不是写给我的：不投，但记指纹，免得每轮重解析。老格式单独打一笔。
        if (!this.isMine(item)) {
          seenThisRound.add(fp);
          this.seen.add(fp);
          this.skipped = (this.skipped || 0) + 1;
          this.lastSkipped = item.to || '(没写)';
          continue;
        }
        seenThisRound.add(fp);
        const attachments = [];
        for (const rel of item.attachments) attachments.push(await checkAttachment(this.dir, rel));
        out.push({
          fp,
          writer: f.writer,
          body: item.body,
          file: path.basename(f.file),
          line: item.line,
          conflict: f.conflict,
          attachments,
        });
      }
    }
    return out;
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.round += 1;
    try {
      if (this.isQuiet()) {
        if (this.round % 20 === 1) this.log('静默时段，攒着不叫');
        return;
      }
      const wait = this.lastDelivered + this.minGapMs - Date.now();
      if (wait > 0) {
        this.schedule(wait);
        return;
      }
      const letters = await this.collect();
      if (!letters.length) {
      if (this.round % 20 === 1) this.log('没有新信' + (this.skipped ? '（跳过 ' + this.skipped + ' 条不是给我的，收件人=' + this.lastSkipped + '）' : ''));
        return;
      }
      await this.deliver(letters);
    } finally {
      this.busy = false;
    }
  }

  /** 把一批信交给监听者，成功才落指纹。返回投没投出去。 */
  async deliver(letters) {
    const results = { ok: false, why: '没人处理' };
    const ack = () => {
      results.ok = true;
      results.why = 'ack';
    };
    const nack = (why = 'nack') => {
      results.ok = false;
      results.why = why;
    };
    let threw = null;
    const handlers = this.listeners('letters');
    if (handlers.length === 0) {
      nack('没有人监听 letters');
    } else {
      for (const fn of handlers) {
        try {
          const r = await fn({ letters, ack, nack });
          if (r === true) ack();
          if (r === false) nack('handler 返回 false');
        } catch (err) {
          threw = err;
          nack(err.message);
        }
      }
    }
    if (threw && !results.ok) results.why = threw.message;

    if (results.ok) {
      for (const l of letters) this.seen.add(l.fp);
      await this.seen.save();
      this.lastDelivered = Date.now();
      if (this.skipped) this.log('跳过 ' + this.skipped + ' 条不是给我的（收件人=' + this.lastSkipped + '）');
      this.log(`投了 ${letters.length} 条 来=${[...new Set(letters.map((l) => l.writer))].join(',')} 首条：${letters[0].body.slice(0, 20).replace(/\n/g, ' ')}`);
      this.emit('delivered', letters);
      return true;
    }

    let gaveUp = 0;
    for (const l of letters) {
      const n = (this.retries.get(l.fp) ?? 0) + 1;
      this.retries.set(l.fp, n);
      if (n >= this.maxRetries) {
        this.abandoned.add(l.fp);
        gaveUp += 1;
      }
    }
    this.log(`投递失败（${results.why}），${letters.length} 条下次重投${gaveUp ? `，${gaveUp} 条已弃` : ''}`);
    this.emit('failed', { letters, why: results.why, gaveUp });
    if (gaveUp) this.schedule(this.debounceMs);
    return false;
  }
}

export function createMailbox(opts) {
  return new Mailbox(opts);
}

export { sleep };







