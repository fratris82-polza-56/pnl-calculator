#!/usr/bin/env node
// Управление персональными кодами руководителей (доступ к общему дашборду).
// Запуск: node manage.mjs <command> [args]
//   add <имя> [заметка]   — выпустить новый код (показывается один раз)
//   list                  — список кодов (с самими кодами — только локально!)
//   revoke <id>           — отозвать (active=0), вход по коду перестанет работать
//   restore <id>          — вернуть из отозванных
// Коды пишутся в таблицу mgr_bind общей БД (data/plan.db).
import { openDb, DB_PATH } from './db.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureMeSchema, createManager, listManagers, setManagerActive } from './me.mjs';

const db = openDb();
ensureMeSchema(db);
const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.error('Использование: node manage.mjs <add|list|revoke|restore> [args]');
  process.exit(2);
}

switch (cmd) {
  case 'modules': {
    // Список модулей: id, title, enabled
    db.exec(`CREATE TABLE IF NOT EXISTS module_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`);
    const MOD_DIR = join(process.cwd(), 'modules');
    let names = [];
    try { if (existsSync(MOD_DIR)) names = readdirSync(MOD_DIR).filter(n => !n.startsWith('_')); } catch (_) {}
    const state = {};
    for (const r of db.prepare(`SELECT id, enabled FROM module_state`).all()) state[r.id] = r.enabled;
    console.log('модуль                  включён   манифест');
    console.log('-'.repeat(55));
    for (const name of names) {
      const manifestPath = join(MOD_DIR, name, 'module.json');
      let title = name, manifestOk = false;
      try { const mf = JSON.parse(readFileSync(manifestPath, 'utf8')); title = mf.title || name; manifestOk = true; } catch (_) {}
      const enabled = name in state ? (state[name] ? '✓' : '✗') : (manifestOk ? '✓ (default)' : '?');
      console.log(`${(title||name).padEnd(24)} ${enabled.padEnd(10)} ${name}`);
    }
    break;
  }
  case 'module': {
    const action = args[0];
    const modId = (args[1] || '').trim();
    if (!modId || (action !== 'enable' && action !== 'disable')) {
      console.error('Использование: node manage.mjs module enable|disable <id>');
      process.exit(2);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS module_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`);
    const enabled = action === 'enable' ? 1 : 0;
    const row = db.prepare(`SELECT id FROM module_state WHERE id=?`).get(modId);
    if (row) {
      db.prepare(`UPDATE module_state SET enabled=? WHERE id=?`).run(enabled, modId);
    } else {
      db.prepare(`INSERT INTO module_state(id, enabled) VALUES (?,?)`).run(modId, enabled);
    }
    console.log(`${action === 'enable' ? '✓' : '✗'} модуль "${modId}" ${action === 'enable' ? 'включён' : 'выключен'}`);
    console.log('  (чтобы изменения вступили в силу, перезапусти сервер)');
    break;
  }
  case 'add': {
    const name = (args[0] || '').trim();
    if (!name) { console.error('нужно имя: node manage.mjs add "Иван Петров"'); process.exit(2); }
    const r = createManager(db, name, args[1] || null);
    console.log(`✓ ${r.name}`);
    console.log(`  код: ${r.code}`);
    console.log('  Сохрани код — он показывается один раз. Вход: /me.html');
    break;
  }
  case 'list': {
    const rows = listManagers(db, true);
    if (!rows.length) { console.log('кодов пока нет'); break; }
    console.log('id  active  код             имя                  последний вход');
    for (const r of rows) {
      const st = r.active ? '  ✓  ' : '  ✗  ';
      console.log(`${String(r.id).padEnd(4)}${st}${(r.code || '').padEnd(16)}${(r.name || '').padEnd(22)}${r.last_login || '—'}`);
    }
    break;
  }
  case 'revoke': {
    const id = Number(args[0]);
    if (!id) usage();
    setManagerActive(db, id, false);
    console.log(`✓ код #${id} отозван`);
    break;
  }
  case 'restore': {
    const id = Number(args[0]);
    if (!id) usage();
    setManagerActive(db, id, true);
    console.log(`✓ код #${id} восстановлен`);
    break;
  }
  default:
    usage();
}
