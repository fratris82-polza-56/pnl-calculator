// Модульный конструктор «Звезда».
// Загружает модули из каталога modules/<id>/, регистрирует роуты /api/m/<id>/...
// и статику /m/<id>/..., предоставляет изолированную БД модуля.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

// ---------- идентификаторы модулей допустимы только в таком формате ----------
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// ---------- загрузчик ----------
export async function loadModules(core) {
  const { db, route, json, readBody } = core;
  const MOD_DIR = join(core.ROOT, 'modules');
  const DATA_MOD = join(core.ROOT, 'data', 'modules');

  // Таблица состояния модулей (ядро)
  db.exec(`CREATE TABLE IF NOT EXISTS module_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`);

  const modDirs = existsSync(MOD_DIR) ? readdirSync(MOD_DIR) : [];
  const loaded = [];

  for (const name of modDirs) {
    // Папки с подчёркиванием — игнорируются (шаблоны, скелеты)
    if (name.startsWith('_')) continue;

    const manifestPath = join(MOD_DIR, name, 'module.json');
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn(`[modules] пропущен ${name}: невалидный module.json — ${e.message}`);
      continue;
    }

    // Валидация: id совпадает с именем папки
    if (!ID_RE.test(name) || manifest.id !== name) {
      console.warn(`[modules] пропущен ${name}: id должен совпадать с именем папки и содержать только a-z0-9-`);
      continue;
    }

    if (!manifest.title || typeof manifest.title !== 'string' || !manifest.title.trim()) {
      console.warn(`[modules] пропущен ${name}: title обязателен и непустой`);
      continue;
    }

    const roles = Array.isArray(manifest.roles) ? manifest.roles : [];
    const validRoles = ['manager', 'staff'];
    for (const r of roles) {
      if (!validRoles.includes(r)) {
        console.warn(`[modules] пропущен ${name}: неизвестная роль "${r}"`);
        continue;
      }
    }
    if (!roles.length) {
      console.warn(`[modules] пропущен ${name}: roles должен содержать хотя бы одну роль`);
      continue;
    }

    // Проверка состояния из БД ядра
    const row = db.prepare('SELECT enabled FROM module_state WHERE id=?').get(name);
    const enabled = row ? !!row.enabled : (manifest.enabled !== false);
    if (!enabled) {
      console.log(`[modules] ${name}: отключён, пропускаем`);
      continue;
    }

    // Собственная БД модуля (data/modules/<id>.db)
    mkdirSync(DATA_MOD, { recursive: true });
    const modDbPath = join(DATA_MOD, `${name}.db`);
    const modDb = new DatabaseSync(modDbPath);
    modDb.exec('PRAGMA journal_mode = WAL');

    // Контекст, передаваемый каждому модулю
    const ctx = {
      id: name,
      db,        // ядро: чтение справочников, план, сотрудники, fact_day — read only
      modDb,     // собственная БД модуля: полный доступ
      route(method, pattern, handler) {
        // '/' → совпадение и с /api/m/<id>, и с /api/m/<id>/ (опциональный слеш)
        const fullPattern = typeof pattern === 'string'
          ? new RegExp(`^\\/api\\/m\\/${name}${pattern === '/' ? '\\/?' : pattern}$`)
          : new RegExp(`^\\/api\\/m\\/${name}${pattern.source.replace(/^\^/, '')}`);

        const wrapped = async (req, res, m, url) => {
          // Проверка роли из манифеста (модуль не открывает публичный доступ)
          const a = core.accessAny(req, res);
          if (!a) return;
          if (!roles.includes(a.role)) {
            json(res, 403, { error: `модуль "${manifest.title}" только для: ${roles.join(', ')}` });
            return;
          }
          await handler(req, res, m, url);
        };

        core.routes.push({ method, pattern: fullPattern, handler: wrapped });
      },
      json,
      readBody,
      log: (...args) => console.log(`[mod:${name}]`, ...args),
    };

    // Импорт api.mjs модуля
    const apiPath = join(MOD_DIR, name, 'api.mjs');
    if (existsSync(apiPath)) {
      try {
        const mod = await import(`file://${apiPath}?t=${Date.now()}`);
        if (mod.default && typeof mod.default === 'function') {
          mod.default(ctx);
          console.log(`[modules] загружен: ${name} (${manifest.title})`);
        } else {
          console.warn(`[modules] ${name}: api.mjs не экспортирует default-функцию`);
        }
      } catch (e) {
        console.warn(`[modules] пропущен ${name}: ошибка загрузки api.mjs — ${e.message}`);
        continue;
      }
    }

    loaded.push({ id: name, manifest });
  }

  return loaded;
}

// ---------- обслуживание статики модулей (вызывается из server.mjs) ----------
function modJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function serveModuleStatic(res, urlPath, req, accessFn, ROOT) {
  // urlPath = /m/<id>/...
  const parts = urlPath.split('/');
  // parts[0]='', parts[1]='m', parts[2]=<id>, parts[3...]=<file>
  if (parts.length < 4 || parts[1] !== 'm' || !parts[2]) {
    return null; // не модульный путь
  }
  const id = parts[2];
  if (!ID_RE.test(id)) return null;

  // Проверка доступа
  const a = accessFn(req);
  if (!a) {
    // Аноним: browser → /me.html, API → 401
    if ((req.headers['accept'] || '').includes('text/html')) {
      res.writeHead(302, { Location: '/me.html' }); res.end(); return 'served';
    }
    modJson(res, 401, { error: 'требуется вход' }); return 'served';
  }
  if (a.role !== 'manager' && a.role !== 'staff') {
    if ((req.headers['accept'] || '').includes('text/html')) {
      res.writeHead(302, { Location: '/me.html' }); res.end(); return 'served';
    }
    modJson(res, 403, { error: 'доступ запрещён' }); return 'served';
  }

  // Проверяем роль модуля из манифеста (manager или staff)
  let mfRoles = null;
  try {
    const mfPath = join(ROOT, 'modules', id, 'module.json');
    if (existsSync(mfPath)) {
      const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
      mfRoles = Array.isArray(mf.roles) ? mf.roles : [];
    }
  } catch (_) {}
  if (mfRoles && !mfRoles.includes(a.role)) {
    if ((req.headers['accept'] || '').includes('text/html')) {
      res.writeHead(302, { Location: '/me.html' }); res.end(); return 'served';
    }
    modJson(res, 403, { error: `модуль "${id}" только для: ${mfRoles.join(', ')}` }); return 'served';
  }

  // Файл: modules/<id>/public/<file>
  // parts[3] может быть пустым (→ index.html) или файлом
  const fileName = parts[3] || 'index.html';
  const safeRel = normalize(decodeURIComponent(fileName)).replace(/^(\.[/\\])+/, '');

  const MOD_DIR = join(ROOT, 'modules');
  const modPublic = join(MOD_DIR, id, 'public', safeRel);
  if (!modPublic.startsWith(join(MOD_DIR, id, 'public'))) {
    res.writeHead(403); res.end('forbidden'); return 'served';
  }
  if (!existsSync(modPublic) || !statSync(modPublic).isFile()) {
    res.writeHead(404); res.end('not found'); return 'served';
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  };
  const ext = (() => { let x = safeRel.lastIndexOf('.'); return x >= 0 ? safeRel.slice(x) : ''; })();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(modPublic));
  return 'served';
}
