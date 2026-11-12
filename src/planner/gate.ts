import type * as ast from '../ast.js';
import { ReadOnlyViolationError, UnsupportedFeatureError } from '../errors.js';

/** True when the query contains any clause that modifies the graph. */
export function hasWriteClause(query: ast.Query): boolean {
  return query.clauses.some(
    (c) => c.type === 'Create' || (c.type === 'UnsupportedClause' && c.write),
  );
}

/** Rejects every write clause. Runs before any feature check, so the error is always the same. */
export function assertQueryReadOnly(query: ast.Query): void {
  for (const clause of query.clauses) {
    if (clause.type === 'Create' || (clause.type === 'UnsupportedClause' && clause.write)) {
      const name = clause.type === 'Create' ? 'CREATE' : clause.name;
      throw new ReadOnlyViolationError(`${name} is not allowed on a read-only graph`, {
        position: clause.position,
        hint: 'Remove the write clause, or run the query on a graph created with readOnly: false.',
      });
    }
  }
}

/** Rejects clauses and expressions this version does not translate. */
export function assertSupported(query: ast.Query): void {
  for (const clause of query.clauses) {
    if (clause.type === 'UnsupportedClause') {
      throw new UnsupportedFeatureError(`${clause.name} is not supported yet`, {
        position: clause.position,
      });
    }
    for (const expr of clauseExpressions(clause)) {
      const unsupported = findUnsupported(expr);
      if (unsupported) {
        throw new UnsupportedFeatureError(`${unsupported.description} are not supported yet`, {
          position: unsupported.position,
        });
      }
    }
  }
}

function clauseExpressions(clause: ast.Clause): ast.Expression[] {
  switch (clause.type) {
    case 'Match':
      return [...patternExpressions(clause.pattern), ...(clause.where ? [clause.where] : [])];
    case 'Create':
      return patternExpressions(clause.pattern);
    case 'Return':
      return [
        ...clause.items.map((i) => i.expression),
        ...clause.orderBy.map((o) => o.expression),
        ...(clause.skip ? [clause.skip] : []),
        ...(clause.limit ? [clause.limit] : []),
      ];
    case 'UnsupportedClause':
      return [];
  }
}

function patternExpressions(pattern: ast.PatternPart[]): ast.Expression[] {
  return pattern.flatMap((part) =>
    part.elements.flatMap((e) => (e.properties ? [e.properties] : [])),
  );
}

function findUnsupported(expr: ast.Expression): ast.UnsupportedExpression | undefined {
  switch (expr.type) {
    case 'UnsupportedExpression':
      return expr;
    case 'List':
      return firstDefined(expr.items.map(findUnsupported));
    case 'Map':
      return firstDefined(expr.entries.map((e) => findUnsupported(e.value)));
    case 'PropertyAccess':
      return findUnsupported(expr.subject);
    default:
      return undefined;
  }
}

function firstDefined<T>(values: (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}
