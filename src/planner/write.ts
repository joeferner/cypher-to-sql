import type * as ast from '../ast.js';
import {
  LimitExceededError,
  SemanticError,
  UnsupportedFeatureError,
  type SourcePosition,
} from '../errors.js';
import type { Limits } from '../limits.js';
import type { BindValue, ColumnSpec, PlanStep, ValueSource, WrittenValue } from '../plan.js';
import type { Dialect } from '../dialect/dialect.js';
import type { GraphMapping } from '../mapping.js';
import { planWrittenReturn, type RowSource, type WrittenVariable } from './read.js';
import { constantValue, SqlBuilder } from './sql-builder.js';
import { mapChildren } from './walk.js';

/** A column of an INSERT: name, value, and whether the column holds JSON. */
type InsertColumn = [name: string, value: BindValue, json: boolean];

/**
 * The source rows of a write query: the reading clauses' rows (`current`), or a
 * one-row SELECT that `need()` makes when a value must be computed in SQL.
 */
export interface CreateSource {
  readonly current: RowSource | undefined;
  need(): RowSource;
}

/** An entity a CREATE clause binds to a variable, by its entity number in the row. */
export interface CreatedEntity {
  kind: 'node' | 'relationship';
  entity: number;
}

/**
 * The variables of a source row and the entities created for it so far, as a
 * written row (see `PlanStep.written`): matched entities and created ones are
 * ids, other values JSON. Adds columns to the source, so it must be called
 * before `source.finish()`.
 */
export function rowVariables(
  source: RowSource,
  created: Map<string, CreatedEntity>,
  mapping: GraphMapping,
  position: SourcePosition,
): { written: { name: string; value: WrittenValue }[]; variables: WrittenVariable[] } {
  const scope = source.scope;
  const written: { name: string; value: WrittenValue }[] = [];
  const variables: WrittenVariable[] = [];
  for (const name of scope.variables) {
    const binding = scope.lookup({ name, position });
    if (binding.kind === 'node' || binding.kind === 'relationship') {
      const table = binding.kind === 'node' ? mapping.nodes : mapping.edges;
      const column = source.column(`${binding.alias}.${scope.b.ident(table.id)}`);
      written.push({ name, value: { kind: 'rowId', column } });
      variables.push({ name, kind: binding.kind });
    } else {
      const value = source.valueColumn({ type: 'Variable', position, name });
      if (value.kind !== 'row') {
        throw new Error('Internal error: a variable is not a row column');
      }
      written.push({ name, value: { kind: 'rowJson', column: value.column } });
      variables.push({ name, kind: 'value' });
    }
  }
  for (const [name, entity] of created) {
    written.push({ name, value: { kind: 'entity', entity: entity.entity } });
    variables.push({ name, kind: entity.kind });
  }
  return { written, variables };
}

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
   * Plans CREATE, SET, and REMOVE clauses, in order.
   *
   * CREATE is one INSERT per entity, in pattern order. With database ids each
   * INSERT returns the new id, which later relationship INSERTs bind.
   *
   * With a source (the reading clauses before CREATE, or a one-row SELECT made
   * when a property value has to be computed), the INSERTs run once for each
   * source row: matched nodes and computed values come from that row.
   *
   * SET and REMOVE always run per source row, each item as a SELECT that
   * computes the target and the value over the row as it is stored now (so it
   * sees earlier writes), then UPDATEs (see `planSetItem`).
   *
   * Returns the steps and the entities the CREATE clauses bind to variables.
   */
  public planUpdates(
    clauses: (ast.CreateClause | ast.SetClause | ast.RemoveClause)[],
    limits: Limits,
    source: CreateSource,
  ): { steps: PlanStep[]; created: Map<string, CreatedEntity> } {
    const steps: PlanStep[] = [];
    /** Variables bound by CREATE, and matched nodes used by it, with the bind value of their id. */
    const variables = new Map<string, { kind: 'node' | 'relationship'; id: BindValue }>();
    const created = new Map<string, CreatedEntity>();
    /** The property map each created entity was given, for `a.key` in later property values. */
    const createdProperties = new Map<string, ast.Expression | undefined>();
    let entities = 0;

    /** A variable from the reading clauses, used in a CREATE pattern. */
    const sourceVariable = (
      name: string,
      position: ast.NodePattern['position'],
    ): { kind: 'node'; id: BindValue } | undefined => {
      const reading = source.current;
      if (!reading?.scope.has(name)) {
        return undefined;
      }
      const binding = reading.scope.lookup({ name, position });
      if (binding.kind !== 'node') {
        throw new SemanticError(`Variable \`${name}\` is not a node`, { position });
      }
      const b = reading.scope.b;
      const column = reading.column(`${binding.alias}.${b.ident(b.mapping.nodes.id)}`);
      const bound = { kind: 'node' as const, id: { kind: 'rowId' as const, column } };
      variables.set(name, bound);
      return bound;
    };

    /**
     * `a.key` of an entity created earlier in the query is the value it was
     * created with: the map entry's expression, `$props.key` for a parameter
     * map, or null. Any other use of such an entity in a value is not supported.
     */
    const substituteCreated = (
      expr: ast.Expression,
      local: readonly string[] = [],
    ): ast.Expression => {
      const created = (e: ast.Expression): e is ast.Variable =>
        e.type === 'Variable' && createdProperties.has(e.name) && !local.includes(e.name);
      if (expr.type === 'PropertyAccess' && created(expr.subject)) {
        const properties = createdProperties.get(expr.subject.name);
        const nothing: ast.Expression = { type: 'Literal', position: expr.position, value: null };
        if (properties?.type === 'Map') {
          const entry = properties.entries.find((e) => e.key === expr.key);
          return entry ? substituteCreated(entry.value) : nothing;
        }
        if (properties?.type === 'Parameter') {
          return { ...expr, subject: properties };
        }
        return nothing;
      }
      if (created(expr)) {
        throw new UnsupportedFeatureError(
          `An entity created in the same query can be used in property values only as \`${expr.name}.key\``,
          { position: expr.position },
        );
      }
      return mapChildren(expr, (child, inner) => substituteCreated(child, [...local, ...inner]));
    };

    const valueOf = (expr: ast.Expression): ValueSource => {
      const value = substituteCreated(expr);
      return constantValue(value) ?? source.need().valueColumn(value);
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
      const labels = [...new Set(node.labels)];
      steps.push(
        this.insert('node', entity, [
          [
            this.mapping.nodes.labels,
            { kind: 'json', value: { kind: 'constant', value: labels } },
            true,
          ],
          [this.mapping.nodes.properties, this.properties('nodes', node.properties, valueOf), true],
        ]),
      );
      // Bound after its properties, which cannot refer to the node itself.
      if (node.variable !== undefined) {
        variables.set(node.variable, { kind: 'node', id });
        created.set(node.variable, { kind: 'node', entity });
        createdProperties.set(node.variable, node.properties);
      }
      return id;
    };

    let computed = 0;
    for (const clause of clauses) {
      if (clause.type !== 'Create') {
        // REMOVE n.key is SET n.key = null.
        const items: ast.SetItem[] =
          clause.type === 'Set'
            ? clause.items
            : clause.items.map((item) =>
                item.kind === 'labels'
                  ? item
                  : { ...item, value: { type: 'Literal', position: item.position, value: null } },
              );
        for (const item of items) {
          steps.push(...this.planSetItem(item, clause.type, source.need(), created, computed++));
        }
        continue;
      }
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
          (variables.has(first.variable) || source.current?.scope.has(first.variable))
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
          if (
            rel.variable !== undefined &&
            (variables.has(rel.variable) || source.current?.scope.has(rel.variable))
          ) {
            throw new SemanticError(`Variable \`${rel.variable}\` is already bound`, {
              position: rel.position,
            });
          }
          const [start, end] = rel.direction === 'left' ? [next, previous] : [previous, next];
          const edges = this.mapping.edges;
          steps.push(
            this.insert('relationship', entity, [
              [edges.startId, start, false],
              [edges.endId, end, false],
              [edges.type, { kind: 'sql', value: rel.types[0]! }, false],
              [edges.properties, this.properties('edges', rel.properties, valueOf), true],
            ]),
          );
          if (rel.variable !== undefined) {
            variables.set(rel.variable, { kind: 'relationship', id: { kind: 'entityId', entity } });
            created.set(rel.variable, { kind: 'relationship', entity });
            createdProperties.set(rel.variable, rel.properties);
          }
          previous = next;
        }
      }
    }
    // A source made for a computed value (after some INSERTs were planned) makes every step per-row.
    return {
      steps: source.current ? steps.map((step) => ({ ...step, perRow: true })) : steps,
      created,
    };
  }

  /**
   * One SET or REMOVE item, for each source row: a SELECT over the row as it is
   * stored now computes the target entity (`t`) and the value (`v`); then one
   * UPDATE per table the target can be in merges the value into the properties
   * (or replaces them), or changes the labels. The runner checks the value and
   * builds the JSON patch (`propertyPatch`), as CREATE checks its properties.
   */
  private planSetItem(
    item: ast.SetItem,
    clause: 'Set' | 'Remove',
    source: RowSource,
    created: Map<string, CreatedEntity>,
    index: number,
  ): PlanStep[] {
    const position = item.position;
    const target: ast.Expression =
      item.kind === 'property' ? item.target : { type: 'Variable', position, name: item.variable };
    const value: ast.Expression =
      item.kind === 'labels' ? { type: 'Literal', position, value: null } : item.value;
    const projection = (expression: ast.Expression, name: string): ast.ProjectionItem => ({
      position: expression.position,
      expression,
      alias: name,
      name,
    });
    const { written, variables } = rowVariables(source, created, this.mapping, position);
    const b = new SqlBuilder(this.dialect, this.mapping);
    const { step, columns } = planWrittenReturn(
      b,
      variables,
      [],
      {
        type: 'Return',
        position,
        distinct: false,
        star: false,
        items: [projection(target, 't'), projection(value, 'v')],
        orderBy: [],
        skip: undefined,
        limit: undefined,
      },
      { kind: 'currentRow', written },
    );
    if (b.searchSteps.length > 0) {
      throw new UnsupportedFeatureError(
        `shortestPath() in ${clause.toUpperCase()} is not supported`,
        {
          position,
        },
      );
    }
    const [t, v] = columns as [ColumnSpec, ColumnSpec];
    const kinds: ('node' | 'relationship')[] =
      t.kind === 'node' || t.kind === 'relationship'
        ? [t.kind]
        : t.kind === 'json'
          ? item.kind === 'labels'
            ? ['node']
            : ['node', 'relationship']
          : [];
    if (kinds.length === 0 || (item.kind === 'labels' && !kinds.includes('node'))) {
      throw new SemanticError(
        `${clause.toUpperCase()} needs a ${item.kind === 'labels' ? 'node' : 'node or relationship'}`,
        { position: target.position },
      );
    }

    const steps: PlanStep[] = [{ ...step, computes: index }];
    for (const kind of kinds) {
      const table = kind === 'node' ? this.mapping.nodes : this.mapping.edges;
      const id = { kind: 'computedId' as const, index, column: t, entity: kind, position };
      if (item.kind === 'labels') {
        for (const label of new Set(item.labels)) {
          const u = new SqlBuilder(this.dialect, this.mapping);
          const labels = u.ident(this.mapping.nodes.labels);
          const l = u.bind({ kind: 'sql', value: label });
          const next =
            clause === 'Set'
              ? `CASE WHEN ${this.dialect.hasLabel(labels, l)} THEN ${labels} ` +
                `ELSE ${this.dialect.appendLabel(labels, l)} END`
              : this.dialect.removeLabel(labels, l);
          steps.push(
            u.finish(
              `UPDATE ${u.table('nodes')} SET ${labels} = ${next} WHERE ${u.ident(table.id)} = ${u.bind(id)}`,
              { updates: true },
            ),
          );
        }
        continue;
      }
      const u = new SqlBuilder(this.dialect, this.mapping);
      const properties = u.ident(table.properties);
      const patch = this.dialect.jsonInput(
        u.bind({
          kind: 'propertyPatch',
          index,
          column: v,
          mode: item.kind,
          key: item.kind === 'property' ? item.key : undefined,
          types: table.propertyTypes,
          position,
        }),
      );
      const next =
        item.kind === 'replace' ? patch : this.dialect.mergeProperties(properties, patch);
      steps.push(
        u.finish(
          `UPDATE ${u.table(kind === 'node' ? 'nodes' : 'edges')} SET ${properties} = ${next} ` +
            `WHERE ${u.ident(table.id)} = ${u.bind(id)}`,
          { updates: true },
        ),
      );
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

  private properties(
    kind: 'nodes' | 'edges',
    expr: ast.Expression | undefined,
    valueOf: (expr: ast.Expression) => ValueSource,
  ): BindValue {
    // Declared types are checked when the values are known, at run time.
    const types = this.mapping[kind].propertyTypes;
    if (!expr) {
      return { kind: 'properties', entries: [], types };
    }
    if (expr.type === 'Parameter') {
      return { kind: 'propertiesParameter', name: expr.name, position: expr.position, types };
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
      types,
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
