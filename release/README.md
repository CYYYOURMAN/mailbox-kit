# 直接能跑的单文件

这两个文件是把 src/ 和 dapters/ 打成一包，不需要装依赖，不需要 npm。

- `mailboxd-0.1.0.mjs` —— 命令行（守护、跑一轮、起网页、问答配置）
- `mailbox-kit-0.1.0.mjs` —— 库，给适配层 import 用

## 怎么跑

需要 Node 18 以上。装没装 Node，跑一下 `node -v` 就知道。

```
# 跑一轮就退，验配置对不对
node mailboxd-0.1.0.mjs --config mailbox.config.json --once

# 一直守着
node mailboxd-0.1.0.mjs --config mailbox.config.json

# 顺便起网页
node mailboxd-0.1.0.mjs --config mailbox.config.json --ui

# 还没有配置？问答生成一份
node mailboxd-0.1.0.mjs --setup
```

## 为什么文件名带版本号

不带版本号的话，人下了一次就再也不看更新了——文件还在，以为是最新的。
带版本号，新版本是 `mailboxd-0.1.1.mjs`，旧的自然不会被当成新的用。

## 单文件版没有热重载

打完之后 `import.meta.url` 指到 release 目录，热重载那套靠它拼路径，会失效。
改代码请用源码跑。
