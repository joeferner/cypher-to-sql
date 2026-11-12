import type * as ast from '../ast.js';
import { LimitExceededError, SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { Limits } from '../limits.js';
import type { BindValue, PlanStep, ValueSource } from '../plan.js';
import type { Dialect } from '../dialect/dialect.js';
import type { GraphMapping } from '../mapping.js';
import type { RowSource } from './read.js';
import { constantValue, SqlBuilder } from './sql-builder.js';

/** A column of an INSERT: name, value, and whether the column holds JSON. */
type InsertColumn = [name: string, value: BindValue, json: boolean];

export type IdStrategy =
  | { kind: 'database' }
  | { kind: 'generator'; generate: (entity: 'node' | 'relationship') => string | number };

/**
 * Write operators. A graph made with `readOnly: true` never constructs this, so its
 * planner has no code path that can emit an INSERT, even if the gate had a bug.
 */
export class WritePlanner {
  public constructor(
    private readonly dialect: Dialect,
    private readonly mapping: GraphMapping,
    private readonly idStrategy: IdStrategy,
  ) {}

  /**
   * Plans CREATE clauses as one INSERT per entity, in pattern order. With database
   * ids each INSERT returns the new id, which later relationship INSERTs bind.
   *
   * With a `source` (the reading clauses before CREATE), the INSERTs run once for
   * each source row: matched nodes and values come from that row.
   */
  public planCreate(clauses: ast.CreateClause[], limits: Limits, source?: RowSource): PlanStep[] {
    const steps: PlanStep[] = [];
    /** Variables bound by CREATE, and matched nodes used by it, with the bind value of their id. */
    const variables = new Map<string, { kind: 'node' | 'relationship'; id: BindValue }>();
    let entities = 0;
    const perRow = source !== undefined;

    /** A variable from the reading clauses, used in a CREATE pattern. */
    const sourceVariable = (
      name: string,
      position: ast.NodePattern['position'],
    ): { kind: 'node'; id: BindValue } | undefined => {
      if (!source?.scope.has(name)) {
        return undefined;
      }
      const binding = source.scope.lookup({ name, position });
      if (binding.kind !== 'node') {
        throw new SemanticError(`Variable \`${name}\` is not a node`, { position });
      }
      const b = source.scope.b;
      const column = source.column(`${binding.alias}.${b.ident(b.mapping.nodes.id)}`);
      const bound = { kind: 'node' as const, id: { kind: 'rowId' as const, column } };
      variables.set(name, bound);
      return bound;
    };

    const valueOf = (expr: ast.Expression): ValueSource => {
      const constant = constantValue(expr);
      if (constant) {
        return constant;
      }
      const root = rootVariable(expr);
      if (root && variables.has(root.name) && !source?.scope.has(root.name)) {
        throw new UnsupportedFeatureError(
          `Entities created in the same query cannot be used in property values yet`,
          { position: expr.position },
        );
      }
      if (!source) {
        if (root) {
          throw new SemanticError(`Variable \`${root.name}\` not defined`, {
            position: root.position,
          });
        }
        throw new UnsupportedFeatureError(
          'Property values in CREATE must be literals, parameters, or variables for now',
          { position: expr.position },
        );
      }
      return source.valueColumn(expr);
    };

    const newEntity = (): number => {
      entities++;
      if (entities > limits.maxCreatedEntities) {
        throw new LimitExceededError(
          `The query creates more than ${limits.maxCreatedEntities} entities (maxCreatedEntities)`,
        );
      }
      return entities - 1;
    };

    const createNode = (node: ast.NodePattern): BindValue => {
      if (node.variable !== undefined) {
        const existing =
          variables.get(node.variable) ?? sourceVariable(node.variable, node.position);
        if (existing) {
          if (existing.kind !== 'node') {
            throw new SemanticError(`Variable \`${node.variable}\` is already a relationship`, {
              position: node.position,
            });
          }
          if (node.labels.length > 0 || node.properties) {
            throw new SemanticError(
              `Variable \`${node.variable}\` is already bound; it cannot get new labels or properties in CREATE`,
              { position: node.position },
            );
          }
          return existing.id;
        }
      }
      const entity = newEntity();
      const id: BindValue = { kind: 'entityId', entity };
      if (node.variable !== undefined) {
        variables.set(node.variable, { kind: 'node', id });
      }
      const labels = [...new Set(node.labels)];
      steps.push(
        this.insert('node', entity, [
          [
            this.mapping.nodes.labels,
            { kind: 'json', value: { kind: 'constant', value: labels } },
            true,
          ],
          [this.mapping.nodes.properties, this.properties(node.properties, valueOf), true],
        ]),
      );
      return id;
    };

    for (const clause of clauses) {
      for (const part of clause.pattern) {
        if (part.variable !== undefined) {
          throw new UnsupportedFeatureError('Named paths in CREATE are not supported yet', {
            position: part.position,
          });
        }
        const first = part.elements[0] as ast.NodePattern;
        if (
          part.elements.length === 1 &&
          first.variable !== undefined &&
          (variables.has(first.variable) || source?.scope.has(first.variable))
        ) {
          // A lone node pattern would create nothing: `MATCH (a) CREATE (a)`.
          throw new SemanticError(`Variable \`${first.variable}\` already declared`, {
            position: first.position,
          });
        }
        let previous = createNode(part.elements[0] as ast.NodePattern);
        for (let i = 1; i < part.elements.length; i += 2) {
          const rel = part.elements[i] as ast.RelationshipPattern;
          const next = createNode(part.elements[i + 1] as ast.NodePattern);
          this.checkRelationship(rel);
          const entity = newEntity();
          if (rel.variable !== undefined) {
            if (variables.has(rel.variable) || source?.scope.has(rel.variable)) {
              throw new SemanticError(`Variable \`${rel.variable}\` is already bound`, {
                position: rel.position,
              });
            }
            variables.set(rel.variable, { kind: 'relationship', id: { kind: 'entityId', entity } });
          }
          const [start, end] = rel.direction === 'left' ? [next, previous] : [previous, next];
          const edges = this.mapping.edges;
          steps.push(
            this.insert('relationship', entity, [
              [edges.startId, start, false],
              [edges.endId, end, false],
              [edges.type, { kind: 'sql', value: rel.types[0]! }, false],
              [edges.properties, this.properties(rel.properties, valueOf), true],
            ]),
          );
          previous = next;
        }
      }
    }
    return perRow ? steps.map((step) => ({ ...step, perRow: true })) : steps;
  }

  private checkRelationship(rel: ast.RelationshipPattern): void {
    if (rel.types.length !== 1) {
      throw new SemanticError('A relationship in CREATE must have exactly one type', {
        position: rel.position,
      });
    }
    if (rel.direction === 'both') {
      throw new SemanticError('A relationship in CREATE must have a direction', {
        position: rel.position,
      });
    }
    if (rel.range) {
      throw new SemanticError('Variable-length relationships cannot be created', {
        position: rel.position,
      });
    }
  }

  private properties(
    expr: ast.Expression | undefined,
    valueOf: (expr: ast.Expression) => ValueSource,
  ): BindValue {
    if (!expr) {
      return { kind: 'properties', entries: [] };
    }
    if (expr.type === 'Parameter') {
      return { kind: 'propertiesParameter', name: expr.name, position: expr.position };
    }
    if (expr.type !== 'Map') {
      throw new UnsupportedFeatureError('Properties must be a map literal or a parameter', {
        position: expr.position,
      });
    }
    return {
      kind: 'properties',
      entries: expr.entries.map(({ key, value }) => {
        if (value.type === 'Map') {
          throw new SemanticError('Property values cannot be maps', { position: value.position });
        }
        return { key, value: valueOf(value) };
      }),
    };
  }

  private insert(kind: 'node' | 'relationship', entity: number, columns: InsertColumn[]): PlanStep {
    const b = new SqlBuilder(this.dialect, this.mapping);
    const table = kind === 'node' ? 'nodes' : 'edges';
    const idColumn = this.mapping[table].id;

    const names: string[] = [];
    const values: string[] = [];
    const generated = this.idStrategy.kind === 'generator';
    if (generated) {
      names.push(b.ident(idColumn));
      values.push(b.bind({ kind: 'entityId', entity }));
    }
    for (const [name, value, json] of columns) {
      names.push(b.ident(name));
      const placeholder = b.bind(value);
      values.push(json ? this.dialect.jsonInput(placeholder) : placeholder);
    }
    let sql = `INSERT INTO ${b.table(table)} (${names.join(', ')}) VALUES (${values.join(', ')})`;
    if (!generated) {
      sql += ` RETURNING ${b.ident(idColumn)} AS id`;
    }
    return b.finish(sql, {
      creates: { entity, kind },
      generatedId: generated ? { entity, kind } : undefined,
    });
  }
}

/** The variable an expression reads from (`x` in `x`, `x.a`, `x.a.b`), if any. */
function rootVariable(expr: ast.Expression): ast.Variable | undefined {
  if (expr.type === 'Variable') {
    return expr;
  }
  return expr.type === 'PropertyAccess' ? rootVariable(expr.subject) : undefined;
}
