#!/usr/bin/env node
// Быстрый смоук-тест офлайн-файла «План-Звезда» через headless Chrome (CDP :9359).
// Использование:  node scripts/dev-check.mjs <файл.html|http://...> [секунды ожидания]
// Пример:         node scripts/dev-check.mjs plan-zvezda-offline-2026-10-08.html
// Код выхода: 0 = всё ок, 1 = найдены проблемы (падение скрипта, красный баннер, пустые графики).
const wsmod = process.env.WS_PATH || 'file:///app/node_modules/.pnpm/ws@8.21.3/node_modules/ws/wrapper.mjs';
const { WebSocket } = await import(wsmod);

const target = process.argv[2];
const waitMs = Number(process.argv[3] || 4000);
if (!target) { console.error('usage: node scripts/dev-check.mjs <file.html|url> [waitMs]'); process.exit(2); }
const url = /^https?:/.test(target) ? target : 'file://' + (target.startsWith('/') ? target : process.cwd() + '/' + target);

const list = await (await fetch('http://127.0.0.1:9359/json/list')).json();
let tab = list.find(x => x.type === 'page');
if (!tab) tab = await (await fetch('http://127.0.0.1:9359/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pend = new Map(); const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on('message', m => {
  const d = JSON.parse(m);
  if (d.id && pend.has(d.id)) { d.error ? pend.get(d.id).rej(new Error(JSON.stringify(d.error))) : pend.get(d.id).res(d.result); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push((d.params?.exceptionDetails?.exception?.description || '').split('\n')[0]);
});
await new Promise(r => ws.on('open', r));
await send('Runtime.enable'); await send('Page.enable');
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: e });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || 'eval fail').split('\n')[0]);
  return r.result?.value;
};
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, waitMs));

const stamp = await ev(`!![...document.querySelectorAll('div,span')].find(d=>d.textContent&&d.textContent.indexOf('сборка')===0)`);
const banner = await ev(`(()=>{const b=document.querySelector('#compatBanner');return b?b.textContent.slice(0,160):null})()`);
const canvases = await ev(`document.querySelectorAll('canvas').length`);
const charts = await ev(`(()=>{try{return [...document.querySelectorAll('canvas')].map(c=>{const g=Chart&&Chart.getChart?Chart.getChart(c):null;return (c.id||'canvas')+':'+(g?g.data.labels.length+'pt/'+g.data.datasets.length+'ds':'EMPTY')})}catch(e){return ['ERR:'+e.message]}})()`);
// клик по фильтру «Месяц», если есть
let monthPopup = 'n/a';
const hasMs = await ev(`!!document.querySelector('#msBtn')`);
if (hasMs) {
  await ev(`document.querySelector('#msBtn').click()`);
  await new Promise(r => setTimeout(r, 400));
  monthPopup = await ev(`(()=>{const p=document.querySelector('#msPop');return p?getComputedStyle(p).display:'no-popup'})()`);
}

console.log(JSON.stringify({ url, stamp, banner, canvases, charts, monthPopup, jsErrors: errors.slice(0, 5) }, null, 1));
const bad = !stamp || !!banner || errors.length > 0 || charts.some(c => c.endsWith('EMPTY') || c.startsWith('ERR'));
console.log(bad ? 'FAIL' : 'PASS');
process.exit(bad ? 1 : 0);
