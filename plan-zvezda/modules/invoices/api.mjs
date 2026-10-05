// api.mjs модуля «Счета»
export default function ({ id, db, modDb, route, json, readBody, log }) {

  // Таблица счетов
  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_invoices(
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor    TEXT   NOT NULL,
      number    TEXT   NOT NULL DEFAULT '',
      pharmacy_id INTEGER,
      d         TEXT   NOT NULL,
      amount    REAL   NOT NULL DEFAULT 0,
      status    TEXT   NOT NULL DEFAULT 'ожидает',
      note      TEXT   NOT NULL DEFAULT '',
      created_at TEXT  NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);

  // GET /api/m/invoices/  — список + фильтры + итого
  route('GET', '/', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const phId  = u.searchParams.get('pharmacy_id');
    const status = u.searchParams.get('status');
    const month  = u.searchParams.get('month'); // YYYY-MM
    const limit  = Math.min(Number(u.searchParams.get('limit') || 50), 200);

    let sql = `SELECT * FROM mod_invoices WHERE 1=1`;
    const params = [];
    if (phId)   { sql += ` AND pharmacy_id=?`;   params.push(+phId); }
    if (status) { sql += ` AND status=?`;         params.push(status); }
    if (month)  { sql += ` AND d GLOB ?`;          params.push(month + '*'); }
    sql += ` ORDER BY d DESC, id DESC LIMIT ?`;
    params.push(limit);

    const rows = modDb.prepare(sql).all(...params);
    const total = modDb.prepare(`SELECT SUM(amount) AS s FROM mod_invoices WHERE 1=1${
      phId   ? ' AND pharmacy_id=?' : ''
    }${status ? ' AND status=?'      : ''
    }${month  ? ' AND d GLOB ?'      : ''
    }`).get(...(phId   ? [+phId]    : []),
            ...(status ? [status]   : []),
            ...(month  ? [month+'*']: [])).s || 0;

    // Справочник аптек из ядра
    const pharmacies = db.prepare(`SELECT id, name FROM pharmacy ORDER BY name`).all();
    json(res, 200, { rows, total: Math.round(total*100)/100, pharmacies });
  });

  // POST /api/m/invoices/  — создать
  route('POST', '/', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) {
      return json(res, 400, { error: `ожидается JSON` }); }
    const { vendor, number='', pharmacy_id, d, amount, status='ожидает', note='' } = b;
    if (!vendor || !d || amount == null) return json(res, 400, { error: `vendor, d, amount — обязательные` });
    const info = modDb.prepare(
      `INSERT INTO mod_invoices(vendor,number,pharmacy_id,d,amount,status,note) VALUES (?,?,?,?,?,?,?)`
    ).run(vendor, String(number), pharmacy_id ? +pharmacy_id : null, d, +amount, String(status), String(note||''));
    json(res, 201, { id: info.lastInsertRowid });
  });

  // PATCH /api/m/invoices/<id>  — обновить статус / сумму / …
  route('PATCH', '/([^/]+)', async (req, res, m) => {
    const row = modDb.prepare(`SELECT * FROM mod_invoices WHERE id=?`).get(+m[1]);
    if (!row) return json(res, 404, { error: `не найден` });
    let b; try { b = await readBody(req); } catch (_) {
      return json(res, 400, { error: `ожидается JSON` }); }
    const allowed = ['vendor','number','pharmacy_id','d','amount','status','note'];
    const updates = [];
    const vals = [];
    for (const k of allowed) {
      if (k in b) {
        updates.push(`${k}=?`);
        vals.push(k === 'pharmacy_id' || k === 'amount' ? +b[k] : b[k]);
      }
    }
    if (!updates.length) return json(res, 400, { error: `нечего обновлять` });
    vals.push(row.id);
    modDb.prepare(`UPDATE mod_invoices SET ${updates.join(',')} WHERE id=?`).run(...vals);
    const updated = modDb.prepare(`SELECT * FROM mod_invoices WHERE id=?`).get(row.id);
    json(res, 200, updated);
  });

  // DELETE /api/m/invoices/<id>
  route('DELETE', '/([^/]+)', async (req, res, m) => {
    const row = modDb.prepare(`SELECT id FROM mod_invoices WHERE id=?`).get(+m[1]);
    if (!row) return json(res, 404, { error: `не найден` });
    modDb.prepare(`DELETE FROM mod_invoices WHERE id=?`).run(row.id);
    json(res, 200, { ok: true });
  });

  log(`модуль "Счета" инициализирован, записей: ${modDb.prepare(`SELECT COUNT(*) AS c FROM mod_invoices`).get().c}`);
}
