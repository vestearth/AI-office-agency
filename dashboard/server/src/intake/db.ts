import fs from 'fs';
import path from 'path';
import { intakeConfig } from './config';
import { runMigrations } from './migrations';

export type DB = any;

let databaseModule: any = null;
let loadError: Error | null = null;

function loadDatabaseModule(): any {
  if (databaseModule !== null || loadError !== null) {
    return databaseModule;
  }

  try {
    databaseModule = require('better-sqlite3');
  } catch (error) {
    loadError = error as Error;
    databaseModule = null;
  }

  return databaseModule;
}

export function openDb(dbPath: string): DB | null {
  const Database = loadDatabaseModule();
  if (!Database) {
    console.warn('better-sqlite3 is unavailable; intake DB routes will be disabled.');
    return null;
  }

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // Decision #13: WAL-consistent backups later
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (error) {
    console.warn('Failed to initialize intake DB; continuing in filesystem-only mode.', error);
    return null;
  }
}

let singleton: DB | null = null;
export function getDb(): DB | null {
  if (!singleton) {
    singleton = openDb(intakeConfig.dbPath);
    if (singleton) {
      runMigrations(singleton);
    }
  }
  return singleton;
}

export function getDbLoadError(): Error | null {
  return loadError;
}
