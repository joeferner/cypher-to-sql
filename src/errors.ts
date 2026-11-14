/** A location in the Cypher source text. `line` is 1-based, `column` is 0-based. */
export interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}

export interface CypherErrorOptions {
  position?: SourcePosition | undefined;
  hint?: string | undefined;
}

/** Base class for every error the library raises on purpose. */
export abstract class CypherError extends Error {
  public readonly position: SourcePosition | undefined;
  public readonly hint: string | undefined;

  public constructor(message: string, options: CypherErrorOptions = {}) {
    super(formatMessage(message, options.position));
    this.name = new.target.name;
    this.position = options.position;
    this.hint = options.hint;
  }
}

/** The query text does not match the openCypher grammar. */
export class CypherSyntaxError extends CypherError {}

/** The query parses, but uses a construct this library does not support (yet). */
export class UnsupportedFeatureError extends CypherError {}

/** The query is well formed but not meaningful (for example, an undefined variable). */
export class SemanticError extends CypherError {}

export interface RuntimeErrorOptions extends CypherErrorOptions {
  /** openCypher's detail code, for example `InvalidArgumentType`. */
  code: string;
}

/**
 * A value of the wrong type, found while the query ran (for example
 * `WHERE n.name` when `name` is a string). Types known when the query is
 * compiled give a `SemanticError` instead.
 */
export class CypherTypeError extends CypherError {
  public readonly code: string;

  public constructor(message: string, options: RuntimeErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}

/**
 * An argument with a value the operation cannot take, found while the query
 * ran: integer overflow, integer division by zero, `range()` with step 0.
 */
export class CypherArgumentError extends CypherError {
  public readonly code: string;

  public constructor(message: string, options: RuntimeErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}

/**
 * A write that would leave the graph inconsistent, found while the query ran:
 * deleting a node that still has relationships without DETACH
 * (`DeleteConnectedNode`).
 */
export class CypherConstraintError extends CypherError {
  public readonly code: string;

  public constructor(message: string, options: RuntimeErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}

/**
 * A read of an entity that is gone, found while the query ran: the properties
 * or labels of a node or relationship that an earlier DELETE in the query
 * deleted (`DeletedEntityAccess`).
 */
export class EntityNotFoundError extends CypherError {
  public readonly code: string;

  public constructor(message: string, options: RuntimeErrorOptions) {
    super(message, options);
    this.code = options.code;
  }
}

/** The graph mapping is invalid. */
export class MappingError extends CypherError {}

/** A configured limit was exceeded while planning or running a query. */
export class LimitExceededError extends CypherError {}

/** A write clause was used on a graph (or plan) that is read-only. */
export class ReadOnlyViolationError extends CypherError {}

function formatMessage(message: string, position: SourcePosition | undefined): string {
  return position ? `${message} (line ${position.line}, column ${position.column})` : message;
}
