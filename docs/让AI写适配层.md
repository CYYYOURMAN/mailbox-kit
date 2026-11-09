# 让 AI 帮你写适配层

`mailbox-kit` 的核心不认识任何 AI 引擎。要让它把新消息叫醒到某个会话里，得写一层薄的适配——通常三十行左右。

这三十行不用你自己憋。把下面那段整个复制给你的 AI，它照着写。

## 先分清两层

**第一层：核心适配（谁都得有）**
核心要的是一个 `wake(letters)` 函数——信箱有新的信，核心把它交给你，你负责送进去。

**契约只有一条：返回 `false` 或者抛错，算没送到；返回别的任何东西（`true`、`undefined`、什么也不 return），都算送到了。**

`ack()` / `nack()` 是**核心内层**的东西，`wake` 拿不到它们。它们只在你直接用 `box.on('letters')` 那种写法里出现，别写进 `wake` 里。

文件形状照 `adapters/stdout.js` 抄：导出 `default` 是一个**工厂**，调用它（可以传空对象）拿到真正的 `wake`。

**第二层：引擎插件（只有 DeepSeek Harness 有现成的）**
`mailbox-dsh` 插件是照 DSH 的 `apply(ctx)` 写的，装上去就行，不用你写。别的引擎没有现成插件，你写的是第二层的「引擎侧」——把消息塞进你的宿主。

两层都写完，配置里的 `adapter` 指**第一层**（`wake` 那个），不是插件。

## 复制这段

```
帮我给 mailbox-kit 写一层适配，让信箱里的新消息能被叫醒到我这个引擎的会话里。

仓库：https://gitee.com/copyme/mailbox-kit
先读 adapters/stdout.js，那是 wake(letters) 的最小写法；再读 adapters/dsh-engine.example.js，看引擎侧怎么把字塞进会话。

我这边的引擎是：<名字和版本>
我是怎么起它的：<命令行 / 插件 / 进程内调用>

核心的契约是这样，别写错：

  box.on('letters', async ({ letters, ack, nack }) => {
    try {
      for (const l of letters) { await sendToEngine(l.body); }
      ack();          // 送成功必须 ack，核心才记指纹
    } catch (e) {
      nack(e);        // 失败 nack，核心会重投，最多三次
    }
  });

不 ack 的后果：核心以为没送到，下一轮重投，你的会话里会看到同一句话两遍。

你只需要解决三件事：
1. 拿到「正在跑的那个会话」——别按会话文件的修改时间挑，要按「最后一条人说的话的时间」挑（同步盘会碰 mtime，但不会改内容）。多个窗口时尤其重要。
2. 把一段文字塞进去，让它当成用户说的话被处理。
3. 塞完确认它是真在处理，不是排队。

别改核心那七个文件（src/index.js、lock.js、log.js、mailbox.js、runner.js、seen.js、ui.js），只写适配层。
写完告诉我三件事：会话从哪拿的、消息用什么对象塞的、怎么确认它真醒了。
```

## 它必须回答的三个问题

不管什么引擎，都绕不开这三步。拿这三个问题去考它，答不上来的就是没写对：

1. **会话从哪拿？** 是有一个 `sessionController` 之类的接口，还是一个全局变量，还是得自己维护一个列表？
2. **消息用什么形状塞？** 是纯字符串，还是要 `{ role, content }`，还是要有 `id`、`source` 这些字段？
3. **怎么确认它真在处理？** 塞完立刻返回算成功？还是要看状态从 idle 变 running？

## 验证：三条

**一、写一条信，看它有没有投出去。**

```bash
echo '- [ ] 09:00 pc→phone：适配层测试，收到回一句' >> <你的信箱文件>
```

把 `<你的信箱文件>` 换成你实际在读的那份（比如 `~/Sync/notes/inbox-pc.md`）。

**注意时段**：核心默认夜里静默（`quietFrom` 00:30 到 `quietTo` 08:30），凌晨试会看不到「投了 1 条」。要不换个钟点，要不先把这两个值设成一样（等于关掉静默）。

**二、看会话里有没有真的出现那句话。**

日志写着「投了」，不等于 AI 真看见了。去会话里翻一眼，看到那句话才算。

**三、跑冒烟脚本，看它抓不抓得住。**

```bash
# 引擎插件（DSH 那种，导出 apply(ctx)）
node test/smoke.mjs <你的插件文件绝对路径>

# 通用适配（导出 wake(letters)）
node test/smoke-wake.mjs <你的适配层文件绝对路径>
```

退出码 0 是过了。但别只信「过」——**复制一份，故意删掉一个 import 再跑**，它必须报错。报不出来说明这个脚本是假通过，什么都验不了。

## 三个坑，都踩过

**拿错对象。** 很多引擎有 `agents.get()` 和 `sessionController.resolveAgent()` 两套，前者拿到的东西没有 `followup`。报错长这样：`TypeError: agent.followup is not a function`。看宿主源码，别猜。

**热重载会跑第二遍 apply。** 插件热重载时 `apply()` 会在同一个进程里再跑一次，里面没清的 `setTimeout` 会把第二个守护拉起来，两个 watcher 抢同一份文件。句柄挂到 `globalThis`，新 apply 开头先 `clearTimeout`。

**`node --check` 过了不等于能跑。** 它只查语法。漏一个 import、错一个函数名，要等定时器响第一声才炸。所以才有冒烟脚本。

## 顺序别搞反

1. 写适配层
2. 把配置里 `adapter` 指过去（写文件路径，或者内置名 `stdout` / `balloon`）
3. 起服务
4. 按上面三条验

先起服务再改配置，改完不重启不会生效，容易白忙一场。
