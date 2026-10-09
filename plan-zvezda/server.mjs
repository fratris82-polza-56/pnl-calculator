// Сервер план-дашборда «Полза · Аптеки»: статика + REST API (в т.ч. приём факта из аптечного ПО).
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { openDb, ensureSchema, seed, seedDemo, ensureKpiTargets, ensureMetricTargets, ensureEmpPlan, ROOT } from './db.mjs';
import { ensureTgSchema, tgToken, buildReports, bindNew, broadcast, scheduleDaily } from './broadcast.mjs';
import { loadModules, serveModuleStatic } from './modules.mjs';

const db = openDb();
ensureSchema(db);
ensureKpiTargets(db);
ensureMetricTargets(db);
ensureEmpPlan(db);
if (seed(db)) {
  const n = seedDemo(db);
  console.log(`seed: план+сотрудники созданы, демо-факт дней: ${n}`);
}

const PORT = Number(process.env.PORT || 8080);
const MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAYS_IN = { 'Сентябрь': 30, 'Октябрь': 31, 'Ноябрь': 30, 'Декабрь': 31 };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---------- утилиты ----------
function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

// ---------- доступ: роли staff/manager/public для данных ----------
const SESS_COOKIE = 'pz_sess';
const COOKIE_MAXAGE = Math.floor(TTL_MS / 1000); // 30 дней
function parseCookies(req) {
  const raw = req.headers['cookie'] || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Аутентификация из Bearer-заголовка ИЛИ cookie-сеанса (браузерная навигация
// не может слать Authorization, поэтому для статики обязателен cookie).
function resolveAuth(req) {
  let h = req.headers['authorization'] || '';
  if (!/^Bearer\s+/i.test(h)) {
    const c = parseCookies(req)[SESS_COOKIE];
    if (c) h = 'Bearer ' + c;
  }
  if (!h) return null;
  // Сначала: manager-код (mgr_bind) — работает как Bearer-токен
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (/^M-[A-Z0-9]{8,12}$/.test(token)) {
    const mgr = db.prepare(`SELECT * FROM mgr_bind WHERE code=? AND active=1`).get(token);
    if (mgr) return { role: 'manager', mgr_id: mgr.id, delegated: false };
  }
  // Сеанс сотрудника
  return authMe(db, { headers: { authorization: h } });
}
const authDb = req => resolveAuth(req);
// Set-Cookie для успешного входа (httpOnly, SameSite=Lax). Secure — когда запрос
// пришёл по HTTPS (в т.ч. через reverse-proxy с x-forwarded-proto).
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessCookie(token, req) {
  return `${SESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAXAGE}${isHttps(req) ? '; Secure' : ''}`;
}
function clearSessCookie(req) {
  return `${SESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}
const readBearer = req => {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
};
// Проверка доступа; false → ответ уже отправлен
function deny(res, code, error) { json(res, code, { error }); return false; }
function access(req, res, role) {
  const a = authDb(req);
  if (!a) return deny(res, 401, 'требуется вход: код сотрудника или руководителя');
  if (role === 'manager' && a.role !== 'manager') return deny(res, 403, 'нужен доступ руководителя');
  if (role === 'staff' && a.role === 'manager') return deny(res, 403, 'это экран сотрудника');
  return a;
}

// Любой валидный токен (staff или manager) — для обёртки маршрутов; ролевые
// ограничения маршруты проверяют сами через access()
function accessAny(req, res) {
  const a = authDb(req);
  if (!a) return deny(res, 401, 'требуется вход: код сотрудника или руководителя');
  return a;
}

// ---- интеграционный ключ доступа (tg_state.key='intg_key' или env INTEGRATION_KEY) ----
function ensureIntgKey(db) {
  const row = db.prepare("SELECT value FROM tg_state WHERE key='intg_key'").get();
  if (row?.value) return row.value;
  let k = process.env.INTEGRATION_KEY || '';
  if (!k) k = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO tg_state(key,value) VALUES ('intg_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k);
  return k;
}
let INTG_KEY = '';
function intgKey() {
  if (!INTG_KEY) INTG_KEY = ensureIntgKey(db);
  return INTG_KEY;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid json'); }
}
function monthOf(dateStr) { // YYYY-MM-DD -> 'Сентябрь'
  const m = Number(String(dateStr).slice(5, 7));
  return MONTHS[m - 9] || null;
}

// Текущий календарный месяц внутри периода проекта (сен–дек 2026), иначе null.
// Вне периода «текущего» нет —Elapsed считается по фактическим дням, а не по дате.
function currentProjectMonth() {
  const now = new Date();
  const mk = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return (mk >= '2026-09' && mk <= '2026-12') ? MONTHS[Number(mk.slice(5, 7)) - 9] : null;
}

// Нормализация ФИО для матчинга: lower, ё→е, без пунктуации и двойных пробелов.
// «Иванова А.С.» и «иванова а с» → «иванова а с» — совпадают.
function normFio(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[.,\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Матч сотрудника: 1) точная нормализованная форма; 2) фaмилия + инициалы;
// 3) фамилия входит в norm(FIO) (падежи: «ивановой» → нет, но «иванова» → да).
function makeEmpMatcher(db) {
  const emps = db.prepare('SELECT id, pharmacy_id, fio FROM employee').all()
    .map(e => ({ ...e, nf: normFio(e.fio), fam: normFio(e.fio).split(' ')[0] }));
  return (pharmacyId, name) => {
    const q = normFio(name);
    if (!q) return null;
    const inPh = emps.filter(e => e.pharmacy_id === pharmacyId);
    return inPh.find(e => e.nf === q)
        || inPh.find(e => q.startsWith(e.fam + ' ') && q.split(' ').length >= 2)
        || inPh.find(e => e.nf.includes(q)) || null;
  };
}

// ---------- роутер ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Каталог: аптеки, план, сотрудники
route('GET', '/api/catalog', (req, res) => {
  const pharm = db.prepare('SELECT id,name,addr,color FROM pharmacy ORDER BY id').all();
  const plan = db.prepare('SELECT pharmacy_id,month,revenue,margin FROM plan').all();
  const emp = db.prepare('SELECT id,pharmacy_id,fio,role,share FROM employee ORDER BY id').all();
  const empPlan = db.prepare('SELECT pharmacy_id,fio,month,revenue,share FROM employee_plan').all();
  json(res, 200, { months: MONTHS, daysIn: DAYS_IN, pharmacy: pharm, plan, employee: emp, empPlan });
});

// Планы провизоров (Excel-override): список и bulk upsert.
// В items запись с revenue=null и share=null — удалить override (используется и для очистки тестовых данных).
route('GET', '/api/plan/employee', (req, res) => {
  json(res, 200, db.prepare('SELECT pharmacy_id,fio,month,revenue,share FROM employee_plan ORDER BY pharmacy_id,fio,month').all());
});
route('POST', /^\/api\/plan\/employee(?:\?|$)/, async (req, res) => {
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: 'invalid json' }); }
  if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{pharmacy_id,fio,month,revenue,share}]}' });
  const phIds = new Set(db.prepare('SELECT id FROM pharmacy').all().map(r => r.id));
  const empFio = new Set(db.prepare('SELECT pharmacy_id, fio FROM employee').all().map(r => `${r.pharmacy_id}|${r.fio}`));
  const up = db.prepare(`INSERT INTO employee_plan(pharmacy_id,fio,month,revenue,share) VALUES (?,?,?,?,?)
    ON CONFLICT(pharmacy_id,fio,month) DO UPDATE SET revenue=excluded.revenue, share=excluded.share`);
  const del = db.prepare('DELETE FROM employee_plan WHERE pharmacy_id=? AND fio=? AND month=?');
  let saved = 0, deleted = 0;
  const unmatched = [];
  for (const it of b.items) {
    const phId = Number(it.pharmacy_id), fio = String(it.fio || '').trim(), month = String(it.month || '').trim();
    if (!phIds.has(phId) || !fio || !MONTHS.includes(month)) { unmatched.push({ ...it, reason: 'аптека/ФИО/месяц не опознаны' }); continue; }
    if (!empFio.has(`${phId}|${fio}`)) { unmatched.push({ ...it, reason: 'ФИО не найдено в справочнике аптеки' }); continue; }
    const rev = it.revenue == null ? null : Number(it.revenue);
    const sh = it.share == null ? null : Number(it.share);
    if (rev == null && sh == null) { deleted += del.run(phId, fio, month).changes; continue; }
    up.run(phId, fio, month, rev, sh);
    saved++;
  }
  json(res, 200, { ok: true, saved, deleted, unmatched });
});

// Сотрудники: CRUD (упрощённо — список/добавить/доля)
route('POST', '/api/employee', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !b.fio) return json(res, 400, { error: 'нужны pharmacy_id и fio' });
  try {
    db.prepare('INSERT INTO employee(pharmacy_id,fio,role,share) VALUES (?,?,?,?)')
      .run(b.pharmacy_id, String(b.fio), String(b.role || 'провизор'), Number(b.share || 0));
    json(res, 201, { ok: true });
  } catch (e) {
    json(res, 409, { error: 'такой сотрудник уже есть' });
  }
});
route('PATCH', /^\/api\/employee\/(\d+)$/, async (req, res, m) => {
  const b = await readBody(req);
  const id = Number(m[1]);
  const cur = db.prepare('SELECT * FROM employee WHERE id=?').get(id);
  if (!cur) return json(res, 404, { error: 'не найден' });
  db.prepare('UPDATE employee SET fio=?, role=?, share=? WHERE id=?')
    .run(String(b.fio ?? cur.fio), String(b.role ?? cur.role), Number(b.share ?? cur.share), id);
  json(res, 200, { ok: true });
});

// Факт: ручной ввод дня {pharmacy_id, employee_id?, d, revenue, margin, checks?, stm?, ustm?, marketing?}
route('POST', '/api/fact', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !b.d || b.revenue == null) {
    return json(res, 400, { error: 'нужны pharmacy_id, d (YYYY-MM-DD), revenue' });
  }
  if (!monthOf(b.d)) return json(res, 400, { error: 'дата вне сен–дек 2026' });
  try {
    db.prepare(`INSERT INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,stm,ustm,marketing,source)
                VALUES (?,?,?,?,?,?,?,?,?,'manual')
                ON CONFLICT(pharmacy_id,employee_id,d,source)
                DO UPDATE SET revenue=excluded.revenue, margin=excluded.margin, checks=excluded.checks, stm=excluded.stm, ustm=excluded.ustm, marketing=excluded.marketing`)
      .run(b.pharmacy_id, b.employee_id ?? null, b.d, Number(b.revenue),
           Number(b.margin || 0), b.checks != null ? Number(b.checks) : null,
           Number(b.stm || 0), Number(b.ustm || 0), Number(b.marketing || 0));
    json(res, 201, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message) }); }
});

// API для аптечного ПО: автоматическая выгрузка продаж (без ручной загрузки файлов).
// POST /api/integration/sales   Заголовок: X-Intg-Key: <ключ>
// {"pharmacy_id":1,"sales":[{"doc_id":"Ч-1042","d":"2026-09-29","employee_name":"Иванова А.С.","amount":1250.5,"margin":310.2}]}
// Ответ: {ok, accepted, duplicates, mapped, unmapped:[...]}
// Повтор той же партии не задвоит факт: строки с уже известным doc_id пропускаются.
// Строки с doc_id СУММИРУЮТСЯ в факт (поток чеков), без doc_id — ЗАМЕНЯЮТ итог дня сотрудника (сводная выгрузка).
route('POST', '/api/integration/sales', async (req, res) => {
  if (String(req.headers['x-intg-key'] || '') !== intgKey()) {
    return json(res, 401, { error: 'нет или неверный ключ доступа (заголовок X-Intg-Key)' });
  }
  const b = await readBody(req);
  if (!b.pharmacy_id || !Array.isArray(b.sales)) {
    return json(res, 400, { error: 'нужны pharmacy_id и sales[]' });
  }
  if (!db.prepare('SELECT id FROM pharmacy WHERE id=?').get(b.pharmacy_id)) {
    return json(res, 400, { error: `нет аптеки pharmacy_id=${b.pharmacy_id} (список: GET /api/catalog)` });
  }
  const matchEmp = makeEmpMatcher(db);
  const findDup = db.prepare('SELECT id FROM sale_raw WHERE pharmacy_id=? AND doc_id=? AND d=? LIMIT 1');
  const insRaw = db.prepare(`INSERT INTO sale_raw(pharmacy_id,doc_id,d,employee_name,amount,margin,stm,ustm,marketing)
                             VALUES (?,?,?,?,?,?,?,?,?)`);
  const mark = db.prepare("UPDATE sale_raw SET state='mapped' WHERE id=?");
  const insFactAcc = db.prepare(`INSERT INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,stm,ustm,marketing,source)
                             VALUES (?,?,?,?,?,1,?,?,?,'api')
                             ON CONFLICT(pharmacy_id,employee_id,d,source)
                             DO UPDATE SET revenue=revenue+excluded.revenue, margin=margin+excluded.margin, checks=checks+1, stm=stm+excluded.stm, ustm=ustm+excluded.ustm, marketing=marketing+excluded.marketing`);
  const insFactRep = db.prepare(`INSERT INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,stm,ustm,marketing,source)
                             VALUES (?,?,?,?,?,1,?,?,?,'api')
                             ON CONFLICT(pharmacy_id,employee_id,d,source)
                             DO UPDATE SET revenue=excluded.revenue, margin=excluded.margin, checks=excluded.checks, stm=excluded.stm, ustm=excluded.ustm, marketing=excluded.marketing`);
  let accepted = 0, mapped = 0, duplicates = 0;
  const unmapped = new Set();
  const tx = db.begin ? db.begin() : null;
  try {
    for (const s of b.sales) {
      if (!s.d || s.amount == null) continue;
      if (!monthOf(s.d)) continue;
      const docId = s.doc_id != null && String(s.doc_id) !== '' ? String(s.doc_id) : null;
      if (docId && findDup.get(b.pharmacy_id, docId, s.d)) { duplicates++; continue; }
      const emp = s.employee_name ? matchEmp(b.pharmacy_id, s.employee_name) : null;
      const stm = s.stm != null ? Number(s.stm) : 0;
      const ustm = s.ustm != null ? Number(s.ustm) : 0;
      const marketing = s.marketing != null ? Number(s.marketing) : 0;
      const info = insRaw.run(b.pharmacy_id, docId, s.d,
                 s.employee_name || null, Number(s.amount), s.margin != null ? Number(s.margin) : null,
                 stm || null, ustm || null, marketing || null);
      if (emp) {
        mapped++;
        mark.run(info.lastInsertRowid);
        (docId ? insFactAcc : insFactRep)
          .run(b.pharmacy_id, emp.id, s.d, Number(s.amount), s.margin != null ? Number(s.margin) : 0, stm, ustm, marketing);
      } else if (s.employee_name) {
        unmapped.add(s.employee_name);
      }
      accepted++;
    }
    if (tx) tx.commit();
  } catch (e) {
    if (tx) tx.rollback();
    return json(res, 500, { error: String(e.message) });
  }
  json(res, 200, { ok: true, accepted, duplicates, mapped, unmapped: [...unmapped] });
});

// Повторная разметка нераспознанных продаж (после добавления/исправления ФИО)
route('POST', '/api/integration/remap', async (req, res) => {
  if (String(req.headers['x-intg-key'] || '') !== intgKey()) {
    return json(res, 401, { error: 'нет или неверный ключ доступа' });
  }
  const matchEmp = makeEmpMatcher(db);
  const rows = db.prepare(`SELECT id, pharmacy_id, d, employee_name, amount, margin, stm, ustm, marketing
                           FROM sale_raw WHERE state='new' AND employee_name IS NOT NULL`).all();
  const mark = db.prepare("UPDATE sale_raw SET state='mapped' WHERE id=?");
  const insFactAcc = db.prepare(`INSERT INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,stm,ustm,marketing,source)
                             VALUES (?,?,?,?,?,1,?,?,?,'api')
                             ON CONFLICT(pharmacy_id,employee_id,d,source)
                             DO UPDATE SET revenue=revenue+excluded.revenue, margin=margin+excluded.margin, checks=checks+1, stm=stm+excluded.stm, ustm=ustm+excluded.ustm, marketing=marketing+excluded.marketing`);
  let fixed = 0;
  const tx = db.begin ? db.begin() : null;
  try {
    for (const r of rows) {
      const emp = matchEmp(r.pharmacy_id, r.employee_name);
      if (emp) {
        mark.run(r.id);
        insFactAcc.run(r.pharmacy_id, emp.id, r.d, r.amount, r.margin || 0, r.stm || 0, r.ustm || 0, r.marketing || 0);
        fixed++;
      }
    }
    if (tx) tx.commit();
  } catch (e) {
    if (tx) tx.rollback();
    return json(res, 500, { error: String(e.message) });
  }
  json(res, 200, { ok: true, checked: rows.length, fixed });
});

// Оборотная ведомость по месяцам (выгрузка 1С «Оборотная ведомость [итоги по месяцам]»):
// POST /api/integration/obeorot  {rows:[{pharmacy_id, ym:"2026-01", channel?:"retail"|"ecom", revenue, margin, checks?}]}
// Повтор той же партией обновляет те же ячейки (месяц очищается перед записью — без дублей).
route('POST', '/api/integration/obeorot', async (req, res) => {
  if (String(req.headers['x-intg-key'] || '') !== intgKey()) {
    return json(res, 401, { error: 'нет или неверный ключ доступа (заголовок X-Intg-Key)' });
  }
  const b = await readBody(req);
  if (!Array.isArray(b.rows) || !b.rows.length) return json(res, 400, { error: 'нужен непустой rows[]' });
  const ins = db.prepare(`INSERT INTO obeorot_month(pharmacy_id, ym, channel, revenue, margin, checks)
                          VALUES (?,?,?,?,?,?)`);
  const touched = new Set(); // ключи "ph|ym": месяц+аптека перезаливаем целиком
  let applied = 0; const bad = [];
  const tx = db.begin ? db.begin() : null;
  try {
    for (const r of b.rows) {
      const ym = String(r.ym || '');
      const ch = r.channel === 'ecom' ? 'ecom' : 'retail';
      if (!r.pharmacy_id || !/^\d{4}-\d{2}$/.test(ym) || r.revenue == null) { bad.push(ym || '?'); continue; }
      if (!db.prepare('SELECT id FROM pharmacy WHERE id=?').get(r.pharmacy_id)) { bad.push(ym + '/ph' + r.pharmacy_id); continue; }
      const tk = r.pharmacy_id + '|' + ym;
      if (!touched.has(tk)) { db.prepare('DELETE FROM obeorot_month WHERE pharmacy_id=? AND ym=?').run(Number(r.pharmacy_id), ym); touched.add(tk); }
      ins.run(Number(r.pharmacy_id), ym, ch, Number(r.revenue), Number(r.margin || 0), r.checks != null ? Number(r.checks) : null);
      applied++;
    }
    if (tx) tx.commit();
  } catch (e) {
    if (tx) tx.rollback();
    return json(res, 500, { error: String(e.message) });
  }
  json(res, 200, { ok: true, applied, skipped: bad.length, bad });
});

// Обороты по месяцам для дашборда (вне плана Q4 — годовая картина из 1С)
route('GET', /^\/api\/obeorot(?:\?|$)/, (req, res, m, url) => {
  const rows = db.prepare(`SELECT o.pharmacy_id, o.ym, o.channel, o.revenue, o.margin, o.checks
                          FROM obeorot_month o ORDER BY o.ym, o.pharmacy_id, o.channel`).all();
  json(res, 200, { rows });
});

// Залежалка (неликвиды) — снапшот из выгрузки 1С «Залежалый товар».
// Файл обновляется скриптом projects/stm-monthly/zalezalka_snapshot.js, здесь только отдача.
route('GET', /^\/api\/zalezalka(?:\?|$)/, (req, res) => {
  const f = join(ROOT, 'zalezalka.json');
  if (!existsSync(f)) return json(res, 200, { available: false });
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    json(res, 200, Object.assign({ available: true }, d));
  } catch (e) {
    json(res, 200, { available: false, error: String(e.message) });
  }
});

// Состояние интеграции для карточки в настройках дашборда
route('GET', /^\/api\/integration\/info(?:\?|$)/, (req, res) => {
  const phs = db.prepare('SELECT id, name FROM pharmacy ORDER BY id').all();
  const st = db.prepare('SELECT state, COUNT(*) n FROM sale_raw GROUP BY state').all();
  const tot = { raw: 0, mapped: 0, new: 0 };
  for (const s of st) { tot.raw += s.n; if (s.state === 'mapped') tot.mapped = s.n; if (s.state === 'new') tot.new = s.n; }
  const last = db.prepare('SELECT imported_at, d FROM sale_raw ORDER BY id DESC LIMIT 1').get() || null;
  const unmapped = db.prepare(`SELECT employee_name name, pharmacy_id, COUNT(*) n
                           FROM sale_raw WHERE state='new' AND employee_name IS NOT NULL
                           GROUP BY pharmacy_id, employee_name ORDER BY n DESC LIMIT 20`).all()
    .map(u => ({ ...u, ph: phs.find(p => p.id === u.pharmacy_id)?.name || u.pharmacy_id }));
  json(res, 200, { key: intgKey(), totals: tot, last, unmapped });
});

// Страница-спецификация для вендора аптечного ПО: GET /integration
route('GET', /^\/integration\/?$/, (req, res) => {
  const key = intgKey();
  const host = req.headers.host || '<адрес-сервера>:8080';
  const phs = db.prepare('SELECT id, name FROM pharmacy ORDER BY id').all()
    .map(p => `<tr><td class="num">${p.id}</td><td>${p.name}</td></tr>`).join('');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Полза · Аптеки — интеграция аптечного ПО</title>
<style>
body{font:14px/1.55 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a2230}
h1{font-size:22px}h2{font-size:16px;margin-top:28px}code,pre{background:#f2f4f8;border-radius:6px;font-size:12.5px}
code{padding:1px 5px}pre{padding:12px;overflow-x:auto;border:1px solid #e3e7ee}
table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #e3e7ee;padding:6px 9px;text-align:left;font-size:13px}
th{background:#f2f4f8}.num{text-align:center}.mut{color:#66707f;font-size:12.5px}.key{font-family:monospace;background:#fff8e1;border:1px dashed #d9b300;padding:6px 10px;border-radius:6px;display:inline-block}
.warn{background:#fff4f4;border-left:3px solid #d84a3f;padding:8px 12px;border-radius:4px}
</style></head><body>
<h1>Выгрузка продаж в дашборд «Полза · Аптеки»</h1>
<p>Сервер принимает продажи по HTTP (POST JSON). Достаточно отправлять пакет один-два раза в день (например в 07:00 и в течение дня каждый час). Повторная отправка того же пакета <b>безопасна</b> — чеки с уже известным номером пропускаются автоматически.</p>

<h2>1. Адрес и ключ доступа</h2>
<p><b>POST</b> <code>http://${host}/api/integration/sales</code></p>
<p>В каждом запросе передавайте заголовок:</p>
<p class="key">X-Intg-Key: ${key}</p>
<p class="warn">Ключ секретный — хранить в настройках аптечного ПО, не публиковать.</p>

<h2>2. Формат запроса</h2>
<table>
<tr><th>Поле</th><th>Тип</th><th>Обязательно</th><th>Описание</th></tr>
<tr><td><code>pharmacy_id</code></td><td>число</td><td>да</td><td>код аптеки (таблица ниже)</td></tr>
<tr><td><code>sales[]</code></td><td>массив</td><td>да</td><td>пакет продаж</td></tr>
<tr><td><code>sales[].d</code></td><td>дата</td><td>да</td><td>дата чека, <code>ГГГГ-ММ-ДД</code></td></tr>
<tr><td><code>sales[].amount</code></td><td>число</td><td>да</td><td>сумма чека, ₽</td></tr>
<tr><td><code>sales[].doc_id</code></td><td>строка</td><td>рекомендуется</td><td>номер чека — защита от дублей</td></tr>
<tr><td><code>sales[].employee_name</code></td><td>строка</td><td>желательно</td><td>ФИО продавца как в справочнике аптеки (совпадение по фамилии+инициалам)</td></tr>
<tr><td><code>sales[].margin</code></td><td>число</td><td>нет</td><td>сумма чека (валовая прибыль), ₽</td></tr>
<tr><td><code>sales[].stm</code></td><td>число</td><td>нет</td><td>продажи СТМ (собственная торговая марка) в чеке, ₽</td></tr>
<tr><td><code>sales[].ustm</code></td><td>число</td><td>нет</td><td>продажи УСТМ (уникальная СТМ) в чеке, ₽</td></tr>
<tr><td><code>sales[].marketing</code></td><td>число</td><td>нет</td><td>продажи маркетинговых (контрактных) позиций в чеке, ₽</td></tr>
</table>
<p class="mut">Если передаются отдельные чеки — указывайте <code>doc_id</code>: они суммируются в факт. Если это сводная выгрузка итогов дня по продавцу — присылайте одну строку на продавца <b>без</b> <code>doc_id</code>: она заменит итог этого дня.</p>

<h2>3. Коды аптек</h2>
<table><tr><th class="num">id</th><th>Аптека</th></tr>${phs}</table>

<h2>4. Пример: curl</h2>
<pre>curl -X POST http://${host}/api/integration/sales \\
  -H "Content-Type: application/json" \\
  -H "X-Intg-Key: ${key}" \\
  -d '{"pharmacy_id":1,"sales":[
         {"doc_id":"Ч-1042","d":"2026-10-01","employee_name":"Иванова А.С.","amount":1250.50,"margin":310.20,"stm":420.00,"ustm":150.00,"marketing":95.00},
         {"doc_id":"Ч-1043","d":"2026-10-01","employee_name":"Петров И.И.","amount":830.00}]}'</pre>

<h2>5. Пример: Python</h2>
<pre>import requests
r = requests.post(
    "http://${host}/api/integration/sales",
    headers={"X-Intg-Key": "${key}"},
    json={"pharmacy_id": 1, "sales": [
        {"doc_id": "Ч-1042", "d": "2026-10-01",
         "employee_name": "Иванова А.С.", "amount": 1250.50, "margin": 310.20,
         "stm": 420.00, "ustm": 150.00, "marketing": 95.00},
    ]}, timeout=15)
print(r.json())</pre>

<h2>6. Пример: 1С (HTTPСоединение)</h2>
<pre>Заголовки = Новый Соответствие;
Заголовки.Вставить("Content-Type", "application/json; charset=utf-8");
Заголовки.Вставить("X-Intg-Key", "${key}");
Соединение = Новый HTTPСоединение("${host.split(':')[0]}", ${host.includes(':') ? host.split(':')[1] : '8080'});
Запрос = Новый HTTPЗапрос("/api/integration/sales", Заголовки);
Запрос.УстановитьТелоИзСтроки(ТелоЖСОН); // сформированный JSON пакета
Ответ = Соединение.Отправить(Запрос); // POST — пакет продаж
// Ответ.КодСостояния = 200 — пакет принят</pre>

<h2>7. Ответ сервера</h2>
<pre>{"ok":true,"accepted":2,"duplicates":0,"mapped":2,"unmapped":[]}</pre>
<p class="mut">Если <code>unmapped</code> не пусто — ФИО из пакета не нашлось в справочнике: продажа учтётся на аптеку, но не на сотрудника. Сообщите нам список — поправим ФИО в справочнике, данные доначислятся при следующей разметке.</p>

<h2>8. Обороты по месяцам (оборотная ведомость 1С)</h2>
<p><b>POST</b> <code>http://${host}/api/integration/obeorot</code> — итоги оборотной ведомости по месяцам («Оборотная ведомость [итоги по месяцам]»). Попадают в блок «Обороты по месяцам» дашборда: выручка, ВД и чеки по каждой аптеке за январь–декабрь, отдельно розница и интернет-заказы.</p>
<pre>curl -X POST http://${host}/api/integration/obeorot \\
  -H "Content-Type: application/json" \\
  -H "X-Intg-Key: ${key}" \\
  -d '{"rows":[{"pharmacy_id":1,"ym":"2026-01","channel":"retail","revenue":10302750.42,"margin":1244556.27,"checks":4819},
       {"pharmacy_id":1,"ym":"2026-01","channel":"ecom","revenue":5414616.85,"margin":228331.09,"checks":666}]}'</pre>
<table>
<tr><th>Поле</th><th>Тип</th><th>Обязательно</th><th>Описание</th></tr>
<tr><td><code>rows[].pharmacy_id</code></td><td>число</td><td>да</td><td>код аптеки (таблица выше)</td></tr>
<tr><td><code>rows[].ym</code></td><td>строка</td><td>да</td><td>месяц, <code>ГГГГ-ММ</code></td></tr>
<tr><td><code>rows[].revenue</code></td><td>число</td><td>да</td><td>выручка месяца («Розн+скидка»), ₽</td></tr>
<tr><td><code>rows[].margin</code></td><td>число</td><td>нет</td><td>валовая доходность («Прибыль»), ₽</td></tr>
<tr><td><code>rows[].checks</code></td><td>число</td><td>нет</td><td>количество чеков за месяц</td></tr>
</table>
<p class="mut">Повторная отправка месяца обновляет те же ячейки (без задвоения).</p>

<h2>9. Проверка связи</h2>
<p><b>GET</b> <code>http://${host}/api/health</code> — без ключа, должен вернуть <code>{"ok":true,...}</code>.</p>
<p class="mut">Коды месяцев: сентябрь–декабрь 2026. Даты вне этого периода отбрасываются без ошибки.</p>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// Сводка для дашборда: план/факт/прогноз по аптеке(-ам), месяцу(-ам), сотрудникам
route('GET', /^\/api\/summary(?:\?|$)/, (req, res, m, url) => {
  const q = url.searchParams;
  const phId = q.get('pharmacy_id') ? Number(q.get('pharmacy_id')) : null;
  // Месяцы: month=Имя (одиночный, старый вид) или months=Имя1,Имя2… (Ctrl-мультиселект)
  const MONTHS_OK = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  let months = String(q.get('months')||'').split(',').map(s=>s.trim()).filter(m=>MONTHS_OK.includes(m));
  if (!months.length){ const one = q.get('month'); if (one && MONTHS_OK.includes(one)) months=[one]; }
  const quarter = q.get('quarter');            // «1»..«4» — показывать только этот квартал (агрегат); прочее — по месяцам
  const qi = ['1','2','3','4'].includes(String(quarter||'')) ? Number(quarter) : null;
  const QMONTHS = {1:['Январь','Февраль','Март'],2:['Апрель','Май','Июнь'],3:['Сентябрь'],4:['Октябрь','Ноябрь','Декабрь']};
  if (qi) months = MONTHS_OK.filter(m=>QMONTHS[qi].includes(m));   // 1-2 кв.: планов в БД нет — вернётся пусто, это честно
  const byMonths = months.length && months.length<MONTHS_OK.length; // подмножество месяцев

  const hasM = months.length > 0;
  const planRows = db.prepare(`
    SELECT p.pharmacy_id, p.month, p.revenue, p.margin, ph.name
    FROM plan p JOIN pharmacy ph ON ph.id=p.pharmacy_id
    WHERE (? IS NULL OR p.pharmacy_id=?)${hasM? ` AND p.month IN (${months.map(()=>'?').join(',')})` : ''}
    ORDER BY p.pharmacy_id, p.month`)
    .all(phId, phId, ...(hasM?months:[]));

  const allFact = db.prepare(`
    SELECT pharmacy_id, d, SUM(revenue) revenue, SUM(margin) margin, SUM(COALESCE(checks,0)) checks,
           SUM(COALESCE(stm,0)) stm, SUM(COALESCE(ustm,0)) ustm, SUM(COALESCE(marketing,0)) marketing
    FROM fact_day WHERE (? IS NULL OR pharmacy_id=?) GROUP BY pharmacy_id, d`).all(phId, phId);
  const factByPhMonth = {};
  for (const f of allFact) {
    const mo = monthOf(f.d);
    if (!mo) continue;
    if (byMonths && !months.includes(mo)) continue;
    const k = `${f.pharmacy_id}|${mo}`;
    factByPhMonth[k] ??= { revenue: 0, margin: 0, checks: 0, stm: 0, ustm: 0, marketing: 0, days: new Set() };
    const a = factByPhMonth[k];
    a.revenue += f.revenue; a.margin += f.margin; a.checks += f.checks; a.stm += f.stm; a.ustm += f.ustm; a.marketing += f.marketing; a.days.add(f.d);
  }

  const MONTH_KEYS = {'Сентябрь':'2026-09','Октябрь':'2026-10','Ноябрь':'2026-11','Декабрь':'2026-12'};
  // Фильтр дат факта для сотрудников: по выбранным месяцам (мультиселект) или одиночному
  const fMonths = months.length? months : null;   // null = за всё время
  const mKeys = fMonths? fMonths.map(m=>MONTH_KEYS[m]).filter(Boolean) : [];
  const mLike = mKeys.length? mKeys.map(k=>k+'%') : null;   // список LIKE '2026-10%'
  // Целевые доли СТМ/Маркетинга: план ₽ = план ТО × доля (metric_target)
  const tgtMap = {};
  try {
    for (const t of db.prepare('SELECT month, stm_share, marketing_share FROM metric_target').all()) tgtMap[t.month] = t;
  } catch { /* таблица ещё не создана — планы null */ }
  const empFact = db.prepare(`
    -- Все сотрудники аптеки, даже без факта (иначе дашборд «теряет» новых)
    -- месяц(ы) (имена месяцев) фильтрует факт по сотруднику; без них — за всё время
    SELECT e.pharmacy_id, e.id employee_id, e.fio, e.share,
           COALESCE(SUM(f.revenue),0) revenue, COALESCE(SUM(f.margin),0) margin,
           COALESCE(SUM(f.checks),0) checks,
           COALESCE(SUM(f.stm),0) stm, COALESCE(SUM(f.ustm),0) ustm, COALESCE(SUM(f.marketing),0) marketing
    FROM employee e LEFT JOIN fact_day f
      ON f.employee_id=e.id ${mLike? 'AND ('+mLike.map(()=>'f.d LIKE ?').join(' OR ')+')' : ''}
    WHERE (? IS NULL OR e.pharmacy_id=?)
    GROUP BY e.id ORDER BY e.pharmacy_id, e.id`)
    .all(...(mLike?mLike:[]), phId, phId);

  // Кварталы: агрегируем строки плана по (pharmacy_id, quarter) — сумма планов/факта
  let out;
  if (qi) {
    const groups = {};
    const QLABEL = {3:'3 кв.',4:'4 кв.'};
    planRows.forEach(p => {
      const idx = MONTHS_OK.indexOf(p.month);
      const qn = Math.floor((8+idx)/3)+1;   // календарный квартал: Сентябрь→3, Октябрь–Декабрь→4
      const key = `${p.pharmacy_id}|Q${qn}`;
      groups[key] ??= { pharmacy_id: p.pharmacy_id, pharmacy: p.name, quarter: qn,
        plan_revenue:0, plan_margin:0, fact_revenue:0, fact_margin:0, fact_stm:0, fact_ustm:0, fact_marketing:0,
        plan_stm_sum:0, plan_mkt_sum:0, hasStmPlan:false, hasMktPlan:false,
        forecast_revenue:0, forecast_margin:0, forecast_stm:0, forecast_marketing:0, fact_checks:0, fact_days:0, total_days:0, months:[] };
      const g = groups[key]; g.months.push(p.month);
      g.plan_revenue += p.revenue; g.plan_margin += p.margin;
      const f = factByPhMonth[`${p.pharmacy_id}|${p.month}`] ||
                { revenue: 0, margin: 0, checks: 0, stm: 0, ustm: 0, marketing: 0, days: new Set() };
      const totalDays = DAYS_IN[p.month];
      const now = new Date();
      const isCur = p.month === currentProjectMonth();
      const elapsed = isCur ? now.getUTCDate() : (f.days.size > 0 ? f.days.size : 0);
      const dayBase = Math.max(elapsed, 1);
      g.fact_revenue += f.revenue; g.fact_margin += f.margin; g.fact_stm += f.stm; g.fact_ustm += f.ustm; g.fact_marketing += f.marketing;
      g.fact_checks += f.checks; g.fact_days += f.days.size; g.total_days += totalDays;
      g.forecast_revenue += (f.revenue/dayBase)*totalDays;
      g.forecast_margin += (f.margin/dayBase)*totalDays;
      const factStm = f.stm + f.ustm;
      g.forecast_stm += (factStm/dayBase)*totalDays;
      g.forecast_marketing += (f.marketing/dayBase)*totalDays;
      const tg = tgtMap[p.month];
      const planStm = tg?.stm_share != null ? p.revenue * tg.stm_share : null;
      const planMkt = tg?.marketing_share != null ? p.revenue * tg.marketing_share : null;
      if (planStm != null){ g.plan_stm_sum += planStm; g.hasStmPlan = true; }
      if (planMkt != null){ g.plan_mkt_sum += planMkt; g.hasMktPlan = true; }
    });
    out = Object.values(groups).sort((a,b)=> a.pharmacy_id-b.pharmacy_id || a.quarter-b.quarter).map(g => {
      const factStm = g.fact_stm + g.fact_ustm;
      const planStm = g.hasStmPlan? Math.round(g.plan_stm_sum) : null;
      const planMkt = g.hasMktPlan? Math.round(g.plan_mkt_sum) : null;
      return {
        pharmacy_id: g.pharmacy_id, pharmacy: g.pharmacy, month: `${QLABEL[g.quarter]||('Q'+g.quarter)} · ${g.months.join('+')}`, q: g.quarter,
        plan_revenue: Math.round(g.plan_revenue), plan_margin: Math.round(g.plan_margin),
        fact_revenue: Math.round(g.fact_revenue), fact_margin: Math.round(g.fact_margin),
        fact_stm: Math.round(g.fact_stm), fact_ustm: Math.round(g.fact_ustm), fact_marketing: Math.round(g.fact_marketing),
        plan_stm: planStm, plan_marketing: planMkt,
        pct_stm: planStm? +(factStm/planStm*100).toFixed(1) : null,
        pct_marketing: planMkt? +(g.fact_marketing/planMkt*100).toFixed(1) : null,
        forecast_stm: Math.round(g.forecast_stm), forecast_marketing: Math.round(g.forecast_marketing),
        forecast_pct_stm: planStm? +(g.forecast_stm/planStm*100).toFixed(1) : null,
        forecast_pct_marketing: planMkt? +(g.forecast_marketing/planMkt*100).toFixed(1) : null,
        fact_checks: g.fact_checks, fact_days: g.fact_days, total_days: g.total_days,
        pct_revenue: g.plan_revenue? +(g.fact_revenue/g.plan_revenue*100).toFixed(1) : null,
        pct_margin: g.plan_margin? +(g.fact_margin/g.plan_margin*100).toFixed(1) : null,
        forecast_revenue: Math.round(g.forecast_revenue), forecast_margin: Math.round(g.forecast_margin),
        forecast_pct: g.plan_revenue? +(g.forecast_revenue/g.plan_revenue*100).toFixed(1) : null,
      };
    }).filter(r => !qi || r.q === qi);   // выбранный квартал 1/2: просто нет строк — пусто без ошибки
  } else {
  out = planRows.map(p => {
    const f = factByPhMonth[`${p.pharmacy_id}|${p.month}`] ||
              { revenue: 0, margin: 0, checks: 0, stm: 0, ustm: 0, marketing: 0, days: new Set() };
    const totalDays = DAYS_IN[p.month];
    const now = new Date();
    const isCur = p.month === currentProjectMonth();
    const elapsed = isCur ? now.getUTCDate() : (f.days.size > 0 ? f.days.size : 0);
    const dayBase = Math.max(elapsed, 1);
    const forecastRev = (f.revenue / dayBase) * totalDays;
    const forecastVd = (f.margin / dayBase) * totalDays;
    const factStm = f.stm + f.ustm; // СТМ+УСТМ — одна метрика
    const forecastStm = (factStm / dayBase) * totalDays;
    const forecastMkt = (f.marketing / dayBase) * totalDays;
    const tg = tgtMap[p.month];
    const planStm = tg?.stm_share != null ? p.revenue * tg.stm_share : null;
    const planMkt = tg?.marketing_share != null ? p.revenue * tg.marketing_share : null;
    return {
      pharmacy_id: p.pharmacy_id, pharmacy: p.name, month: p.month,
      plan_revenue: p.revenue, plan_margin: p.margin,
      fact_revenue: Math.round(f.revenue), fact_margin: Math.round(f.margin),
      fact_stm: Math.round(f.stm), fact_ustm: Math.round(f.ustm), fact_marketing: Math.round(f.marketing),
      plan_stm: planStm != null ? Math.round(planStm) : null,
      plan_marketing: planMkt != null ? Math.round(planMkt) : null,
      pct_stm: planStm ? +(factStm / planStm * 100).toFixed(1) : null,
      pct_marketing: planMkt ? +(f.marketing / planMkt * 100).toFixed(1) : null,
      forecast_stm: Math.round(forecastStm),
      forecast_marketing: Math.round(forecastMkt),
      forecast_pct_stm: planStm ? +(forecastStm / planStm * 100).toFixed(1) : null,
      forecast_pct_marketing: planMkt ? +(forecastMkt / planMkt * 100).toFixed(1) : null,
      fact_checks: f.checks, fact_days: f.days.size, total_days: totalDays,
      pct_revenue: p.revenue ? +(f.revenue / p.revenue * 100).toFixed(1) : null,
      pct_margin: p.margin ? +(f.margin / p.margin * 100).toFixed(1) : null,
      forecast_revenue: Math.round(forecastRev),
      forecast_margin: Math.round(forecastVd),
      forecast_pct: p.revenue ? +(forecastRev / p.revenue * 100).toFixed(1) : null,
    };
  });
  }

  json(res, 200, {
    rows: out,
    metric_targets: tgtMap,
    employees: empFact.map(e => ({
      pharmacy_id: e.pharmacy_id, employee_id: e.employee_id, fio: e.fio, share: e.share,
      revenue: Math.round(e.revenue), margin: Math.round(e.margin), checks: e.checks,
      stm: Math.round(e.stm), ustm: Math.round(e.ustm), marketing: Math.round(e.marketing),
    })),
    asOf: new Date().toISOString().slice(0, 10),
  });
});

// Факт по дням (для накопительного графика)
route('GET', /^\/api\/s\.series(?:\?|$)/, (req, res, m, url) => {
  const q = url.searchParams;
  const phId = q.get('pharmacy_id') ? Number(q.get('pharmacy_id')) : null;
  const MONTHS_OK = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  let months = String(q.get('months')||'').split(',').map(s=>s.trim()).filter(m=>MONTHS_OK.includes(m));
  if (!months.length){ const one = q.get('month'); if (one && MONTHS_OK.includes(one)) months=[one]; }
  const all = db.prepare(`
    SELECT pharmacy_id, d, SUM(revenue) revenue
    FROM fact_day WHERE (? IS NULL OR pharmacy_id=?) GROUP BY pharmacy_id, d ORDER BY d`)
    .all(phId, phId)
    .filter(f => {
      if (!months.length) return true;
      const mo = monthOf(f.d);
      return mo && months.includes(mo);
    });
  const byDay = {};
  for (const f of all) {
    byDay[f.d] ??= 0;
    byDay[f.d] += f.revenue;
  }
  json(res, 200, { series: Object.entries(byDay).map(([d, fact]) => ({ d, fact: Math.round(fact) })) });
});

// Журнал импорта (последние события sale_raw + разметка сотрудников)
route('GET', /^\/api\/integration\/log(?:\?|$)/, (req, res, m, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
  const rows = db.prepare(`
    SELECT s.imported_at, s.d, s.amount, s.margin, s.employee_name, s.state, ph.name ph
    FROM sale_raw s JOIN pharmacy ph ON ph.id=s.pharmacy_id
    ORDER BY s.id DESC LIMIT ?`).all(limit);
  json(res, 200, { events: rows.map(r => ({
    at: r.imported_at,
    text: `${r.ph}: ${fmtStatic(r.amount)} (${r.employee_name || 'без сотрудника'}) · ${r.d} · ${r.state}`,
  })) });
});

function fmtStatic(v) {
  return Math.round(v).toLocaleString('ru-RU') + ' ₽';
}

// Очистка демо-факта (source='demo') — перед подключением реальных продаж
route('DELETE', /^\/api\/demo$/, (req, res) => {
  const n = db.prepare("DELETE FROM fact_day WHERE source='demo'").run().changes;
  json(res, 200, { removed: n });
});

// ---------- Telegram-рассылка сотрудникам ----------
ensureTgSchema(db);

route('GET', /^\/api\/tg\/status(?:\?|$)/, (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.fio, e.share, ph.name ph, t.code, t.chat_id, t.username
    FROM employee e JOIN pharmacy ph ON ph.id=e.pharmacy_id
    LEFT JOIN tg_bind t ON t.employee_id=e.id ORDER BY e.pharmacy_id, e.id`).all();
  json(res, 200, {
    token: !!tgToken(),
    employees: rows.map(r => ({ ...r, bound: !!r.chat_id })),
    last_broadcast: db.prepare("SELECT value FROM tg_state WHERE key='last_broadcast'").get()?.value || null,
  });
});

route('POST', /^\/api\/tg\/check(?:\?|$)/, async (req, res) => {
  const token = tgToken();
  if (!token) return json(res, 400, { error: 'токен бота не задан' });
  const r = await bindNew(db, token);
  json(res, r.ok ? 200 : 400, r);
});

route('POST', /^\/api\/tg\/broadcast(?:\?|$)/, async (req, res) => {
  const token = tgToken();
  if (!token) return json(res, 400, { error: 'токен бота не задан' });
  const r = await broadcast(db, token);
  json(res, r.ok ? 200 : 500, r);
});

route('GET', /^\/api\/tg\/preview(?:\?|$)/, (req, res) => {
  const r = buildReports(db);
  json(res, 200, r);
});

scheduleDaily(db, tgToken, async () => { await bindNew(db, tgToken()); return broadcast(db, tgToken()); }, 5);

// ---------- KPI: отказы, купоны, цели ----------
// Отказ «нет в наличии»: {pharmacy_id, d, product, qty?, note?}
route('POST', '/api/stockout', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !b.d || !b.product) {
    return json(res, 400, { error: 'нужны pharmacy_id, d (YYYY-MM-DD), product' });
  }
  db.prepare('INSERT INTO stockout(pharmacy_id,d,product,qty,note) VALUES (?,?,?,?,?)')
    .run(b.pharmacy_id, b.d, String(b.product), Number(b.qty || 1), b.note ? String(b.note) : null);
  json(res, 201, { ok: true });
});

// Топ отказов за период (по умолчанию 7 дней) — база еженедельной дозакупки
route('GET', /^\/api\/stockout\/top(?:\?|$)/, (req, res, m, url) => {
  const days = Math.min(Number(url.searchParams.get('days') || 7), 90);
  const rows = db.prepare(`
    SELECT s.product,
           COUNT(*) times,
           SUM(s.qty) qty,
           GROUP_CONCAT(DISTINCT ph.name) pharmacies
    FROM stockout s JOIN pharmacy ph ON ph.id = s.pharmacy_id
    WHERE s.d >= date('now', ?)
    GROUP BY lower(s.product) ORDER BY times DESC, qty DESC LIMIT 30`)
    .all(`-${days} days`);
  json(res, 200, { days, top: rows });
});

// Купоны: возврат {pharmacy_id, d, qty?, amount?, campaign?}
route('POST', '/api/coupon', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !b.d) {
    return json(res, 400, { error: 'нужны pharmacy_id, d (YYYY-MM-DD)' });
  }
  db.prepare('INSERT INTO coupon(pharmacy_id,d,qty,amount,campaign) VALUES (?,?,?,?,?)')
    .run(b.pharmacy_id, b.d, Number(b.qty || 1), b.amount != null ? Number(b.amount) : null,
         String(b.campaign || 'листовка'));
  json(res, 201, { ok: true });
});

// Цели KPI квартала
route('GET', /^\/api\/kpi(?:\?|$)/, (req, res) => {
  const targets = db.prepare('SELECT * FROM kpi_target').all();
  // Сеть: фактические метрики по месяцам из fact_day
  const byMonth = db.prepare(`
    SELECT d,
           SUM(revenue) revenue,
           SUM(COALESCE(checks,0)) checks
    FROM fact_day GROUP BY d`).all();
  const months = {};
  for (const f of byMonth) {
    const mo = monthOf(f.d);
    if (!mo) continue;
    months[mo] ??= { revenue: 0, checks: 0, days: new Set() };
    const a = months[mo];
    a.revenue += f.revenue; a.checks += f.checks; a.days.add(f.d);
  }
  const coupByMonth = {};
  for (const c of db.prepare('SELECT d, qty FROM coupon').all()) {
    const mo = monthOf(c.d);
    if (!mo) continue;
    coupByMonth[mo] ??= 0;
    coupByMonth[mo] += c.qty;
  }
  const out = targets.map(t => {
    const f = months[t.month] || { revenue: 0, checks: 0, days: new Set() };
    const days = Math.max(f.days.size, 1);
    const avgCheck = f.checks ? f.revenue / f.checks : null;
    return {
      month: t.month,
      target_checks_per_day: t.checks_per_day,
      target_avg_check: t.avg_check,
      target_multi_share: t.multi_share,
      target_coupons_per_week: t.coupons_per_week,
      fact_checks_per_day: f.days.size ? +(f.checks / days).toFixed(1) : null,
      fact_avg_check: avgCheck != null ? Math.round(avgCheck) : null,
      fact_coupons: coupByMonth[t.month] || 0,
      fact_days: f.days.size,
    };
  });
  json(res, 200, { rows: out });
});

// ---------- Личный кабинет (вход по коду привязки) ----------
import { ensureMeSchema, loginByCode, authMe, logoutMe, createDelegation, meData,
         loginManagerByCode, mgrLoginLocked, TTL_MS } from './me.mjs';
ensureMeSchema(db);

route('POST', /^\/api\/me\/login(?:\?|$)/, async (req, res) => {
  const b = await readBody(req);
  const code = String(b.code || '').trim().toUpperCase();
  // Код руководителя (M-...): сессия manager, данные общего дашборда
  if (/^M-[A-Z0-9]{4,12}$/.test(code)) {
    if (mgrLoginLocked()) return json(res, 429, { error: 'слишком много попыток — подожди 5 минут' });
    const mr = loginManagerByCode(db, code);
    if (!mr) return json(res, 401, { error: 'код не найден — проверь буквы и цифры' });
    return json(res, 200, mr, { 'Set-Cookie': sessCookie(mr.token, req) });
  }
  const r = loginByCode(db, b.code);
  if (!r) return json(res, 401, { error: 'код не найден — проверь буквы и цифры' });
  json(res, 200, r, { 'Set-Cookie': sessCookie(r.token, req) });
});

const meAuth = async (req, res) => {
  const a = resolveAuth(req);
  if (!a) { json(res, 401, { error: 'сессия истекла — войди по коду заново' }); return null; }
  return a;
};

route('GET', /^\/api\/me(?:\?|$)/, async (req, res, m, url) => {
  const a = await meAuth(req, res); if (!a) return;
  if (a.role === 'manager') return json(res, 403, { error: 'это экран сотрудника' });
  const d = meData(db, a.employee_id, a.delegated, url.searchParams.get('as'));
  if (!d) return json(res, 404, { error: 'не найден' });
  json(res, 200, d);
});

route('POST', /^\/api\/me\/logout(?:\?|$)/, async (req, res) => {
  logoutMe(db, req); json(res, 200, { ok: true }, { 'Set-Cookie': clearSessCookie(req) });
});

// Отказ «нет в наличии» от сотрудника/заведующей (своей аптеки)
route('POST', /^\/api\/me\/stockout(?:\?|$)/, async (req, res) => {
  const a = await meAuth(req, res); if (!a) return;
  if (a.role === 'manager') return json(res, 403, { error: 'это экран сотрудника' });
  const b = await readBody(req);
  if (!b.product) return json(res, 400, { error: 'укажи товар' });
  const phId = db.prepare('SELECT pharmacy_id FROM employee WHERE id=?').get(a.employee_id)?.pharmacy_id;
  if (!phId) return json(res, 404, { error: 'не найден' });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(b.d || '') ? b.d : new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO stockout(pharmacy_id,d,product,qty,note) VALUES (?,?,?,?,?)')
    .run(phId, d, String(b.product), Number(b.qty || 1), b.note ? String(b.note) : null);
  json(res, 201, { ok: true });
});

// Купоны: возвращает только заведующая своей аптеки
route('POST', /^\/api\/me\/coupon(?:\?|$)/, async (req, res) => {
  const a = await meAuth(req, res); if (!a) return;
  if (a.role === 'manager') return json(res, 403, { error: 'это экран сотрудника' });
  const e = db.prepare('SELECT role, pharmacy_id FROM employee WHERE id=?').get(a.employee_id);
  if (!e || (e.role !== 'заведующая' && !a.delegated)) return json(res, 403, { error: 'купоны вносит заведующая' });
  const b = await readBody(req);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(b.d || '') ? b.d : new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO coupon(pharmacy_id,d,qty,amount,campaign) VALUES (?,?,?,?,?)')
    .run(e.pharmacy_id, d, Number(b.qty || 1), b.amount != null ? Number(b.amount) : null, String(b.campaign || 'листовка'));
  json(res, 201, { ok: true });
});

// Разовый код для старшей смены (только заведующая своей аптеки)
route('POST', /^\/api\/me\/delegate(?:\?|$)/, async (req, res) => {
  const a = await meAuth(req, res); if (!a) return;
  if (a.role === 'manager') return json(res, 403, { error: 'это экран сотрудника' });
  const e = db.prepare('SELECT role FROM employee WHERE id=?').get(a.employee_id);
  if (!e || e.role !== 'заведующая') return json(res, 403, { error: 'только заведующая' });
  const r = createDelegation(db, a.employee_id);
  json(res, 201, r);
});

// Здоровье
route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true, asOf: new Date().toISOString() }));

// ---------- Личный кабинет (вход по коду привязки) ----------
import { listManagers, createManager, setManagerActive } from './me.mjs';
route('GET', /^\/api\/managers(?:\?|$)/, (req, res) => {
  const a = access(req, res, 'manager'); if (!a) return;
  json(res, 200, { managers: listManagers(db, true) }); // коды видит только manager
});
route('POST', /^\/api\/managers(?:\?|$)/, async (req, res) => {
  const a = access(req, res, 'manager'); if (!a) return;
  const b = await readBody(req);
  if (!b.name || !String(b.name).trim()) return json(res, 400, { error: 'укажи имя' });
  const r = createManager(db, String(b.name).trim(), b.note ? String(b.note) : null);
  json(res, 201, r);
});
route('PATCH', /^\/api\/managers\/(\d+)$/, async (req, res, m) => {
  const a = access(req, res, 'manager'); if (!a) return;
  const b = await readBody(req);
  setManagerActive(db, Number(m[1]), !!b.active);
  json(res, 200, { ok: true });
});

// ---------- реестр модулей (загрузка после всех route(), до applyAccessControl) ----------
// GET /api/modules → [{id,title,icon,group,order}] отфильтровано по роли вызывающего

route('GET', '/api/modules', (req, res) => {
  const a = resolveAuth(req); if (!a) { json(res, 401, { error: 'требуется вход' }); return; }
  const modDir = join(ROOT, 'modules');
  const out = [];
  let names = [];
  try { if (existsSync(modDir)) names = readdirSync(modDir).filter(n => !n.startsWith('_')); } catch (_) {}
  for (const name of names) {
    let mf;
    try { mf = JSON.parse(readFileSync(join(modDir, name, 'module.json'), 'utf8')); } catch (_) { continue; }
    if (mf.enabled === false) continue;
    if (!mf.roles || !mf.roles.includes(a.role)) continue;
    out.push({
      id: mf.id, title: mf.title, icon: mf.icon || '',
      group: mf.nav?.group || '', order: mf.nav?.order || 99,
    });
  }
  out.sort((a, b) => (a.group > b.group ? 1 : a.group < b.group ? -1 : a.order - b.order));
  json(res, 200, out);
});

// ---------- пускалки доступа (запуск после всех route()) ----------
// Exempt-пути: здоровье, вход, интеграция (самопроверка X-Intg-Key внутри маршрута)
const EXEMPT_PATHS = [
  '/api/health',
  '/api/me/login',
  '/api/integration/sales',
  '/api/integration/remap',
  '/api/integration/obeorot',
  '/api/modules',
];
// Публичная статика: экран входа, оболочка дашборда (данные — только по API с доступом) + вендорная библиотека
const STATIC_PUBLIC = new Set(['/me.html', '/index.html', '/chart.min.js']);
function effRe(r) { return r.pattern instanceof RegExp ? r.pattern : new RegExp(`^${r.pattern}$`); }
function applyAccessControl() {
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const re = effRe(r);
    // Маршрут exempt, если его regex матчит любой из exempt-путей
    if (EXEMPT_PATHS.some(p => re.test(p))) continue;
    const orig = r.handler;
    // /api/me* → любой валидный токен (роль проверяет сам маршрут);
    // всё прочее (сетевые данные + админка) → только manager.
    // Все /api/me*-маршруты объявлены RegExp'ом ^\/api\/me..., login уже exempt.
    const isMe = re.source.includes('api\\/me');
    routes[i].handler = async (req, res, m, url) => {
      const a = isMe ? accessAny(req, res) : access(req, res, 'manager');
      if (!a) return;
      return orig(req, res, m, url);
    };
  }
}

// ---------- статика ----------
const PUBLIC = join(ROOT, 'public');
function serveStatic(res, urlPath, req) {
  let p = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  if (!STATIC_PUBLIC.has(p)) {
    // Общий дашборд — только руководителям (manager)
    const a = authDb(req);
    if (!a || a.role !== 'manager') {
      // Браузерный запрос страницы → на вход; не браузер → 401/403 JSON
      if ((req.headers['accept'] || '').includes('text/html')) {
        res.writeHead(302, { Location: '/me.html' }); res.end(); return;
      }
      return json(res, a ? 403 : 401, { error: a ? 'нужен доступ руководителя' : 'требуется вход' });
    }
  }
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (type.indexOf('text/html') === 0) headers['Cache-Control'] = 'no-store, must-revalidate';   // HTML не кэшируем: обновления дашборда должны применяться сразу
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

// Загружаем модули до applyAccessControl — гейт накроет и модульные роуты
await loadModules({ db, route, json, readBody, ROOT, routes, accessAny });

// Включаем проверку доступа на всех route() — вызов после их объявления
applyAccessControl();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern instanceof RegExp ? r.pattern : new RegExp(`^${r.pattern}$`));
      if (!m) continue;
      await r.handler(req, res, m, url);
      return;
    }
    // Статика модулей /m/<id>/...
    if (req.method === 'GET' && url.pathname.startsWith('/m/')) {
      const srv = serveModuleStatic(res, url.pathname, req, authDb, ROOT);
      if (srv) return;
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname, req);
    json(res, 404, { error: 'no route' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`plan-zvezda on :${PORT}`));
