import type * as ast from '../ast.js';

/**
 * A copy of `expr` with each direct child expression replaced by `f(child, local)`.
 * `local` lists the variables that the expression binds for that child: the
 * element of a list comprehension or quantifier in its WHERE and projection, and
 * the variables of the pattern of an EXISTS or pattern comprehension in its
 * property maps, WHERE, and projection. Inside such a child those names may not
 * mean what they mean outside. It is empty for every other child.
 *
 * `EXISTS { query }` is opaque: its clauses are not children.
 */
export function mapChildren(
  expr: ast.Expression,
  f: (child: ast.Expression, local: readonly string[]) => ast.Expression,
): ast.Expression {
  const none: readonly string[] = [];
  const outer = (child: ast.Expression): ast.Expression => f(child, none);
  const optional = (
    child: ast.Expression | undefined,
    local: readonly string[],
  ): ast.Expression | undefined => (child === undefined ? undefined : f(child, local));
  const parts = (pattern: ast.PatternPart[], local: readonly string[]): ast.PatternPart[] =>
    pattern.map((part) => ({
      ...part,
      elements: part.elements.map((e) => ({ ...e, properties: optional(e.properties, local) })),
    }));
  switch (expr.type) {
    case 'List':
      return { ...expr, items: expr.items.map(outer) };
    case 'Map':
      return {
        ...expr,
        entries: expr.entries.map((e) => ({ key: e.key, value: outer(e.value) })),
      };
    case 'PropertyAccess':
    case 'HasLabels':
      return { ...expr, subject: outer(expr.subject) };
    case 'Binary':
      return { ...expr, left: outer(expr.left), right: outer(expr.right) };
    case 'FunctionCall':
      return { ...expr, args: expr.args.map(outer) };
    case 'Not':
    case 'Negate':
    case 'IsNull':
      return { ...expr, operand: outer(expr.operand) };
    case 'Index':
      return { ...expr, subject: outer(expr.subject), index: outer(expr.index) };
    case 'Slice':
      return {
        ...expr,
        subject: outer(expr.subject),
        from: optional(expr.from, none),
        to: optional(expr.to, none),
      };
    case 'ListComprehension':
      return {
        ...expr,
        list: outer(expr.list),
        where: optional(expr.where, [expr.variable]),
        projection: optional(expr.projection, [expr.variable]),
      };
    case 'Quantifier':
      return {
        ...expr,
        list: outer(expr.list),
        where: optional(expr.where, [expr.variable]),
      };
    case 'Case':
      return {
        ...expr,
        subject: optional(expr.subject, none),
        alternatives: expr.alternatives.map((a) => ({ when: outer(a.when), then: outer(a.then) })),
        otherwise: optional(expr.otherwise, none),
      };
    case 'PatternPredicate':
      // Every variable of a pattern predicate is bound outside it.
      return { ...expr, pattern: parts([expr.pattern], none)[0]! };
    case 'PatternComprehension': {
      const local = patternVariables([expr.pattern]);
      return {
        ...expr,
        pattern: parts([expr.pattern], local)[0]!,
        where: optional(expr.where, local),
        projection: f(expr.projection, local),
      };
    }
    case 'Exists': {
      if (!expr.pattern) {
        return expr;
      }
      const local = patternVariables(expr.pattern);
      return { ...expr, pattern: parts(expr.pattern, local), where: optional(expr.where, local) };
    }
    default:
      return expr;
  }
}

/** The direct child expressions of `expr`, with the variables each is in the scope of (see `mapChildren`). */
export function children(
  expr: ast.Expression,
): { child: ast.Expression; local: readonly string[] }[] {
  const found: { child: ast.Expression; local: readonly string[] }[] = [];
  mapChildren(expr, (child, local) => {
    found.push({ child, local });
    return child;
  });
  return found;
}

/** The variables named in a pattern: path, node, and relationship variables. */
export function patternVariables(pattern: ast.PatternPart[]): string[] {
  const names = pattern.flatMap((part) => [
    part.variable,
    ...part.elements.map((element) => element.variable),
  ]);
  return [...new Set(names.filter((name) => name !== undefined))];
}
