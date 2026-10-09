// api.mjs модуля «Окупаемость»: плановые значения по ВД и расходы по аптекам.
// Плановая ВД хранится в % (margin_pct); расходы — ежемесячные статьи в рублях.
export default function ({ id, db, modDb, route, json, readBody, log }) {

  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_payback_target(
      pharmacy_id INTEGER NOT NULL,
      month       TEXT    NOT NULL,
      margin_pct  REAL    NOT NULL DEFAULT 0,
      PRIMARY KEY (pharmacy_id, month)
    )
  `);
  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_payback_expense(
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pharmacy_id INTEGER NOT NULL,
      month       TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      amount      REAL    NOT NULL DEFAULT 0,
      UNIQUE (pharmacy_id, month, title)
    )
  `);

  const upT = modDb.prepare(`
    INSERT INTO mod_payback_target(pharmacy_id, month, margin_pct) VALUES (?,?,?)
    ON CONFLICT(pharmacy_id, month) DO UPDATE SET margin_pct=excluded.margin_pct`);
  const upE = modDb.prepare(`
    INSERT INTO mod_payback_expense(pharmacy_id, month, title, amount) VALUES (?,?,?,?)
    ON CONFLICT(pharmacy_id, month, title) DO UPDATE SET amount=excluded.amount`);
  const delE = modDb.prepare(`DELETE FROM mod_payback_expense WHERE pharmacy_id=? AND month=? AND title=?`);

  const okMonth = m => typeof m === 'string' && /^20\d\d-\d\d$/.test(m);
  const okPh = pid => !!db.prepare(`SELECT id FROM pharmacy WHERE id=?`).get(+pid);

  // GET /api/m/payback/targets?pharmacy_id=&month= (YYYY-MM) — плановая ВД,%
  route('GET', '/targets', async (req, res, m, url) => {
    const u = new URL(req.url, 'http://x');
    const ph = u.searchParams.get('pharmacy_id');
    const mo = u.searchParams.get('month');
    let sql = `SELECT pharmacy_id, month, margin_pct FROM mod_payback_target WHERE 1=1`;
    const p = [];
    if (ph) { sql += ` AND pharmacy_id=?`; p.push(+ph); }
    if (mo) { sql += ` AND month=?`; p.push(mo); }
    sql += ` ORDER BY pharmacy_id, month`;
    json(res, 200, { rows: modDb.prepare(sql).all(...p) });
  });

  // POST /api/m/payback/targets {items:[{pharmacy_id, month, margin_pct}]}
  route('POST', '/targets', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) { return json(res, 400, { error: 'ожидается JSON' }); }
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{pharmacy_id,month,margin_pct}]}' });
    let saved = 0; const bad = [];
    for (const it of b.items) {
      if (!okPh(it.pharmacy_id) || !okMonth(it.month) || it.margin_pct == null || !isFinite(+it.margin_pct)) {
        bad.push({ ...it, reason: 'аптека/месяц (YYYY-MM)/margin_pct не опознаны' }); continue;
      }
      upT.run(+it.pharmacy_id, it.month, +it.margin_pct);
      saved++;
    }
    json(res, 200, { ok: true, saved, bad });
  });

  // GET /api/m/payback/expenses?pharmacy_id=&month= — статьи расходов
  route('GET', '/expenses', async (req, res, m, url) => {
    const u = new URL(req.url, 'http://x');
    const ph = u.searchParams.get('pharmacy_id');
    const mo = u.searchParams.get('month');
    let sql = `SELECT id, pharmacy_id, month, title, amount FROM mod_payback_expense WHERE 1=1`;
    const p = [];
    if (ph) { sql += ` AND pharmacy_id=?`; p.push(+ph); }
    if (mo) { sql += ` AND month=?`; p.push(mo); }
    sql += ` ORDER BY pharmacy_id, month, title`;
    json(res, 200, { rows: modDb.prepare(sql).all(...p) });
  });

  // POST /api/m/payback/expenses {items:[{pharmacy_id,month,title,amount}]} — upsert;
  // amount:null — удалить статью
  route('POST', '/expenses', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) { return json(res, 400, { error: 'ожидается JSON' }); }
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{pharmacy_id,month,title,amount}]}' });
    let saved = 0, deleted = 0; const bad = [];
    for (const it of b.items) {
      if (!okPh(it.pharmacy_id) || !okMonth(it.month) || !String(it.title || '').trim()) {
        bad.push({ ...it, reason: 'аптека/месяц/статья не опознаны' }); continue;
      }
      const t = String(it.title).trim();
      if (it.amount == null) { deleted += delE.run(+it.pharmacy_id, it.month, t).changes; continue; }
      if (!isFinite(+it.amount)) { bad.push({ ...it, reason: 'amount не число' }); continue; }
      upE.run(+it.pharmacy_id, it.month, t, +it.amount);
      saved++;
    }
    json(res, 200, { ok: true, saved, deleted, bad });
  });

  // GET /api/m/payback/plan?pharmacy_id=&month= — план ТО/ВД из ядра (таблица plan)
  route('GET', '/plan', async (req, res, m, url) => {
    const u = new URL(req.url, 'http://x');
    const ph = u.searchParams.get('pharmacy_id');
    const mo = u.searchParams.get('month'); // YYYY-MM
    let sql = `SELECT p.pharmacy_id, ph.name AS ph_name, p.month, p.revenue, p.margin
               FROM plan p JOIN pharmacy ph ON ph.id=p.pharmacy_id WHERE 1=1`;
    const p = [];
    if (ph) { sql += ` AND p.pharmacy_id=?`; p.push(+ph); }
    if (mo) { const nm = monthName(mo); if (nm) { sql += ` AND p.month=?`; p.push(nm); } }
    sql += ` ORDER BY p.pharmacy_id, p.id`;
    json(res, 200, { rows: db.prepare(sql).all(...p) });
  });

  function monthName(ym) {
    const names = { '09': 'Сентябрь', '10': 'Октябрь', '11': 'Ноябрь', '12': 'Декабрь' };
    const mm = String(ym || '').slice(5, 7);
    return names[mm] || null;
  }

  // POST /api/m/payback/plan-file {items:[{pharmacy_id,month:'YYYY-MM',revenue,margin}],fileName?}
  // Загрузка файла с планами: обновляет ядровую таблицу plan (месяц — именем). Неизвестные
  // аптеки/месяцы не молча теряются, а возвращаются в bad.
  route('POST', '/plan-file', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) { return json(res, 400, { error: 'ожидается JSON' }); }
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{pharmacy_id,month,revenue,margin}]}' });
    const ins = db.prepare(`INSERT INTO plan(pharmacy_id,month,revenue,margin) VALUES (?,?,?,?)
      ON CONFLICT(pharmacy_id, month) DO UPDATE SET revenue=excluded.revenue, margin=excluded.margin`);
    let saved = 0; const bad = [];
    for (const it of b.items) {
      const nm = okPh(it.pharmacy_id) ? monthName(it.month) : null;
      const rev = +it.revenue, mg = +it.margin;
      if (!nm || !isFinite(rev) || !isFinite(mg) || rev < 0 || mg < 0) {
        bad.push({ ...it, reason: !okPh(it.pharmacy_id) ? 'аптека не найдена' : (!nm ? 'месяц вне периода сен–дек' : 'revenue/margin не числа') });
        continue;
      }
      ins.run(+it.pharmacy_id, nm, rev, mg);
      saved++;
    }
    log(`payback: план из файла «${String(b.fileName || '').slice(0, 60)}» — обновлено ${saved}, отклонено ${bad.length}`);
    json(res, 200, { ok: true, saved, bad });
  });

  log(`модуль "Окупаемость" готов, целей ВД: ${modDb.prepare('SELECT COUNT(*) AS c FROM mod_payback_target').get().c}, статей расходов: ${modDb.prepare('SELECT COUNT(*) AS c FROM mod_payback_expense').get().c}`);
}
