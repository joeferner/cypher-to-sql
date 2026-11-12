export interface Limits {
  /** Upper bound for `[*]` and `[*n..]`. */
  maxPathDepth: number;
  /** Rows a single SQL step may return. */
  maxRowsPerStep: number;
  /** Records a query may return. */
  maxResultRows: number;
  /** Ids carried from one breadth-first search step to the next. */
  maxFrontierSize: number;
  /** SQL steps in one plan. */
  maxSteps: number;
  /** Total wall-clock time, checked between steps. */
  timeoutMs: number;
  /** Nodes plus relationships created by one query (write mode only). */
  maxCreatedEntities: number;
}

export const defaultLimits: Limits = {
  maxPathDepth: 10,
  maxRowsPerStep: 100_000,
  maxResultRows: 10_000,
  maxFrontierSize: 100_000,
  maxSteps: 32,
  timeoutMs: 30_000,
  maxCreatedEntities: 100_000,
};

/** Combines limits. A per-query override can only lower a graph's limit, never raise it. */
export function lowerLimits(base: Limits, override: Partial<Limits> | undefined): Limits {
  if (!override) {
    return base;
  }
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof Limits)[]) {
    const value = override[key];
    if (value !== undefined) {
      out[key] = Math.min(base[key], value);
    }
  }
  return out;
}
