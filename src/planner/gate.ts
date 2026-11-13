import type * as ast from '../ast.js';
import { ReadOnlyViolationError, SemanticError, UnsupportedFeatureError } from '../errors.js';
import { containsAggregate } from './aggregates.js';
import { children } from './walk.js';

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
    const shortest =
      clause.type === 'Create' ? clause.pattern.find((p) => p.shortest !== undefined) : undefined;
    if (shortest) {
      throw new SemanticError('shortestPath() and allShortestPaths() can only be used in MATCH', {
        position: shortest.position,
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
    case 'Unwind':
      return [clause.expression];
    case 'Create':
      return patternExpressions(clause.pattern);
    case 'With':
      return [
        ...clause.items.map((i) => i.expression),
        ...clause.orderBy.map((o) => o.expression),
        ...(clause.skip ? [clause.skip] : []),
        ...(clause.limit ? [clause.limit] : []),
        ...(clause.where ? [clause.where] : []),
      ];
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

/**
 * The first unsupported construct in the expression. Also rejects aggregates in
 * the WHERE or projection of a list comprehension or quantifier, which would
 * aggregate over the list's elements.
 */
function findUnsupported(expr: ast.Expression): ast.UnsupportedExpression | undefined {
  if (expr.type === 'UnsupportedExpression') {
    return expr;
  }
  for (const { child, local } of children(expr)) {
    if (local !== undefined && containsAggregate(child)) {
      throw new SemanticError(
        'Aggregate functions cannot be used in a list comprehension or quantifier',
        { position: child.position },
      );
    }
    const found = findUnsupported(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}
