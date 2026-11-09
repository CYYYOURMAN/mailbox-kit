// seen.js —— 指纹库。投递成功后记一口，下次就不再投。
// 落盘用「写临时文件再改名」，断电不留半截。

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class SeenStore {
  constructor(file, { limit = 500 } = {}) {
    this.file = file;
    this.limit = limit;
    this.set = new Set();
    this.loaded = false;
    this.fileExisted = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      // 文件在，就算建过档——哪怕里面是 []（首跑一条都没扫到时就是这样）
      this.fileExisted = true;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) this.set = new Set(arr.slice(-this.limit));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  /** 「建过档没有」认文件在不在，不认里面有几条。认条数的话，首跑 0 条会每次重启都重来一遍。 */
  get existed() {
    return this.fileExisted === true;
  }

  has(fp) {
    return this.set.has(fp);
  }

  add(fp) {
    if (this.set.has(fp)) return false;
    this.set.add(fp);
    while (this.set.size > this.limit) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
    return true;
  }

  delete(fp) {
    return this.set.delete(fp);
  }

  async save() {
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.set]), 'utf8');
    await rename(tmp, this.file);
  }
}

