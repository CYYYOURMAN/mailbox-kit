// 桌面气泡适配层：不依赖哪个引擎，把信弹到屏幕上。
// Windows 走 PowerShell 的 NotifyIcon，macOS 走 osascript，Linux 走 notify-send。

import { spawn } from 'node:child_process';
import { formatLetters } from '../src/index.js';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {}
        resolve(false);
      }
    }, timeout);
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const PS_SCRIPT = `
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

/**
 * @param {object} opts
 * @param {string} [opts.title] 气泡标题
 * @param {string} [opts.pwsh]  PowerShell 7 的路径；Windows PowerShell 5.1 读 UTF-8 脚本会乱码
 * @param {number} [opts.max]   气泡里最多列几条
 */
/**
 * 找 PowerShell 7。Windows PowerShell 5.1 读 UTF-8 脚本会乱码，所以优先 pwsh。
 * 不写死任何路径里的用户名——按安装顺序找，找不到就退回 PATH 上的 pwsh。
 */
function defaultPwsh() {
  if (process.platform !== 'win32') return 'pwsh';
  const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  for (const root of roots) {
    if (!root) continue;
    const p = `${root}\\Microsoft\\PowerShell\\7\\pwsh.exe`;
    try { if (require('node:fs').existsSync(p)) return p; } catch {}
  }
  return 'pwsh'; // 交给 PATH
}
export function balloonAdapter({ title = '信箱有信', pwsh, max = 5 } = {}) {
  const shell = pwsh ?? process.env.MAILBOX_PWSH ?? defaultPwsh();

  return async function wake(letters) {
    const text = formatLetters(letters, { max }); // 第一行是「信箱有 N 条新信」，正文从第二行起
    const body = text.split('\n').slice(1).join('\n') || text;
    if (process.platform === 'win32') {
      return run(shell, ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT, '-Title', title, '-Text', body]);
    }
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      return run('osascript', ['-e', script]);
    }
    return run('notify-send', [title, body]);
  };
}

export default balloonAdapter;

