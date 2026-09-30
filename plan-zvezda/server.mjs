// Сервер план-дашборда «Звезда»: статика + REST API (в т.ч. приём факта из аптечного ПО).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { openDb, ensureSchema, seed, seedDemo, ROOT } from './db.mjs';

const db = openDb();
ensureSchema(db);
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
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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

// ---------- роутер ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Каталог: аптеки, план, сотрудники
route('GET', '/api/catalog', (req, res) => {
  const pharm = db.prepare('SELECT id,name,addr,color FROM pharmacy ORDER BY id').all();
  const plan = db.prepare('SELECT pharmacy_id,month,revenue,margin FROM plan').all();
  const emp = db.prepare('SELECT id,pharmacy_id,fio,role,share FROM employee ORDER BY id').all();
  json(res, 200, { months: MONTHS, daysIn: DAYS_IN, pharmacy: pharm, plan, employee: emp });
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

// Факт: ручной ввод дня {pharmacy_id, employee_id?, d, revenue, margin, checks?}
route('POST', '/api/fact', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !b.d || b.revenue == null) {
    return json(res, 400, { error: 'нужны pharmacy_id, d (YYYY-MM-DD), revenue' });
  }
  if (!monthOf(b.d)) return json(res, 400, { error: 'дата вне сен–дек 2026' });
  try {
    db.prepare(`INSERT INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,source)
                VALUES (?,?,?,?,?,?, 'manual')
                ON CONFLICT(pharmacy_id,employee_id,d,source)
                DO UPDATE SET revenue=excluded.revenue, margin=excluded.margin, checks=excluded.checks`)
      .run(b.pharmacy_id, b.employee_id ?? null, b.d, Number(b.revenue),
           Number(b.margin || 0), b.checks != null ? Number(b.checks) : null);
    json(res, 201, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message) }); }
});

// API для аптечного ПО: пакетная выгрузка продаж.
// POST /api/integration/sales
// {"pharmacy_id":1,"from":"2026-09-01","to":"2026-09-30","sales":[{"doc_id":"...","d":"2026-09-05","employee_name":"Иванова","amount":1250.5,"margin":310.2}]}
// Ответ: {accepted, mapped, unmapped:[...]} ; employee_name матчится на employee.fio (ILIKE, без падежей — точное вхождение).
route('POST', '/api/integration/sales', async (req, res) => {
  const b = await readBody(req);
  if (!b.pharmacy_id || !Array.isArray(b.sales)) {
    return json(res, 400, { error: 'нужны pharmacy_id и sales[]' });
  }
  const insRaw = db.prepare(`INSERT INTO sale_raw(pharmacy_id,doc_id,d,employee_name,amount,margin)
                             VALUES (?,?,?,?,?,?)`);
  const findEmp = db.prepare('SELECT id FROM employee WHERE pharmacy_id=? AND lower(fio)=lower(?)');
  let accepted = 0, mapped = 0;
  const unmapped = new Set();
  const tx = db.begin ? db.begin() : null;
  try {
    for (const s of b.sales) {
      if (!s.d || s.amount == null) continue;
      if (!monthOf(s.d)) continue;
      insRaw.run(b.pharmacy_id, s.doc_id || null, s.d,
                 s.employee_name || null, Number(s.amount), s.margin != null ? Number(s.margin) : null);
      accepted++;
      if (s.employee_name) {
        const e = findEmp.get(b.pharmacy_id, s.employee_name);
        if (e) mapped++; else unmapped.add(s.employee_name);
      }
    }
    if (tx) tx.commit();
  } catch (e) {
    if (tx) tx.rollback();
    return json(res, 500, { error: String(e.message) });
  }
  json(res, 200, { accepted, mapped, unmapped: [...unmapped] });
});

// Сводка для дашборда: план/факт/прогноз по аптеке(-ам), месяцу(-ам), сотрудникам
route('GET', /^\/api\/summary(?:\?|$)/, (req, res, m, url) => {
  const q = url.searchParams;
  const phId = q.get('pharmacy_id') ? Number(q.get('pharmacy_id')) : null;
  const month = q.get('month');

  const planRows = db.prepare(`
    SELECT p.pharmacy_id, p.month, p.revenue, p.margin, ph.name
    FROM plan p JOIN pharmacy ph ON ph.id=p.pharmacy_id
    WHERE (? IS NULL OR p.pharmacy_id=?) AND (? IS NULL OR p.month=?)
    ORDER BY p.pharmacy_id, p.month`).all(phId, phId, month, month);

  const allFact = db.prepare(`
    SELECT pharmacy_id, d, SUM(revenue) revenue, SUM(margin) margin, SUM(COALESCE(checks,0)) checks
    FROM fact_day WHERE (? IS NULL OR pharmacy_id=?) GROUP BY pharmacy_id, d`).all(phId, phId);
  const factByPhMonth = {};
  for (const f of allFact) {
    const mo = monthOf(f.d);
    if (!mo) continue;
    if (month && mo !== month) continue;
    const k = `${f.pharmacy_id}|${mo}`;
    factByPhMonth[k] ??= { revenue: 0, margin: 0, checks: 0, days: new Set() };
    const a = factByPhMonth[k];
    a.revenue += f.revenue; a.margin += f.margin; a.checks += f.checks; a.days.add(f.d);
  }

  const empFact = db.prepare(`
    SELECT f.pharmacy_id, f.employee_id, e.fio, e.share,
           SUM(f.revenue) revenue, SUM(f.margin) margin
    FROM fact_day f JOIN employee e ON e.id=f.employee_id
    WHERE (? IS NULL OR f.pharmacy_id=?) GROUP BY f.pharmacy_id, f.employee_id`).all(phId, phId);

  const out = planRows.map(p => {
    const f = factByPhMonth[`${p.pharmacy_id}|${p.month}`] ||
              { revenue: 0, margin: 0, checks: 0, days: new Set() };
    const totalDays = DAYS_IN[p.month];
    const now = new Date();
    const isCur = p.month === MONTHS[now.getUTCMonth() - 9];
    const elapsed = isCur ? now.getUTCDate() : (f.days.size > 0 ? f.days.size : 0);
    const dayBase = Math.max(elapsed, 1);
    const forecastRev = (f.revenue / dayBase) * totalDays;
    const forecastVd = (f.margin / dayBase) * totalDays;
    return {
      pharmacy_id: p.pharmacy_id, pharmacy: p.name, month: p.month,
      plan_revenue: p.revenue, plan_margin: p.margin,
      fact_revenue: Math.round(f.revenue), fact_margin: Math.round(f.margin),
      fact_checks: f.checks, fact_days: f.days.size, total_days: totalDays,
      pct_revenue: p.revenue ? +(f.revenue / p.revenue * 100).toFixed(1) : null,
      pct_margin: p.margin ? +(f.margin / p.margin * 100).toFixed(1) : null,
      forecast_revenue: Math.round(forecastRev),
      forecast_margin: Math.round(forecastVd),
      forecast_pct: p.revenue ? +(forecastRev / p.revenue * 100).toFixed(1) : null,
    };
  });

  json(res, 200, {
    rows: out,
    employees: empFact.map(e => ({
      pharmacy_id: e.pharmacy_id, employee_id: e.employee_id, fio: e.fio, share: e.share,
      revenue: Math.round(e.revenue), margin: Math.round(e.margin),
    })),
    asOf: new Date().toISOString().slice(0, 10),
  });
});

// Факт по дням (для накопительного графика)
route('GET', /^\/api\/s\.series(?:\?|$)/, (req, res, m, url) => {
  const q = url.searchParams;
  const phId = q.get('pharmacy_id') ? Number(q.get('pharmacy_id')) : null;
  const month = q.get('month');
  const all = db.prepare(`
    SELECT pharmacy_id, d, SUM(revenue) revenue
    FROM fact_day WHERE (? IS NULL OR pharmacy_id=?) GROUP BY pharmacy_id, d ORDER BY d`)
    .all(phId, phId)
    .filter(f => !month || monthOf(f.d) === month);
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

// Здоровье
route('GET', /^\/api\/health$/, (req, res) => json(res, 200, { ok: true, asOf: new Date().toISOString() }));

// ---------- статика ----------
const PUBLIC = join(ROOT, 'public');
function serveStatic(res, urlPath) {
  let p = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

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
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    json(res, 404, { error: 'no route' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`plan-zvezda on :${PORT}`));
