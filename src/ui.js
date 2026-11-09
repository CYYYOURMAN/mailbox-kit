// ui.js —— 一个本机网页，两件事：看来信、写回执或标自己的条。
// 不做配置（配置走 mailboxd --setup），不碰对方的文件。
// 只绑 127.0.0.1，启动时生成口令，URL 里带 k= 才能进。

import { createServer } from 'node:http';
import { readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { listBoxFiles, parseLetters, fingerprint, writerOf } from './mailbox.js';

const PAGE = [
  '<!doctype html>',
  '<html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>信箱</title>',
  '<style>',
  ':root{color-scheme:light dark}',
  'body{margin:0;padding:24px;font:16px/1.6 -apple-system,"Segoe UI",sans-serif;max-width:820px}',
  'h1{font-size:20px;margin:0 0 4px}',
  '.sub{opacity:.6;font-size:13px;margin-bottom:20px}',
  '.card{border:1px solid #8884;border-radius:10px;padding:12px 14px;margin:10px 0}',
  '.meta{font-size:12px;opacity:.6;margin-bottom:6px}',
  '.body{white-space:pre-wrap}',
  '.mine{border-left:3px solid #3a7}',
  '.peer{border-left:3px solid #38f}',
  'button{font:inherit;padding:4px 10px;border-radius:8px;border:1px solid #8886;background:transparent;cursor:pointer}',
  'button:hover{background:#8881}',
  'textarea{width:100%;min-height:70px;font:inherit;padding:8px;border-radius:8px;border:1px solid #8886;background:transparent;box-sizing:border-box}',
  '.done{opacity:.45}',
  '.row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}',
  '#hint{font-size:13px;opacity:.7;margin-top:6px;min-height:20px}',
  '</style></head><body>',
  '<h1>信箱</h1>',
  '<div class="sub" id="sub">读配置中…</div>',
  '<div class="card"><div class="meta">写一条，只写自己那份</div>',
  '<textarea id="txt" placeholder="一句话，写清要对方做什么"></textarea>',
  '<div class="row"><button id="send">写进去</button></div></div>',
  '<div id="list"></div>',
  '<div id="hint"></div>',
  '<script>',
  'var K = new URLSearchParams(location.search).get("k") || "";',
  'function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}',
  'function hint(s){document.getElementById("hint").textContent=s}',
  'async function load(){',
  '  var r = await fetch("/api/letters?k=" + encodeURIComponent(K));',
  '  if(!r.ok){hint("读不了：" + r.status);return}',
  '  var d = await r.json();',
  '  document.getElementById("sub").textContent = "我=" + d.self + " · 目录 " + d.dir + " · 未办 " + d.letters.filter(function(x){return !x.done}).length + " 条";',
  '  var box = document.getElementById("list"); box.textContent = "";',
  '  var items = d.letters.slice().sort(function(a,b){ return (a.done?1:0)-(b.done?1:0) || 0 });',
  '  items.forEach(function(it){',
  '    var c = el("div","card " + (it.mine?"mine":"peer") + (it.done?" done":""));',
  '    c.appendChild(el("div","meta", it.time + " · " + it.writer + (it.mine?"（我）":"") + (it.done?" · 已办":"")));',
  '    c.appendChild(el("div","body", it.body));',
  '    var row = el("div","row");',
  '    if(it.mine && !it.done){',
  '      var b = el("button",null,"标已办");',
  '      b.onclick = function(){ ack(it.fp) };',
  '      row.appendChild(b);',
  '    } else if(!it.mine && !it.done){',
  '      var b2 = el("button",null,"写回执");',
  '      b2.onclick = function(){ reply(it) };',
  '      row.appendChild(b2);',
  '    }',
  '    if(row.childNodes.length) c.appendChild(row);',
  '    box.appendChild(c);',
  '  });',
  '}',
  'async function ack(fp){',
  '  var r = await fetch("/api/ack?k=" + encodeURIComponent(K), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fp:fp})});',
  '  if(!r.ok){ hint("标不了：" + await r.text()); return }',
  '  hint("标好了"); load();',
  '}',
  'function reply(it){',
  '  document.getElementById("txt").value = "回 " + it.writer + "：" ;',
  '  document.getElementById("txt").focus();',
  '  hint("写好点上面那个「写进去」");',
  '}',
  'document.getElementById("send").onclick = async function(){',
  '  var t = document.getElementById("txt").value.trim();',
  '  if(!t){ hint("空的不写"); return }',
  '  var r = await fetch("/api/letters?k=" + encodeURIComponent(K), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t})});',
  '  if(!r.ok){ hint("写不进去：" + await r.text()); return }',
  '  document.getElementById("txt").value = "";',
  '  hint("写进去了"); load();',
  '};',
  'load();',
  'setInterval(load, 10000);',
  '</script></body></html>',
].join('\n');

function nowHHMM() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// 写文件走「临时文件 + 改名」，跟核心写指纹一个做法，半截读不到。
async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/**
 * 起本机网页。
 * @param {{dir:string, self:string, prefix?:string, ext?:string, read?:string[], host?:string, port?:number, log?:(s:string)=>void}} opts
 */
export function createUiServer(opts) {
  const {
    dir,
    self,
    prefix = 'inbox-',
    ext = '.md',
    read,
    selfFile: selfFileOpt,
    host = '127.0.0.1',
    port = 7654,
    log = () => {},
  } = opts;

  const key = randomBytes(8).toString('hex');
  // 自己那份：优先用显式给的 selfFile。中文命名（信箱-手机.md）靠 prefix+self 拼不出来时，
  // 只有这个能救——默认的 inbox- 前缀会拼出一个根本不存在的文件，写进去也没人读到。
  const selfFile = selfFileOpt
    ? path.join(dir, selfFileOpt)
    : path.join(dir, prefix + self + ext);
  log('自己那份：' + selfFile);

  async function allLetters() {
    // 自己那份单独读：listBoxFiles 默认把「自己的」排除在外，可界面要能标自己的条。
    const boxes = [{ file: selfFile, writer: self }];
    try {
      boxes.push(...(await listBoxFiles(dir, { self, prefix, ext, read })));
    } catch {}
    const out = [];
    const seenFp = new Set();
    for (const b of boxes) {
      let text = '';
      try {
        text = await readFile(b.file, 'utf8');
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
          time: (it.body.match(/^(\d{1,2}:\d{2})/) || [])[1] || '',
          fp,
        });
      }
    }
    return out;
  }

  function auth(req, url) {
    const k = url.searchParams.get('k') || req.headers['x-mailbox-key'];
    return k === key;
  }

  function json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(s);
  }

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 64 * 1024) throw new Error('太大的');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (!auth(req, url)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('没有口令。地址后面带 ?k=…（启动时打在控制台里）。');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (url.pathname === '/api/letters' && req.method === 'GET') {
        json(res, 200, { self, dir, letters: await allLetters() });
        return;
      }
      if (url.pathname === '/api/letters' && req.method === 'POST') {
        const { text } = await body(req);
        const t = String(text || '').trim();
        if (!t) {
          json(res, 400, { error: '空的' });
          return;
        }
        const line = '- [ ] ' + nowHHMM() + ' ' + self + '→对面：' + t.replace(/\n/g, '\n  ') + '\n';
        let old = '';
        try {
          old = await readFile(selfFile, 'utf8');
        } catch {
          old = '';
        }
        const sep = old && !old.endsWith('\n') ? '\n' : '';
        await writeAtomic(selfFile, old + sep + line);
        log('UI 写了一条：' + t.slice(0, 30));
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/ack' && req.method === 'POST') {
        const { fp } = await body(req);
        const items = await allLetters();
        const hit = items.find((x) => x.fp === fp);
        if (!hit) {
          json(res, 404, { error: '没这条' });
          return;
        }
        if (!hit.mine) {
          json(res, 403, { error: '不是自己写的，不能标' });
          return;
        }
        const text = await readFile(selfFile, 'utf8').catch(() => null);
        if (text === null) {
          json(res, 409, { error: '自己那份文件不存在：' + selfFile + '（prefix 或 selfFile 可能填错了）' });
          return;
        }
        const lines = text.split(/\r?\n/);
        const i = hit.line - 1;
        if (!lines[i] || !/^- \[ \]/.test(lines[i])) {
          json(res, 409, { error: '行对不上，可能已经改过了' });
          return;
        }
        lines[i] = lines[i].replace('- [ ]', '- [x]') + ' 已办 ' + nowHHMM();
        await writeAtomic(selfFile, lines.join('\n'));
        log('UI 标了已办：' + hit.body.slice(0, 20));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: '没有这个' });
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
            server.removeListener('listening', onOk);
            if (e.code === 'EADDRINUSE') resolve(false);
            else throw e;
          };
          const onOk = () => {
            server.removeListener('error', onErr);
            resolve(true);
          };
          server.once('error', onErr);
          server.once('listening', onOk);
          server.listen(p, host);
        });
        if (ok) {
          return { port: p, url: 'http://' + host + ':' + p + '/?k=' + key };
        }
      }
      throw new Error('端口从 ' + port + ' 试到 ' + (port + 99) + ' 都被占了');
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}
