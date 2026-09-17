#!/usr/bin/env node
/* Приём кода плана из P&L-калькулятора → вебхук → лист «Планы» Google-таблицы.
   Использование: node save_plan.mjs "PNL1.<base64url>" [Аптека]
   Аптека по умолчанию — «Без названия».
   Токен берётся из env HOOK_TOKEN (не хардкодится). */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [,, code, pharmacyArg] = process.argv;
if (!code || !code.startsWith('PNL1.')) {
  console.error('usage: node save_plan.mjs "PNL1.<code>" [Аптека]');
  process.exit(1);
}
const TOKEN = process.env.HOOK_TOKEN;
if (!TOKEN) { console.error('HOOK_TOKEN env required'); process.exit(1); }

// URL вебхука — из gsheet-hook/Code.gs (строка URL=...)
const gs = readFileSync(new URL('../gsheet-hook/Code.gs', import.meta.url), 'utf8');
const m = gs.match(/https:\/\/script\.google\.com\/macros\/s\/[^'"\s]+\/exec/);
if (!m) { console.error('hook URL not found'); process.exit(1); }
const URL_ = m[0];

const b64 = code.slice(5).replace(/-/g, '+').replace(/_/g, '/');
const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
const p = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));

const row = [
  new Date().toISOString().slice(0, 10),        // дата сохранения
  pharmacyArg || 'Без названия',                // аптека
  p.d ?? '',                                    // дата расчёта
  p.rev ?? 0, p.vd ?? 0, p.exp ?? 0, p.op ?? 0, p.np ?? 0,
  p.rw ?? 0, p.rr ?? 0, p.re ?? 0,
  p.mr ?? 0, p.me ?? 0, p.mw ?? 0,
  code,                                          // полный код (для аудита)
];

const body = JSON.stringify({
  token: TOKEN, sheet: 'Планы', createIfMissing: true, appendRow: row,
});
// 302 → GET location (нюанс Google), как в hook_post.sh
const out = execFileSync('curl', ['-s', '-D', '-', '-o', '/dev/null', '--max-time', '30',
  '-X', 'POST', '-H', 'Content-Type: application/json', '-d', body, URL_], { encoding: 'utf8' });
const loc = out.split('\n').find(l => l.toLowerCase().startsWith('location:'))?.split(' ')[1]?.trim();
if (!loc) { console.error('no redirect location'); process.exit(1); }
const resp = execFileSync('curl', ['-s', '--max-time', '30', loc], { encoding: 'utf8' });
console.log(resp);
