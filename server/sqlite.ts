// The shared SQLite connection (one file, WAL). db.ts and the economy modules
// (economy.ts / market.ts / trades.ts) all import it from here so there is a
// single handle and no import cycle between them.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'instagib.sqlite');

export const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
// WAL + NORMAL: fsync only at checkpoint instead of on every commit. Still crash-
// safe (only an OS/power loss in the small WAL window can lose the last few
// transactions — acceptable for game stats), and it removes a synchronous fsync
// from the shared event loop on every write. Match-end stat writes and logins no
// longer risk stalling the 64Hz game tick on a slow (e.g. network-backed) disk.
sqlite.pragma('synchronous = NORMAL');
