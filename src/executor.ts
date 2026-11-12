/** A row returned by the caller's driver, keyed by column name. */
export type Row = Record<string, unknown>;

/**
 * Runs SQL for the library. The caller implements it over their own driver.
 * All statements of one query run inside one `transaction` call.
 */
export interface SqlExecutor {
  transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}

export interface SqlTx {
  query(sql: string, values: unknown[]): Promise<Row[]>;
}
