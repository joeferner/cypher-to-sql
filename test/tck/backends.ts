import { sqlite } from '../../src/index.js';
import { createSqliteDatabase, sqliteExecutor } from '../support/sqlite.js';
import type { TckBackend } from './runner.js';

export const sqliteBackend: TckBackend = {
  name: 'sqlite',
  open() {
    const db = createSqliteDatabase();
    return Promise.resolve({
      dialect: sqlite(),
      executor: sqliteExecutor(db),
      close: () => {
        db.close();
        return Promise.resolve();
      },
    });
  },
};

/** Backends the TCK runs on, keyed by the dialect name used in the allow-list. */
export const backends: TckBackend[] = [sqliteBackend];
