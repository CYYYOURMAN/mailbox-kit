#!/usr/bin/env node
// mailbox-kit v0.1.0 · 生成物，勿手改 · 2026-11-09 13:20:36

// bin/mailboxd.js
import { readFile as readFile5, writeFile as writeFile4, mkdir as mkdir3 } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path6 from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

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
  const base2 = path.basename(fileName);
  if (!base2.startsWith(prefix)) return null;
  if (!base2.includes(ext)) return null;
  const rest = base2.slice(prefix.length);
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
      const raw2 = await readFile2(this.file, "utf8");
      this.fileExisted = true;
      const arr = JSON.parse(raw2);
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
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
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
    const base2 = path4.basename(name);
    if (Array.isArray(this.read) && this.read.length) {
      return this.read.some((n) => base2.startsWith(path4.basename(n, this.ext)));
    }
    return base2.includes(this.prefix);
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
    const raw2 = await readFile3(`/proc/${pid}/stat`, "utf8");
    const parts = raw2.split(" ");
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
    let raw2 = "";
    try {
      raw2 = (await readFile3(file, "utf8")).trim();
    } catch {
    }
    const [pidText, held = ""] = raw2.split("|");
    const pid = Number(pidText);
    if (await alive(pid, held)) return { ok: false, holder: raw2 || "?" };
    try {
      await unlink(file);
    } catch {
    }
    if (!await claim()) return { ok: false, holder: raw2 || "?" };
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const raw2 = (await readFile3(file, "utf8")).trim();
      if (raw2.split("|")[0] === String(process.pid)) await unlink(file);
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

// src/ui.js
import { createServer } from "node:http";
import { readFile as readFile4, writeFile as writeFile3, rename as rename3, open } from "node:fs/promises";
import path5 from "node:path";
import { randomBytes } from "node:crypto";
var PAGE = [
  "<!doctype html>",
  '<html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>\u4FE1\u7BB1</title>",
  "<style>",
  ":root{color-scheme:light dark}",
  'body{margin:0;padding:24px;font:16px/1.6 -apple-system,"Segoe UI",sans-serif;max-width:820px}',
  "h1{font-size:20px;margin:0 0 4px}",
  ".sub{opacity:.6;font-size:13px;margin-bottom:20px}",
  ".card{border:1px solid #8884;border-radius:10px;padding:12px 14px;margin:10px 0}",
  ".meta{font-size:12px;opacity:.6;margin-bottom:6px}",
  ".body{white-space:pre-wrap}",
  ".attach{margin-top:6px;font-size:14px;color:#57606a;font-family:ui-monospace,Consolas,monospace}",
  ".attach.gone{color:#cf222e}",
  ".mine{border-left:3px solid #3a7}",
  ".peer{border-left:3px solid #38f}",
  "button{font:inherit;padding:4px 10px;border-radius:8px;border:1px solid #8886;background:transparent;cursor:pointer}",
  "button:hover{background:#8881}",
  "textarea{width:100%;min-height:70px;font:inherit;padding:8px;border-radius:8px;border:1px solid #8886;background:transparent;box-sizing:border-box}",
  ".done{opacity:.45}",
  ".row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}",
  "#hint{font-size:13px;opacity:.7;margin-top:6px;min-height:20px}",
  "</style></head><body>",
  "<h1>\u4FE1\u7BB1</h1>",
  '<div class="sub" id="sub">\u8BFB\u914D\u7F6E\u4E2D\u2026</div>',
  '<div class="card"><div class="meta">\u5199\u4E00\u6761\uFF0C\u53EA\u5199\u81EA\u5DF1\u90A3\u4EFD</div>',
  '<textarea id="txt" placeholder="\u4E00\u53E5\u8BDD\uFF0C\u5199\u6E05\u8981\u5BF9\u65B9\u505A\u4EC0\u4E48"></textarea>',
  '<div class="row"><button id="send">\u5199\u8FDB\u53BB</button></div></div>',
  '<div id="list"></div>',
  '<div id="hint"></div>',
  "<script>",
  'var K = new URLSearchParams(location.search).get("k") || "";',
  "function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}",
  'function hint(s){document.getElementById("hint").textContent=s}',
  "async function load(){",
  '  var r = await fetch("/api/letters?k=" + encodeURIComponent(K));',
  '  if(!r.ok){hint("\u8BFB\u4E0D\u4E86\uFF1A" + r.status);return}',
  "  var d = await r.json();",
  '  document.getElementById("sub").textContent = "\u6211=" + d.self + " \xB7 \u76EE\u5F55 " + d.dir + " \xB7 \u672A\u529E " + d.letters.filter(function(x){return !x.done}).length + " \u6761";',
  '  var box = document.getElementById("list"); box.textContent = "";',
  "  var items = d.letters.slice().sort(function(a,b){ return (a.done?1:0)-(b.done?1:0) || 0 });",
  "  items.forEach(function(it){",
  '    var c = el("div","card " + (it.mine?"mine":"peer") + (it.done?" done":""));',
  '    c.appendChild(el("div","meta", it.time + " \xB7 " + it.writer + (it.mine?"\uFF08\u6211\uFF09":"") + (it.done?" \xB7 \u5DF2\u529E":"")));',
  '    c.appendChild(el("div","body", it.body));',
  "    (it.attach||[]).forEach(function(a){",
  '      var sz = a.size >= 1024 ? (a.size/1024).toFixed(1) + "K" : a.size + "B";',
  '      var txt = a.exists ? ("\u3014\u9644\u4EF6 " + a.rel + " " + sz + "\u3015") : ("\u3014\u9644\u4EF6 " + a.rel + " \u4E0D\u89C1\u4E86\u3015");',
  '      c.appendChild(el("div", a.exists ? "attach" : "attach gone", txt));',
  "    });",
  '    var row = el("div","row");',
  "    if(it.mine && !it.done){",
  '      var b = el("button",null,"\u6807\u5DF2\u529E");',
  "      b.onclick = function(){ ack(it.fp) };",
  "      row.appendChild(b);",
  "    } else if(!it.mine && !it.done){",
  '      var b2 = el("button",null,"\u5199\u56DE\u6267");',
  "      b2.onclick = function(){ reply(it) };",
  "      row.appendChild(b2);",
  "    }",
  "    if(row.childNodes.length) c.appendChild(row);",
  "    box.appendChild(c);",
  "  });",
  "}",
  "async function ack(fp){",
  '  var r = await fetch("/api/ack?k=" + encodeURIComponent(K), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fp:fp})});',
  '  if(!r.ok){ hint("\u6807\u4E0D\u4E86\uFF1A" + await r.text()); return }',
  '  hint("\u6807\u597D\u4E86"); load();',
  "}",
  "function reply(it){",
  '  document.getElementById("txt").value = "\u56DE " + it.writer + "\uFF1A" ;',
  '  document.getElementById("txt").focus();',
  '  hint("\u5199\u597D\u70B9\u4E0A\u9762\u90A3\u4E2A\u300C\u5199\u8FDB\u53BB\u300D");',
  "}",
  'document.getElementById("send").onclick = async function(){',
  '  var t = document.getElementById("txt").value.trim();',
  '  if(!t){ hint("\u7A7A\u7684\u4E0D\u5199"); return }',
  '  var r = await fetch("/api/letters?k=" + encodeURIComponent(K), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t})});',
  '  if(!r.ok){ hint("\u5199\u4E0D\u8FDB\u53BB\uFF1A" + await r.text()); return }',
  '  document.getElementById("txt").value = "";',
  '  hint("\u5199\u8FDB\u53BB\u4E86"); load();',
  "};",
  "load();",
  "setInterval(load, 10000);",
  "</script></body></html>"
].join("\n");
function nowHHMM() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
async function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + ".tmp";
  await writeFile3(tmp, text, "utf8");
  await rename3(tmp, file);
}
function createUiServer(opts) {
  const {
    dir,
    self,
    prefix = "inbox-",
    ext = ".md",
    read,
    selfFile: selfFileOpt,
    host = "127.0.0.1",
    port = 7654,
    log = () => {
    }
  } = opts;
  const key = randomBytes(8).toString("hex");
  const selfFile = selfFileOpt ? path5.join(dir, selfFileOpt) : path5.join(dir, prefix + self + ext);
  log("\u81EA\u5DF1\u90A3\u4EFD\uFF1A" + selfFile);
  async function allLetters() {
    const boxes = [{ file: selfFile, writer: self }];
    try {
      boxes.push(...await listBoxFiles(dir, { self, prefix, ext, read }));
    } catch {
    }
    const out = [];
    const seenFp = /* @__PURE__ */ new Set();
    for (const b of boxes) {
      let text = "";
      try {
        text = await readFile4(b.file, "utf8");
      } catch {
        continue;
      }
      for (const it of parseLetters(text)) {
        const fp = fingerprint(b.writer, it.body);
        if (seenFp.has(fp)) continue;
        seenFp.add(fp);
        out.push({
          writer: b.writer,
          mine: String(b.writer).toLowerCase() === String(self).toLowerCase(),
          done: it.done,
          line: it.line,
          body: it.body,
          time: (it.body.match(/^(\d{1,2}:\d{2})/) || [])[1] || "",
          attach: await Promise.all((it.attachments || []).map(async function(a) {
            const chk = await checkAttachment(dir, a);
            return { rel: a, exists: chk.exists, size: chk.size };
          })),
          fp
        });
      }
    }
    return out;
  }
  function auth(req, url) {
    const k = url.searchParams.get("k") || req.headers["x-mailbox-key"];
    return k === key;
  }
  function json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(s);
  }
  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 64 * 1024) throw new Error("\u592A\u5927\u7684");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (!auth(req, url)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("\u6CA1\u6709\u53E3\u4EE4\u3002\u5730\u5740\u540E\u9762\u5E26 ?k=\u2026\uFF08\u542F\u52A8\u65F6\u6253\u5728\u63A7\u5236\u53F0\u91CC\uFF09\u3002");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (url.pathname === "/api/letters" && req.method === "GET") {
        json(res, 200, { self, dir, letters: await allLetters() });
        return;
      }
      if (url.pathname === "/api/letters" && req.method === "POST") {
        const { text } = await body(req);
        const t = String(text || "").trim();
        if (!t) {
          json(res, 400, { error: "\u7A7A\u7684" });
          return;
        }
        const line = "- [ ] " + nowHHMM() + " " + self + "\u2192\u5BF9\u9762\uFF1A" + t.replace(/\n/g, "\n  ") + "\n";
        let old = "";
        try {
          old = await readFile4(selfFile, "utf8");
        } catch {
          old = "";
        }
        const sep = old && !old.endsWith("\n") ? "\n" : "";
        await writeAtomic(selfFile, old + sep + line);
        log("UI \u5199\u4E86\u4E00\u6761\uFF1A" + t.slice(0, 30));
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/ack" && req.method === "POST") {
        const { fp } = await body(req);
        const items = await allLetters();
        const hit = items.find((x) => x.fp === fp);
        if (!hit) {
          json(res, 404, { error: "\u6CA1\u8FD9\u6761" });
          return;
        }
        if (!hit.mine) {
          json(res, 403, { error: "\u4E0D\u662F\u81EA\u5DF1\u5199\u7684\uFF0C\u4E0D\u80FD\u6807" });
          return;
        }
        const text = await readFile4(selfFile, "utf8").catch(() => null);
        if (text === null) {
          json(res, 409, { error: "\u81EA\u5DF1\u90A3\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A" + selfFile + "\uFF08prefix \u6216 selfFile \u53EF\u80FD\u586B\u9519\u4E86\uFF09" });
          return;
        }
        const lines = text.split(/\r?\n/);
        const i = hit.line - 1;
        if (!lines[i] || !/^- \[ \]/.test(lines[i])) {
          json(res, 409, { error: "\u884C\u5BF9\u4E0D\u4E0A\uFF0C\u53EF\u80FD\u5DF2\u7ECF\u6539\u8FC7\u4E86" });
          return;
        }
        lines[i] = lines[i].replace("- [ ]", "- [x]") + " \u5DF2\u529E " + nowHHMM();
        await writeAtomic(selfFile, lines.join("\n"));
        log("UI \u6807\u4E86\u5DF2\u529E\uFF1A" + hit.body.slice(0, 20));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: "\u6CA1\u6709\u8FD9\u4E2A" });
    } catch (err) {
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });
  return {
    key,
    server,
    /** 起服务；端口被占就往后找，找到返回实际端口。 */
    async listen() {
      for (let p = port; p < port + 100; p++) {
        const ok = await new Promise((resolve) => {
          const onErr = (e) => {
            server.removeListener("listening", onOk);
            if (e.code === "EADDRINUSE") resolve(false);
            else throw e;
          };
          const onOk = () => {
            server.removeListener("error", onErr);
            resolve(true);
          };
          server.once("error", onErr);
          server.once("listening", onOk);
          server.listen(p, host);
        });
        if (ok) {
          return { port: p, url: "http://" + host + ":" + p + "/?k=" + key };
        }
      }
      throw new Error("\u7AEF\u53E3\u4ECE " + port + " \u8BD5\u5230 " + (port + 99) + " \u90FD\u88AB\u5360\u4E86");
    },
    close() {
      return new Promise((r) => server.close(r));
    }
  };
}

// adapters/stdout.js
function stdoutAdapter({ out = console.log, max = 5 } = {}) {
  return async function wake2(letters) {
    out(formatLetters(letters, { max }));
  };
}

// adapters/balloon.js
import { spawn } from "node:child_process";
function run(cmd, args2, timeout = 8e3) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, args2, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {
        }
        resolve(false);
      }
    }, timeout);
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
var PS_SCRIPT = `
param([string]$Title, [string]$Text)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.BalloonTipTitle = $Title
$icon.BalloonTipText = $Text
$icon.Visible = $true
$icon.ShowBalloonTip(12000)
Start-Sleep -Seconds 13
$icon.Visible = $false
$icon.Dispose()
`;
function balloonAdapter({ title = "\u4FE1\u7BB1\u6709\u4FE1", pwsh, max = 5 } = {}) {
  const shell = pwsh ?? (process.env.MAILBOX_PWSH || "C:/Users/30259/AppData/Local/Microsoft/PowerShell/7/pwsh.exe");
  return async function wake2(letters) {
    const text = formatLetters(letters, { max });
    const body = text.split("\n").slice(1).join("\n") || text;
    if (process.platform === "win32") {
      return run(shell, ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT, "-Title", title, "-Text", body]);
    }
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      return run("osascript", ["-e", script]);
    }
    return run("notify-send", [title, body]);
  };
}

// bin/mailboxd.js
var args = process.argv.slice(2);
var has = (f) => args.includes(f);
var val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
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
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  return prompts.map((_, i) => (lines[i] ?? "").trim());
}
if (has("--setup")) {
  {
    console.log("\u95EE\u7B54\u5F0F\u914D\u7F6E\u3002\u4E00\u8DEF\u56DE\u8F66\u7528\u9ED8\u8BA4\u503C\uFF0C\u6700\u540E\u5199\u6210\u4E00\u4E2A json\u3002\n");
    const [dirInRaw, selfRaw, peerRaw, prefixRaw, outRaw] = await askAll([
      "\u4FE1\u7BB1\u76EE\u5F55\uFF08\u653E md \u6587\u4EF6\u7684\u6587\u4EF6\u5939\uFF09: ",
      "\u81EA\u5DF1\u53EB\u4EC0\u4E48\uFF08\u5F88\u77ED\uFF0C\u6BD4\u5982 pc\u3001phone\u3001\u7535\u8111\uFF09: ",
      "\u5BF9\u9762\u53EB\u4EC0\u4E48\uFF08\u540C\u4E0A\uFF0C\u7559\u7A7A\u5C31\u53EA\u7528\u524D\u7F00\u626B\uFF09: ",
      "\u6587\u4EF6\u540D\u524D\u7F00 [inbox-]: ",
      "\u914D\u7F6E\u5199\u5230\u54EA [mailbox.config.json]: "
    ]);
    const dirIn = dirInRaw;
    if (!dirIn) {
      console.error("\u6CA1\u6709\u76EE\u5F55\uFF0C\u7B97\u4E86\u3002");
      process.exit(2);
    }
    const self = selfRaw || "me";
    const peer = peerRaw;
    let guessed = "inbox-";
    try {
      const names = readdirSync(path6.resolve(dirIn)).filter(
        (n) => n.endsWith(".md") && !/sync-conflict/.test(n)
      );
      if (names.length) {
        const cut = names[0].indexOf("-");
        const pre = cut > 0 ? names[0].slice(0, cut + 1) : "";
        if (pre && names.every((n) => n.startsWith(pre))) guessed = pre;
      }
    } catch {
    }
    const prefix = prefixRaw || guessed;
    if (!prefixRaw && guessed !== "inbox-") console.log("\u636E\u76EE\u5F55\u91CC\u7684\u6587\u4EF6\u540D\uFF0C\u524D\u7F00\u7528\u300C" + guessed + "\u300D\u3002\u4E0D\u5BF9\u5C31\u91CD\u8DD1\uFF0C\u624B\u52A8\u586B\u3002");
    const outIn = outRaw || "mailbox.config.json";
    const cfg = {
      dir: path6.resolve(dirIn),
      self,
      prefix,
      ext: ".md",
      adapter: "stdout",
      pollMs: 6e4,
      debounceMs: 3e3,
      minGapMs: 5e3,
      quietFrom: "00:30",
      quietTo: "08:30",
      firstRunSilent: false
    };
    if (peer) cfg.read = [prefix + peer + ".md"];
    try {
      await mkdir3(cfg.dir, { recursive: true });
    } catch (e) {
      console.error("\u76EE\u5F55\u5EFA\u4E0D\u8D77\u6765\uFF1A" + e.message);
      process.exit(2);
    }
    const selfName = cfg.selfFile || prefix + self + cfg.ext;
    const selfPath = path6.join(cfg.dir, selfName);
    if (!existsSync(selfPath)) {
      let cands = [];
      try {
        cands = readdirSync(cfg.dir).filter((n) => n.endsWith(cfg.ext));
      } catch {
      }
      console.log("\n\u6CE8\u610F\uFF1A" + selfPath + " \u73B0\u5728\u4E0D\u5B58\u5728\u3002");
      if (cands.length) console.log("\u8FD9\u4E2A\u76EE\u5F55\u91CC\u73B0\u6709\uFF1A" + cands.join("\u3001"));
      console.log("\u8981\u662F\u6587\u4EF6\u540D\u4E0D\u6309\u300C\u524D\u7F00+\u81EA\u5DF1+\u540E\u7F00\u300D\u62FC\uFF0C\u8BF7\u5728\u914D\u7F6E\u91CC\u52A0\u4E00\u9879 selfFile\uFF08\u81EA\u5DF1\u90A3\u4EFD\u7684\u5B8C\u6574\u6587\u4EF6\u540D\uFF09\u3002");
      console.log("\u4E0D\u7136\u5199\u4FE1\u4F1A\u5199\u8FDB\u4E00\u4E2A\u6CA1\u4EBA\u8BFB\u7684\u65B0\u6587\u4EF6\uFF0C\u754C\u9762\u4E5F\u770B\u4E0D\u5230\u81EA\u5DF1\u90A3\u51E0\u6761\u3002");
    }
    const outFile = path6.resolve(outIn);
    await writeFile4(outFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log("\n\u5199\u597D\u4E86\uFF1A" + outFile);
    console.log('\u8DD1\u8D77\u6765\uFF1Amailboxd --config "' + outFile + '"');
    console.log("\u60F3\u7528\u7F51\u9875\u770B\u4FE1\uFF0C\u52A0\u4E00\u4E2A --ui\u3002");
  }
  process.exit(0);
}
var configPath = val("--config", "mailbox.config.json");
var absConfig = path6.resolve(configPath);
if (!existsSync(absConfig)) {
  console.error("\u627E\u4E0D\u5230\u914D\u7F6E\uFF1A" + absConfig);
  console.error("\u7528\u6CD5\uFF1Anode bin/mailboxd.js --config <\u914D\u7F6E\u6587\u4EF6>\uFF0C\u6216\u8005 --setup \u95EE\u7B54\u751F\u6210\u4E00\u4EFD\u3002");
  process.exit(2);
}
var raw = JSON.parse(await readFile5(absConfig, "utf8"));
var base = path6.dirname(absConfig);
function resolveOne(p) {
  return p ? path6.resolve(base, p) : void 0;
}
async function pickAdapter(spec, opts) {
  if (!spec || spec === "stdout") return stdoutAdapter(opts);
  if (spec === "balloon") return balloonAdapter(opts);
  const [modPath, exportName = "default"] = String(spec).split("#");
  const mod = await import(pathToFileURL(path6.resolve(base, modPath)).href);
  const fn = mod[exportName];
  if (typeof fn !== "function") throw new Error("\u9002\u914D\u5C42 " + spec + " \u627E\u4E0D\u5230\u5BFC\u51FA " + exportName);
  return fn(opts);
}
var adapterOpts = raw.adapterOptions ?? {};
var wake = await pickAdapter(raw.adapter, adapterOpts);
var lockFile = resolveOne(raw.lockPath) ?? path6.join(base, "mailboxd.lock");
var lock = await acquireLock(lockFile);
if (!lock.ok) {
  console.error("\u5DF2\u7ECF\u6709\u4E00\u4E2A\u5728\u8DD1\u4E86\uFF08" + lock.holder + "\uFF09\uFF0C\u4E0D\u91CD\u590D\u8D77\u3002");
  process.exit(3);
}
var box = createMailbox({
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
  read: raw.read
});
box.on("letters", async ({ letters, ack, nack }) => {
  try {
    await wake(letters);
    ack();
  } catch (err) {
    nack(err.message);
  }
});
box.on("failed", ({ letters, why, gaveUp }) => {
  console.error("\u6295\u9012\u5931\u8D25\uFF08" + why + "\uFF09\uFF0C" + letters.length + " \u6761" + (gaveUp ? "\uFF0C\u5F03 " + gaveUp : "\uFF0C\u4E0B\u6B21\u91CD\u6295"));
});
await box.start();
if (has("--once")) {
  box.stop();
  process.exit(0);
}
var ui = null;
if (has("--ui")) {
  ui = createUiServer({
    dir: box.dir,
    self: box.self,
    prefix: raw.prefix,
    ext: raw.ext,
    read: raw.read,
    selfFile: raw.selfFile,
    port: Number(val("--port", raw.uiPort || 7654)),
    log: (s) => console.log(s)
  });
  const { url } = await ui.listen();
  console.log("\u7F51\u9875\uFF1A" + url);
  console.log("\uFF08\u8FD9\u4E2A\u5730\u5740\u5E26\u53E3\u4EE4\uFF0C\u522B\u8D34\u51FA\u53BB\u3002\u53EA\u5728\u672C\u673A\u80FD\u5F00\u3002\uFF09");
}
var bye = async () => {
  box.stop();
  if (ui) await ui.close();
  lock.release();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
console.log("\u4FE1\u7BB1\u5B88\u62A4\u8D77\u6765\u4E86\uFF1A" + box.dir + "\uFF08\u81EA\u5DF1=" + box.self + "\uFF09");
