#!/usr/bin/env node
// 插件冒烟：把插件塞进假 ctx 里跑一遍 apply，再手动把每个定时器拨响一次，
// 抓的是 node --check 查不出的东西——漏导入、漏定义、定时器里才炸的引用。
//
// 用法：node test/smoke.mjs <插件入口绝对路径>
// 退出码：0 过 / 1 挂 / 3 卡住（20 秒硬超时）
//
// 怎么证明它真管用（手机那边验的，值得每次都做）：
//   把插件入口复制一份，故意删掉一个 import 或者一个函数名，再拿它跑一遍，
//   应该报 ReferenceError、退出码 1。报不出来就是脚本自己瞎了。
// 冒烟：把插件的 apply 在一个假 ctx 里跑一遍，再把定时器的回调各掐一次。
// 目的：抓 node --check 查不出来的东西——比如漏 import 的函数，只有定时器响的时候才炸。
//
// 用法：
//   node test/smoke.mjs <插件入口的绝对路径>
// 例：
//   node test/smoke.mjs C:/Users/30259/.dsh/plugins-data/mailbox-dsh/lib/index.js

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const HARD_MS = 20000
realTimeoutHard = setTimeout(() => {
  console.error('✗ 冒烟超时了（' + HARD_MS + 'ms），插件里有东西一直不放手')
  process.exit(3)
}, HARD_MS)
realTimeoutHard.unref()

const entry = process.argv[2]
if (!entry || !existsSync(entry)) {
  console.error('用法：node test/smoke.mjs <插件入口的绝对路径>')
  process.exit(2)
}

// 1. 把定时器换成记账的，不让它真跑
const timers = []
const realTimeout = globalThis.setTimeout
var realTimeoutHard = realTimeout
const realInterval = globalThis.setInterval
let capturing = true
globalThis.setTimeout = (fn, ms, ...args) => {
  if (capturing) timers.push({ kind: 'timeout', fn, ms, args })
  return timers.length
}
globalThis.setInterval = (fn, ms, ...args) => {
  if (capturing) timers.push({ kind: 'interval', fn, ms, args })
  return timers.length
}

// 2. 假 ctx：够用就行，多给几个空的不亏
const logs = []
const fakeCtx = {
  on() {},
  off() {},
  get() {
    return null
  },
  plugin() {
    return { dispose() {} }
  },
  logger: {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
    debug: (...a) => logs.push(['debug', ...a]),
  },
  sessions: { flush: async () => {} },
}

const fails = []
let mod
try {
  mod = await import(pathToFileURL(entry).href)
} catch (e) {
  console.error(`✗ 入口加载就炸了：${e && e.message}`)
  process.exit(1)
}
if (typeof mod.apply !== 'function') {
  console.error('✗ 这个模块没导出 apply')
  process.exit(1)
}

// 插件里常有「延后十秒再起」这种，别干等：超时就当它跑着，回头掐定时器照样能抓毛病
function withTimeout(promise, ms, tag) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => realTimeout(() => rej(new Error(`${tag} 超时 ${ms}ms`)), ms)),
  ])
}

try {
  await withTimeout(mod.apply(fakeCtx), 3000, 'apply')
} catch (e) {
  if (String(e && e.message).includes('超时')) {
    logs.push(['warn', e.message])
  } else {
    console.error(`✗ apply 一跑就炸：${e && e.stack}`)
    process.exit(1)
  }
}

// 3. 停手：跑回调时不许再挂新的定时器，否则递归没完
capturing = false
globalThis.setTimeout = (fn) => {
  void fn
  return 0
}
globalThis.setInterval = (fn) => {
  void fn
  return 0
}

// 4. 每个定时器回调掐一次，等它 promise 落地
for (const t of timers) {
  try {
    await withTimeout(t.fn(...t.args), 2000, `${t.kind}/${t.ms}ms`)
  } catch (e) {
    if (String(e && e.message).includes('超时')) continue
    fails.push(`${t.kind}/${t.ms}ms：${e && e.name ? e.name + ': ' : ''}${e && e.message}`)
  }
}

globalThis.setTimeout = realTimeout
globalThis.setInterval = realInterval

const n = timers.length
if (fails.length) {
  console.error(`✗ 挂了 ${fails.length} 处（共 ${n} 个定时器）`)
  for (const f of fails) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✓ 冒烟过：apply 跑得起来，${n} 个定时器各掐了一次，没炸`)
process.exit(0)
