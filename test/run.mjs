// 不用 node --test：它在某些沙箱里起子进程会卡在管道上。
// 这套自己跑，一个断言一个，最后给一行汇总。

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkAttachment, parseLetters, writerOf, isConflict, fingerprint } from '../src/mailbox.js';
import { acquireLock } from '../src/lock.js';
import { createMailbox, formatLetters } from '../src/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtemp(path.join(tmpdir(), 'mbox-'));
let pass = 0;
const fails = [];

async function it(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fails.push([name, err]);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

await it('拆条：未办、已办、续行', () => {
  const text = ['- [ ] 10:00 第一条', '  第二行', '- [x] 10:01 办完了', '', '- [ ] 10:02 第三条'].join('\n');
  const items = parseLetters(text);
  assert.equal(items.length, 3);
  assert.equal(items[0].body, '10:00 第一条\n第二行');
  assert.equal(items[1].done, true);
  assert.equal(items[2].body, '10:02 第三条');
});

await it('方向看文件名，冲突文件算同一写者', () => {
  assert.equal(writerOf('inbox-pc.md'), 'pc');
  assert.equal(writerOf('inbox-phone.md'), 'phone');
  assert.equal(writerOf('inbox-pc.sync-conflict-20261109-162710-ABCDEFG.md'), 'pc');
  assert.equal(writerOf('别的.md'), null);
  assert.equal(isConflict('inbox-pc.sync-conflict-20261109-162710-ABCDEFG.md'), true);
  assert.equal(isConflict('inbox-pc.md'), false);
});

await it('指纹不随空白变形，写者不同就不同', () => {
  assert.equal(fingerprint('pc', '  同一  句话 '), fingerprint('pc', '同一 句话'));
  assert.notEqual(fingerprint('pc', '这句话'), fingerprint('phone', '这句话'));
});

await it('首跑有积压只投一条汇总，之后来新信投一次，同条不重投', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'inbox-pc.md'), '- [ ] 10:00 老的\n', 'utf8');
  const box = createMailbox({ dir, self: 'phone', pollMs: 60_000, debounceMs: 20, minGapMs: 0, quietFrom: 0, quietTo: 0, logPath: path.join(dir, 'log.txt') });
  const got = [];
  box.on('letters', ({ letters, ack }) => {
    got.push(...letters);
    ack();
  });
  await box.start();
  await wait(80);
  // 首跑不能一条不响，也不能逐条吵：投一条汇总，正文带条数
  assert.equal(got.length, 1, '首跑该投一条汇总');
  assert.match(got[0].body, /1 条/, '汇总里要写清几条积压');

  await writeFile(path.join(dir, 'inbox-pc.md'), '- [ ] 10:00 老的\n- [ ] 10:05 新的\n', 'utf8');
  await box.tick();
  await wait(60);
  assert.equal(got.length, 2, '新的那条要投');
  assert.equal(got[1].body, '10:05 新的');
  assert.equal(got.filter((l) => l.body === '10:00 老的').length, 0, '积压条不逐条投');

  await box.tick();
  await wait(60);
  assert.equal(got.length, 2, '同一条不投第二次');
  box.stop();
});

await it('不看自己写的那份', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'inbox-pc.md'), '- [ ] 10:00 给手机\n', 'utf8');
  await writeFile(path.join(dir, 'inbox-phone.md'), '- [ ] 10:00 我自己写的\n', 'utf8');
  const box = createMailbox({ dir, self: 'phone', pollMs: 60_000, quietFrom: 0, quietTo: 0, firstRunSilent: false });
  const got = [];
  box.on('letters', ({ letters, ack }) => {
    got.push(...letters);
    ack();
  });
  await box.start();
  await wait(60);
  assert.deepEqual(got.map((l) => l.body), ['10:00 给手机']);
  box.stop();
});

await it('投递失败会重投，满三次弃掉', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'inbox-pc.md'), '- [ ] 10:00 投不出去\n', 'utf8');
  const box = createMailbox({ dir, self: 'phone', pollMs: 60_000, minGapMs: 0, quietFrom: 0, quietTo: 0, maxRetries: 3, firstRunSilent: false });
  let calls = 0;
  box.on('letters', ({ nack }) => {
    calls += 1;
    nack('引擎没起来');
  });
  await box.start();
  for (let i = 0; i < 4; i++) {
    await box.tick();
    box.lastDelivered = 0;
  }
  assert.equal(calls, 3, '试三次就停');
  box.stop();
});

await it('静默时段判定', () => {
  const box = createMailbox({ dir: '.', self: 'pc', quietFrom: 0, quietTo: 8 });
  assert.equal(box.isQuiet(new Date('2026-01-01T03:00:00')), true);
  assert.equal(box.isQuiet(new Date('2026-01-01T09:00:00')), false);
  assert.equal(box.isQuiet(new Date('2026-01-01T23:30:00')), false);
  const box2 = createMailbox({ dir: '.', self: 'pc', quietFrom: 6, quietTo: 7 });
  assert.equal(box2.isQuiet(new Date('2026-01-01T06:30:00')), true);
  assert.equal(box2.isQuiet(new Date('2026-01-01T07:30:00')), false);
});

await it('排成短文本', () => {
  const txt = formatLetters([{ body: '一条' }, { body: '两条\n续行' }], { max: 1 });
  assert.match(txt, /信箱有 2 条新信/);
  assert.match(txt, /· 一条/);
  assert.match(txt, /还有 1 条/);
});

await it('附件按信箱目录找，穿出去的不认', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, '附件'), { recursive: true });
  await writeFile(path.join(dir, '附件', 'x.png'), 'abc', 'utf8');
  const items = parseLetters('- [ ] 10:00 看图\n  附件: 附件/x.png\n- [ ] 10:01 偷看\n  附件: ../外面/x.png\n');
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[0].body, '10:00 看图', '附件行要从正文里摘掉');
  const a = await checkAttachment(dir, items[0].attachments[0]);
  assert.equal(a.exists, true);
  assert.equal(a.size, 3);
  const b = await checkAttachment(dir, items[1].attachments[0]);
  assert.equal(b.exists, false, '穿出信箱目录的一律当没有');
});

await it('静默支持分钟粒度，跨午夜也对', async () => {
  const dir = await tmp();
  const box = createMailbox({ dir, self: 'pc', quietFrom: '00:30', quietTo: '08:30', logPath: path.join(dir, 'log.txt') });
  const at = (h, m) => new Date(2026, 10, 9, h, m, 0);
  assert.equal(box.isQuiet(at(1, 0)), true);
  assert.equal(box.isQuiet(at(0, 29)), false);
  assert.equal(box.isQuiet(at(8, 29)), true);
  assert.equal(box.isQuiet(at(8, 30)), false);
  assert.equal(box.isQuiet(at(14, 0)), false);
  const night = createMailbox({ dir, self: 'pc', quietFrom: '22:00', quietTo: '06:00', logPath: path.join(dir, 'log.txt') });
  assert.equal(night.isQuiet(at(23, 0)), true);
  assert.equal(night.isQuiet(at(5, 59)), true);
  assert.equal(night.isQuiet(at(6, 0)), false);
});

await it('单实例锁：活的不抢，死的能接管', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'x.lock');
  const a = await acquireLock(file);
  assert.equal(a.ok, true);
  const b = await acquireLock(file);
  assert.equal(b.ok, false, '已经有一个在跑就不该抢到');
  await a.release();
  const c = await acquireLock(file);
  assert.equal(c.ok, true, '释放之后能再拿');
  await c.release();
  await writeFile(file, '999999|', 'utf8');
  const d = await acquireLock(file);
  assert.equal(d.ok, true, '死进程留的锁要能接管');
  await d.release();
});
console.log(`\n${pass} 过，${fails.length} 挂`);
process.exit(fails.length ? 1 : 0);





