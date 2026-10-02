#!/usr/bin/env node
// Управление персональными кодами руководителей (доступ к общему дашборду).
// Запуск: node manage.mjs <command> [args]
//   add <имя> [заметка]   — выпустить новый код (показывается один раз)
//   list                  — список кодов (с самими кодами — только локально!)
//   revoke <id>           — отозвать (active=0), вход по коду перестанет работать
//   restore <id>          — вернуть из отозванных
// Коды пишутся в таблицу mgr_bind общей БД (data/plan.db).
import { openDb, DB_PATH } from './db.mjs';
import { ensureMeSchema, createManager, listManagers, setManagerActive } from './me.mjs';

const db = openDb();
ensureMeSchema(db);
const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.error('Использование: node manage.mjs <add|list|revoke|restore> [args]');
  process.exit(2);
}

switch (cmd) {
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
