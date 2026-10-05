# Модули — План-Звезда

Добавление модуля занимает ~10 минут.

## Рецепт: новый модуль за 10 шагов

```
1. Создать папку   modules/<id>/
2. Написать        modules/<id>/module.json
3. Создать         modules/<id>/api.mjs
4. Создать         modules/<id>/public/index.html
5. (опц.) данные:  modules/<id>/public/extra.css и .js — подключатся автоматически
6. Проверить:      node --check modules/<id>/api.mjs
7. Перезапустить   dev-сервер (kill по PID, не pkill)
8. Открыть         http://localhost:8090/m/<id>/
9. Готово: модуль появится в навигации, /api/m/<id>/ работает
```

## Структура модуля

```
modules/
  <id>/
    module.json       ← манифест (обязателен)
    api.mjs           ← серверная логика (default-функция)
    public/
      index.html     ← UI модуля
      extra.css      ← (опц)
      extra.js       ← (опц)
```

## module.json

```json
{
  "id":    "bonuses",
  "title": "Бонусы",
  "icon":  "🎁",
  "version": "1.0.0",
  "roles": ["manager", "staff"],
  "nav": {
    "group": "Кадры",
    "order": 20
  },
  "entry": "public/index.html",
  "enabled": true
}
```

**id** — только `a-z 0-9 -`, 2–32 символа, совпадает с именем папки.
**roles** — `manager` и/или `staff`.
**enabled: false** — модуль загружен, но скрыт из навигации.

## Контекст api.mjs

```js
export default function ({ id, db, modDb, route, json, readBody, log }) {
  // id        — id модуля (совпадает с папкой)
  // db        — ядро (таблицы pharmacy, plan, employee, fact_day — READ ONLY)
  // modDb     — своя БД: data/modules/<id>.db (WAL, полный доступ)
  // route()   — регистрация роута /api/m/<id>...
  // json()    — ответ JSON клиенту
  // readBody(req) — тело запроса: уже распарсенный JSON-объект (или {} при пустом теле)
  // log()     — console.log с префиксом [mod:<id>]
}
```

### Роутер модуля

```js
route('GET', '/',    async (req, res) => { ... json(res,200,data) });
route('POST', '/',   async (req, res) => { ... });
route('PATCH', '/([^/]+)', async (req, res, m) => {
  const id = m[1]; // из URL
});
route('DELETE', '/([^/]+)', async (req, res, m) => { ... });
```

Роль модуля проверяется автоматически: manager/staff из манифеста.
Публичный доступ запрещён (middleware `applyAccessControl` накрывает все `/api/m/`).

### Своя БД модуля

```js
modDb.exec(`CREATE TABLE IF NOT EXISTS mod_bonuses(
  id INTEGER PRIMARY KEY,
  employee_id INTEGER,
  amount REAL,
  d TEXT
)`);
modDb.prepare(`INSERT INTO mod_bonuses...`).run(...);
const rows = modDb.prepare(`SELECT * FROM ...`).all();
```

## Включение/выключение

```bash
# dev
node manage.mjs modules                  # список модулей
node manage.mjs module enable  <id>       # включить
node manage.mjs module disable <id>       # выключить
```

Состояние хранится в `module_state` ядра, манифест остаётся git-чистым.

## Ограничения

- НЕ добавлять `publicRoute` — публичный API модуля запрещён.
- Все роуты модуля живут в `/api/m/<id>/...`, статика в `/m/<id>/`.
- Модуль-шаблон начинается с `_` ( `_template`, `_skeleton`) — не попадает в навигацию.
- Битый модуль (ошибка в api.mjs, bad manifest) — пропускается с `console.warn`, сервер НЕ падает.

## Пример: модуль «Счета»

См. `modules/invoices/` — полный пример с CRUD, фильтрами, суммами и UI-формой.
