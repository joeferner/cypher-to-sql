import type * as ast from '../ast.js';
import { LimitExceededError, SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { Limits } from '../limits.js';
import type { BindValue, PlanStep } from '../plan.js';
import type { Dialect } from '../dialect/dialect.js';
import type { GraphMapping } from '../mapping.js';
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
   * Plans a query made only of CREATE clauses as one INSERT per entity, in pattern
   * order. With database ids each INSERT returns the new id, which later
   * relationship INSERTs bind.
   */
  public planCreate(clauses: ast.CreateClause[], limits: Limits): PlanStep[] {
    const steps: PlanStep[] = [];
    const variables = new Map<string, { entity: number; kind: 'node' | 'relationship' }>();
    let entities = 0;

    const newEntity = (): number => {
      entities++;
      if (entities > limits.maxCreatedEntities) {
        throw new LimitExceededError(
          `The query creates more than ${limits.maxCreatedEntities} entities (maxCreatedEntities)`,
        );
      }
      return entities - 1;
    };

    const createNode = (node: ast.NodePattern): number => {
      if (node.variable !== undefined) {
        const existing = variables.get(node.variable);
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
          return existing.entity;
        }
      }
      const entity = newEntity();
      if (node.variable !== undefined) {
        variables.set(node.variable, { entity, kind: 'node' });
      }
      const labels = [...new Set(node.labels)];
      steps.push(
        this.insert('node', entity, [
          [
            this.mapping.nodes.labels,
            { kind: 'json', value: { kind: 'constant', value: labels } },
            true,
          ],
          [this.mapping.nodes.properties, this.properties(node.properties), true],
        ]),
      );
      return entity;
    };

    for (const clause of clauses) {
      for (const part of clause.pattern) {
        if (part.variable !== undefined) {
          throw new UnsupportedFeatureError('Named paths in CREATE are not supported yet', {
            position: part.position,
          });
        }
        let previous = createNode(part.elements[0] as ast.NodePattern);
        for (let i = 1; i < part.elements.length; i += 2) {
          const rel = part.elements[i] as ast.RelationshipPattern;
          const next = createNode(part.elements[i + 1] as ast.NodePattern);
          this.checkRelationship(rel);
          const entity = newEntity();
          if (rel.variable !== undefined) {
            if (variables.has(rel.variable)) {
              throw new SemanticError(`Variable \`${rel.variable}\` is already bound`, {
                position: rel.position,
              });
            }
            variables.set(rel.variable, { entity, kind: 'relationship' });
          }
          const [start, end] = rel.direction === 'left' ? [next, previous] : [previous, next];
          const edges = this.mapping.edges;
          steps.push(
            this.insert('relationship', entity, [
              [edges.startId, { kind: 'entityId', entity: start }, false],
              [edges.endId, { kind: 'entityId', entity: end }, false],
              [edges.type, { kind: 'sql', value: rel.types[0]! }, false],
              [edges.properties, this.properties(rel.properties), true],
            ]),
          );
          previous = next;
        }
      }
    }
    return steps;
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

  private properties(expr: ast.Expression | undefined): BindValue {
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
        const constant = constantValue(value);
        if (!constant) {
          throw new UnsupportedFeatureError(
            'Property values in CREATE must be literals or parameters for now',
            { position: value.position },
          );
        }
        return { key, value: constant };
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
