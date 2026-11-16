# Values

`graph.query()` returns one object per record, keyed by column name. Each value is a `CypherValue`:

| Cypher                    | JavaScript                                                                   |
| ------------------------- | ---------------------------------------------------------------------------- |
| `null`                    | `null`                                                                       |
| boolean                   | `boolean`                                                                    |
| integer (64-bit)          | `bigint`, including `count()` and `id()`                                     |
| float                     | `number` (on PostgreSQL also `NaN` and the infinities)                       |
| string                    | `string`                                                                     |
| list                      | array                                                                        |
| map                       | plain object                                                                 |
| node                      | `CypherNode`: `id` (a string), `labels`, `properties`                        |
| relationship              | `CypherRelationship`: `id`, `type`, `startNodeId`, `endNodeId`, `properties` |
| path                      | `CypherPath`: `nodes`, `relationships`                                       |
| date, time, and date-time | `CypherTemporal`: `kind` and `text` (`2024-03-01`)                           |
| duration                  | `CypherDuration`: `text` (`P1D`)                                             |

Integers are `bigint` so that 64-bit values stay exact and `1` stays distinct from `1.0`, as in Cypher. Parameters take the same types, except nodes, relationships, and paths. A JavaScript `number` parameter is a float, unless it is written to a property [declared](schema.md#properties) as `integer`; anything else, such as a `Date`, is an [error](errors.md).

## Plain JSON

`JSON.stringify` throws on a `bigint`. `toJson` turns any value, or a whole result, into plain JSON for logs, HTTP responses, or an LLM prompt:

```ts
import { toJson } from 'cypher-to-sql';

const records = await graph.query('MATCH p = (a)-[r:KNOWS]->(b) RETURN a, r, p, count(*) AS c');
JSON.stringify(toJson(records));
```

| Value                       | JSON                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| integer                     | a number up to 2^53, a string beyond it (see `integers` below)                |
| float                       | a number; `NaN`, `Infinity`, and `-Infinity` as those strings                 |
| node                        | `{ "~id": "1", "~labels": ["P"], ...properties }`                             |
| relationship                | `{ "~id": "5", "~type": "KNOWS", "~start": "1", "~end": "2", ...properties }` |
| path                        | `{ "~nodes": [...], "~relationships": [...] }`                                |
| temporal value and duration | its Cypher text: `"2024-03-01"`, `"P1D"`                                      |

These `~` keys are [reserved](schema.md#data-rules) property keys, so they never clash with properties.

The `integers` option chooses how integers are written:

- `'number-if-safe'` (default): a number when it is within ±2^53, otherwise a string, so no precision is lost silently.
- `'string'`: always a string, for a consumer that wants one type.
- `'number'`: always a number; integers beyond 2^53 are rounded.

```ts
toJson(records, { integers: 'string' });
```
