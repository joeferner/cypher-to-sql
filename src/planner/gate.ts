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
    for (const { expr, where } of clauseExpressions(clause)) {
      checkExpression(expr, where);
    }
  }
}

/** The expressions of a clause; `where` marks those of a WHERE. */
function clauseExpressions(clause: ast.Clause): { expr: ast.Expression; where: boolean }[] {
  const plain = (
    exprs: (ast.Expression | undefined)[],
  ): { expr: ast.Expression; where: boolean }[] =>
    exprs.filter((e) => e !== undefined).map((expr) => ({ expr, where: false }));
  const where = (expr: ast.Expression | undefined): { expr: ast.Expression; where: boolean }[] =>
    expr ? [{ expr, where: true }] : [];
  switch (clause.type) {
    case 'Match':
      return [...plain(patternExpressions(clause.pattern)), ...where(clause.where)];
    case 'Unwind':
      return plain([clause.expression]);
    case 'Create':
      return plain(patternExpressions(clause.pattern));
    case 'With':
      return [
        ...plain([
          ...clause.items.map((i) => i.expression),
          ...clause.orderBy.map((o) => o.expression),
          clause.skip,
          clause.limit,
        ]),
        ...where(clause.where),
      ];
    case 'Return':
      return plain([
        ...clause.items.map((i) => i.expression),
        ...clause.orderBy.map((o) => o.expression),
        clause.skip,
        clause.limit,
      ]);
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
 * Rejects unsupported constructs in an expression, and constructs in the wrong
 * place: aggregates in the WHERE or projection of a list comprehension,
 * quantifier, EXISTS, or pattern comprehension (they would aggregate per
 * element); pattern predicates outside a WHERE (`inWhere`), as in Cypher; and
 * write clauses in `EXISTS { query }`.
 */
function checkExpression(expr: ast.Expression, inWhere: boolean): void {
  switch (expr.type) {
    case 'UnsupportedExpression':
      throw new UnsupportedFeatureError(`${expr.description} are not supported yet`, {
        position: expr.position,
      });
    case 'PatternPredicate':
      if (!inWhere) {
        throw new SemanticError('A pattern can be used as a condition only in WHERE', {
          position: expr.position,
          hint: 'Use EXISTS { (a)-->(b) } instead, or count the matches with size([(a)-->(b) | 1]).',
        });
      }
      break;
    case 'Exists':
      if (expr.query) {
        const write = expr.query.clauses.find(
          (c) => c.type === 'Create' || (c.type === 'UnsupportedClause' && c.write),
        );
        if (write) {
          throw new SemanticError('An EXISTS subquery cannot modify the graph', {
            position: write.position,
          });
        }
        assertSupported(expr.query);
      }
      break;
  }
  for (const { child, local } of children(expr)) {
    if (local.length > 0 && containsAggregate(child)) {
      throw new SemanticError(
        'Aggregate functions cannot be used inside a list comprehension, quantifier, EXISTS, or pattern comprehension',
        { position: child.position },
      );
    }
    checkExpression(child, inWhere || local.length > 0);
  }
}
