// api.mjs модуля «СТМ»: продажи собственных торговых марок по месяцам/аптекам.
// Данные сначала загружаются файлами (кнопка «Загрузить файл»), позже — по API.
export default function ({ id, db, modDb, route, json, readBody, log }) {

  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_stm_sale(
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      month       TEXT    NOT NULL,              -- 'YYYY-MM'
      pharmacy_id INTEGER,                       -- NULL = сеть
      brand       TEXT    NOT NULL,              -- СТМ-бренд
      revenue     REAL    NOT NULL DEFAULT 0,
      margin      REAL,                          -- валовая маржа, ₽ (необязательно)
      qty         REAL,                          -- упаковки (необязательно)
      UNIQUE (month, pharmacy_id, brand)
    )
  `);

  const upS = modDb.prepare(`
    INSERT INTO mod_stm_sale(month, pharmacy_id, brand, revenue, margin, qty) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, pharmacy_id, brand) DO UPDATE SET
      revenue=excluded.revenue, margin=excluded.margin, qty=excluded.qty`);

  const okMonth = m => typeof m === 'string' && /^20\d\d-\d\d$/.test(m);
  const okPh = pid => pid == null || pid === '' || !!db.prepare(`SELECT id FROM pharmacy WHERE id=?`).get(+pid);

  // GET /api/m/stm/sales?month=&pharmacy_id=
  route('GET', '/sales', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const mo = u.searchParams.get('month');
    const ph = u.searchParams.get('pharmacy_id');
    let sql = `SELECT id, month, pharmacy_id, brand, revenue, margin, qty FROM mod_stm_sale WHERE 1=1`;
    const p = [];
    if (mo) { sql += ` AND month=?`; p.push(mo); }
    if (ph) { sql += ` AND pharmacy_id=?`; p.push(+ph); }
    sql += ` ORDER BY month DESC, revenue DESC`;
    json(res, 200, { rows: modDb.prepare(sql).all(...p) });
  });

  // POST /api/m/stm/sales {items:[{month,pharmacy_id?,brand,revenue,margin?,qty?}],replace?:bool,fileName?}
  route('POST', '/sales', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) { return json(res, 400, { error: 'ожидается JSON' }); }
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{month,brand,revenue,…}]}' });
    let saved = 0; const bad = [];
    if (b.replace) {
      const months = new Set(b.items.filter(it => okMonth(it.month)).map(it => it.month));
      for (const mo of months) modDb.prepare(`DELETE FROM mod_stm_sale WHERE month=?`).run(mo);
    }
    for (const it of b.items) {
      const br = String(it.brand || '').trim();
      if (!okMonth(it.month) || !okPh(it.pharmacy_id) || !br || !isFinite(+it.revenue)) {
        bad.push({ ...it, reason: !okMonth(it.month) ? 'месяц не YYYY-MM' : (!okPh(it.pharmacy_id) ? 'аптека не найдена' : (!br ? 'нет бренда' : 'revenue не число')) });
        continue;
      }
      const ph = it.pharmacy_id == null || it.pharmacy_id === '' ? null : +it.pharmacy_id;
      const mg = it.margin == null || it.margin === '' ? null : +it.margin;
      const qt = it.qty == null || it.qty === '' ? null : +it.qty;
      upS.run(it.month, ph, br, +it.revenue, mg != null && isFinite(mg) ? mg : null, qt != null && isFinite(qt) ? qt : null);
      saved++;
    }
    log(`СТМ: сохранено ${saved}, отклонено ${bad.length}${b.fileName ? ` (файл «${String(b.fileName).slice(0, 60)}»)` : ''}`);
    json(res, 200, { ok: true, saved, bad });
  });

  // DELETE /api/m/stm/sales?id=NN
  route('DELETE', '/sales', async (req, res, m, url) => {
    const u = new URL(url || req.url, 'http://x');
    const nid = +u.searchParams.get('id');
    if (!nid) return json(res, 400, { error: 'нужен id' });
    const d = modDb.prepare(`DELETE FROM mod_stm_sale WHERE id=?`).run(nid);
    json(res, 200, { ok: true, deleted: d.changes });
  });

  // GET /api/m/stm/pharmacies — справочник аптек (для маппинга имён из файлов)
  route('GET', '/pharmacies', async (req, res) => {
    json(res, 200, { rows: db.prepare(`SELECT id, name FROM pharmacy ORDER BY name`).all() });
  });

  log(`модуль "СТМ" готов, строк продаж: ${modDb.prepare('SELECT COUNT(*) AS c FROM mod_stm_sale').get().c}`);
}
