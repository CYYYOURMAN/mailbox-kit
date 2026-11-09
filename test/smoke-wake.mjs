// 通用适配层冒烟：验 wake(letters) 这个契约。
// 用法：node test/smoke-wake.mjs <适配层文件绝对路径>
// 退出码：0 过、1 挂、3 卡住。
//
// 它验三样：
//   1. 文件能 import，导出里有 fetch 或者 default，是个函数
//   2. 给它一批假信，它不炸
//   3. 它调了 ack（成功）或 nack（失败）——一个都不调，核心会一直重投

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('用法：node test/smoke-wake.mjs <适配层文件绝对路径>');
  process.exit(1);
}

const abs = path.resolve(file);
const t = setTimeout(() => {
  console.error('✗ 卡住了：二十秒还没结束');
  process.exit(3);
}, 20000);

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ok   ' + m); };
const no = (m) => { fail++; console.log('  ×    ' + m); };

let mod;
try {
  mod = await import(pathToFileURL(abs).href);
  ok('import 得动');
} catch (e) {
  no('import 失败：' + e.message);
  console.log('\n' + pass + ' 过，' + fail + ' 挂');
  clearTimeout(t);
  process.exit(1);
}

// 约定：适配层导出 default（或 wake）是一个工厂，调用后拿到真正的 wake。
// adapters/stdout.js、adapters/balloon.js 都是这个形状。
const factory = typeof mod.default === 'function' ? mod.default : mod.wake;
if (typeof factory !== 'function') {
  no('导出里既没有 default 也没有 wake，拿什么叫醒？');
  console.log('\n' + pass + ' 过，' + fail + ' 挂');
  clearTimeout(t);
  process.exit(1);
}
ok('拿到工厂函数');

let wake;
try {
  wake = factory({});
} catch (e) {
  no('调工厂就炸了：' + e.message);
  console.log('\n' + pass + ' 过，' + fail + ' 挂');
  clearTimeout(t);
  process.exit(1);
}
if (typeof wake !== 'function') {
  no('工厂没返回函数（应该 return 一个 async function wake(letters)）');
  console.log('\n' + pass + ' 过，' + fail + ' 挂');
  clearTimeout(t);
  process.exit(1);
}
ok('工厂返回了 wake 函数');

let acked = 0;
let nacked = 0;
const fakeLetters = [
  { writer: 'pc', body: '09:00 pc→phone：冒烟第一条', attach: [] },
  { writer: 'pc', body: '09:01 pc→phone：冒烟第二条', attach: [] },
];
const ack = () => { acked++; };
const nack = (e) => { nacked++; };

let val;
try {
  const r = wake(fakeLetters, { ack, nack });
  val = r && typeof r.then === 'function' ? await r : r;
  ok('给了两封信，没炸');
} catch (e) {
  no('给信就炸了：' + e.message);
}

// 核心只认一条：返回 false 才算没送到。
// undefined / true / 别的都算送到了——别要求适配层非得 return true。
if (val === false) {
  no('返回 false：适配层自己说没送到，核心会重投——如果这不是故意的，就有问题');
} else if (nacked > 0) {
  no('调了 nack(' + nacked + ' 次)，但 wake 拿不到 ack/nack，这个调用不起作用——失败要么 return false，要么抛错');
} else {
  ok('返回值不是 false，核心当送到了（val=' + String(val) + '）');
}
clearTimeout(t);
console.log('\n' + pass + ' 过，' + fail + ' 挂');
process.exit(fail === 0 ? 0 : 1);
