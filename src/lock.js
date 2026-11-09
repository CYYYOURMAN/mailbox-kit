// lock.js —— 单实例锁：同一个信箱只让一个进程扫，免得两个进程抢同一份指纹和日志。
// 锁里写「pid|进程启动时间」。只认 pid 会撞上进程号回收，启动时间能挡住。

import { readFile, unlink, writeFile } from 'node:fs/promises';

/** Linux 上能拿到进程启动时间戳；Windows 拿不到就只留 pid。 */
async function startTimeOf(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const parts = raw.split(' ');
    return parts[21] ? `proc:${parts[21]}` : '';
  } catch {
    return '';
  }
}

async function alive(pid, stamp) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (!stamp) return true;
  const now = await startTimeOf(pid);
  if (!now) return true;
  return now === stamp;
}

/**
 * 拿锁。拿到了返回 `{ok:true, release}`；被占着返回 `{ok:false, holder}`。
 * 进程已经没了的锁（崩溃留下的）直接接管。
 */
export async function acquireLock(file) {
  const stamp = (await startTimeOf(process.pid)) || '';
  const me = `${process.pid}|${stamp}`;

  const tryWrite = () => writeFile(file, me, { encoding: 'utf8', flag: 'wx' });

  const claim = async () => {
    try {
      await tryWrite();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (!(await claim())) {
    let raw = '';
    try {
      raw = (await readFile(file, 'utf8')).trim();
    } catch {}
    const [pidText, held = ''] = raw.split('|');
    const pid = Number(pidText);
    if (await alive(pid, held)) return { ok: false, holder: raw || '?' };

    // 进程没了：清掉再抢一次
    try {
      await unlink(file);
    } catch {}
    if (!(await claim())) return { ok: false, holder: raw || '?' };
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const raw = (await readFile(file, 'utf8')).trim();
      if (raw.split('|')[0] === String(process.pid)) await unlink(file);
    } catch {}
  };

  return { ok: true, release };
}
