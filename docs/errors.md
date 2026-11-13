# Errors

Every error the library raises on purpose extends `CypherError`:

| Property   | Type                                    | Content                                                                        |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `name`     | `string`                                | The class name, for example `'SemanticError'`.                                 |
| `message`  | `string`                                | What is wrong, ending in `(line L, column C)` when the error has a position.   |
| `position` | `{ line, column, offset } \| undefined` | Where in the Cypher text: `line` from 1, `column` and `offset` from 0.         |
| `hint`     | `string \| undefined`                   | A suggested fix, phrased so that a person or an LLM can apply it.              |
| `code`     | `string`                                | Only on `CypherTypeError` and `CypherArgumentError`: openCypher's detail code. |

Errors from the database driver that the library does not recognize (a lost connection, a statement timeout) pass through unchanged.

## Classes

| Class                     | Raised by          | When                                                                                                                                                      |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CypherSyntaxError`       | `compile`, `query` | The text does not parse as Cypher.                                                                                                                        |
| `SemanticError`           | `compile`, `query` | The query parses but is not meaningful: an undefined variable, a type error the compiler can see (`'a' - 1`), an aggregate in WHERE, a missing parameter. |
| `UnsupportedFeatureError` | `compile`, `query` | Valid Cypher this library does not translate (yet), such as `MERGE` or temporal functions. The hint often names a rewrite.                                |
| `ReadOnlyViolationError`  | `compile`, `query` | A write clause on a read-only graph.                                                                                                                      |
| `LimitExceededError`      | `compile`, `query` | A [limit](safe-execution.md#limits) was exceeded.                                                                                                         |
| `CypherTypeError`         | `query`            | A value had the wrong type while the query ran, for example `WHERE n.name` when `name` is a string.                                                       |
| `CypherArgumentError`     | `query`            | A value an operation cannot take, found while the query ran: integer overflow, integer division by zero, `range()` with step 0.                           |
| `MappingError`            | `createGraph`      | The mapping has an invalid name or property type.                                                                                                         |

`CypherTypeError` and `CypherArgumentError` come from the data, so the same query can succeed on other data. Their `position` points at the expression that failed. Codes:

| Code                          | Class                 | Example                                     |
| ----------------------------- | --------------------- | ------------------------------------------- |
| `InvalidArgumentType`         | `CypherTypeError`     | `n.name + 1` with a string `name`           |
| `InvalidArgumentValue`        | `CypherTypeError`     | `toInteger(n.tags)` with a list `tags`      |
| `MapElementAccessByNonString` | `CypherTypeError`     | `$map[0]`                                   |
| `NumberOutOfRange`            | `CypherArgumentError` | `9223372036854775807 + 1`, `range(1, 5, 0)` |
| `DivisionByZero`              | `CypherArgumentError` | `n.count / 0` with an integer `count`       |

Not errors, as in Cypher: comparing values of different types (`1 = 'a'` is false, `1 < 'a'` is null), any operation on null (null), and the `...OrNull` conversions (`toIntegerOrNull([1])` is null).

## Examples

| Query                                  | Error                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH (n) RETURN n, m`                | ``SemanticError: Variable `m` not defined (line 1, column 20)``                                                                                                                     |
| `RETURN foo(1)`                        | `UnsupportedFeatureError: Function foo() is not supported (line 1, column 7)`, hint `Supported functions: abs, acos, asin, ...`                                                     |
| `MATCH (n) RETURN (n)-->()`            | `SemanticError: A pattern can be used as a condition only in WHERE (line 1, column 17)`, hint `Use EXISTS { (a)-->(b) } instead, or count the matches with size([(a)-->(b) \| 1]).` |
| `UNWIND range(1, 20000) AS i RETURN i` | `LimitExceededError: The query returned more than 10000 records (maxResultRows)`, hint `Add LIMIT to the query.`                                                                    |
| `MATCH (n) WHERE n.name RETURN n`      | `CypherTypeError: Type mismatch: expected a boolean (line 1, column 17)`, code `InvalidArgumentType`                                                                                |
| `MATCH (n) RETURN n.count / 0`         | `CypherArgumentError: Division by zero (line 1, column 17)`, code `DivisionByZero`                                                                                                  |

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
