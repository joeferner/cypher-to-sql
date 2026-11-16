# Errors

Every error the library raises on purpose extends `CypherError`:

| Property   | Type                                    | Content                                                                      |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `name`     | `string`                                | The class name, for example `'SemanticError'`.                               |
| `message`  | `string`                                | What is wrong, ending in `(line L, column C)` when the error has a position. |
| `position` | `{ line, column, offset } \| undefined` | Where in the Cypher text: `line` from 1, `column` and `offset` from 0.       |
| `hint`     | `string \| undefined`                   | A suggested fix, phrased so that a person or an LLM can apply it.            |
| `code`     | `string`                                | Only on the run-time errors (see below): openCypher's detail code.           |

Errors from the database driver that the library does not recognize (a lost connection, a statement timeout) pass through unchanged.

## Classes

| Class                     | Raised by          | When                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CypherSyntaxError`       | `compile`, `query` | The text does not parse as openCypher 9. The hint names a likely fix: a misspelled keyword, a missing `RETURN`, an unclosed string, or a construct of other Cypher versions (`reduce()`, `CALL { }`, `COUNT { }`, `LOAD CSV`) and what to use instead. |
| `SemanticError`           | `compile`, `query` | The query parses but is not meaningful: an undefined variable, a type error the compiler can see (`'a' - 1`), an aggregate in WHERE, a missing parameter.                                                                                              |
| `UnsupportedFeatureError` | `compile`, `query` | Valid Cypher this library does not translate (yet), such as `stDev()` or a `SKIP` expression on MySQL. The hint often names a rewrite.                                                                                                                 |
| `ReadOnlyViolationError`  | `compile`, `query` | A write clause on a read-only graph.                                                                                                                                                                                                                   |
| `LimitExceededError`      | `compile`, `query` | A [limit](safe-execution.md#limits) was exceeded.                                                                                                                                                                                                      |
| `CypherTypeError`         | `query`            | A value had the wrong type while the query ran, for example `WHERE n.name` when `name` is a string, or a parameter that is not a Cypher value (a `Date`).                                                                                              |
| `CypherArgumentError`     | `query`            | A value an operation cannot take, found while the query ran: integer overflow, integer division by zero, `range()` with step 0, an invalid regular expression or date, a NaN parameter.                                                                |
| `CypherConstraintError`   | `query`            | A write that would leave the graph inconsistent: `DELETE` of a node that still has relationships, or a key that a unique index already has.                                                                                                            |
| `EntityNotFoundError`     | `query`            | A read of a node or relationship that an earlier `DELETE` in the same query deleted.                                                                                                                                                                   |
| `SchemaError`             | `migrate`          | The database's schema version is newer than the library's, existing rows share a key that a declared unique index needs to be unique (the message lists them), or an index was asked for that the mapping does not declare.                            |
| `MappingError`            | `createGraph`      | The mapping has an invalid name or property type.                                                                                                                                                                                                      |

The run-time errors (`CypherTypeError`, `CypherArgumentError`, `CypherConstraintError`, `EntityNotFoundError`) come from the data, so the same query can succeed on other data. Their `position` points at the expression that failed, where the database's error allows it. Codes:

| Code                          | Class                   | Example                                                                                                           |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `InvalidArgumentType`         | `CypherTypeError`       | `n.name * 2` with a string `name`; a `Date` as a parameter                                                        |
| `InvalidArgumentValue`        | `CypherTypeError`       | `toInteger(n.tags)` with a list `tags`                                                                            |
| `MapElementAccessByNonString` | `CypherTypeError`       | `$map[0]`                                                                                                         |
| `NumberOutOfRange`            | `CypherArgumentError`   | `9223372036854775807 + 1`, `range(1, 5, 0)`                                                                       |
| `DivisionByZero`              | `CypherArgumentError`   | `n.count / 0` with an integer `count`                                                                             |
| `InvalidRegex`                | `CypherArgumentError`   | `n.name =~ '('`                                                                                                   |
| `InvalidArgumentValue`        | `CypherArgumentError`   | `date('2020-13-01')`; NaN or infinity as a parameter                                                              |
| `DeleteConnectedNode`         | `CypherConstraintError` | `MATCH (n) DELETE n` when `n` has relationships (use `DETACH`)                                                    |
| `ConstraintValidationFailed`  | `CypherConstraintError` | `CREATE` of a key that a [unique index](schema.md#composite-and-unique-indexes) already has                       |
| `MissingEndpoint`             | `CypherConstraintError` | [`bulkWrite`](bulk.md#relationships) of a relationship whose end matches no node, with `missingEndpoint: 'error'` |
| `DeletedEntityAccess`         | `EntityNotFoundError`   | `MATCH (n) DETACH DELETE n RETURN n.name`                                                                         |

Parameters, and the rows that [procedures](../README.md#usage) return, must be Cypher values: `null`, booleans, `bigint` integers, finite numbers (floats), strings, arrays, plain objects, `CypherTemporal`, and `CypherDuration`. `undefined` is null. Anything else is an error that names the parameter or output, such as `Parameter $p.a[0] is NaN, which cannot be passed`.

Not errors, as in Cypher: comparing values of different types (`1 = 'a'` is false, `1 < 'a'` is null), any operation on null (null), and the `...OrNull` conversions (`toIntegerOrNull([1])` is null).

## Examples

| Query                                   | Error                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH (n) RETRUN n`                    | `CypherSyntaxError: Invalid Cypher: no viable alternative at input 'MATCH (n) RETRUN' (line 1, column 10)`, hint `Did you mean RETURN?`                                             |
| `RETURN reduce(s = 0, x IN l \| s + x)` | `CypherSyntaxError: ...`, hint `reduce() is not supported. For a sum or a product, UNWIND the list and aggregate (sum(x)); ...`                                                     |
| `MATCH (n) RETURN n, m`                 | ``SemanticError: Variable `m` not defined (line 1, column 20)``                                                                                                                     |
| `RETURN foo(1)`                         | `SemanticError: Unknown function foo() (line 1, column 7)`, hint `Supported functions: abs, acos, asin, ...`                                                                        |
| `MATCH (n) RETURN (n)-->()`             | `SemanticError: A pattern can be used as a condition only in WHERE (line 1, column 17)`, hint `Use EXISTS { (a)-->(b) } instead, or count the matches with size([(a)-->(b) \| 1]).` |
| `UNWIND range(1, 20000) AS i RETURN i`  | `LimitExceededError: The query returned more than 10000 records (maxResultRows)`, hint `Add LIMIT to the query.`                                                                    |
| `MATCH (n) WHERE n.name RETURN n`       | `CypherTypeError: Type mismatch: expected a boolean (line 1, column 17)`, code `InvalidArgumentType`                                                                                |
| `MATCH (n) RETURN n.count / 0`          | `CypherArgumentError: Division by zero (line 1, column 17)`, code `DivisionByZero`                                                                                                  |

## Retry loops

The messages and hints are written so that a generator can fix the query. A loop that feeds them back:

```ts
import { CypherError, MappingError, type CypherValue, type Graph } from 'cypher-to-sql';

async function queryWithRetries(
  graph: Graph,
  question: string,
  generate: (question: string, feedback?: string) => Promise<string>,
): Promise<Record<string, CypherValue>[]> {
  let cypher = await generate(question);
  for (let attempt = 1; ; attempt++) {
    try {
      return await graph.query(cypher);
    } catch (error) {
      // Only errors about the query itself can be fixed by changing it.
      if (!(error instanceof CypherError) || error instanceof MappingError || attempt === 3) {
        throw error;
      }
      const feedback = `${error.name}: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}`;
      cypher = await generate(question, `This query failed:\n${cypher}\n${feedback}`);
    }
  }
}
```

Use `graph.compile(cypher)` to check a generated query before running it: it raises every error except the run-time ones without touching the database.
