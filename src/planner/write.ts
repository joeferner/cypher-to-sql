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
import { planWrittenReturn, typeKey, type RowSource, type WrittenVariable } from './read.js';
import { constantValue, SqlBuilder } from './sql-builder.js';
import { children, mapChildren } from './walk.js';

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
export type CreatedEntity =
  | { kind: 'node' | 'relationship'; entity: number }
  /** FOREACH's variable: its element's JSON, in the runner's entity slot `entity`. */
  | { kind: 'slot'; entity: number };

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
      if (binding.kind === 'relationship') {
        // Kept so that type(r) still works after DELETE r.
        const type = source.column(`${binding.alias}.${scope.b.ident(mapping.edges.type)}`);
        written.push({ name: typeKey(name), value: { kind: 'rowString', column: type } });
      }
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
    if (entity.kind === 'slot') {
      written.push({ name, value: { kind: 'slot', entity: entity.entity } });
      variables.push({ name, kind: 'value' });
    } else {
      written.push({ name, value: { kind: 'entity', entity: entity.entity } });
      variables.push({ name, kind: entity.kind });
    }
  }
  return { written, variables };
}

/** The clauses that change the graph. */
export type UpdateClause =
  | ast.CreateClause
  | ast.SetClause
  | ast.RemoveClause
  | ast.DeleteClause
  | ast.MergeClause
  | ast.ForeachClause;

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
    clauses: UpdateClause[],
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
      const b = reading.scope.b;
      let column: string;
      const known =
        binding.kind === 'value' || binding.kind === 'column'
          ? reading.scope.expressions.compile({ type: 'Variable', position, name }).type
          : undefined;
      if (known === 'json') {
        // A node held as a value (`WITH list[0] AS n`): its id, from its JSON,
        // checked when the query runs.
        const d = b.dialect;
        const json = reading.scope.value({ type: 'Variable', position, name });
        const table = b.mapping.nodes;
        const id = d.jsonId(
          d.jsonMember(json, b.bind({ kind: 'sql', value: '~id' }), '~id'),
          b.table('nodes'),
          table.id,
        );
        // Ids are 64-bit integers (see docs/schema.md), so the error has that type.
        const notNode = b.typeError(
          `Type mismatch: \`${name}\` must be a node to be used in a pattern`,
          position,
          'integer',
        );
        column = reading.column(
          `(CASE WHEN ${d.jsonIsNull(json)} THEN NULL WHEN ${d.jsonType(json)} = 'node' ` +
            `THEN ${id} ELSE ${notNode} END)`,
        );
      } else if (binding.kind === 'node') {
        column = reading.column(`${binding.alias}.${b.ident(b.mapping.nodes.id)}`);
      } else {
        throw new SemanticError(`Variable \`${name}\` is not a node`, { position });
      }
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

    /** True when `expr` uses a variable that the source rows do not have (FOREACH's). */
    const foreign = (expr: ast.Expression, local: readonly string[] = []): boolean =>
      (expr.type === 'Variable' &&
        !local.includes(expr.name) &&
        !(source.current?.scope.has(expr.name) ?? false)) ||
      children(expr).some(({ child, local: inner }) => foreign(child, [...local, ...inner]));

    let computed = 0;
    const valueOf = (expr: ast.Expression): ValueSource => {
      const value = substituteCreated(expr);
      const constant = constantValue(value);
      if (constant) {
        return constant;
      }
      if (!foreign(value)) {
        return source.need().valueColumn(value);
      }
      // Computed over the row as stored now, where FOREACH's variable is bound.
      const index = computed++;
      const { step, column } = this.computeValue(value, source.need(), created, index);
      into.push(step);
      return { kind: 'computed', index, column };
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

    /** Where the INSERTs of a pattern go: the plan's steps, or a MERGE's create branch. */
    let into = steps;
    /** For MERGE: a null property value is an error, and parameter maps are not allowed. */
    let merging = false;

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
              `Variable \`${node.variable}\` is already bound; it cannot get new labels or properties in ${merging ? 'MERGE' : 'CREATE'}`,
              { position: node.position },
            );
          }
          return existing.id;
        }
      }
      const entity = newEntity();
      const id: BindValue = { kind: 'entityId', entity };
      const labels = [...new Set(node.labels)];
      into.push(
        this.insert('node', entity, [
          [
            this.mapping.nodes.labels,
            { kind: 'json', value: { kind: 'constant', value: labels } },
            true,
          ],
          [
            this.mapping.nodes.properties,
            this.properties('nodes', node.properties, valueOf, merging),
            true,
          ],
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

    /** Plans the INSERTs of one pattern part (into `into`), binding its new variables. */
    const createPart = (part: ast.PatternPart): void => {
      let previous = createNode(part.elements[0] as ast.NodePattern);
      for (let i = 1; i < part.elements.length; i += 2) {
        const rel = part.elements[i] as ast.RelationshipPattern;
        const next = createNode(part.elements[i + 1] as ast.NodePattern);
        this.checkRelationship(rel, merging);
        const entity = newEntity();
        if (
          rel.variable !== undefined &&
          (variables.has(rel.variable) || source.current?.scope.has(rel.variable))
        ) {
          throw new SemanticError(`Variable \`${rel.variable}\` is already bound`, {
            position: rel.position,
          });
        }
        // MERGE creates an undirected relationship from left to right.
        const [start, end] = rel.direction === 'left' ? [next, previous] : [previous, next];
        const edges = this.mapping.edges;
        into.push(
          this.insert('relationship', entity, [
            [edges.startId, start, false],
            [edges.endId, end, false],
            [edges.type, { kind: 'sql', value: rel.types[0]! }, false],
            [edges.properties, this.properties('edges', rel.properties, valueOf, merging), true],
          ]),
        );
        if (rel.variable !== undefined) {
          variables.set(rel.variable, { kind: 'relationship', id: { kind: 'entityId', entity } });
          created.set(rel.variable, { kind: 'relationship', entity });
          createdProperties.set(rel.variable, rel.properties);
        }
        previous = next;
      }
    };

    let deletesNodes = false;
    let slots = 0;

    /** Steps tagged with their clause (the runner runs a clause for every row before the next). */
    const tagged = (list: PlanStep[], starts: number[]): PlanStep[] =>
      list.map((step, i) => ({
        ...step,
        clause: starts.findLastIndex((start) => start <= i),
      }));

    /** Plans one clause into `out`. */
    const planClause = (clause: UpdateClause, out: PlanStep[]): void => {
      const previous = into;
      into = out;
      try {
        planInto(clause, out);
      } finally {
        into = previous;
      }
    };

    const planInto = (clause: UpdateClause, steps: PlanStep[]): void => {
      if (clause.type === 'Foreach') {
        // The list, for each row; the inner clauses for each element, with the
        // variable in an entity slot. Variables bound inside do not leave it.
        const index = computed++;
        const { step, column } = this.computeValue(
          substituteCreated(clause.list),
          source.need(),
          created,
          index,
        );
        const slot = -++slots;
        const createdBefore = new Map(created);
        const variablesBefore = new Map(variables);
        created.set(clause.variable, { kind: 'slot', entity: slot });
        const inner: PlanStep[] = [];
        const starts: number[] = [];
        for (const c of clause.clauses) {
          starts.push(inner.length);
          // The parser allows only updating clauses in FOREACH.
          planClause(c as UpdateClause, inner);
        }
        created.clear();
        createdBefore.forEach((v, k) => created.set(k, v));
        variables.clear();
        variablesBefore.forEach((v, k) => variables.set(k, v));
        steps.push({
          ...step,
          foreach: {
            slot,
            column,
            position: clause.position,
            steps: tagged(inner, starts).map((s) => ({ ...s, perRow: true })),
          },
        });
        return;
      }
      if (clause.type === 'Merge') {
        steps.push(
          this.planMerge(
            clause,
            source.need(),
            created,
            computed++,
            (part) => {
              // The create branch: the pattern's INSERTs, with its variables bound.
              const branch: PlanStep[] = [];
              into = branch;
              merging = true;
              try {
                createPart(part);
              } finally {
                into = steps;
                merging = false;
              }
              return branch;
            },
            (item) => this.planSetItem(item, 'Set', source.need(), created, computed++),
          ),
        );
        return;
      }
      if (clause.type === 'Delete') {
        for (const expression of clause.expressions) {
          steps.push(
            ...this.planDeleteItem(expression, clause.detach, source.need(), created, computed++),
          );
        }
        // After the clause ran for every row: its nodes without relationships go now.
        steps.push(this.deleteFreeNodes());
        deletesNodes = true;
        return;
      }
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
        return;
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
        createPart(part);
      }
    };

    const starts: number[] = [];
    for (const clause of clauses) {
      starts.push(steps.length);
      planClause(clause, steps);
    }
    const clauseSteps = tagged(steps, starts);
    // A source made for a computed value (after some INSERTs were planned) makes every step per-row.
    const all = source.current
      ? clauseSteps.map((step) => ({ ...step, perRow: true }))
      : clauseSteps;
    return { steps: deletesNodes ? [...all, ...this.deleteNodes()] : all, created };
  }

  /**
   * A SELECT that computes `value` over the row as it is stored now (with
   * FOREACH's variables bound); its row is kept as `computes: index`.
   */
  private computeValue(
    value: ast.Expression,
    source: RowSource,
    created: Map<string, CreatedEntity>,
    index: number,
  ): { step: PlanStep; column: ColumnSpec } {
    const position = value.position;
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
        items: [{ position, expression: value, alias: 'v', name: 'v' }],
        orderBy: [],
        skip: undefined,
        limit: undefined,
      },
      { kind: 'currentRow', written },
    );
    if (b.searchSteps.length > 0) {
      throw new UnsupportedFeatureError('shortestPath() in an updating clause is not supported', {
        position,
      });
    }
    return { step: { ...step, computes: index }, column: columns[0]! };
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

  /**
   * MERGE, for each source row: a SELECT over the row as stored now finds the
   * pattern's matches (the ids of its new variables). The runner then runs the
   * rest of the row once for each match, after the ON MATCH items; with no
   * match it runs the create branch (the pattern's INSERTs) and the ON CREATE
   * items. The new variables are entities (as CREATE's), whose ids come from the
   * match or the INSERT, so later clauses see them alike.
   */
  private planMerge(
    clause: ast.MergeClause,
    source: RowSource,
    created: Map<string, CreatedEntity>,
    index: number,
    createBranch: (part: ast.PatternPart) => PlanStep[],
    setItem: (item: ast.SetItem) => PlanStep[],
  ): PlanStep {
    const part = clause.pattern;
    const position = clause.position;
    if (part.variable !== undefined || part.shortest !== undefined) {
      throw new UnsupportedFeatureError('Named paths in MERGE are not supported yet', {
        position: part.position,
      });
    }
    const bound = (name: string): boolean => source.scope.has(name) || created.has(name);
    const first = part.elements[0] as ast.NodePattern;
    if (part.elements.length === 1 && first.variable !== undefined && bound(first.variable)) {
      throw new SemanticError(`Variable \`${first.variable}\` already declared`, {
        position: first.position,
      });
    }
    const fresh = [
      ...new Set(
        part.elements
          .map((e) => e.variable)
          .filter((name): name is string => name !== undefined && !bound(name)),
      ),
    ];
    const { written, variables } = rowVariables(source, created, this.mapping, position);
    const b = new SqlBuilder(this.dialect, this.mapping);
    const items: ast.ProjectionItem[] = fresh.map((name, i) => ({
      position,
      expression: { type: 'Variable', position, name },
      alias: `m${i}`,
      name: `m${i}`,
    }));
    if (items.length === 0) {
      items.push({
        position,
        expression: { type: 'Literal', position, value: 1n },
        alias: 'm',
        name: 'm',
      });
    }
    const { step, columns } = planWrittenReturn(
      b,
      variables,
      [{ type: 'Match', position, optional: false, pattern: [part], where: undefined }],
      {
        type: 'Return',
        position,
        distinct: false,
        star: false,
        items,
        orderBy: [],
        skip: undefined,
        limit: undefined,
      },
      { kind: 'currentRow', written },
    );
    if (b.searchSteps.length > 0) {
      throw new UnsupportedFeatureError('shortestPath() in MERGE is not supported', { position });
    }
    // The create branch binds the new variables to new entities.
    const createSteps = createBranch(part);
    const bind = fresh.map((name, i) => ({
      entity: created.get(name)!.entity,
      column: columns[i]!,
    }));
    const onCreate = clause.onCreate.flatMap(setItem);
    const onMatch = clause.onMatch.flatMap(setItem);
    const perRow = (s: PlanStep): PlanStep => ({ ...s, perRow: true });
    return {
      ...step,
      computes: index,
      merge: {
        bind,
        onCreate: [...createSteps, ...onCreate].map(perRow),
        onMatch: onMatch.map(perRow),
      },
    };
  }

  /**
   * One DELETE value, for each source row: a SELECT over the row as stored now
   * computes it (a node, relationship, or path), then its relationships are
   * deleted, and with DETACH every relationship of its nodes. Its nodes are
   * collected and deleted after every row (see `deleteNodes`), so that a node
   * whose relationships a later row deletes is not an error.
   */
  private planDeleteItem(
    expression: ast.Expression,
    detach: boolean,
    source: RowSource,
    created: Map<string, CreatedEntity>,
    index: number,
  ): PlanStep[] {
    const position = expression.position;
    if (expression.type === 'HasLabels') {
      throw new SemanticError('DELETE cannot delete labels; use REMOVE n:Label', { position });
    }
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
        items: [{ position, expression, alias: 't', name: 't' }],
        orderBy: [],
        skip: undefined,
        limit: undefined,
      },
      { kind: 'currentRow', written },
    );
    const [t] = columns as [ColumnSpec];
    if (t.kind === 'scalar') {
      throw new SemanticError('DELETE needs a node, relationship, or path', { position });
    }
    const steps: PlanStep[] = [{ ...step, computes: index, deletesNodes: t }];
    const edges = this.mapping.edges;
    const deleteEdges = (part: 'nodes' | 'relationships', columnsToMatch: string[]): PlanStep => {
      const u = new SqlBuilder(this.dialect, this.mapping);
      const ids = this.dialect.jsonInput(
        u.bind({ kind: 'deleteIds', index, column: t, part, position }),
      );
      const table = u.table('edges');
      const conditions = columnsToMatch.map((c) =>
        this.dialect.boundIdIn(u.ident(c), ids, table, edges.id),
      );
      return u.finish(`DELETE FROM ${table} WHERE ${conditions.join(' OR ')}`, { updates: true });
    };
    if (t.kind !== 'node') {
      steps.push(deleteEdges('relationships', [edges.id]));
    }
    if (detach && t.kind !== 'relationship') {
      steps.push(deleteEdges('nodes', [edges.startId, edges.endId]));
    }
    return steps;
  }

  /**
   * After a DELETE clause ran for every row: its nodes that no longer have
   * relationships are deleted, so that later clauses no longer see them.
   */
  private deleteFreeNodes(): PlanStep {
    const { nodes, edges } = this.mapping;
    const u = new SqlBuilder(this.dialect, this.mapping);
    const ids = this.dialect.jsonInput(u.bind({ kind: 'deletedNodes' }));
    const nodeTable = u.table('nodes');
    const id = `${nodeTable}.${u.ident(nodes.id)}`;
    // RETURNING: the runner forgets the deleted ids, so that a new entity that
    // gets one of them again (SQLite reuses the largest id) is not deleted later.
    return u.finish(
      `DELETE FROM ${nodeTable} WHERE ${this.dialect.boundIdIn(id, ids, nodeTable, nodes.id)} ` +
        `AND NOT EXISTS (SELECT 1 FROM ${u.table('edges')} AS e WHERE e.${u.ident(edges.startId)} = ${id} ` +
        `OR e.${u.ident(edges.endId)} = ${id}) RETURNING ${id} AS id`,
      { updates: true, afterClause: true, forgetsDeleted: true },
    );
  }

  /**
   * The node deletions of DELETE, after every row: fails when a deleted node
   * still has relationships (`DeleteConnectedNode`), then deletes the nodes.
   */
  private deleteNodes(): PlanStep[] {
    const { nodes, edges } = this.mapping;
    const check = new SqlBuilder(this.dialect, this.mapping);
    const ids = this.dialect.jsonInput(check.bind({ kind: 'deletedNodes' }));
    const edgeTable = check.table('edges');
    const nodeTable = check.table('nodes');
    const connected =
      `EXISTS (SELECT 1 FROM ${edgeTable} WHERE ` +
      `${this.dialect.boundIdIn(check.ident(edges.startId), ids, nodeTable, nodes.id)} OR ` +
      `${this.dialect.boundIdIn(check.ident(edges.endId), ids, nodeTable, nodes.id)})`;
    const raise = check.raise(
      {
        kind: 'constraint',
        code: 'DeleteConnectedNode',
        message: 'Cannot delete a node that still has relationships; use DETACH DELETE',
        position: undefined,
      },
      'integer',
    );
    const remove = new SqlBuilder(this.dialect, this.mapping);
    const removeIds = this.dialect.jsonInput(remove.bind({ kind: 'deletedNodes' }));
    return [
      check.finish(`SELECT (CASE WHEN ${connected} THEN ${raise} ELSE 1 END) AS ok`, {
        afterRows: true,
      }),
      remove.finish(
        `DELETE FROM ${remove.table('nodes')} WHERE ` +
          this.dialect.boundIdIn(
            remove.ident(nodes.id),
            removeIds,
            remove.table('nodes'),
            nodes.id,
          ),
        { afterRows: true, updates: true },
      ),
    ];
  }

  private checkRelationship(rel: ast.RelationshipPattern, merging: boolean): void {
    const clause = merging ? 'MERGE' : 'CREATE';
    if (rel.types.length !== 1) {
      throw new SemanticError(`A relationship in ${clause} must have exactly one type`, {
        position: rel.position,
      });
    }
    if (rel.direction === 'both' && !merging) {
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
    merging = false,
  ): BindValue {
    // Declared types are checked when the values are known, at run time.
    const types = this.mapping[kind].propertyTypes;
    if (!expr) {
      return { kind: 'properties', entries: [], types };
    }
    if (expr.type === 'Parameter') {
      if (merging) {
        throw new SemanticError('MERGE cannot take its properties from a parameter map', {
          position: expr.position,
          hint: 'Write the properties as a map: MERGE (n {key: $value}).',
        });
      }
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
      ...(merging ? { noNulls: true } : {}),
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
