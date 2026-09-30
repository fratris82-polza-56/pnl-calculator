// БД: схема + сид. Используется сервером (авто-сид при первом запуске) и seed.mjs (CLI).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.PZ_DB || join(ROOT, 'data', 'plan.db');

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export function ensureSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS pharmacy(
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, addr TEXT NOT NULL, color TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plan(
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
    month TEXT NOT NULL CHECK(month IN ('Сентябрь','Октябрь','Ноябрь','Декабрь')),
    revenue REAL NOT NULL, margin REAL NOT NULL,
    UNIQUE(pharmacy_id, month));
  CREATE TABLE IF NOT EXISTS employee(
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
    fio TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'провизор',
    share REAL NOT NULL DEFAULT 0 CHECK(share BETWEEN 0 AND 1),
    UNIQUE(pharmacy_id, fio));
  CREATE TABLE IF NOT EXISTS fact_day(
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacy(id),
    employee_id INTEGER REFERENCES employee(id),
    d TEXT NOT NULL,
    revenue REAL NOT NULL DEFAULT 0,
    margin REAL NOT NULL DEFAULT 0,
    checks INTEGER,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','api','demo')),
    UNIQUE(pharmacy_id, employee_id, d, source));
  CREATE INDEX IF NOT EXISTS i_fact_d ON fact_day(d);
  CREATE TABLE IF NOT EXISTS sale_raw(
    id INTEGER PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL, doc_id TEXT, d TEXT NOT NULL,
    employee_name TEXT, amount REAL NOT NULL, margin REAL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','mapped','error')));
  `);
}

export function seed(db) {
  ensureSchema(db);
  const ph = db.prepare('SELECT count(*) n FROM pharmacy').get().n;
  if (ph > 0) return false;
  db.prepare('INSERT INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)')
    .run(1, 'Азовская', 'Москва, ул. Азовская, 24 к2', '#4277c2');
  db.prepare('INSERT INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)')
    .run(2, 'Юбилейный', 'Химки, пр-кт Юбилейный, 60', '#6dc47b');
  db.prepare('INSERT INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)')
    .run(3, 'Проспект Мира', 'Химки, пр-кт Мира, 13/7', '#f9a968');
  db.prepare('INSERT INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)')
    .run(4, 'Маяковская', 'Химки, ул. Маяковского, 14', '#e5484d');
  db.prepare('INSERT INTO pharmacy(id,name,addr,color) VALUES (?,?,?,?)')
    .run(5, 'Пятницкое', 'Москва, ш. Пятницкое, 21 к1', '#9b7fe8');

  // Утверждённый план (xlsx «План_Звезда_для_аптек», сен–дек 2026)
  const PLAN = {
    'Азовская':      { to: [4900000, 6000000, 6200000, 7000000], vd: [1086770, 1330739, 1375097, 1552529] },
    'Пятницкое':     { to: [1400000, 1540000, 1600000, 1700000], vd: [310506, 341556, 354864, 377043] },
    'Проспект Мира': { to: [2300000, 2800000, 2950000, 3300000], vd: [510117, 621012, 654280, 731907] },
    'Маяковская':    { to: [800000, 2950000, 2950000, 3300000],  vd: [177432, 654280, 654280, 731907] },
    'Юбилейный':     { to: [2850000, 4100000, 4200000, 4300000], vd: [632101, 909339, 931518, 953696] },
  };
  const MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const insPlan = db.prepare('INSERT INTO plan(pharmacy_id,month,revenue,margin) VALUES (?,?,?,?)');
  for (const [name, p] of Object.entries(PLAN)) {
    const id = db.prepare('SELECT id FROM pharmacy WHERE name=?').get(name).id;
    MONTHS.forEach((m, i) => insPlan.run(id, m, p.to[i], p.vd[i]));
  }

  const EMP = {
    'Азовская':      ['Заведующая', 'Провизор 1', 'Провизор 2'],
    'Юбилейный':     ['Заведующая', 'Провизор 1', 'Провизор 2'],
    'Проспект Мира': ['Заведующая', 'Провизор 1'],
    'Маяковская':    ['Заведующая', 'Провизор 1'],
    'Пятницкое':     ['Заведующая', 'Провизор 1'],
  };
  const insEmp = db.prepare('INSERT INTO employee(pharmacy_id,fio,role,share) VALUES (?,?,?,?)');
  for (const [name, list] of Object.entries(EMP)) {
    const id = db.prepare('SELECT id FROM pharmacy WHERE name=?').get(name).id;
    const share = Math.round(100 / list.length) / 100;
    list.forEach(f => insEmp.run(id, f, f.startsWith('Зав') ? 'заведующая' : 'провизор', share));
  }
  return true;
}

// Демо-факт: сентябрь по вчера, план/день с разбросом, разбивка по сотрудникам по share.
export function seedDemo(db) {
  const rows = db.prepare(`
    SELECT p.pharmacy_id ph, p.revenue rev, p.margin vd, p.month,
           (SELECT group_concat(id) FROM employee e WHERE e.pharmacy_id = p.pharmacy_id) emps,
           (SELECT group_concat(share) FROM employee e WHERE e.pharmacy_id = p.pharmacy_id) shares
    FROM plan p WHERE p.month='Сентябрь'`).all();
  const ins = db.prepare(`INSERT OR REPLACE INTO fact_day(pharmacy_id,employee_id,d,revenue,margin,checks,source)
                          VALUES (?,?,?,?,?,?, 'demo')`);
  let seeded = 0;
  const now = new Date();
  const lastDay = new Date(2026, 8, 0) // не используется
  const cutoff = new Date(Date.UTC(2026, 8, Math.min(28, now.getUTCDate()))); // сентябрь, до сегодня
  for (const r of rows) {
    const empIds = r.emps ? r.emps.split(',').map(Number) : [null];
    const shares = r.shares ? r.shares.split(',').map(Number) : [1];
    for (let day = 1; day <= cutoff.getUTCDate(); day++) {
      const d = `2026-09-${String(day).padStart(2, '0')}`;
      const dow = new Date(Date.UTC(2026, 8, day)).getUTCDay();
      const weekend = (dow === 0 || dow === 6) ? 1.18 : 0.92;
      const k = weekend * (0.9 + Math.random() * 0.2);
      const revDay = (r.rev / 30) * k;
      const vdDay = (r.vd / 30) * k;
      empIds.forEach((eid, i) => {
        const s = (shares[i] || 0) / shares.reduce((a, b) => a + b, 0);
        ins.run(r.ph, eid, d, Math.round(revDay * s), Math.round(vdDay * s),
                Math.max(1, Math.round((revDay * s) / 900)));
        seeded++;
      });
    }
  }
  return seeded;
}
