import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { intakeConfig } from './config';
import { runMigrations } from './migrations';

export type DB = Database.Database;

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // Decision #13: WAL-consistent backups later
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

let singleton: DB | null = null;
export function getDb(): DB {
  if (!singleton) {
    singleton = openDb(intakeConfig.dbPath);
    runMigrations(singleton);
  }
  return singleton;
}
