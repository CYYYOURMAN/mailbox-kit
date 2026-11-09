import { createUiServer } from './src/ui.js';

const ui = createUiServer({
  dir: 'C:/Users/30259/Documents/dafeiyu/notes/pc',
  self: '电脑',
  read: ['信箱-手机.md', '信箱-电脑.md'],
  port: 7654,
});
await ui.listen();
console.log('地址 http://127.0.0.1:' + ui.server.address().port + '/?k=' + ui.key);
