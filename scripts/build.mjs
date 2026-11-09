// 打两个单文件：库和命令行。运行时不带任何依赖，只有开发时要 esbuild。
// 注意：打出来的文件里 import.meta.url 指到 dist/，所以单文件版不提供热重载。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const head = '// ' + pkg.name + ' v' + pkg.version + ' · 生成物，勿手改';

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/mailbox-kit.mjs',
  banner: { js: head },
  legalComments: 'none',
});

await build({
  entryPoints: ['bin/mailboxd.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/mailboxd.mjs',
  banner: { js: head },
  legalComments: 'none',
});

console.log('打好了：dist/mailbox-kit.mjs、dist/mailboxd.mjs');
