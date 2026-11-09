// mailbox-kit v0.1.0 · 生成物，勿手改

// src/runner.js
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import path4 from "node:path";

// src/mailbox.js
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var ITEM_RE = /^- \[([ xX])\]\s+(.*)$/;
var CONT_RE = /^\s{2,}(\S.*)$/;
var ATT_RE = /^附件\s*[:：]\s*(.+)$/;
function parseLetters(text) {
  const out = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = ITEM_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { done: m[1] !== " ", body: m[2].trim(), line: i + 1, attachments: [] };
      continue;
    }
    const c = CONT_RE.exec(line);
    if (c && cur) {
      cur.body += "\n" + c[1].trim();
      continue;
    }
    if (cur && line.trim() === "") continue;
    if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  for (const item of out) {
    const kept = [];
    for (const line of item.body.split("\n")) {
      const a = ATT_RE.exec(line.trim());
      if (a) item.attachments.push(a[1].trim());
      else kept.push(line);
    }
    item.body = kept.join("\n").trim();
  }
  return out;
}
async function checkAttachment(dir, rel) {
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
function writerOf(fileName, { prefix = "inbox-", ext = ".md" } = {}) {
  const base = path.basename(fileName);
  if (!base.startsWith(prefix)) return null;
  if (!base.includes(ext)) return null;
  const rest = base.slice(prefix.length);
  const m = /^([A-Za-z0-9_-]+)/.exec(rest);
  return m ? m[1] : null;
}
function isConflict(fileName) {
  return /sync-conflict|\.conflict[-.]/i.test(path.basename(fileName));
}
async function listBoxFiles(dir, { self, prefix = "inbox-", ext = ".md", read = null } = {}) {
  let names = [];
  const listed = Array.isArray(read) && read.length > 0;
  if (listed) {
    const bases = read.map((n) => path.basename(n, ext));
    let all = [];
    try {
      all = await readdir(dir);
    } catch {
    }
    names = all.filter(
      (n) => bases.some((b) => n === `${b}${ext}` || n.startsWith(b) && isConflict(n))
    );
    if (!names.length) names = read.map((n) => path.basename(n));
  } else {
    try {
      names = await readdir(dir);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    names = names.filter((n) => writerOf(n, { prefix, ext }));
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, path.basename(name));
    const w = writerOf(name, { prefix, ext }) ?? path.basename(name).replace(new RegExp(`${ext}$`), "").replace(new RegExp(`^${prefix}`), "");
    if (!w) continue;
    if (!listed && w.toLowerCase() === String(self).toLowerCase()) continue;
    out.push({ file, writer: w, conflict: isConflict(name) });
  }
  return out;
}
async function readStable(file, { tries = 3, delayMs = 250 } = {}) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const text = await readFile(file, "utf8");
    const size = (await stat(file)).size;
    const whole = text.length > 0 && Buffer.byteLength(text, "utf8") === size;
    if (whole && (prev === null || prev === text)) return text;
    if (text === "" && size > 0) {
      await sleep(delayMs);
      continue;
    }
    if (prev !== null && prev === text) return text;
    prev = text;
    if (i < tries - 1) await sleep(delayMs);
  }
  return prev ?? "";
}
function fingerprint(writer, body) {
  const norm = String(body).replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${writer}\0${norm}`).digest("hex").slice(0, 16);
}

// src/seen.js
import { readFile as readFile2, rename, writeFile, mkdir } from "node:fs/promises";
import path2 from "node:path";
var SeenStore = class {
  constructor(file, { limit = 500 } = {}) {
    this.file = file;
    this.limit = limit;
    this.set = /* @__PURE__ */ new Set();
    this.loaded = false;
    this.fileExisted = false;
  }
  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await readFile2(this.file, "utf8");
      this.fileExisted = true;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) this.set = new Set(arr.slice(-this.limit));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this;
  }
  /** 「建过档没有」认文件在不在，不认里面有几条。认条数的话，首跑 0 条会每次重启都重来一遍。 */
  get existed() {
    return this.fileExisted === true;
  }
  has(fp) {
    return this.set.has(fp);
  }
  add(fp) {
    if (this.set.has(fp)) return false;
    this.set.add(fp);
    while (this.set.size > this.limit) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
    return true;
  }
  delete(fp) {
    return this.set.delete(fp);
  }
  async save() {
    const dir = path2.dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.set]), "utf8");
    await rename(tmp, this.file);
  }
};

// src/log.js
import { appendFile, mkdir as mkdir2, rename as rename2, stat as stat2 } from "node:fs/promises";
import path3 from "node:path";
function createLogger(file, { maxBytes = 1024 * 1024, keep = 2 } = {}) {
  if (!file) {
    return () => {
    };
  }
  let ready = null;
  let size = null;
  let lastCheck = 0;
  async function rotateIfNeeded() {
    if (size === null) {
      try {
        size = (await stat2(file)).size;
      } catch {
        size = 0;
      }
    }
    if (size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i -= 1) {
      try {
        await rename2(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
      }
    }
    try {
      await rename2(file, `${file}.1`);
    } catch {
    }
    size = 0;
  }
  return async function log(line) {
    const d = /* @__PURE__ */ new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const text = `[${stamp}] ${line}
`;
    try {
      if (!ready) ready = mkdir2(path3.dirname(file), { recursive: true });
      await ready;
      const now = Date.now();
      if (now - lastCheck > 1e3) {
        lastCheck = now;
        await rotateIfNeeded();
      }
      await appendFile(file, text, "utf8");
      if (size !== null) size += Buffer.byteLength(text, "utf8");
    } catch {
    }
  };
}

// src/runner.js
function toMinutes(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 60);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return fallback;
}
var Mailbox = class extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts?.dir) throw new Error("mailbox: \u5C11\u4E86 dir");
    if (!opts?.self) throw new Error("mailbox: \u5C11\u4E86 self\uFF08\u6211\u81EA\u5DF1\u53EB\u4EC0\u4E48\uFF0C\u7528\u6765\u51B3\u5B9A\u4E0D\u8BFB\u54EA\u4EFD\uFF09");
    this.dir = path4.resolve(opts.dir);
    this.self = opts.self;
    this.prefix = opts.prefix ?? "inbox-";
    this.ext = opts.ext ?? ".md";
    this.seenPath = path4.resolve(opts.seenPath ?? path4.join(this.dir, `.mailbox-seen-${this.self}.json`));
    this.debounceMs = opts.debounceMs ?? 3e3;
    this.minGapMs = opts.minGapMs ?? 5e3;
    this.pollMs = opts.pollMs ?? 3e5;
    this.quietFrom = opts.quietFrom ?? 0;
    this.quietTo = opts.quietTo ?? 8;
    this.quietFromMin = toMinutes(opts.quietFrom, 0);
    this.quietToMin = toMinutes(opts.quietTo, 8 * 60);
    this.maxRetries = opts.maxRetries ?? 3;
    this.firstRunSilent = opts.firstRunSilent ?? true;
    this.read = opts.read ?? null;
    this.seen = new SeenStore(this.seenPath, { limit: opts.seenLimit ?? 500 });
    this.log = createLogger(opts.logPath);
    this.retries = /* @__PURE__ */ new Map();
    this.abandoned = /* @__PURE__ */ new Set();
    this.timer = null;
    this.watcher = null;
    this.busy = false;
    this.stopped = false;
    this.lastDelivered = 0;
    this.round = 0;
    this.on("error", () => {
    });
  }
  async start() {
    await this.seen.load();
    this.firstRun = !this.seen.existed;
    this.log(`\u542F\u52A8 \u76EE\u5F55=${this.dir} \u81EA\u5DF1=${this.self} \u9996\u8DD1=${this.firstRun}`);
    if (this.firstRun) {
      const fresh = await this.collect();
      if (!fresh.length) {
        await this.seen.save();
        this.log("\u9996\u8DD1 0 \u6761\uFF0C\u5EFA\u4E86\u6863");
      } else if (this.firstRunSilent) {
        const summary = {
          fp: `firstrun:${Date.now()}`,
          writer: "\u9996\u8DD1",
          body: `\u9996\u8DD1\u626B\u5230 ${fresh.length} \u6761\u6CA1\u529E\u7684\u79EF\u538B\uFF0C\u9010\u6761\u89C1\u4FE1\u7BB1\u3002`,
          file: "",
          line: 0,
          attachments: []
        };
        let ok = false;
        try {
          ok = await this.deliver([summary]);
        } catch (err) {
          this.log(`\u9996\u8DD1\u6C47\u603B\u51FA\u9519\uFF1A${err.message}`);
        }
        if (ok) {
          for (const l of fresh) this.seen.add(l.fp);
          await this.seen.save();
          this.log(`\u9996\u8DD1 ${fresh.length} \u6761\u79EF\u538B\uFF0C\u6295\u4E86\u4E00\u6761\u6C47\u603B`);
        } else {
          this.log(`\u9996\u8DD1\u6C47\u603B\u6CA1\u6295\u51FA\u53BB\uFF0C${fresh.length} \u6761\u6309\u65B0\u4FE1\u6295`);
        }
      } else {
        this.log(`\u9996\u8DD1\u5EFA\u6863 ${fresh.length} \u6761\uFF0C\u7167\u5E38\u6295`);
      }
    }
    try {
      this.watcher = watch(this.dir, { persistent: true }, (_ev, name) => {
        if (name && !this.nameMatches(String(name))) return;
        this.schedule(this.debounceMs);
      });
      this.log(`\u76EF\u4E0A\u4E86\u76EE\u5F55 ${this.dir}`);
    } catch (err) {
      this.log(`\u76EE\u5F55\u76EF\u4E0D\u4E0A\uFF0C\u6539\u7528\u8F6E\u8BE2\uFF1A${err.message}`);
    }
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.log(`\u8F6E\u6B21\u51FA\u9519\uFF1A${err.message}`);
        this.emit("error", err);
      }
      if (!this.stopped) {
        const t = setTimeout(loop, this.pollMs);
        if (t.unref) t.unref();
      }
    };
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
        this.log(`\u8F6E\u6B21\u51FA\u9519\uFF1A${err.message}`);
        this.emit("error", err);
      });
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }
  /** 目录事件里这个文件名，是不是本箱要关心的。
   *  按前缀扫时看 prefix；点名读时看名单，否则被点名的文件改名落地会被一律丢掉，监听等于白装。 */
  nameMatches(name) {
    const base = path4.basename(name);
    if (Array.isArray(this.read) && this.read.length) {
      return this.read.some((n) => base.startsWith(path4.basename(n, this.ext)));
    }
    return base.includes(this.prefix);
  }
  isQuiet(now = /* @__PURE__ */ new Date()) {
    const m = now.getHours() * 60 + now.getMinutes();
    const a = this.quietFromMin;
    const b = this.quietToMin;
    if (a === b) return false;
    return a < b ? m >= a && m < b : m >= a || m < b;
  }
  /** 扫一遍，返回还没投过的未办条。 */
  async collect() {
    const files = await listBoxFiles(this.dir, { self: this.self, prefix: this.prefix, ext: this.ext, read: this.read });
    const out = [];
    const seenThisRound = /* @__PURE__ */ new Set();
    for (const f of files) {
      let text;
      try {
        text = await readStable(f.file);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      for (const item of parseLetters(text)) {
        if (item.done) continue;
        const fp = fingerprint(f.writer, item.body);
        if (this.seen.has(fp) || this.abandoned.has(fp) || seenThisRound.has(fp)) continue;
        seenThisRound.add(fp);
        const attachments = [];
        for (const rel of item.attachments) attachments.push(await checkAttachment(this.dir, rel));
        out.push({
          fp,
          writer: f.writer,
          body: item.body,
          file: path4.basename(f.file),
          line: item.line,
          conflict: f.conflict,
          attachments
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
        if (this.round % 20 === 1) this.log("\u9759\u9ED8\u65F6\u6BB5\uFF0C\u6512\u7740\u4E0D\u53EB");
        return;
      }
      const wait = this.lastDelivered + this.minGapMs - Date.now();
      if (wait > 0) {
        this.schedule(wait);
        return;
      }
      const letters = await this.collect();
      if (!letters.length) {
        if (this.round % 20 === 1) this.log("\u6CA1\u6709\u65B0\u4FE1");
        return;
      }
      await this.deliver(letters);
    } finally {
      this.busy = false;
    }
  }
  /** 把一批信交给监听者，成功才落指纹。返回投没投出去。 */
  async deliver(letters) {
    const results = { ok: false, why: "\u6CA1\u4EBA\u5904\u7406" };
    const ack = () => {
      results.ok = true;
      results.why = "ack";
    };
    const nack = (why = "nack") => {
      results.ok = false;
      results.why = why;
    };
    let threw = null;
    const handlers = this.listeners("letters");
    if (handlers.length === 0) {
      nack("\u6CA1\u6709\u4EBA\u76D1\u542C letters");
    } else {
      for (const fn of handlers) {
        try {
          const r = await fn({ letters, ack, nack });
          if (r === true) ack();
          if (r === false) nack("handler \u8FD4\u56DE false");
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
      this.log(`\u6295\u4E86 ${letters.length} \u6761 \u6765=${[...new Set(letters.map((l) => l.writer))].join(",")} \u9996\u6761\uFF1A${letters[0].body.slice(0, 20).replace(/\n/g, " ")}`);
      this.emit("delivered", letters);
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
    this.log(`\u6295\u9012\u5931\u8D25\uFF08${results.why}\uFF09\uFF0C${letters.length} \u6761\u4E0B\u6B21\u91CD\u6295${gaveUp ? `\uFF0C${gaveUp} \u6761\u5DF2\u5F03` : ""}`);
    this.emit("failed", { letters, why: results.why, gaveUp });
    if (gaveUp) this.schedule(this.debounceMs);
    return false;
  }
};
function createMailbox(opts) {
  return new Mailbox(opts);
}

// src/lock.js
import { readFile as readFile3, unlink, writeFile as writeFile2 } from "node:fs/promises";
async function startTimeOf(pid) {
  try {
    const raw = await readFile3(`/proc/${pid}/stat`, "utf8");
    const parts = raw.split(" ");
    return parts[21] ? `proc:${parts[21]}` : "";
  } catch {
    return "";
  }
}
async function alive(pid, stamp) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }
  if (!stamp) return true;
  const now = await startTimeOf(pid);
  if (!now) return true;
  return now === stamp;
}
async function acquireLock(file) {
  const stamp = await startTimeOf(process.pid) || "";
  const me = `${process.pid}|${stamp}`;
  const tryWrite = () => writeFile2(file, me, { encoding: "utf8", flag: "wx" });
  const claim = async () => {
    try {
      await tryWrite();
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      return false;
    }
  };
  if (!await claim()) {
    let raw = "";
    try {
      raw = (await readFile3(file, "utf8")).trim();
    } catch {
    }
    const [pidText, held = ""] = raw.split("|");
    const pid = Number(pidText);
    if (await alive(pid, held)) return { ok: false, holder: raw || "?" };
    try {
      await unlink(file);
    } catch {
    }
    if (!await claim()) return { ok: false, holder: raw || "?" };
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const raw = (await readFile3(file, "utf8")).trim();
      if (raw.split("|")[0] === String(process.pid)) await unlink(file);
    } catch {
    }
  };
  return { ok: true, release };
}

// src/index.js
function formatLetters(letters, { max = 5, width = 120 } = {}) {
  const head = letters.slice(0, max).map((l) => {
    const lines = l.body.split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
    const att = (l.attachments ?? []).length ? ` \u3014\u9644\u4EF6 ${l.attachments.map((a) => `${a.rel}${a.exists ? ` ${Math.max(1, Math.round(a.size / 1024))}K` : " \u4E22\u4E86"}`).join("\u3001")}\u3015` : "";
    return `\xB7 ${lines.length > width ? `${lines.slice(0, width)}\u2026` : lines}${att}`;
  });
  const more = letters.length > max ? `
\xB7 \u8FD8\u6709 ${letters.length - max} \u6761` : "";
  return `\u4FE1\u7BB1\u6709 ${letters.length} \u6761\u65B0\u4FE1
${head.join("\n")}${more}`;
}
export {
  Mailbox,
  SeenStore,
  acquireLock,
  checkAttachment,
  createLogger,
  createMailbox,
  fingerprint,
  formatLetters,
  isConflict,
  listBoxFiles,
  parseLetters,
  readStable,
  writerOf
};
