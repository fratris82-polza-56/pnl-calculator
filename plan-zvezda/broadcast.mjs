// Telegram-рассылка планов сотрудникам (Bot API).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAYS_IN = { 'Сентябрь': 30, 'Октябрь': 31, 'Ноябрь': 30, 'Декабрь': 31 };
const MM = { '09': 'Сентябрь', '10': 'Октябрь', '11': 'Ноябрь', '12': 'Декабрь' };
const MKEY = { 'Сентябрь': '2026-09', 'Октябрь': '2026-10', 'Ноябрь': '2026-11', 'Декабрь': '2026-12' };
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function ensureTgSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tg_bind(
    employee_id INTEGER PRIMARY KEY REFERENCES employee(id),
    code TEXT UNIQUE NOT NULL,
    chat_id TEXT, username TEXT, bound_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS tg_state(key TEXT PRIMARY KEY, value TEXT)`);
  const missing = db.prepare(
    'SELECT e.id FROM employee e LEFT JOIN tg_bind t ON t.employee_id=e.id WHERE t.employee_id IS NULL').all();
  for (const { id } of missing) {
    const code = Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
    db.prepare('INSERT INTO tg_bind(employee_id, code) VALUES (?,?)').run(id, code);
  }
}

export function tgToken() {
  if (process.env.TG_BOT_TOKEN) return process.env.TG_BOT_TOKEN.trim();
  try { return readFileSync(join(ROOT, 'data', 'tg-token'), 'utf8').trim() || null; } catch { return null; }
}

const state = {
  get: (db, k) => db.prepare('SELECT value FROM tg_state WHERE key=?').get(k)?.value ?? null,
  set: (db, k, v) => db.prepare('INSERT INTO tg_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),
};

async function tgApi(token, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return r.json();
}

// Активный месяц = месяц последних данных факта (числа совпадают с дашбордом).
function activeMonth(db) {
  const d = db.prepare('SELECT MAX(d) md FROM fact_day').get()?.md;
  return (d && MM[d.slice(5, 7)]) || 'Сентябрь';
}

const fmt = n => Math.round(n).toLocaleString('ru-RU');
const fmtM = n => n >= 1e6 ? (n / 1e6).toFixed(2).replace('.', ',') + ' млн ₽' : fmt(n) + ' ₽';
const pct1 = x => x == null ? '—' : x.toFixed(1).replace('.', ',') + '%';

export function buildReports(db) {
  const month = activeMonth(db);
  const totalDays = DAYS_IN[month];
  const mkey = MKEY[month];
  const now = new Date();
  const isCurrentCal = MM[`0${now.getUTCMonth() + 1}`.slice(-2)] === month;
  // elapsed: если план-месяц = текущий календарный — прошло дней; иначе — сколько дней факта накоплено
  const factDays = db.prepare('SELECT COUNT(DISTINCT d) n FROM fact_day WHERE substr(d,1,7)=?').get(mkey)?.n || 0;
  const elapsed = isCurrentCal ? Math.max(now.getUTCDate(), factDays, 1) : Math.max(factDays, 1);

  const plans = Object.fromEntries(db.prepare('SELECT pharmacy_id, revenue FROM plan WHERE month=?').all(month).map(p => [p.pharmacy_id, p.revenue]));
  const names = Object.fromEntries(db.prepare('SELECT id, name FROM pharmacy').all().map(p => [p.id, p.name]));
  const phFact = db.prepare('SELECT pharmacy_id, SUM(revenue) rev FROM fact_day WHERE substr(d,1,7)=? GROUP BY pharmacy_id').all(mkey);
  const ph = {};
  let netPlan = 0, netFact = 0;
  for (const f of phFact) {
    const plan = plans[f.pharmacy_id] || 0;
    const fact = f.rev || 0;
    const fcst = fact / elapsed * totalDays;
    ph[f.pharmacy_id] = { plan, fact, pct: plan ? fact / plan * 100 : 0, fcstPct: plan ? fcst / plan * 100 : 0 };
    netPlan += plan; netFact += fact;
  }
  const netFcstPct = netPlan ? (netFact / elapsed * totalDays) / netPlan * 100 : 0;
  const netPct = netPlan ? netFact / netPlan * 100 : 0;

  const emps = db.prepare(`
    SELECT e.id, e.fio, e.share, e.pharmacy_id
    FROM employee e WHERE e.share > 0`).all();
  const factByEmp = Object.fromEntries(db.prepare(`
    SELECT employee_id id, SUM(revenue) rev FROM fact_day
    WHERE substr(d,1,7)=? GROUP BY employee_id`)
    .all(mkey)
    .map(r => [r.id, r.rev || 0]));

  const reports = emps.map(e => {
    const plan = Math.round((plans[e.pharmacy_id] || 0) * e.share);
    const fact = Math.round(factByEmp[e.id] || 0);
    const p = pct1(plan ? fact / plan * 100 : null);
    const left = Math.max(plan - fact, 0);
    const daysLeft = Math.max(totalDays - elapsed, 1);
    const fcstPct = plan ? (fact / elapsed * totalDays) / plan * 100 : null;
    const phInfo = ph[e.pharmacy_id] || { pct: 0, fcstPct: 0 };
    const lines = [
      `📊 ${month} · ${names[e.pharmacy_id] || '—'}`,
      '',
      `Ты: ${fmt(fact)} из ${fmt(plan)} ₽ — ${p}`,
    ];
    if (left > 0) lines.push(`Осталось: ${fmt(left)} ₽ ≈ ${fmt(left / daysLeft)} ₽/день`);
    lines.push('',
      `Аптека: ${pct1(phInfo.pct)} · прогноз ~${pct1(phInfo.fcstPct)}`,
      `Сеть: ${pct1(netPct)} из ${fmtM(netPlan)} · прогноз ~${pct1(netFcstPct)}`);
    return { employee_id: e.id, fio: e.fio, month, text: lines.join('\n'), pct: fact / (plan || 1) * 100 };
  });
  return { month, reports, net: { plan: netPlan, fact: netFact, pct: netPct, fcstPct: netFcstPct }, meta: { elapsed, totalDays } };
}

// Привязка: /start <CODE> от сотрудника -> chat_id
export async function bindNew(db, token) {
  const offset = Number(state.get(db, 'upd_offset') || 0);
  const res = await tgApi(token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
  if (!res.ok) return { ok: false, error: res.description || 'getUpdates failed' };
  const bound = [];
  let maxId = offset;
  for (const u of res.result || []) {
    maxId = Math.max(maxId, u.update_id + 1);
    const msg = u.message;
    if (!msg || !msg.text) continue;
    const m = msg.text.match(/(?:^\/start\s+|^)([A-Z0-9]{6})$/i);
    if (!m) continue;
    const code = m[1].toUpperCase();
    const row = db.prepare('SELECT employee_id FROM tg_bind WHERE code=?').get(code);
    if (!row) continue;
    db.prepare('UPDATE tg_bind SET chat_id=?, username=?, bound_at=? WHERE employee_id=?')
      .run(String(msg.chat.id), msg.from.username || null, new Date().toISOString(), row.employee_id);
    bound.push({ fio: db.prepare('SELECT fio FROM employee WHERE id=?').get(row.employee_id)?.fio, username: msg.from.username || null });
  }
  if (maxId !== offset) state.set(db, 'upd_offset', maxId);
  return { ok: true, bound, scanned: (res.result || []).length };
}

export async function broadcast(db, token) {
  const { reports } = buildReports(db);
  const bindings = db.prepare('SELECT employee_id, chat_id, username FROM tg_bind WHERE chat_id IS NOT NULL').all();
  const byId = Object.fromEntries(reports.map(r => [r.employee_id, r]));
  const results = [];
  for (const b of bindings) {
    const rep = byId[b.employee_id];
    if (!rep) continue;
    const res = await tgApi(token, 'sendMessage', { chat_id: b.chat_id, text: rep.text, disable_web_page_preview: true });
    results.push({ fio: rep.fio, ok: !!res.ok, error: res.ok ? null : res.description });
  }
  state.set(db, 'last_broadcast', new Date().toISOString());
  return { ok: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results, unbound: reports.length - bindings.length };
}

// Ежедневный триггер 08:00 МСК (UTC+3 -> час 5 UTC), проверять каждые 60с.
export function scheduleDaily(db, getToken, run, hourUtc = 5) {
  const tick = async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() !== hourUtc || now.getUTCMinutes() > 2) return;
      const today = now.toISOString().slice(0, 10);
      if (state.get(db, 'last_broadcast')?.slice(0, 10) === today) return;
      const token = getToken();
      if (!token) return;
      const r = await run();
      console.log(`tg-broadcast: sent=${r.sent} failed=${r.failed} unbound=${r.unbound}`);
    } catch (e) { console.error('tg-broadcast:', e.message); }
  };
  setInterval(tick, 60_000);
}
