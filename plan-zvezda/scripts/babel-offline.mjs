// Babel-транспиляция всех inline <script> офлайн-файла в ES5 (кроме полифил-блока __pzFail).
// Использование: node babel-offline.mjs <файл.html>   (запускать из plan-zvezda/, где node_modules)
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from '@babel/core';
const path = process.argv[2];
if (!path) { console.error('usage: node babel-offline.mjs <file.html>'); process.exit(2); }
let s = readFileSync(path, 'utf8');
const sizes = [];
s = s.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
  if (code.indexOf('__pzFail') >= 0) { sizes.push('polyfill:skip'); return m; }
  const out = transformSync(code, {
    presets: [['@babel/preset-env', { targets: { ie: '11' } }]],
    compact: false,
    comments: false,
    configFile: false,
    babelrc: false,
  });
  sizes.push(String(out.code.length));
  return '<script>\n' + out.code + '\n</script>';
});
writeFileSync(path, s);
console.log('babel blocks:', sizes.join(', '), '| total', s.length);
