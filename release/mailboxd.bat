@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "mailboxd-0.1.0.mjs" (
  echo 找不到 mailboxd-0.1.0.mjs。把它和这个 bat 放同一个文件夹。
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo 没装 Node.js。去 nodejs.org 下 LTS 版，装完再双击。
  pause
  exit /b 1
)
echo 起来了。下面会打一行「网页：」，把那个地址整条复制到浏览器。这个黑窗口别关。
node "mailboxd-0.1.0.mjs" --ui
echo.
echo 退出了。按任意键关窗。
pause >nul