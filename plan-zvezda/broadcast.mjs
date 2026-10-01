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

// Рекомендация дня: главная подсказка сотруднику из его же цифр.
function advice(db, e, fact, plan, elapsed, avgCheck, phPct) {
  if (!plan) return 'Роль без персонального плана. Ориентир: план и топ-товары аптеки, с первого дня — допродажа каждому покупателю.';
  const empPct = plan ? fact / plan * 100 : 0;
  const gap = empPct - phPct;
  const month = activeMonth(db);
  const mkey = MKEY[month];
  const t = db.prepare('SELECT checks_per_day, avg_check FROM kpi_target WHERE month=?').get(month);
  const days = Math.max(elapsed, 1);
  const half = `d > date('${mkey}-15')`;
  const w = db.prepare(`
    SELECT SUM(CASE WHEN ${half} THEN revenue ELSE 0 END) r2, SUM(CASE WHEN ${half} THEN checks ELSE 0 END) c2,
           SUM(revenue) r1, SUM(checks) c1
    FROM fact_day WHERE employee_id=? AND substr(d,1,7)=?`).get(e.id, mkey);
  const avgPrev = w?.c1 > w?.c2 ? (w.r1 - w.r2) / (w.c1 - w.c2) : null;
  const trend = avgPrev ? (avgCheck - avgPrev) / avgPrev : 0;

  // 1) отставание от аптеки — самое важное
  if (gap < -3) return `Ты ${pct1(empPct)} при аптеке ${pct1(phPct)} — отстаёшь от коллег. Сегодня фокус: каждый покупатель — с допродажей (витамины, уход, детские).`;
  // 2) ср.чек ниже цели
  if (t?.avg_check && avgCheck < t.avg_check * 0.97) {
    const need = Math.round(t.avg_check - avgCheck);
    return `Средний чек ${Math.round(avgCheck)} ₽ при цели ${Math.round(t.avg_check)} ₽. Добавь ${need} ₽ к чеку: это +1 позиция (сопутствующее, акция полки).`;
  }
  // 3) чек растёт — закрепить
  if (trend > 0.02) return `Средний чек растёт: ${Math.round(avgPrev)} → ${Math.round(avgCheck)} ₽. Отличная динамика — держи темп, веди к цели ${Math.round(t?.avg_check || 0)} ₽.`;
  // 4) отставание по % от плана при равной аптеке — объём
  if (empPct < 90) return `До плана ${pct1(empPct)}. Сегодня задача — количество: +2 контакта в час, приветствие каждого покупателя акцией дня.`;
  return `Ты в графике (${pct1(empPct)}). Поддержи план: предложи промо-товар или СТМ каждому второму покупателю.`;
}

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
    FROM employee e`).all();
  const factByEmp = Object.fromEntries(db.prepare(`
    SELECT employee_id id, SUM(revenue) rev FROM fact_day
    WHERE substr(d,1,7)=? GROUP BY employee_id`)
    .all(mkey)
    .map(r => [r.id, r.rev || 0]));

  const reports = emps.map(e => {
    const hasRole = e.share > 0;
    const plan = Math.round((plans[e.pharmacy_id] || 0) * e.share);
    const fact = Math.round(factByEmp[e.id] || 0);
    const p = pct1(hasRole && plan ? fact / plan * 100 : null);
    const left = hasRole ? Math.max(plan - fact, 0) : 0;
    const daysLeft = Math.max(totalDays - elapsed, 1);
    const fcstPct = hasRole && plan ? (fact / elapsed * totalDays) / plan * 100 : null;
    const phInfo = ph[e.pharmacy_id] || { pct: 0, fcstPct: 0 };
    const chkRow = db.prepare('SELECT SUM(revenue) rev, SUM(checks) chk FROM fact_day WHERE employee_id=? AND substr(d,1,7)=?').get(e.id, mkey);
    const avgCheck = chkRow?.chk ? chkRow.rev / chkRow.chk : 0;
    const tip = advice(db, e, fact, plan, elapsed, avgCheck, phInfo.pct);
    const lines = [
      `📊 ${month} · ${names[e.pharmacy_id] || '—'}`,
      '',
      hasRole ? `Ты: ${fmt(fact)} из ${fmt(plan)} ₽ — ${p}` : `Статус: вакансия — персональный отчёт появится с выходом сотрудника`,
    ];
    if (left > 0) lines.push(`Осталось: ${fmt(left)} ₽ ≈ ${fmt(left / daysLeft)} ₽/день`);
    lines.push('',
      `Аптека: ${pct1(phInfo.pct)} · прогноз ~${pct1(phInfo.fcstPct)}`,
      `Сеть: ${pct1(netPct)} из ${fmtM(netPlan)} · прогноз ~${pct1(netFcstPct)}`,
      '',
      `💡 ${tip}`);
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
  // Несколько ролей одного человека (заведующая 3 аптек) => один chat_id: дайджест, одно сообщение
  const byChat = new Map();
  for (const b of bindings) {
    const rep = byId[b.employee_id];
    if (!rep) continue;
    if (!byChat.has(b.chat_id)) byChat.set(b.chat_id, { fio: rep.fio, parts: [] });
    byChat.get(b.chat_id).parts.push(rep);
  }
  const results = [];
  for (const [chatId, { fio, parts }] of byChat) {
    const text = parts.length === 1 ? parts[0].text
      : parts.map(p => p.text).join(`\n\n${'—'.repeat(14)}\n\n`);
    const res = await tgApi(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    results.push({ fio: fio + (parts.length > 1 ? ` (+${parts.length - 1} апт.)` : ''), ok: !!res.ok, error: res.ok ? null : res.description });
  }
  state.set(db, 'last_broadcast', new Date().toISOString());
  return { ok: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results, unbound: reports.length - byChat.size };
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
