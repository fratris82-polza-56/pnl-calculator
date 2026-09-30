// Seed: план «Звезда» сен–дек 2026 из утверждённого xlsx (рукописный ввод, без рантайм-парсинга).
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(new URL('./data/plan.db', import.meta.url).pathname);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS pharmacy(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, addr TEXT NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan(
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
  month TEXT NOT NULL CHECK(month IN ('Сентябрь','Октябрь','Ноябрь','Декабрь')),
  revenue REAL NOT NULL,   -- план ТО, ₽/мес
  margin  REAL NOT NULL,   -- план ВД, ₽/мес
  UNIQUE(pharmacy_id, month));
CREATE TABLE IF NOT EXISTS employee(
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
  fio TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'провизор',
  share REAL NOT NULL DEFAULT 0 CHECK(share BETWEEN 0 AND 1), -- доля личного плана
  UNIQUE(pharmacy_id, fio));
CREATE TABLE IF NOT EXISTS fact_day(
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
  employee_id INTEGER REFERENCES employee(id),  -- NULL = на аптеку (не размечен)
  d TEXT NOT NULL,                              -- ISO дата YYYY-MM-DD
  revenue REAL NOT NULL DEFAULT 0,
  margin  REAL NOT NULL DEFAULT 0,
  UNIQUE(pharmacy_id, employee_id, d));
CREATE INDEX IF NOT EXISTS i_fact_d ON fact_day(d);
CREATE TABLE IF NOT EXISTS sale_raw(
  id INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL, doc_id TEXT, d TEXT NOT NULL,
  employee_name TEXT, amount REAL NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','mapped','error')));
`);

const PH = [
  [1, 'Азовская',      'Москва, ул. Азовская, 24 к2',        '#4277c2'],
  [2, 'Юбилейный',     'Химки, пр-кт Юбилейный, 60',         '#6dc47b'],
  [3, 'Проспект Мира', 'Химки, пр-кт Мира, 13/7',            '#f9a968'],
  [4, 'Маяковская',    'Химки, ул. Маяковского, 14',         '#e5484d'],
  [5, 'Пятницкое',     'Москва, ш. Пятницкое, 21 к1',        '#9b7fe8'],
];
const insPh = db.prepare('INSERT OR IGNORE INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)');
for (const p of PH) insPh.run(...p);

// План из xlsx (месячные значения; ВД — округлённые из выгрузки)
const PLAN = {
  'Азовская':      { to: [4900000, 6000000, 6200000, 7000000], vd: [1086770, 1330739, 1375097, 1552529] },
  'Пятницкое':     { to: [1400000, 1540000, 1600000, 1700000], vd: [310506, 341556, 354864, 377043] },
  'Проспект Мира': { to: [2300000, 2800000, 2950000, 3300000], vd: [510117, 621012, 654280, 731907] },
  'Маяковская':    { to: [800000, 2950000, 2950000, 3300000],  vd: [177432, 654280, 654280, 731907] },
  'Юбилейный':     { to: [2850000, 4100000, 4200000, 4300000], vd: [632101, 909339, 931518, 953696] },
};
const MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const insPlan = db.prepare('INSERT OR IGNORE INTO plan(pharmacy_id,month,revenue,margin) VALUES (?,?,?,?)');
for (const [name, p] of Object.entries(PLAN)) {
  const id = db.prepare('SELECT id FROM pharmacy WHERE name=?').get(name).id;
  MONTHS.forEach((m, i) => insPlan.run(id, m, p.to[i], p.vd[i]));
}

// Заглушка сотрудников (Артём поправит ФИО в UI)
const EMP = {
  'Азовская':      ['Заведующая', 'Провизор 1', 'Провизор 2'],
  'Юбилейный':     ['Заведующая', 'Провизор 1', 'Провизор 2'],
  'Проспект Мира': ['Заведующая', 'Провизор 1'],
  'Маяковская':    ['Заведующая', 'Провизор 1'],
  'Пятницкое':     ['Заведующая', 'Провизор 1'],
};
const insEmp = db.prepare('INSERT OR IGNORE INTO employee(pharmacy_id,fio,role,share) VALUES (?,?,?,?)');
for (const [name, list] of Object.entries(EMP)) {
  const id = db.prepare('SELECT id FROM pharmacy WHERE name=?').get(name).id;
  list.forEach(f => insEmp.run(id, f, f.startsWith('Зав') ? 'заведующая' : 'провизор', 0));
}
console.log('seed ok:', {
  pharm: db.prepare('SELECT count(*) n FROM pharmacy').get().n,
  plan: db.prepare('SELECT count(*) n FROM plan').get().n,
  emp: db.prepare('SELECT count(*) n FROM employee').get().n,
});
