// Cypher values as returned to callers.
//
// Cypher distinguishes INTEGER (64-bit) from FLOAT, so integers are `bigint` and
// floats are `number`. `1n` and `1.0` are different values, as they are in Cypher.

export type CypherValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | CypherValue[]
  | CypherMap
  | CypherNode
  | CypherRelationship
  | CypherPath;

export interface CypherMap {
  [key: string]: CypherValue;
}

export class CypherNode {
  public constructor(
    /** Internal id from the node table, as a string. */
    public readonly id: string,
    public readonly labels: string[],
    public readonly properties: CypherMap,
  ) {}
}

export class CypherRelationship {
  public constructor(
    /** Internal id from the edge table, as a string. */
    public readonly id: string,
    public readonly type: string,
    public readonly startNodeId: string,
    public readonly endNodeId: string,
    public readonly properties: CypherMap,
  ) {}
}

export class CypherPath {
  public constructor(
    /** `nodes.length === relationships.length + 1` */
    public readonly nodes: CypherNode[],
    public readonly relationships: CypherRelationship[],
  ) {}
}

export function isCypherMap(value: CypherValue): value is CypherMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof CypherNode) &&
    !(value instanceof CypherRelationship) &&
    !(value instanceof CypherPath)
  );
}
