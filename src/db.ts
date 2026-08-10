import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "jurnal.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS roles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  label            TEXT NOT NULL,
  manage_users     INTEGER NOT NULL DEFAULT 0,
  view_all_reports INTEGER NOT NULL DEFAULT 0,
  delete_reports   INTEGER NOT NULL DEFAULT 0,
  export_import    INTEGER NOT NULL DEFAULT 0,
  built_in         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  xidmet         TEXT NOT NULL,
  obyekt         TEXT NOT NULL DEFAULT '',
  sistem         TEXT NOT NULL,
  nasazliq       TEXT NOT NULL,
  nasazliq_vaxti TEXT NOT NULL,
  sebeb          TEXT NOT NULL DEFAULT '',
  tedbir         TEXT NOT NULL DEFAULT '',
  berpa_vaxti    TEXT NOT NULL DEFAULT '',
  muraciet       TEXT NOT NULL DEFAULT '',
  cavabdeh       TEXT NOT NULL DEFAULT '',
  prioritet      TEXT NOT NULL DEFAULT 'orta',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// Миграция: колонка важности записи (aşağı / orta / yüksək)
const reportCols = db.prepare("PRAGMA table_info(reports)").all() as { name: string }[];
if (!reportCols.some((c) => c.name === "prioritet")) {
  db.exec("ALTER TABLE reports ADD COLUMN prioritet TEXT NOT NULL DEFAULT 'orta'");
  console.log("Miqrasiya: 'prioritet' sütunu əlavə olundu");
}

// Миграция со старой схемы: роль 'director' переименована в 'admin'
const usersSchema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
  .get() as { sql: string };
if (usersSchema.sql.includes("'director'")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','employee')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO users_new (id, username, password_hash, full_name, role, active, created_at)
      SELECT id, username, password_hash, full_name,
             CASE role WHEN 'director' THEN 'admin' ELSE role END,
             active, created_at
      FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
  db.pragma("foreign_keys = ON");
  console.log("Miqrasiya: 'director' rolu 'admin' ilə əvəz olundu");
}

// Миграция: снимаем жёсткое ограничение CHECK на роль, чтобы разрешить
// произвольные роли, создаваемые администратором.
const usersSchema2 = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
  .get() as { sql: string };
if (usersSchema2.sql.includes("CHECK")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      role          TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO users_new (id, username, password_hash, full_name, role, active, created_at)
      SELECT id, username, password_hash, full_name, role, active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
  db.pragma("foreign_keys = ON");
  console.log("Miqrasiya: rol üçün CHECK məhdudiyyəti götürüldü");
}

// Встроенные роли: admin (полный доступ) и employee (только свои записи)
const roleCount = db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number };
if (roleCount.n === 0) {
  const seed = db.prepare(
    `INSERT INTO roles (name, label, manage_users, view_all_reports, delete_reports, export_import, built_in)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  seed.run("admin", "Admin", 1, 1, 1, 1);
  seed.run("employee", "İşçi", 0, 0, 0, 0);
  console.log("Встроенные роли созданы: admin, employee");
}

// Старый стандартный аккаунт: логин 'director' переименовываем в 'admin'
const oldDirector = db
  .prepare("SELECT id FROM users WHERE username = 'director'")
  .get() as { id: number } | undefined;
const adminTaken = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
if (oldDirector && !adminTaken) {
  db.prepare("UPDATE users SET username = 'admin', full_name = 'Admin' WHERE id = ?").run(
    oldDirector.id
  );
  console.log("Miqrasiya: 'director' hesabı 'admin' adlandırıldı (parol dəyişməyib)");
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: string;
  active: number;
}

export interface Role {
  id: number;
  name: string;
  label: string;
  manage_users: number;
  view_all_reports: number;
  delete_reports: number;
  export_import: number;
  built_in: number;
}

export function getRole(name: string): Role | undefined {
  return db.prepare("SELECT * FROM roles WHERE name = ?").get(name) as Role | undefined;
}

export interface Report {
  id: number;
  user_id: number;
  xidmet: string;
  obyekt: string;
  sistem: string;
  nasazliq: string;
  nasazliq_vaxti: string;
  sebeb: string;
  tedbir: string;
  berpa_vaxti: string;
  muraciet: string;
  cavabdeh: string;
  prioritet: string;
  created_at: string;
  updated_at: string;
}

// Первый запуск: создаём аккаунт администратора
const hasUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
if (hasUsers.n === 0) {
  db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'admin')"
  ).run("admin", bcrypt.hashSync("admin123", 10), "Admin");
  console.log("Создан аккаунт администратора: login=admin, password=admin123 (смените пароль!)");
}
