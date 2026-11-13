import type * as ast from '../ast.js';

/**
 * A copy of `expr` with each direct child expression replaced by `f(child, local)`.
 * `local` is the variable that a list comprehension or quantifier binds for that
 * child (its WHERE and projection), and undefined for every other child: inside
 * such a child, `local` names the list element, not anything outside.
 */
export function mapChildren(
  expr: ast.Expression,
  f: (child: ast.Expression, local: string | undefined) => ast.Expression,
): ast.Expression {
  const outer = (child: ast.Expression): ast.Expression => f(child, undefined);
  const optional = (
    child: ast.Expression | undefined,
    local: string | undefined,
  ): ast.Expression | undefined => (child === undefined ? undefined : f(child, local));
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
        from: optional(expr.from, undefined),
        to: optional(expr.to, undefined),
      };
    case 'ListComprehension':
      return {
        ...expr,
        list: outer(expr.list),
        where: optional(expr.where, expr.variable),
        projection: optional(expr.projection, expr.variable),
      };
    case 'Quantifier':
      return {
        ...expr,
        list: outer(expr.list),
        where: optional(expr.where, expr.variable),
      };
    default:
      return expr;
  }
}

/** The direct child expressions of `expr`, with the variable each is in the scope of (see `mapChildren`). */
export function children(
  expr: ast.Expression,
): { child: ast.Expression; local: string | undefined }[] {
  const found: { child: ast.Expression; local: string | undefined }[] = [];
  mapChildren(expr, (child, local) => {
    found.push({ child, local });
    return child;
  });
  return found;
}
