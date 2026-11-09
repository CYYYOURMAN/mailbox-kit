#!/data/data/com.termux/files/usr/bin/bash
# 安卓安装：在 Termux 里跑这一个脚本，把 node 和 mailboxd 装好。
# 用法：bash install-android.sh
# 不写成 curl | bash：先把文件下到本地、对过 sha256，再跑。

set -eu

VERSION="${MAILBOX_VERSION:-0.1.0}"
FILE="mailboxd-${VERSION}.mjs"
# 兜底用的，拉不到旁文件时拿它比
SHA_FALLBACK="f9e10cfa789eae548f6de7ee251a4ee3a48aede63c61271bf49a65ea6a19781b"
BASE_GITEE="https://gitee.com/copyme/mailbox-kit/raw/main/release"
BASE_GITHUB="https://raw.githubusercontent.com/CYYYOURMAN/mailbox-kit/main/release"
DIR="${HOME}/mailbox"

say() { printf '%s\n' "$*"; }
die() { printf '停了：%s\n' "$*" >&2; exit 1; }

get() { # get <url> <out>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q "$1" -O "$2"
  fi
}

say "== 1/6 看环境 =="
if [ "${PREFIX:-}" = "" ]; then
  die "这里不是 Termux。这套只在 Termux 里跑（鸿蒙 4 及以前能侧载 Termux，鸿蒙 NEXT 不认安卓 apk，走不通）。"
fi
command -v pkg >/dev/null 2>&1 || die "找不到 pkg 命令，Termux 装坏了，先重装 Termux。"

say "== 2/6 更新软件源 =="
# 首次运行会弹镜像选择和 Y/n，这里全部默认答应，不让它卡住
yes | pkg update -y >/dev/null 2>&1 || true
yes | pkg upgrade -y >/dev/null 2>&1 || true
say "  要是下一步装 node 报错，先退出 Termux 再打开一次，重跑这个脚本。"

say "== 3/6 装 node =="
pkg install -y nodejs >/dev/null 2>&1 || die "装 nodejs 失败，网络或者源的问题。"
# 不写死版本号，装完自己判
NODE_V="$(node -v 2>/dev/null || echo none)"
say "  node 版本：${NODE_V}"
case "$NODE_V" in
  v1[89].*|v[2-9][0-9].*) say "  够用。" ;;
  none) die "node 装完还是跑不起来。" ;;
  *) die "node 版本太低（${NODE_V}），这版要 18 以上。先 pkg install -y nodejs，或者退出 Termux 重开再跑一遍。" ;;
esac

say "== 4/6 下文件并校验 =="
mkdir -p "$DIR"
cd "$DIR"
ok=0
for base in "$BASE_GITEE" "$BASE_GITHUB"; do
  say "  试 ${base}/${FILE}"
  if get "${base}/${FILE}" "${FILE}.part" && get "${base}/${FILE}.sha256" "${FILE}.sha256.part"; then
    ok=1; break
  fi
done
if [ "$ok" != "1" ]; then
  die "两个源都下不下来。挂个代理，或者手动把 ${FILE} 放进 ${DIR} 再跑。"
fi
WANT="$(awk '{print $1}' "${FILE}.sha256.part" 2>/dev/null || echo "")"
[ -n "$WANT" ] || WANT="$SHA_FALLBACK"
GOT="$(sha256sum "${FILE}.part" | awk '{print $1}')"
if [ "$WANT" != "$GOT" ]; then
  rm -f "${FILE}.part" "${FILE}.sha256.part"
  die "下下来的文件跟公布的 sha256 对不上（要 ${WANT}，拿到 ${GOT}）。可能是下到半截，也可能源被换了。换个网络重跑，还是不对就别装。"
fi
say "  sha256 对上了。"
mv "${FILE}.part" "$FILE"
mv "${FILE}.sha256.part" "${FILE}.sha256"
rm -f "${DIR}/mailboxd.mjs"
ln -sf "${FILE}" "${DIR}/mailboxd.mjs"
say "  $(wc -c < "$FILE") 字节，放在 ${DIR}/${FILE}"

say "== 5/6 起服务 =="
cat > "${DIR}/run.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
# 拿唤醒锁，别让系统睡过去把进程掐了
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
# 配一次：直接转给 node，不碰下面的启动流程
if [ "$1" = "--setup" ]; then
  exec node mailboxd.mjs --setup
fi
# 旧进程不清掉就起，新进程会让位给 7654，网页一直 403、口令对不上。
# 只认「node 跑 mailboxd.mjs」这种进程，别按名字一锅端（会误杀 vim、less）
PAT='node .*mailboxd\.mjs'
for p in $(pgrep -f "$PAT" 2>/dev/null); do kill "$p" 2>/dev/null; done
sleep 2
for p in $(pgrep -f "$PAT" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
sleep 1
if pgrep -f "$PAT" >/dev/null 2>&1; then
  echo "$(date '+%F %T') 旧进程杀不掉，先手动处理再起：pgrep -f '$PAT'" >> run.log
  exit 1
fi
# 没配置就别起，写日志等人来配（清完旧进程再判，免得留下一个没人管的旧实例）
if [ ! -f mailbox.config.json ]; then
  echo "$(date '+%F %T') 没有 mailbox.config.json，先手动跑一次：bash run.sh --setup" >> run.log
  exit 1
fi
echo "$(date '+%F %T') 起来，先试 http://127.0.0.1:7654/；被占会往后找，实际地址看下面插件打的那行" >> run.log
exec node mailboxd.mjs --config mailbox.config.json --ui
EOS
chmod +x "${DIR}/run.sh"

say "== 6/6 自启（要你手动点两下）=="
if pm list packages 2>/dev/null | grep -q "termux.boot"; then
  mkdir -p "${HOME}/.termux/boot"
  cat > "${HOME}/.termux/boot/mailbox.sh" <<EOS
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
# 没配置就只记一行日志，不开问答（开机会话没有终端，问了会卡住）
[ -f "${DIR}/mailbox.config.json" ] || { echo "\$(date '+%F %T') 没配置，跳过一次" >> "${DIR}/run.log"; exit 0; }
nohup "${DIR}/run.sh" >> "${DIR}/run.log" 2>&1 &
EOS
  chmod +x "${HOME}/.termux/boot/mailbox.sh"
  say "  Termux:Boot 已装，开机脚本放到 ${HOME}/.termux/boot/mailbox.sh"
  say "  还要去：设置 → 应用 → Termux:Boot → 允许自启动。那个开关第三方读不到，只能你自己点。"
else
  say "  没装 Termux:Boot。想开机自启就去 F-Droid 装它，再跑一遍这个脚本。"
fi

say ""
say "下一步，手动来一次（两行都能直接复制）："
say "  cd ~/mailbox && bash run.sh --setup"
say "配完再起："
say "  cd ~/mailbox && bash run.sh"
say "浏览器开 http://127.0.0.1:7654/ 就能看信，地址带 ?k= 口令，整行一起抄进地址栏。端口被占会自动往后找一个，具体地址在 ~/mailbox/run.log 第一行。"
say ""
say "两件脚本管不了、要你自己做的："
say "  一，把 Termux 的电池优化关掉。不知道在哪就搜「<机型> termux 后台被杀」。"
say "  二，要读手机里的文件（同步目录在 /sdcard 上）就先跑一次 termux-setup-storage。一般会弹权限框；没弹也能用，那就直接用。"
