// api.mjs — шаблон модуля «Звезда»
export default function ({ id, db, modDb, route, json, readBody, log }) {

  // Собственная таблица: изменить под задачу модуля
  modDb.exec(`
    CREATE TABLE IF NOT EXISTS mod_data(
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',
      d     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now'))
    )
  `);

  // GET /api/m/<id>/ — список
  route('GET', '/', async (req, res) => {
    const rows = modDb.prepare(`SELECT * FROM mod_data ORDER BY d DESC, id DESC LIMIT 100`).all();
    json(res, 200, { rows });
  });

  // POST /api/m/<id>/ — создать
  route('POST', '/', async (req, res) => {
    let b; try { b = await readBody(req); } catch (_) {
      return json(res, 400, { error: 'ожидается JSON' }); }
    if (!b.title) return json(res, 400, { error: 'title — обязательное поле' });
    const info = modDb.prepare(`INSERT INTO mod_data(title,value) VALUES (?,?)`).run(b.title, String(b.value || ''));
    json(res, 201, { id: info.lastInsertRowid });
  });

  log(`модуль "${id}" готов`);
}
