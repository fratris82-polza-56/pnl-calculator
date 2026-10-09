// api.mjs модуля «Маркетинг»: рекламные акции и статьи расходов на маркетинг.
// Данные сначала загружаются файлами (кнопка «Загрузить файл»), позже — по API.
export default function ({ id, db, modDb, route, json, readBody, log }) {

  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_marketing_item(
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      month       TEXT    NOT NULL,              -- 'YYYY-MM'
      pharmacy_id INTEGER,                       -- NULL = сеть
      title       TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'акция',
      amount      REAL    NOT NULL DEFAULT 0,    -- бюджет/расход, ₽
      revenue     REAL,                          -- продажи в период акции, ₽ (необязательно)
      UNIQUE (month, pharmacy_id, title, kind)
    )
  `);

  const upI = modDb.prepare(`
    INSERT INTO mod_marketing_item(month, pharmacy_id, title, kind, amount, revenue) VALUES (?,?,?,?,?,?)
    ON CONFLICT(month, pharmacy_id, title, kind) DO UPDATE SET
      amount=excluded.amount, revenue=excluded.revenue`);

  const okMonth = m => typeof m === 'string' && /^20\d\d-\d\d$/.test(m);
  const okPh = pid => pid == null || pid === '' || !!db.prepare(`SELECT id FROM pharmacy WHERE id=?`).get(+pid);

  // GET /api/m/marketing/pharmacies — справочник аптек (нужен для маппинга имён из файлов)
  route('GET', '/pharmacies', async (req, res) => {
    json(res, 200, { rows: db.prepare(`SELECT id, name FROM pharmacy ORDER BY name`).all() });
  });

  // GET /api/m/marketing/items?month=YYYY-MM
  route('GET', '/items', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const mo = u.searchParams.get('month');
    let sql = `SELECT id, month, pharmacy_id, title, kind, amount, revenue FROM mod_marketing_item WHERE 1=1`;
    const p = [];
    if (mo) { sql += ` AND month=?`; p.push(mo); }
    sql += ` ORDER BY month DESC, kind, title`;
    json(res, 200, { rows: modDb.prepare(sql).all(...p) });
  });

  // POST /api/m/marketing/items {items:[{month,pharmacy_id?,title,kind?,amount,revenue?}],replace?:bool,fileName?}
  // replace:true — перед сохранением удалить строки этого месяца (полная замена месяца из файла)
  route('POST', '/items', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) { return json(res, 400, { error: 'ожидается JSON' }); }
    if (!Array.isArray(b.items)) return json(res, 400, { error: 'нужен {items:[{month,title,amount,…}]}' });
    let saved = 0; const bad = []; const months = new Set();
    if (b.replace) {
      b.items.forEach(it => { if (okMonth(it.month)) months.add(it.month); });
      for (const mo of months) modDb.prepare(`DELETE FROM mod_marketing_item WHERE month=?`).run(mo);
    }
    for (const it of b.items) {
      const t = String(it.title || '').trim();
      if (!okMonth(it.month) || !okPh(it.pharmacy_id) || !t || !isFinite(+it.amount)) {
        bad.push({ ...it, reason: !okMonth(it.month) ? 'месяц не YYYY-MM' : (!okPh(it.pharmacy_id) ? 'аптека не найдена' : (!t ? 'нет названия' : 'amount не число')) });
        continue;
      }
      const ph = it.pharmacy_id == null || it.pharmacy_id === '' ? null : +it.pharmacy_id;
      const rev = it.revenue == null || it.revenue === '' ? null : +it.revenue;
      upI.run(it.month, ph, t, String(it.kind || 'акция').trim() || 'акция', +it.amount, rev != null && isFinite(rev) ? rev : null);
      saved++;
    }
    log(`маркетинг: сохранено ${saved}, отклонено ${bad.length}${b.fileName ? ` (файл «${String(b.fileName).slice(0, 60)}»)` : ''}`);
    json(res, 200, { ok: true, saved, bad });
  });

  // DELETE /api/m/marketing/items?id=NN — удалить одну строку
  route('DELETE', '/items', async (req, res, m, url) => {
    const u = new URL(url || req.url, 'http://x');
    const nid = +u.searchParams.get('id');
    if (!nid) return json(res, 400, { error: 'нужен id' });
    const d = modDb.prepare(`DELETE FROM mod_marketing_item WHERE id=?`).run(nid);
    json(res, 200, { ok: true, deleted: d.changes });
  });

  log(`модуль "Маркетинг" готов, строк: ${modDb.prepare('SELECT COUNT(*) AS c FROM mod_marketing_item').get().c}`);
}
