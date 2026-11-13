// The differential query corpus: hand-written queries, each run on the graph
// of its group. Results compare in order when the final RETURN has ORDER BY;
// queries keep their results deterministic (full sort keys, no collect() over
// unordered rows).

import type { CypherValue } from '../src/index.js';
import { GRAPHS } from '../bench/graphs.js';
import type { GraphSource } from './engines.js';

export interface DiffQuery {
  cypher: string;
  params?: Record<string, CypherValue>;
  /**
   * Why this library is expected to differ from the reference engines here
   * (a deliberate difference, or a known bug with its issue); a difference is
   * then reported but does not fail the run.
   */
  known?: string;
}

export interface DiffGroup {
  graph: string;
  source: GraphSource;
  /** Also run with the mapping that declares `name` and `age` (bench/load.ts). */
  declared?: boolean;
  queries: DiffQuery[];
}

/** Edge cases: nulls, mixed types, several labels, a self-loop, parallel relationships. */
const EDGE_CASES = `
CREATE (a:A {name: 'a', n: 1, f: 1.5, s: 'Hello', l: [1, 2, 3], b: true}),
       (b:A:B {name: 'b', n: -3, f: -0.5, s: 'world', l: [], b: false}),
       (c:B {name: 'c', n: 0, s: '', l: ['x', 'y']}),
       (d:C {name: 'd', f: 2.0, s: 'ÄÖü 😀'}),
       (e:D {name: 'e'}),
       (a)-[:R {w: 1}]->(b), (a)-[:R {w: 2}]->(b), (b)-[:R {w: 3}]->(c),
       (c)-[:S]->(a), (c)-[:R {w: 1}]->(c), (d)-[:S {w: 1.5}]->(a)`;

const q = (cypher: string, params?: Record<string, CypherValue>): DiffQuery =>
  params ? { cypher, params } : { cypher };

export const CORPUS: DiffGroup[] = [
  {
    graph: 'edge_cases',
    source: { create: EDGE_CASES },
    queries: [
      // Matching
      q('MATCH (n) RETURN n'),
      q('MATCH (n:A) RETURN n.name AS name'),
      q('MATCH (n:A:B) RETURN n.name AS name'),
      q('MATCH (n) WHERE n:B RETURN n.name AS name'),
      q('MATCH (n) WHERE n.n > 0 RETURN n.name AS name'),
      q('MATCH (n) WHERE n.n IS NULL RETURN n.name AS name'),
      q('MATCH (n) WHERE n.n <> 1 RETURN n.name AS name'),
      q('MATCH (a)-[r]->(b) RETURN a.name AS a, type(r) AS t, r.w AS w, b.name AS b'),
      q('MATCH (a)-[r]-(b) RETURN a.name AS a, r.w AS w, b.name AS b'),
      q('MATCH (a)-[:R]->(a) RETURN a.name AS a'),
      q('MATCH (a)-[:R]->(b)-[:R]->(c) RETURN a.name AS a, b.name AS b, c.name AS c'),
      q('MATCH (a)-[r1]->(b)<-[r2]-(a) RETURN a.name AS a, r1.w AS w1, r2.w AS w2'),
      q("MATCH (a {name: 'a'}), (b {name: 'b'}) RETURN a.name AS a, b.name AS b"),
      q('MATCH (n) OPTIONAL MATCH (n)-[:S]->(m) RETURN n.name AS n, m.name AS m'),
      q("MATCH (n {name: 'e'}) OPTIONAL MATCH (n)-[r]->(m) RETURN n.name AS n, r, m"),

      // Variable-length and paths
      q("MATCH p = ({name: 'a'})-[*1..3]->(x) RETURN p"),
      q("MATCH ({name: 'a'})-[r*]->(x) RETURN x.name AS x, size(r) AS n"),
      q("MATCH ({name: 'd'})-[*]-(x) RETURN DISTINCT x.name AS x"),
      q("MATCH ({name: 'a'})-[:R*0..1]->(x) RETURN x.name AS x"),
      q("MATCH ({name: 'a'})-[*2]->(x) RETURN x.name AS x"),
      q("MATCH ({name: 'a'})-[:R* {w: 1}]->(x) RETURN x.name AS x"),
      q("MATCH (a {name: 'a'}), (d {name: 'd'}) MATCH p = shortestPath((a)-[*]-(d)) RETURN p"),
      q("MATCH (a {name: 'a'}), (c {name: 'c'}) MATCH p = allShortestPaths((a)-[*]->(c)) RETURN p"),
      q('MATCH p = (a)-[:S]->(b) RETURN nodes(p) AS n, relationships(p) AS r, length(p) AS l'),

      // Aggregation
      q(
        'MATCH (n) RETURN count(*) AS c, count(n.n) AS cn, sum(n.n) AS s, avg(n.n) AS a, ' +
          'min(n.f) AS mi, max(n.s) AS ma',
      ),
      q('MATCH (n) WITH n ORDER BY n.name RETURN collect(n.name) AS names'),
      q('MATCH (n) RETURN n.b AS b, count(*) AS c'),
      q('MATCH (n) RETURN count(DISTINCT n.b) AS c, collect(DISTINCT n.b IS NULL) AS d'),
      q(
        'MATCH (n) WHERE n.x = 1 RETURN count(*) AS c, sum(n.n) AS s, avg(n.n) AS a, max(n.n) AS m',
      ),
      q('MATCH (n) WITH n.b AS b, count(*) AS c WHERE c > 1 RETURN b, c'),
      q('MATCH (n) WITH DISTINCT n.b AS b RETURN b'),
      q('MATCH (a)-[r]->(b) RETURN a.name AS a, count(r) AS c, sum(r.w) AS w'),

      // Ordering and paging
      q('MATCH (n) RETURN n.name AS name ORDER BY n.n, name'),
      q('MATCH (n) RETURN n.name AS name ORDER BY n.n DESC, name'),
      q('MATCH (n) RETURN n.name AS name ORDER BY n.f, name'),
      q('MATCH (n) RETURN n.name AS name ORDER BY n.s DESC'),
      q('MATCH (n) RETURN n.name AS name ORDER BY name SKIP 1 LIMIT 2'),
      q('UNWIND [3, 1, null, 2] AS x RETURN x ORDER BY x'),
      q('UNWIND [3, 1, null, 2] AS x RETURN x ORDER BY x DESC'),
      q("UNWIND [1, 'a', null, 2.5, true, [1], {k: 1}] AS x RETURN x ORDER BY x"),

      // Properties and values
      q('MATCH (n) RETURN n.name AS name, n.n + 1 AS a, n.f * 2 AS b, n.n / 2 AS c, n.n % 2 AS d'),
      q(
        'MATCH (n) RETURN n.name AS name, n.s + "!" AS s, size(n.s) AS len, toUpper(n.s) AS u, ' +
          'toLower(n.s) AS l',
      ),
      q(
        'MATCH (n) RETURN n.name AS name, size(n.l) AS len, n.l[0] AS first, n.l[-1] AS last, ' +
          'n.l[1..] AS rest',
      ),
      q('MATCH (n) RETURN n.name AS name, labels(n) AS labels'),
      q('MATCH ()-[r]->() RETURN type(r) AS t, properties(r) AS p'),
      q("MATCH (n {name: 'a'}) RETURN properties(n) AS p"),
      q('MATCH (n) UNWIND n.l AS x RETURN n.name AS name, x'),
      q('MATCH (n) WHERE n.name IN $names RETURN n.name AS name', { names: ['a', 'c', 'z'] }),
      q('MATCH (n) WHERE n.n = $n RETURN n.name AS name', { n: 1n }),
      q('MATCH (n) WHERE n.n = $n RETURN n.name AS name', { n: 1.0 }),
      q('MATCH (n) WHERE n.f = $f RETURN n.name AS name', { f: 2n }),

      // Pattern expressions
      q('MATCH (n) WHERE (n)-[:R]->() RETURN n.name AS name'),
      q('MATCH (n) WHERE NOT (n)<--() RETURN n.name AS name'),
      q('MATCH (n) WHERE EXISTS { MATCH (n)-[:S]->(:A) } RETURN n.name AS name'),
      q(
        'MATCH (n) WHERE EXISTS { MATCH (n)-->(m) WITH m WHERE m.n > 0 MATCH (m)-->(o) } ' +
          'RETURN n.name AS name',
      ),
      q('MATCH (n) WHERE NOT EXISTS { UNWIND n.l AS x MATCH (m {n: x}) } RETURN n.name AS name'),
      q('MATCH (n) WHERE EXISTS { MATCH (n)-[:S]->(m:A) RETURN m } RETURN n.name AS name'),
      q('MATCH (n) WHERE EXISTS { (n)-[:S]->(:A) } RETURN n.name AS name'),
      q('MATCH (n) RETURN n.name AS name, size([(n)--() | 1]) AS degree'),
      q("MATCH (n {name: 'b'}) RETURN [(n)-[:R]->(m) | m.name] AS out"),
      // Map projections (a Neo4j extension)
      q('MATCH (n) RETURN n {.name, .n, x: 1} AS m'),
      q('MATCH (n) RETURN n {.*} AS m'),
      q("MATCH (n) RETURN n {.*, name: 'z', extra: n.n * 2, missing: null} AS m"),
      q("MATCH (n {name: 'a'})-[r]->(b) RETURN r {.w, type: type(r)} AS m, b {.name, b} AS bb"),
      q('MATCH (n) WITH n, n.name AS k RETURN n {k, .missing} AS m'),
      q("MATCH (n {name: 'e'}) OPTIONAL MATCH (n)-[r]->(m) RETURN m {.name} AS m, r {.*} AS r"),
      q('WITH {a: 1, b: [2]} AS map RETURN map {.a, .c, d: 3} AS m, map {.*, a: 0} AS n'),
      q('MATCH (n) RETURN n.b AS b, collect(n {.name})[0] AS first ORDER BY b'),
      q('MATCH (n) WITH n ORDER BY n.name RETURN collect(n {.name, .n}) AS l'),

      // Expressions without a graph
      q('RETURN 7 / 2 AS a, -7 / 2 AS b, 7 % -3 AS c, -7 % 3 AS d, 7.0 / 2 AS e, 2 ^ 3 AS f'),
      q(
        "RETURN 1 = 1.0 AS a, 'a' < 'b' AS b, null = null AS c, [1, 2] = [1, 2] AS d, " +
          "[1, null] = [1, null] AS e, 1 < 'a' AS f",
      ),
      q(
        "RETURN toInteger('42') AS a, toInteger('4.7') AS b, toFloat('1e3') AS c, " +
          "toString(1.5) AS d, toString(2.0) AS e, toBoolean('TRUE') AS f, toInteger(4.7) AS g",
      ),
      q(
        'RETURN round(2.5) AS a, round(-2.5) AS b, ceil(1.1) AS c, floor(-1.1) AS d, ' +
          'abs(-3) AS e, sign(-2.5) AS f, sqrt(16) AS g',
      ),
      q(
        "RETURN substring('hello', 1, 3) AS a, left('hello', 2) AS b, right('hello', 2) AS c, " +
          "replace('aXbX', 'X', '-') AS d, split('a,b,,c', ',') AS e, trim('  x  ') AS f, " +
          "reverse('abc') AS g",
      ),
      q(
        'RETURN range(1, 10, 3) AS a, range(5, 1, -2) AS b, head([1, 2]) AS c, ' +
          'last([1, 2]) AS d, tail([1, 2, 3]) AS e, reverse([1, 2, 3]) AS f, size([1, 2, 3]) AS g',
      ),
      q(
        'RETURN [x IN range(1, 5) WHERE x % 2 = 1 | x * 10] AS a, all(x IN [1, 2] WHERE x > 0) AS b, ' +
          'any(x IN [] WHERE x > 0) AS c, none(x IN [1, null] WHERE x > 1) AS d, ' +
          'single(x IN [1, 2] WHERE x > 1) AS e',
      ),
      q(
        "RETURN CASE WHEN 1 > 2 THEN 'a' WHEN null THEN 'b' ELSE 'c' END AS a, " +
          "CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' END AS b",
      ),
      q("RETURN 'abc' STARTS WITH 'a' AS a, 'abc' ENDS WITH 'bc' AS b, 'abc' CONTAINS 'd' AS c"),
      // Temporal values
      q(
        "RETURN date('2015-07-21') AS a, date({year: 1984, week: 10, dayOfWeek: 3}) AS b, " +
          "localtime('214032.142') AS c, time({hour: 12, timezone: '+02:05:59'}) AS d, " +
          "localdatetime('2015-W30-2T214032.142') AS e, " +
          "datetime('2015-07-21T21:40:32.142[Europe/London]') AS f, " +
          "datetime({year: 1818, month: 7, day: 21, hour: 21, timezone: 'Europe/Stockholm'}) AS g",
      ),
      q(
        "WITH date('1984-10-11') AS d, datetime('1984-10-11T12:31:14.645876123+01:00') AS t " +
          'RETURN d.year AS y, d.quarter AS q, d.week AS w, d.weekYear AS wy, d.ordinalDay AS o, ' +
          'd.dayOfWeek AS dw, t.hour AS h, t.nanosecond AS ns, t.millisecond AS ms, ' +
          't.offsetSeconds AS off, t.epochSeconds AS es, toString(t) AS s',
      ),
      q(
        "WITH datetime('1984-10-11T12:00+01:00') AS a, datetime('1984-10-11T11:30Z') AS b, " +
          "time('10:00+01:00') AS c, time('09:35Z') AS d " +
          'RETURN a < b AS ab, a = b AS eq, c < d AS cd, date(a) = date(b) AS dates',
      ),
      q(
        "UNWIND [date('2020-01-02'), date('2019-05-06'), date('2021-03-04')] AS d " +
          'RETURN d ORDER BY d',
      ),
      q(
        "WITH datetime({year: 1984, month: 10, day: 11, hour: 12, timezone: 'Europe/Stockholm'}) AS o " +
          "RETURN datetime({datetime: o, timezone: '+05:00'}) AS a, date({date: o, week: 1}) AS b, " +
          'localtime(o) AS c',
      ),
      q(
        'RETURN datetime.fromepoch(416779, 999999999) AS a, datetime.fromepochmillis(237821673987) AS b',
      ),
      q("RETURN date('2015-13-01') AS bad"),
      // Durations and temporal arithmetic
      q(
        "RETURN duration('P14DT16H12M') AS a, duration({months: 0.75}) AS b, duration({weeks: 2.5}) AS c, " +
          "duration({seconds: -60, milliseconds: -1}) AS d, duration('P2012-02-02T14:37:21.545') AS e",
      ),
      q(
        'WITH duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 2}) AS d, ' +
          "date('1984-10-11') AS a, datetime('1984-10-11T12:31:14.000000001+01:00') AS c UNWIND [1] AS one " +
          'RETURN a + d AS a1, a - d AS a2, c + d AS c1, d + d AS dd, d * 0.5 AS half, d / 2 AS div, ' +
          'd.days AS days, d.minutesOfHour AS moh, d = d AS same',
      ),
      q(
        "RETURN duration.between(date('1984-10-11'), datetime('2015-07-21T21:40:32.142+0100')) AS a, " +
          "duration.inMonths(date('1984-10-11'), date('2015-06-24')) AS b, " +
          "duration.inDays(localdatetime('2015-07-21T21:40:32.142'), date('2015-06-24')) AS c, " +
          "duration.inSeconds(datetime({year: 2017, month: 10, day: 29, hour: 0, timezone: 'Europe/Stockholm'}), " +
          'localdatetime({year: 2017, month: 10, day: 29, hour: 4})) AS d',
      ),
      q(
        "WITH datetime('1984-10-11T12:31:14.645876123+01:00') AS x UNWIND [1] AS one " +
          "RETURN date.truncate('weekYear', x) AS a, datetime.truncate('quarter', x) AS b, " +
          "datetime.truncate('year', x, {timezone: 'Europe/Stockholm'}) AS c, " +
          "localdatetime.truncate('millisecond', x, {nanosecond: 2}) AS d, " +
          "time.truncate('minute', x) AS e, date.truncate('week', x, {dayOfWeek: 2}) AS f",
      ),

      // Regular expressions (Java syntax, whole-string match)
      q(
        "RETURN 'abc' =~ 'a.*' AS a, 'abc' =~ 'b' AS b, 'ab' =~ 'a|ab' AS c, 'ABC' =~ '(?i)abc' AS d, " +
          "'a1_' =~ '\\\\w\\\\d\\\\w' AS e, 'x-y' =~ '[a-z]-[a-z]' AS f, '' =~ 'a*' AS g",
      ),
      q(
        "RETURN 'a\\nb' =~ 'a.b' AS a, 'a\\nb' =~ '(?s)a.b' AS b, 'a\\nb' =~ '(?m)a$.b' AS c, " +
          "'a\\nb' =~ '(?ms)a$.^b' AS d, 'ü😀' =~ '..' AS e, 'aaa' =~ 'a{2,3}' AS f",
      ),
      q("RETURN null =~ 'a' AS a, 'a' =~ null AS b, 'a' =~ $p AS c", { p: '[a]' }),
      q("UNWIND [1, 'a', true, null, [1]] AS x RETURN x =~ 'a' AS r"),
      q("RETURN 'a+' =~ 'a\\\\+' AS a, 'a-' =~ 'a\\\\-' AS b, 'a.b' =~ 'a\\\\.b' AS c"),
      q("MATCH (n) WHERE n.s =~ '(?i)[hw].*' RETURN n.name AS name"),
      q('MATCH (n) WHERE n.name =~ $p RETURN n.name AS name', { p: '[a-c]' }),
      q("MATCH (n) RETURN n.name AS name, n.s =~ '.*l.*' AS l"),
      q("RETURN 'a' =~ '(' AS a"),
      q(
        'RETURN coalesce(null, 1) AS a, null + 1 AS b, null IS NULL AS c, NOT null AS d, ' +
          'true XOR null AS e, false AND null AS f, true OR null AS g',
      ),
      q('RETURN [1, 2, 3][5] AS a, [1, 2, 3][-5] AS b, [1, 2, 3][1..-1] AS c, [1, 2] + 3 AS d'),
      q('RETURN $p AS p, $p + 1 AS q, $f * 2 AS f', { p: 5n, f: 1.25 }),
      q('UNWIND [[1, 2], [3]] AS l UNWIND l AS x RETURN x'),
      q('UNWIND [1, 1, 2] AS x RETURN DISTINCT x'),
      q('WITH 1 AS x, 2 AS y RETURN x + y AS z'),
      q('RETURN 9223372036854775807 + 1 AS overflow'),
      q('RETURN 1 / 0 AS a'),
      q(
        "RETURN 1 + 'a' AS a, 'a' + 1.5 AS b, 'a' + 2.0 AS c, 'a' + (0.1 + 0.2) AS d, " +
          "-3 + 'a' AS e, 'a' + 1e20 AS f, 'a' + 1e-7 AS g, 'a' + 123456789.0 AS h",
      ),
      q('MATCH (n) RETURN n.name + n.n AS a, n.f + n.s AS b, n.n + n.f AS c'),
      q("MATCH (n) RETURN n.name + 1 AS a, 2.5 + n.name AS b, n.l + 'x' AS c"),
      q("RETURN 'a' + true AS a, false + 'a' AS b"),
      q(
        'RETURN toString(0.001) AS a, toString(0.0009) AS b, toString(9999999.0) AS c, ' +
          'toString(10000000.0) AS d, toString(-1.5e-10) AS e, toString(1.7976931348623157e308) AS f, ' +
          'toString(2.5e-300) AS g, toString(100.0) AS h, toString(0.1) AS i, toString(-2.0) AS j, ' +
          'toString(123.456) AS k, toString(1.0 / 3) AS l',
      ),
      q('RETURN toUpper(1) AS a'),
    ],
  },
  {
    graph: 'social',
    source: { generate: GRAPHS.find((g) => g.name === 'small')! },
    declared: true,
    queries: [
      q('MATCH (p:Person) RETURN count(*) AS c'),
      q('MATCH (p:Person {name: $a}) RETURN p', { a: 'p1' }),
      q('MATCH (p:Person) WHERE p.age > 75 RETURN count(*) AS n'),
      q('MATCH (p:Person) WHERE p.age IN [20, 30, 40] RETURN count(*) AS n'),
      q("MATCH (p:Person) WHERE p.name STARTS WITH 'p99' RETURN p.name AS name ORDER BY name"),
      q(
        'MATCH (p:Person) RETURN p.city AS city, count(*) AS n, avg(p.age) AS age, ' +
          'min(p.score) AS lo, max(p.score) AS hi ORDER BY city',
      ),
      q('MATCH (p:Person) RETURN sum(p.score) AS s, avg(p.score) AS a, sum(p.age) AS ages'),
      q('MATCH (p:Person) RETURN p.name AS name ORDER BY p.age DESC, p.name LIMIT 10'),
      q('MATCH (p:Person) RETURN p.age % 10 AS bucket, count(*) AS n ORDER BY bucket'),
      q(
        'MATCH (p:Person) WITH p ORDER BY p.score DESC, p.name LIMIT 5 ' +
          'RETURN p.name AS name, p.score AS score ORDER BY score DESC, name',
      ),
      q('MATCH (p:Person {name: $a})-[:KNOWS]->(f) RETURN f.name AS name', { a: 'p1' }),
      q('MATCH (p:Person {name: $a})-[:KNOWS]-(f) RETURN count(*) AS n', { a: 'p1' }),
      q('MATCH (p:Person {name: $a})-[:KNOWS]->()-[:KNOWS]->(f) RETURN count(DISTINCT f) AS n', {
        a: 'p1',
      }),
      q('MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(a) RETURN count(*) AS n'),
      q(
        'MATCH (p:Person)-[k:KNOWS]->(f:Person) WHERE k.since < 1995 AND f.age > p.age ' +
          'RETURN count(*) AS n',
      ),
      q(
        'MATCH (:Person)-[:WORKS_AT]->(c:Company) RETURN c.name AS c, count(*) AS n ' +
          'ORDER BY n DESC, c LIMIT 10',
      ),
      q(
        'MATCH (c:Company)<-[:WORKS_AT]-(p) WITH c, count(p) AS n ORDER BY n DESC, c.name LIMIT 3 ' +
          'RETURN c.name AS name, n ORDER BY n DESC, name',
      ),
      q(
        'MATCH (p:Person) WITH p.city AS city, avg(p.score) AS s WHERE s > 50 ' +
          'RETURN city, s ORDER BY city',
      ),
      q(
        'MATCH (p:Person {name: $a}) OPTIONAL MATCH (p)-[:KNOWS]->(f:Person {city: p.city}) ' +
          'RETURN count(f) AS n',
        { a: 'p1' },
      ),
      q('MATCH (p:Person) WHERE NOT (p)<-[:KNOWS]-() RETURN count(*) AS n'),
      q(
        'MATCH (a:Person {name: $a}) RETURN size([(a)-[:KNOWS]->(f) WHERE f.age > 50 | f.name]) AS n',
        { a: 'p1' },
      ),
      q('MATCH (p:Person {name: $a})-[:KNOWS*1..2]->(f) RETURN count(*) AS n', { a: 'p1' }),
      q('MATCH (p:Person {name: $a})-[:KNOWS*1..3]->(f) RETURN count(DISTINCT f) AS n', {
        a: 'p1',
      }),
      q('MATCH (p:Person {name: $a})-[:KNOWS*2]->(f) RETURN f.name AS name ORDER BY name', {
        a: 'p1',
      }),
      q(
        'MATCH (a:Person {name: $a}), (b:Person {name: $b}) ' +
          'MATCH p = shortestPath((a)-[:KNOWS*..10]-(b)) RETURN length(p) AS l',
        { a: 'p1', b: 'p450' },
      ),
      q(
        'MATCH (a:Person {name: $a}), (b:Person {name: $b}) ' +
          'MATCH p = shortestPath((a)-[:KNOWS*..10]->(b)) RETURN length(p) AS l',
        { a: 'p1', b: 'p40' },
      ),
    ],
  },
];
