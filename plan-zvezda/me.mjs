// Личный кабинет: сессии по коду сотрудника + личные данные (план/факт/рекомендация).
// Роли сессий: 'staff' — сотрудник аптеки (tg-код из tg_bind), 'manager' — руководитель (mgr_bind).
import { randomBytes, createHash } from 'node:crypto';

const DAYS_IN = { 'Сентябрь': 30, 'Октябрь': 31, 'Ноябрь': 30, 'Декабрь': 31 };
const MM = { '09': 'Сентябрь', '10': 'Октябрь', '11': 'Ноябрь', '12': 'Декабрь' };
const MKEY = { 'Сентябрь': '2026-09', 'Октябрь': '2026-10', 'Ноябрь': '2026-11', 'Декабрь': '2026-12' };
export const TTL_MS = 1000 * 60 * 60 * 24 * 30; // месяц

// ---------- сессии ----------
export function ensureMeSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS me_session(
    token_hash TEXT PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  // Разовые коды заведующей для передачи старшей в смене (час, хранится только хэш)
  db.exec(`CREATE TABLE IF NOT EXISTS me_delegation(
    token_hash TEXT PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id),
    created_by INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  // Персональные коды руководителей ПОЛЬЗА: доступ к общему дашборду (роль manager)
  db.exec(`CREATE TABLE IF NOT EXISTS mgr_bind(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, note TEXT,
    created_at TEXT NOT NULL, last_login TEXT)`);
  // Сессии руководителей (отдельная таблица: employee_id в me_session — NOT NULL)
  db.exec(`CREATE TABLE IF NOT EXISTS mgr_session(
    token_hash TEXT PRIMARY KEY, mgr_id INTEGER NOT NULL REFERENCES mgr_bind(id),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
}

// Персональный код руководителя (10 симв., префикс M- отличает при вводе)
export function createManager(db, name, note = null) {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих 0/O/1/I/L
  const code = 'M-' + Array.from({ length: 10 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  db.prepare('INSERT INTO mgr_bind(name,code,note,created_at) VALUES (?,?,?,?)')
    .run(name, code, note, new Date().toISOString());
  return { name, code };
}

export function listManagers(db, showCodes = false) {
  return db.prepare('SELECT id, name, active, note, created_at, last_login' + (showCodes ? ', code' : '') + ' FROM mgr_bind ORDER BY id').all();
}

export function setManagerActive(db, id, active) {
  db.prepare('UPDATE mgr_bind SET active=? WHERE id=?').run(active ? 1 : 0, id);
}

// Мягкий лимит попыток входа по коду руководителя (anti-bruteforce)
const mgrFails = { n: 0, until: 0 };
export function mgrLoginLocked() { return Date.now() < mgrFails.until; }
export function mgrFail(db) { if (++mgrFails.n >= 10) { mgrFails.until = Date.now() + 5 * 60 * 1000; mgrFails.n = 0; } }

export function loginManagerByCode(db, code) {
  const cand = String(code || '').trim().toUpperCase();
  const m = db.prepare('SELECT id, name FROM mgr_bind WHERE upper(code)=? AND active=1').get(cand);
  if (!m) { mgrFail(db); return null; }
  mgrFails.n = 0;
  db.prepare('UPDATE mgr_bind SET last_login=? WHERE id=?').run(new Date().toISOString(), m.id);
  const token = randomBytes(24).toString('base64url');
  const now = new Date(), exp = new Date(Date.now() + TTL_MS);
  db.prepare('INSERT INTO mgr_session(token_hash,mgr_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(sha(token), m.id, now.toISOString(), exp.toISOString());
  return { token, expires_at: exp.toISOString(), role: 'manager', name: m.name };
}

const sha = s => createHash('sha256').update(String(s)).digest('hex');

export function loginByCode(db, code) {
  const row = db.prepare(`
    SELECT e.id FROM tg_bind t JOIN employee e ON e.id = t.employee_id
    WHERE upper(t.code) = upper(?)`).get(String(code || '').trim());
  if (!row) return null;
  const token = randomBytes(24).toString('base64url');
  const now = new Date(), exp = new Date(Date.now() + TTL_MS);
  db.prepare('INSERT INTO me_session(token_hash,employee_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(sha(token), row.id, now.toISOString(), exp.toISOString());
  return { token, expires_at: exp.toISOString(), employee_id: row.id, role: 'staff' };
}

// Аутентификация: Bearer-токен или разовый код заведующей
export function authMe(db, req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const cand = m ? m[1] : String(h).trim();
  if (!cand) return null;
  // Сессия руководителя?
  const hsh = sha(cand);
  const ms = db.prepare(`SELECT mgr_id, expires_at FROM mgr_session WHERE token_hash=?`).get(hsh);
  if (ms && ms.expires_at > new Date().toISOString()) {
    const mg = db.prepare('SELECT name, active FROM mgr_bind WHERE id=?').get(ms.mgr_id);
    if (mg && mg.active) return { employee_id: null, role: 'manager', name: mg.name };
  }
  // Прямой код руководителя M-... (вход без предварительного логина)
  if (/^M-[A-Z0-9]{4,12}$/.test(cand)) {
    const mg = db.prepare(`SELECT id, name, active FROM mgr_bind WHERE code=? AND active=1`).get(cand);
    if (mg) return { employee_id: null, role: 'manager', name: mg.name };
  }
  const s = db.prepare(`SELECT employee_id, expires_at FROM me_session WHERE token_hash=?`)
    .get(hsh);
  if (s && s.expires_at > new Date().toISOString()) {
    return { employee_id: s.employee_id, role: 'staff' };
  }
  const d = db.prepare(`SELECT employee_id, expires_at FROM me_delegation WHERE token_hash=?`)
    .get(hsh);
  if (d && d.expires_at > new Date().toISOString()) return { employee_id: d.employee_id, role: 'staff', delegated: true };
  return null;
}

export function logoutMe(db, req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const cand = m ? m[1] : String(h).trim();
  if (cand) {
    db.prepare('DELETE FROM me_session WHERE token_hash=?').run(sha(cand));
    db.prepare('DELETE FROM mgr_session WHERE token_hash=?').run(sha(cand));
  }
}

// Разовый код (24 ч) для просмотра данных аптеки; выдаёт только сотрудник этой аптеки
export function createDelegation(db, employeeId) {
  const e = db.prepare('SELECT pharmacy_id FROM employee WHERE id=?').get(employeeId);
  if (!e) return null;
  const token = 'Z-' + randomBytes(4).toString('hex').toUpperCase(); // 9 символов, отличим от личного
  const exp = new Date(Date.now() + 1000 * 60 * 60 * 24);
  db.prepare('INSERT INTO me_delegation(token_hash,employee_id,created_by,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(sha(token), e.pharmacy_id, employeeId, new Date().toISOString(), exp.toISOString());
  return { token: token, expires_at: exp.toISOString() };
}

// ---------- данные ----------
function activeMonth(db) {
  const d = db.prepare('SELECT MAX(d) md FROM fact_day').get()?.md;
  return (d && MM[d.slice(5, 7)]) || 'Сентябрь';
}
const pct1 = x => x == null ? null : +(x).toFixed(1);

// Короткая рекомендация дня (личная): отставание от аптеки → средний чек → объём
function myAdvice(db, e, plan, fact, phPct, avgCheck, month) {
  if (!plan) return 'Вакансия: персональный план появится с выходом на смену. Ориентир — план аптеки.';
  const fp = x => x.toFixed(1).replace('.', ',');
  const empPct = fact / plan * 100;
  const gap = empPct - phPct;
  const t = db.prepare('SELECT checks_per_day, avg_check FROM kpi_target WHERE month=?').get(month);
  if (gap < -3) return `Ты ${fp(empPct)}% при аптеке ${fp(phPct)}% — отстаёшь от коллег. Фокус дня: допродажа каждому покупателю (сопутствующее, акции полки).`;
  if (t?.avg_check && avgCheck && avgCheck < t.avg_check * 0.97) {
    const need = Math.round(t.avg_check - avgCheck);
    return `Средний чек ${Math.round(avgCheck)} ₽ при цели ${Math.round(t.avg_check)} ₽. Добавь ${need} ₽ к чеку — это +1 позиция (витамины, уход, детские).`;
  }
  if (empPct < 90) return `До плана ${fp(empPct)}%. Задача дня — количество: +2 контакта в час, приветствие каждого покупателя акцией дня.`;
  return `Ты в графике (${fp(empPct)}%). Поддержи темп: промо-товар или СТМ каждому второму покупателю.`;
}

// Личный экран сотрудника (или аптеки, если delegated); asId — другая роль того же человека (та же ФИО)
export function meData(db, employeeId, delegated = false, asId = null) {
  let targetId = employeeId;
  if (!delegated && asId && Number(asId) !== Number(employeeId)) {
    const base = db.prepare('SELECT fio FROM employee WHERE id=?').get(employeeId);
    const t = db.prepare('SELECT id, fio FROM employee WHERE id=?').get(Number(asId));
    if (base && t && t.fio === base.fio) targetId = Number(asId); // чужой id отклонён тихо
  }
  const emps = delegated
    ? db.prepare(`SELECT id, fio, role, share, pharmacy_id FROM employee WHERE pharmacy_id=? ORDER BY id`).all(
        db.prepare('SELECT pharmacy_id FROM employee WHERE id=?').get(employeeId)?.pharmacy_id)
    : db.prepare('SELECT id, fio, role, share, pharmacy_id FROM employee WHERE id=?').all(targetId);
  if (!emps.length) return null;
  const e0 = emps[0];
  const ph = db.prepare('SELECT id, name, addr, color FROM pharmacy WHERE id=?').get(e0.pharmacy_id);
  const month = activeMonth(db);
  const mkey = MKEY[month];
  const totalDays = DAYS_IN[month];
  const now = new Date();
  const isCur = MM[`0${now.getUTCMonth() + 1}`.slice(-2)] === month;
  const factDays = db.prepare('SELECT COUNT(DISTINCT d) n FROM fact_day WHERE substr(d,1,7)=?').get(mkey)?.n || 0;
  const elapsed = isCur ? Math.max(now.getUTCDate(), factDays, 1) : Math.max(factDays, 1);

  const planRow = db.prepare('SELECT revenue, margin FROM plan WHERE pharmacy_id=? AND month=?').get(ph.id, month);
  const phPlan = planRow?.revenue || 0;
  // Excel-override личных планов (employee_plan): revenue важнее, share подменяет долю.
  const epMap = {};
  try {
    for (const r of db.prepare('SELECT pharmacy_id, fio, revenue, share FROM employee_plan WHERE month=?').all(month)) {
      epMap[`${r.pharmacy_id}|${r.fio}`] = r;
    }
  } catch { /* таблица отсутствует — считаем по share */ }
  const phFactRow = db.prepare('SELECT SUM(revenue) rev, SUM(COALESCE(checks,0)) chk, SUM(COALESCE(stm,0)) stm, SUM(COALESCE(ustm,0)) ustm, SUM(COALESCE(marketing,0)) marketing FROM fact_day WHERE pharmacy_id=? AND substr(d,1,7)=?').get(ph.id, mkey);
  const phFact = phFactRow?.rev || 0;
  const phStm = phFactRow?.stm || 0;
  const phUstm = phFactRow?.ustm || 0;
  const phMarketing = phFactRow?.marketing || 0;
  const phPct = phPlan ? phFact / phPlan * 100 : 0;
  const phFcstPct = phPlan ? (phFact / elapsed * totalDays) / phPlan * 100 : 0;

  // Сеть
  const net = db.prepare(`
    SELECT (SELECT COALESCE(SUM(revenue),0) FROM plan WHERE month=? ) plan,
           (SELECT COALESCE(SUM(revenue),0) FROM fact_day WHERE substr(d,1,7)=?) fact`).get(month, mkey);
  const netPct = net.plan ? net.fact / net.plan * 100 : 0;
  // Все роли того же человека (для переключения заведующей между аптеками)
  const roles = delegated ? [] : db.prepare(`
    SELECT e.id, e.role, p.name ph FROM employee e JOIN pharmacy p ON p.id=e.pharmacy_id
    WHERE e.fio=(SELECT fio FROM employee WHERE id=?) ORDER BY p.id`).all(targetId);

  const me = [];
  for (const e of emps) {
    const ov = epMap[`${e.pharmacy_id}|${e.fio}`];
    const plan = Math.round((ov && ov.revenue != null) ? ov.revenue : phPlan * ((ov && ov.share != null) ? ov.share : e.share));
    const fRow = db.prepare('SELECT SUM(revenue) rev, SUM(COALESCE(checks,0)) chk, SUM(COALESCE(stm,0)) stm, SUM(COALESCE(ustm,0)) ustm, SUM(COALESCE(marketing,0)) marketing FROM fact_day WHERE employee_id=? AND substr(d,1,7)=?').get(e.id, mkey);
    const fact = fRow?.rev || 0;
    const checks = fRow?.chk || 0;
    const stm = fRow?.stm || 0;
    const ustm = fRow?.ustm || 0;
    const marketing = fRow?.marketing || 0;
    const avgCheck = checks ? fact / checks : null;
    // В виде аптеки (код старшей) персональные цифры не раскрываем — только имена/роли
    const pub = delegated
      ? { employee_id: e.id, fio: e.fio, role: e.role, share: e.share, plan: null, fact: null, pct: null, left: 0, per_day: null, avg_check: null, stm: null, ustm: null, marketing: null, tip: null }
      : {
          employee_id: e.id, fio: e.fio, role: e.role, share: e.share,
          plan, fact, pct: plan ? pct1(fact / plan * 100) : null,
          left: Math.max(plan - fact, 0),
          per_day: plan ? Math.round(Math.max(plan - fact, 0) / Math.max(totalDays - elapsed, 1)) : null,
          avg_check: avgCheck != null ? Math.round(avgCheck) : null,
          stm: Math.round(stm), ustm: Math.round(ustm),
          stm_share: fact ? pct1(stm / fact * 100) : null,
          marketing: Math.round(marketing),
          marketing_share: fact ? pct1(marketing / fact * 100) : null,
          tip: myAdvice(db, e, plan, fact, phPct, avgCheck, month),
        };
    me.push(pub);
  }

  // История по дням месяца (личная сумма по всем ролям сотрудника этой записи)
  const ids = emps.map(e => e.id);
  const qMarks = ids.map(() => '?').join(',');
  const days = db.prepare(`
    SELECT d, SUM(revenue) rev FROM fact_day
    WHERE substr(d,1,7)=? AND (employee_id IN (${qMarks}) OR (pharmacy_id=? AND employee_id IS NULL))
    GROUP BY d ORDER BY d`).all(mkey, ...ids, ph.id);
  const series = days.map(r => ({ d: r.d, rev: r.rev || 0 }));

  // Отказы и купоны аптеки (7 дней)
  const stockouts = db.prepare(`
    SELECT d, product, qty, note FROM stockout WHERE pharmacy_id=? AND d >= date('now','-7 days')
    ORDER BY d DESC LIMIT 50`).all(ph.id);
  const coupons = db.prepare(`
    SELECT d, qty, amount, campaign FROM coupon WHERE pharmacy_id=? AND d >= date('now','-7 days')
    ORDER BY d DESC LIMIT 20`).all(ph.id);

  return {
    view: delegated ? 'pharmacy' : 'me',
    month, days_in: totalDays, elapsed,
    pharmacy: { id: ph.id, name: ph.name, addr: ph.addr, color: ph.color },
    net: { pct: pct1(netPct) }, // сеть — только процент, без абсолютов
    roles,
    pharmacy_stats: { plan: phPlan, fact: phFact, pct: pct1(phPct), fcst_pct: pct1(phFcstPct), stm: Math.round(phStm), ustm: Math.round(phUstm), stm_share: phFact ? pct1(phStm / phFact * 100) : null, marketing: Math.round(phMarketing), marketing_share: phFact ? pct1(phMarketing / phFact * 100) : null },
    me, series, stockouts, coupons,
    tip: delegated ? 'Сводка аптеки: план, факт и прогноз. Персональные цифры сотрудников видны только им самим.' : me[0].tip,
  };
}
