import type { SourcePosition } from './errors.js';

// Typed AST for the subset of openCypher the library understands. Constructs the
// parser recognizes but the library does not support yet are kept as
// `UnsupportedClause` / `UnsupportedExpression` nodes, so that later stages (the
// read-only gate in particular) can still see them and report a precise error.

interface Node {
  position: SourcePosition;
}

export interface Query extends Node {
  type: 'Query';
  clauses: Clause[];
}

export type Clause =
  MatchClause | UnwindClause | WithClause | CreateClause | ReturnClause | UnsupportedClause;

/** Clauses that read rows (they come before any updating clause in a query part). */
export type ReadingClause = MatchClause | UnwindClause;

/** Clauses that produce the rows a RETURN or CREATE works on. */
export type RowClause = ReadingClause | WithClause;

/**
 * `WITH`: a projection like RETURN that ends a query part. Only the projected
 * names are visible after it. `where` filters the projected rows.
 */
export interface WithClause extends Omit<ReturnClause, 'type'> {
  type: 'With';
  where: Expression | undefined;
}

export interface UnwindClause extends Node {
  type: 'Unwind';
  expression: Expression;
  variable: string;
}

export interface MatchClause extends Node {
  type: 'Match';
  optional: boolean;
  pattern: PatternPart[];
  where: Expression | undefined;
}

export interface CreateClause extends Node {
  type: 'Create';
  pattern: PatternPart[];
}

export interface ReturnClause extends Node {
  type: 'Return';
  distinct: boolean;
  /** `RETURN *` */
  star: boolean;
  items: ProjectionItem[];
  orderBy: SortItem[];
  skip: Expression | undefined;
  limit: Expression | undefined;
}

export interface UnsupportedClause extends Node {
  type: 'UnsupportedClause';
  /** Clause keyword as written in Cypher, upper case (for example `MERGE`). */
  name: string;
  /** True for clauses that modify the graph. */
  write: boolean;
}

export interface ProjectionItem extends Node {
  expression: Expression;
  /** Explicit `AS` alias, if any. */
  alias: string | undefined;
  /** Column name in the result: the alias, or the expression text as written. */
  name: string;
}

export interface SortItem extends Node {
  expression: Expression;
  descending: boolean;
}

export interface PatternPart extends Node {
  /** Path variable (`p = ...`), if any. */
  variable: string | undefined;
  /** Alternating node and relationship patterns, starting and ending with a node. */
  elements: PatternElement[];
  /** `shortestPath(...)` (`'one'`) or `allShortestPaths(...)` (`'all'`) around the pattern. */
  shortest: 'one' | 'all' | undefined;
}

export type PatternElement = NodePattern | RelationshipPattern;

export interface NodePattern extends Node {
  type: 'NodePattern';
  variable: string | undefined;
  labels: string[];
  properties: Expression | undefined;
}

export type RelationshipDirection = 'left' | 'right' | 'both';

export interface RelationshipPattern extends Node {
  type: 'RelationshipPattern';
  variable: string | undefined;
  types: string[];
  direction: RelationshipDirection;
  /** Variable-length range (`*1..3`). `undefined` for a fixed-length relationship. */
  range: { min: number | undefined; max: number | undefined } | undefined;
  properties: Expression | undefined;
}

export type Expression =
  | Literal
  | ListExpression
  | MapExpression
  | Parameter
  | Variable
  | PropertyAccess
  | BinaryExpression
  | NotExpression
  | NegateExpression
  | IsNullExpression
  | HasLabelsExpression
  | FunctionCall
  | CountStar
  | UnsupportedExpression;

/** `count(*)` */
export interface CountStar extends Node {
  type: 'CountStar';
}

/** `name(args)`, `ns.name(args)`, `name(DISTINCT args)`. */
export interface FunctionCall extends Node {
  type: 'FunctionCall';
  /** As written, with the namespace (`ns.name`). Function names are case-insensitive. */
  name: string;
  distinct: boolean;
  args: Expression[];
}

export type BooleanOperator = 'OR' | 'XOR' | 'AND';
export type ComparisonOperator = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type ArithmeticOperator = '+' | '-' | '*' | '/' | '%' | '^';
export type StringOperator = 'STARTS WITH' | 'ENDS WITH' | 'CONTAINS';

/**
 * A binary operator. A comparison chain `a < b < c` is parsed as
 * `a < b AND b < c`, as openCypher defines it.
 */
export interface BinaryExpression extends Node {
  type: 'Binary';
  operator: BooleanOperator | ComparisonOperator | ArithmeticOperator | StringOperator | 'IN';
  left: Expression;
  right: Expression;
}

export interface NotExpression extends Node {
  type: 'Not';
  operand: Expression;
}

/** Unary minus (a minus in front of a number literal is folded into the literal). */
export interface NegateExpression extends Node {
  type: 'Negate';
  operand: Expression;
}

export interface IsNullExpression extends Node {
  type: 'IsNull';
  operand: Expression;
  /** `IS NOT NULL` */
  negated: boolean;
}

/** Label predicate `n:A:B`. */
export interface HasLabelsExpression extends Node {
  type: 'HasLabels';
  subject: Expression;
  labels: string[];
}

export interface Literal extends Node {
  type: 'Literal';
  /** Integers are `bigint`, floats are `number`. */
  value: string | bigint | number | boolean | null;
}

export interface ListExpression extends Node {
  type: 'List';
  items: Expression[];
}

export interface MapExpression extends Node {
  type: 'Map';
  entries: { key: string; value: Expression }[];
}

export interface Parameter extends Node {
  type: 'Parameter';
  name: string;
}

export interface Variable extends Node {
  type: 'Variable';
  name: string;
}

export interface PropertyAccess extends Node {
  type: 'PropertyAccess';
  subject: Expression;
  key: string;
}

export interface UnsupportedExpression extends Node {
  type: 'UnsupportedExpression';
  /** Short description of the construct, for example `CASE expression`. */
  description: string;
}
