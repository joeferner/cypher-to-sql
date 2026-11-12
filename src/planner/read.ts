import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { ColumnSpec, PlanStep } from '../plan.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';

/** A node variable bound to an alias of the node table. */
interface NodeBinding {
  alias: string;
}

/**
 * Plans `MATCH ... RETURN ...` as a single SELECT.
 *
 * Supported so far: node patterns with labels (several patterns form a Cartesian
 * product), and RETURN of node variables, node properties, and constants, with LIMIT.
 */
export function planRead(
  b: SqlBuilder,
  matches: ast.MatchClause[],
  ret: ast.ReturnClause,
): { step: PlanStep; columns: ColumnSpec[] } {
  const bindings = new Map<string, NodeBinding>();
  const from: string[] = [];
  const where: string[] = [];
  const nodes = b.mapping.nodes;

  for (const match of matches) {
    if (match.optional) {
      throw new UnsupportedFeatureError('OPTIONAL MATCH is not supported yet', {
        position: match.position,
      });
    }
    if (match.where) {
      throw new UnsupportedFeatureError('WHERE is not supported yet', {
        position: match.where.position,
      });
    }
    for (const part of match.pattern) {
      if (part.variable !== undefined) {
        throw new UnsupportedFeatureError('Named paths are not supported yet', {
          position: part.position,
        });
      }
      if (part.elements.length > 1) {
        throw new UnsupportedFeatureError('Relationship patterns in MATCH are not supported yet', {
          position: part.elements[1]!.position,
        });
      }
      const node = part.elements[0] as ast.NodePattern;
      if (node.properties) {
        throw new UnsupportedFeatureError('Property maps in MATCH patterns are not supported yet', {
          position: node.properties.position,
        });
      }
      let binding = node.variable !== undefined ? bindings.get(node.variable) : undefined;
      if (!binding) {
        binding = { alias: `n${from.length}` };
        from.push(`${b.table('nodes')} AS ${binding.alias}`);
        if (node.variable !== undefined) {
          bindings.set(node.variable, binding);
        }
      }
      for (const label of node.labels) {
        where.push(
          b.dialect.hasLabel(
            `${binding.alias}.${b.ident(nodes.labels)}`,
            b.bind({ kind: 'sql', value: label }),
          ),
        );
      }
    }
  }

  if (ret.distinct || ret.orderBy.length > 0 || ret.skip) {
    const what = ret.distinct ? 'DISTINCT' : ret.orderBy.length > 0 ? 'ORDER BY' : 'SKIP';
    throw new UnsupportedFeatureError(`${what} is not supported yet`, { position: ret.position });
  }

  const items: ast.ProjectionItem[] = [...ret.items];
  if (ret.star) {
    if (bindings.size === 0) {
      throw new SemanticError('RETURN * is not allowed when there are no variables in scope', {
        position: ret.position,
      });
    }
    const starItems = [...bindings.keys()].sort().map((name): ast.ProjectionItem => ({
      position: ret.position,
      expression: { type: 'Variable', position: ret.position, name },
      alias: undefined,
      name,
    }));
    items.unshift(...starItems);
  }

  const select: string[] = [];
  const columns: ColumnSpec[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new SemanticError(`Multiple result columns with the same name: ${item.name}`, {
        position: item.position,
      });
    }
    seen.add(item.name);

    const c = `c${columns.length}`;
    const expr = item.expression;
    if (expr.type === 'Variable') {
      const binding = lookup(bindings, expr);
      select.push(
        `${binding.alias}.${b.ident(nodes.id)} AS ${c}_id`,
        `${b.dialect.jsonText(`${binding.alias}.${b.ident(nodes.labels)}`)} AS ${c}_labels`,
        `${b.dialect.jsonText(`${binding.alias}.${b.ident(nodes.properties)}`)} AS ${c}_props`,
      );
      columns.push({
        name: item.name,
        kind: 'node',
        id: `${c}_id`,
        labels: `${c}_labels`,
        properties: `${c}_props`,
      });
      continue;
    }
    if (expr.type === 'PropertyAccess' && expr.subject.type === 'Variable') {
      const binding = lookup(bindings, expr.subject);
      const member = b.dialect.jsonMember(
        `${binding.alias}.${b.ident(nodes.properties)}`,
        b.bind({ kind: 'sql', value: expr.key }),
        expr.key,
      );
      select.push(`${b.dialect.jsonText(member)} AS ${c}`);
      columns.push({ name: item.name, kind: 'json', column: c });
      continue;
    }
    const constant = constantValue(expr);
    if (constant) {
      select.push(`${b.bind({ kind: 'json', value: constant })} AS ${c}`);
      columns.push({ name: item.name, kind: 'json', column: c });
      continue;
    }
    throw new UnsupportedFeatureError('This RETURN expression is not supported yet', {
      position: expr.position,
    });
  }

  let userLimit;
  if (ret.limit) {
    userLimit = constantValue(ret.limit);
    if (!userLimit) {
      throw new UnsupportedFeatureError('LIMIT must be an integer literal or a parameter', {
        position: ret.limit.position,
      });
    }
    if (
      userLimit.kind === 'constant' &&
      (typeof userLimit.value !== 'bigint' || userLimit.value < 0n)
    ) {
      throw new SemanticError('LIMIT must be a non-negative integer', {
        position: ret.limit.position,
      });
    }
  }

  let sql = `SELECT ${select.join(', ')}`;
  if (from.length > 0) {
    sql += ` FROM ${from.join(' CROSS JOIN ')}`;
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  sql += ` LIMIT ${b.bind({ kind: 'rowLimit', userLimit })}`;

  return { step: b.finish(sql), columns };
}

function lookup(bindings: Map<string, NodeBinding>, variable: ast.Variable): NodeBinding {
  const binding = bindings.get(variable.name);
  if (!binding) {
    throw new SemanticError(`Variable \`${variable.name}\` not defined`, {
      position: variable.position,
    });
  }
  return binding;
}
