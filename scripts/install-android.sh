#!/data/data/com.termux/files/usr/bin/bash
# 安卓安装：在 Termux 里跑这一个脚本，把 node 和 mailboxd 装好。
# 用法：bash install-android.sh
# 不写成 curl | bash：先把文件下到本地、看一眼，再跑。

set -eu

VERSION="${MAILBOX_VERSION:-0.1.0}"
FILE="mailboxd-${VERSION}.mjs"
BASE_GITEE="https://gitee.com/copyme/mailbox-kit/raw/main/release"
BASE_GITHUB="https://raw.githubusercontent.com/CYYYOURMAN/mailbox-kit/main/release"
DIR="${HOME}/mailbox"
BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin"

say() { printf '%s\n' "$*"; }
die() { printf '停了：%s\n' "$*" >&2; exit 1; }

say "== 1/6 看环境 =="
if [ "${PREFIX:-}" = "" ]; then
  die "这里不是 Termux。这套只在 Termux 里跑（鸿蒙 4 及以前能侧载 Termux，鸿蒙 NEXT 不认安卓 apk，走不通）。"
fi
command -v pkg >/dev/null 2>&1 || die "找不到 pkg 命令，Termux 装坏了，先重装 Termux。"

say "== 2/6 更新软件源 =="
# 首次运行会弹镜像选择和 Y/n，这里全部默认答应，不让它卡住
yes | pkg update -y >/dev/null 2>&1 || true
yes | pkg upgrade -y >/dev/null 2>&1 || true

say "== 3/6 装 node =="
pkg install -y nodejs >/dev/null 2>&1 || die "装 nodejs 失败，网络或者源的问题。"
# 不写死版本号，装完自己判
NODE_V="$(node -v 2>/dev/null || echo none)"
say "  node 版本：${NODE_V}"
case "$NODE_V" in
  v1[89].*|v[2-9][0-9].*) say "  够用。" ;;
  none) die "node 装完还是跑不起来。" ;;
  *) die "node 版本太低（${NODE_V}），这版要 18 以上。先 pkg install -y nodejs 再跑一遍。" ;;
esac

say "== 4/6 下文件 =="
mkdir -p "$DIR"
cd "$DIR"
ok=0
for base in "$BASE_GITEE" "$BASE_GITHUB"; do
  say "  试 ${base}/${FILE}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${base}/${FILE}" -o "${FILE}.part" && ok=1
  else
    wget -q "${base}/${FILE}" -O "${FILE}.part" && ok=1
  fi
  [ "$ok" = "1" ] && break
done
[ "$ok" = "1" ] || die "两个源都下不下来。挂个代理，或者手动把 ${FILE} 放进 ${DIR}。"
mv "${FILE}.part" "$FILE"
say "  $(wc -c < "$FILE") 字节，放在 ${DIR}/${FILE}"

say "== 5/6 起服务 =="
cat > "${DIR}/run.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
# 拿唤醒锁，别让系统睡过去把进程掐了
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
# 第一次没有配置，先问一轮
if [ ! -f mailbox.config.json ]; then
  node mailboxd.mjs --setup
fi
exec node mailboxd.mjs --config mailbox.config.json --ui
EOS
ln -sf "${DIR}/${FILE}" "${DIR}/mailboxd.mjs"
chmod +x "${DIR}/run.sh"

say "== 6/6 自启（要你手动点两下）=="
if pm list packages 2>/dev/null | grep -q "termux.boot"; then
  mkdir -p "${HOME}/.termux/boot"
  cat > "${HOME}/.termux/boot/mailbox.sh" <<EOS
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
nohup ${DIR}/run.sh > ${DIR}/run.log 2>&1 &
EOS
  chmod +x "${HOME}/.termux/boot/mailbox.sh"
  say "  Termux:Boot 已装，开机脚本放到 ${HOME}/.termux/boot/mailbox.sh"
  say "  还要去：设置 → 应用 → Termux:Boot → 允许自启动。那个开关第三方读不到，只能你自己点。"
else
  say "  没装 Termux:Boot。想开机自启就去 F-Droid 装它，再跑一遍这个脚本。"
fi

say ""
say "下一步，手动来一次："
say "  bash ${DIR}/run.sh"
say "第一次会让你填信箱目录、自己叫什么。填完浏览器开 http://127.0.0.1:7654 就能看信。"
say ""
say "两件脚本管不了、要你自己做的："
say "  一，把 Termux 的电池优化关掉。不知道在哪就搜「<机型> termux 后台被杀」。"
say "  二，要读手机里的文件（同步目录在 /sdcard 上）就先跑一次 termux-setup-storage，会弹权限框。"
