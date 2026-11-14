// Procedures the caller registers with `createGraph({ procedures })`, called
// with `CALL name(args) YIELD ...`. The library has no built-in procedures.

import { CypherTypeError, SemanticError, type SourcePosition } from './errors.js';
import { isCypherMap, type CypherValue } from './values.js';

/** The type of a procedure input or output. Every type also accepts null. */
export type ProcedureType =
  'STRING' | 'INTEGER' | 'FLOAT' | 'NUMBER' | 'BOOLEAN' | 'LIST' | 'MAP' | 'ANY';

export interface ProcedureField {
  name: string;
  type: ProcedureType;
}

/**
 * A read-only procedure: rows computed from the arguments in TypeScript. It
 * cannot read or change the graph.
 */
export interface Procedure {
  inputs: ProcedureField[];
  /** No outputs makes a void procedure: it leaves the rows of the query as they are. */
  outputs: ProcedureField[];
  /**
   * The rows for one call. Arguments come by input name, already checked
   * against the input types (an integer for a FLOAT input is converted). A
   * missing output in a row is null.
   */
  call(args: Record<string, CypherValue>): Record<string, CypherValue>[];
}

/** Procedures by name as called, with the namespace (`my.proc`). Names are case-sensitive. */
export type Procedures = Record<string, Procedure>;

/** Whether `value` may be passed as an argument of `type`. */
export function acceptsValue(type: ProcedureType, value: CypherValue): boolean {
  if (value === null) {
    return true;
  }
  switch (type) {
    case 'STRING':
      return typeof value === 'string';
    case 'INTEGER':
      return typeof value === 'bigint';
    case 'FLOAT':
    case 'NUMBER':
      return typeof value === 'bigint' || typeof value === 'number';
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'LIST':
      return Array.isArray(value);
    case 'MAP':
      return isCypherMap(value);
    case 'ANY':
      return true;
  }
}

/** Looks up a procedure; an unknown name is a `SemanticError` (ProcedureNotFound). */
export function findProcedure(
  procedures: Procedures,
  name: string,
  position: SourcePosition,
): Procedure {
  const procedure = Object.hasOwn(procedures, name) ? procedures[name] : undefined;
  if (!procedure) {
    throw new SemanticError(`There is no procedure \`${name}\``, {
      position,
      hint: 'Register it with createGraph({ procedures: { ... } }).',
    });
  }
  return procedure;
}

/**
 * Calls a procedure: checks and converts the arguments, then returns its rows
 * as lists of the output values, in the order of the outputs.
 */
export function runProcedure(
  name: string,
  procedure: Procedure,
  values: CypherValue[],
  position: SourcePosition,
): CypherValue[][] {
  const args: Record<string, CypherValue> = {};
  procedure.inputs.forEach((input, i) => {
    const value = values[i] ?? null;
    if (!acceptsValue(input.type, value)) {
      throw new CypherTypeError(
        `Type mismatch: argument \`${input.name}\` of ${name}() must be ${input.type}`,
        { code: 'InvalidArgumentType', position },
      );
    }
    args[input.name] = input.type === 'FLOAT' && typeof value === 'bigint' ? Number(value) : value;
  });
  return procedure
    .call(args)
    .map((row) => procedure.outputs.map((output) => row[output.name] ?? null));
}
