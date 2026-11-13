import {
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  ParserRuleContext,
  PredictionMode,
  type ATNSimulator,
  type RecognitionException,
  type Recognizer,
  type Token,
} from 'antlr4ng';
import type * as ast from '../ast.js';
import { CypherSyntaxError, UnsupportedFeatureError, type SourcePosition } from '../errors.js';
import { CypherLexer } from './generated/CypherLexer.js';
import {
  CypherParser,
  OC_ExpressionContext,
  OC_ListOperatorExpressionContext,
  OC_ListPredicateExpressionContext,
  OC_PropertyLookupContext,
  type OC_FilterExpressionContext,
  type OC_RelationshipsPatternContext,
  OC_MultiplyDivideModuloExpressionContext,
  OC_NullPredicateExpressionContext,
  OC_PowerOfExpressionContext,
  OC_StringPredicateExpressionContext,
  OC_UnaryAddOrSubtractExpressionContext,
  type OC_AddOrSubtractExpressionContext,
  type OC_AndExpressionContext,
  type OC_AtomContext,
  type OC_ComparisonExpressionContext,
  type OC_CreateContext,
  type OC_NotExpressionContext,
  type OC_OrExpressionContext,
  type OC_StringListNullPredicateExpressionContext,
  type OC_XorExpressionContext,
  type OC_IntegerLiteralContext,
  type OC_LiteralContext,
  type OC_MapLiteralContext,
  type OC_MapProjectionContext,
  type OC_MatchContext,
  type OC_MultiPartQueryContext,
  type OC_NodeLabelsContext,
  type OC_NodePatternContext,
  type OC_PatternContext,
  type OC_PatternElementContext,
  type OC_PatternPartContext,
  type OC_ProjectionBodyContext,
  type OC_PropertiesContext,
  type OC_PropertyExpressionContext,
  OC_ReadingClauseContext,
  type OC_RemoveContext,
  type OC_SetContext,
  type OC_RelationshipPatternContext,
  type OC_SchemaNameContext,
  type OC_SinglePartQueryContext,
  type OC_SymbolicNameContext,
  OC_UpdatingClauseContext,
  OC_WithContext,
} from './generated/CypherParser.js';

const MAX_INT64 = 2n ** 63n - 1n;

/** Parses Cypher text into the library's AST. Throws `CypherSyntaxError` for invalid text. */
export function parse(cypher: string): ast.Query {
  const lexer = new CypherLexer(CharStream.fromString(cypher));
  const parser = new CypherParser(new CommonTokenStream(lexer));
  const errors = new ThrowingErrorListener();
  lexer.removeErrorListeners();
  lexer.addErrorListener(errors);
  parser.removeErrorListeners();
  parser.addErrorListener(errors);
  parser.interpreter.predictionMode = PredictionMode.LL;

  const tree = parser.oC_Cypher();
  const query = tree.oC_Statement().oC_Query();
  const regular = query.oC_RegularQuery();
  if (!regular) {
    throw new UnsupportedFeatureError('Procedure calls (CALL) are not supported', {
      position: pos(query),
    });
  }
  if (regular.oC_Union().length > 0) {
    throw new UnsupportedFeatureError('UNION is not supported yet', {
      position: pos(regular.oC_Union(0)!),
    });
  }
  return new AstBuilder(cypher).query(regular.oC_SingleQuery());
}

class ThrowingErrorListener extends BaseErrorListener {
  public override syntaxError<S extends Token, T extends ATNSimulator>(
    _recognizer: Recognizer<T>,
    offendingSymbol: S | null,
    line: number,
    column: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    throw new CypherSyntaxError(`Invalid Cypher: ${msg}`, {
      position: { line, column, offset: offendingSymbol?.start ?? -1 },
    });
  }
}

function pos(ctx: ParserRuleContext): SourcePosition {
  const token = ctx.start;
  return { line: token?.line ?? 0, column: token?.column ?? 0, offset: token?.start ?? 0 };
}

class AstBuilder {
  public constructor(private readonly source: string) {}

  public query(
    ctx: {
      oC_SinglePartQuery(): OC_SinglePartQueryContext | null;
      oC_MultiPartQuery(): OC_MultiPartQueryContext | null;
    } & ParserRuleContext,
  ): ast.Query {
    const clauses: ast.Clause[] = [];
    let single = ctx.oC_SinglePartQuery();
    if (!single) {
      // Query parts ending in WITH, in order, then the last part.
      const multi = ctx.oC_MultiPartQuery()!;
      for (const child of multi.children) {
        if (child instanceof OC_ReadingClauseContext) {
          clauses.push(this.readingClause(child));
        } else if (child instanceof OC_UpdatingClauseContext) {
          clauses.push(this.updatingClause(child));
        } else if (child instanceof OC_WithContext) {
          clauses.push(this.withClause(child));
        }
      }
      single = multi.oC_SinglePartQuery();
    }
    for (const reading of single.oC_ReadingClause()) {
      clauses.push(this.readingClause(reading));
    }
    for (const updating of single.oC_UpdatingClause()) {
      clauses.push(this.updatingClause(updating));
    }
    const ret = single.oC_Return();
    if (ret) {
      clauses.push(this.returnClause(ret.oC_ProjectionBody(), ret));
    }
    return { type: 'Query', position: pos(ctx), clauses };
  }

  private withClause(ctx: OC_WithContext): ast.WithClause {
    const where = ctx.oC_Where();
    return {
      ...this.returnClause(ctx.oC_ProjectionBody(), ctx),
      type: 'With',
      where: where ? this.expression(where.oC_Expression()) : undefined,
    };
  }

  private readingClause(ctx: OC_ReadingClauseContext): ast.Clause {
    const match = ctx.oC_Match();
    if (match) {
      return this.matchClause(match);
    }
    const unwind = ctx.oC_Unwind();
    if (unwind) {
      return {
        type: 'Unwind',
        position: pos(unwind),
        expression: this.expression(unwind.oC_Expression()),
        variable: this.symbolicName(unwind.oC_Variable().oC_SymbolicName()),
      };
    }
    return { type: 'UnsupportedClause', position: pos(ctx), name: 'CALL', write: false };
  }

  private updatingClause(ctx: OC_UpdatingClauseContext): ast.Clause {
    const create = ctx.oC_Create();
    if (create) {
      return this.createClause(create);
    }
    const set = ctx.oC_Set();
    if (set) {
      return this.setClause(set);
    }
    const remove = ctx.oC_Remove();
    if (remove) {
      return this.removeClause(remove);
    }
    const del = ctx.oC_Delete();
    if (del) {
      return {
        type: 'Delete',
        position: pos(del),
        detach: del.DETACH() !== null,
        expressions: del.oC_Expression().map((e) => this.expression(e)),
      };
    }
    const merge = ctx.oC_Merge()!;
    const actions = (onCreate: boolean): ast.SetItem[] =>
      merge
        .oC_MergeAction()
        .filter((a) => (a.CREATE() !== null) === onCreate)
        .flatMap((a) => this.setClause(a.oC_Set()!).items);
    return {
      type: 'Merge',
      position: pos(merge),
      pattern: this.patternPart(merge.oC_PatternPart()),
      onCreate: actions(true),
      onMatch: actions(false),
    };
  }

  private setClause(ctx: OC_SetContext): ast.SetClause {
    return {
      type: 'Set',
      position: pos(ctx),
      items: ctx.oC_SetItem().map((item): ast.SetItem => {
        const property = item.oC_PropertyExpression();
        const value = item.oC_Expression();
        if (property) {
          return { ...this.propertyTarget(property), value: this.expression(value!) };
        }
        const variable = this.symbolicName(item.oC_Variable()!.oC_SymbolicName());
        const labels = item.oC_NodeLabels();
        if (labels) {
          return { kind: 'labels', position: pos(item), variable, labels: this.nodeLabels(labels) };
        }
        return {
          kind: item.getText().includes('+=') ? 'merge' : 'replace',
          position: pos(item),
          variable,
          value: this.expression(value!),
        };
      }),
    };
  }

  private removeClause(ctx: OC_RemoveContext): ast.RemoveClause {
    return {
      type: 'Remove',
      position: pos(ctx),
      items: ctx.oC_RemoveItem().map((item) => {
        const property = item.oC_PropertyExpression();
        if (property) {
          return this.propertyTarget(property);
        }
        return {
          kind: 'labels' as const,
          position: pos(item),
          variable: this.symbolicName(item.oC_Variable()!.oC_SymbolicName()),
          labels: this.nodeLabels(item.oC_NodeLabels()),
        };
      }),
    };
  }

  /**
   * `n {.a, b: e, c, .*}` (a Neo4j extension) as the expressions it stands for:
   * `CASE WHEN n IS NULL THEN NULL ELSE {a: n.a, b: e, c: c} END`, with `.*`
   * the map is set over `properties(n)` (`MapProjection`). A later entry for a
   * key replaces an earlier one.
   */
  private mapProjection(ctx: OC_MapProjectionContext): ast.Expression {
    const position = pos(ctx);
    const subject: ast.Variable = {
      type: 'Variable',
      position: pos(ctx.oC_Variable()),
      name: this.symbolicName(ctx.oC_Variable().oC_SymbolicName()),
    };
    let all = false;
    const entries = new Map<string, ast.Expression>();
    for (const item of ctx.oC_MapProjectionItem()) {
      const lookup = item.oC_PropertyLookup();
      const key = item.oC_PropertyKeyName();
      const variable = item.oC_Variable();
      if (lookup) {
        const name = this.schemaName(lookup.oC_PropertyKeyName()!.oC_SchemaName());
        entries.delete(name);
        entries.set(name, { type: 'PropertyAccess', position: pos(item), subject, key: name });
      } else if (key) {
        const name = this.schemaName(key.oC_SchemaName());
        entries.delete(name);
        entries.set(name, this.expression(item.oC_Expression()!));
      } else if (variable) {
        const name = this.symbolicName(variable.oC_SymbolicName());
        entries.delete(name);
        entries.set(name, { type: 'Variable', position: pos(item), name });
      } else {
        all = true;
      }
    }
    const map: ast.MapExpression = {
      type: 'Map',
      position,
      entries: [...entries].map(([key, value]) => ({ key, value })),
    };
    const projected: ast.Expression = all
      ? {
          type: 'MapProjection',
          position,
          base: {
            type: 'FunctionCall',
            position,
            name: 'properties',
            distinct: false,
            args: [subject],
          },
          entries: map.entries,
        }
      : map;
    return {
      type: 'Case',
      position,
      subject: undefined,
      alternatives: [
        {
          when: { type: 'IsNull', position, operand: subject, negated: false },
          then: { type: 'Literal', position, value: null },
        },
      ],
      otherwise: projected,
    };
  }

  /** `atom.a.b`: the target is `atom.a`, the key `b`. */
  private propertyTarget(ctx: OC_PropertyExpressionContext): ast.PropertyTarget {
    const lookups = ctx.oC_PropertyLookup();
    let target = this.atom(ctx.oC_Atom(), false);
    for (const lookup of lookups.slice(0, -1)) {
      target = {
        type: 'PropertyAccess',
        position: pos(lookup),
        subject: target,
        key: this.schemaName(lookup.oC_PropertyKeyName()!.oC_SchemaName()),
      };
    }
    const last = lookups.at(-1)!;
    return {
      kind: 'property',
      position: pos(ctx),
      target,
      key: this.schemaName(last.oC_PropertyKeyName()!.oC_SchemaName()),
    };
  }

  private matchClause(ctx: OC_MatchContext): ast.MatchClause {
    const where = ctx.oC_Where();
    return {
      type: 'Match',
      position: pos(ctx),
      optional: ctx.OPTIONAL() !== null,
      pattern: this.pattern(ctx.oC_Pattern()),
      where: where ? this.expression(where.oC_Expression()) : undefined,
    };
  }

  private createClause(ctx: OC_CreateContext): ast.CreateClause {
    return { type: 'Create', position: pos(ctx), pattern: this.pattern(ctx.oC_Pattern()) };
  }

  private returnClause(body: OC_ProjectionBodyContext, ctx: ParserRuleContext): ast.ReturnClause {
    const itemsCtx = body.oC_ProjectionItems();
    const items = itemsCtx.oC_ProjectionItem().map((item): ast.ProjectionItem => {
      const exprCtx = item.oC_Expression()!;
      const variable = item.oC_Variable();
      const alias = variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined;
      return {
        position: pos(item),
        expression: this.expression(exprCtx),
        alias,
        name: alias ?? this.text(exprCtx),
      };
    });
    const order = body.oC_Order();
    const skip = body.oC_Skip();
    const limit = body.oC_Limit();
    return {
      type: 'Return',
      position: pos(ctx),
      distinct: body.DISTINCT() !== null,
      star: itemsCtx.getChild(0)?.getText() === '*',
      items,
      orderBy: (order?.oC_SortItem() ?? []).map((sort) => ({
        position: pos(sort),
        expression: this.expression(sort.oC_Expression()),
        descending: sort.DESC() !== null || sort.DESCENDING() !== null,
      })),
      skip: skip ? this.expression(skip.oC_Expression()) : undefined,
      limit: limit ? this.expression(limit.oC_Expression()) : undefined,
    };
  }

  // ---- patterns -------------------------------------------------------------

  private pattern(ctx: OC_PatternContext): ast.PatternPart[] {
    return ctx.oC_PatternPart().map((part) => this.patternPart(part));
  }

  private patternPart(part: OC_PatternPartContext): ast.PatternPart {
    const variable = part.oC_Variable();
    const anonymous = part.oC_AnonymousPatternPart()!;
    const shortest = anonymous.oC_ShortestPathPattern();
    return {
      position: pos(part),
      variable: variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined,
      elements: this.patternElement(
        shortest ? shortest.oC_PatternElement() : anonymous.oC_PatternElement()!,
      ),
      shortest: shortest ? this.shortestKind(shortest.oC_SymbolicName()) : undefined,
    };
  }

  /** The function name of `shortestPath(...)` or `allShortestPaths(...)` (any case). */
  private shortestKind(ctx: OC_SymbolicNameContext): 'one' | 'all' {
    const name = this.symbolicName(ctx).toLowerCase();
    if (name === 'shortestpath') {
      return 'one';
    }
    if (name === 'allshortestpaths') {
      return 'all';
    }
    throw new CypherSyntaxError(
      `Invalid Cypher: a pattern can only be wrapped in shortestPath() or allShortestPaths(), not ${this.symbolicName(ctx)}()`,
      { position: pos(ctx) },
    );
  }

  private patternElement(ctx: OC_PatternElementContext): ast.PatternElement[] {
    const nested = ctx.oC_PatternElement();
    if (nested) {
      return this.patternElement(nested);
    }
    const elements: ast.PatternElement[] = [this.nodePattern(ctx.oC_NodePattern()!)];
    for (const chain of ctx.oC_PatternElementChain()) {
      elements.push(this.relationshipPattern(chain.oC_RelationshipPattern()));
      elements.push(this.nodePattern(chain.oC_NodePattern()));
    }
    return elements;
  }

  private nodePattern(ctx: OC_NodePatternContext): ast.NodePattern {
    const variable = ctx.oC_Variable();
    const properties = ctx.oC_Properties();
    return {
      type: 'NodePattern',
      position: pos(ctx),
      variable: variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined,
      labels: this.nodeLabels(ctx.oC_NodeLabels()),
      properties: properties ? this.properties(properties) : undefined,
    };
  }

  private relationshipPattern(ctx: OC_RelationshipPatternContext): ast.RelationshipPattern {
    const left = ctx.oC_LeftArrowHead() !== null;
    const right = ctx.oC_RightArrowHead() !== null;
    const detail = ctx.oC_RelationshipDetail();
    const variable = detail?.oC_Variable();
    const types = detail?.oC_RelationshipTypes();
    const range = detail?.oC_RangeLiteral();
    const properties = detail?.oC_Properties();

    let parsedRange: ast.RelationshipPattern['range'];
    if (range) {
      // `*`, `*n`, `*n..`, `*..m`, `*n..m`: an integer before `..` (or without `..`) is the minimum.
      const hasDots = range.getText().includes('..');
      const ints = range.oC_IntegerLiteral().map((i) => Number(this.integerLiteral(i)));
      const text = range.getText();
      const startsWithInt = /^\*\s*\d/.test(text);
      if (!hasDots) {
        parsedRange = { min: ints[0], max: ints[0] };
      } else if (startsWithInt) {
        parsedRange = { min: ints[0], max: ints[1] };
      } else {
        parsedRange = { min: undefined, max: ints[0] };
      }
    }

    return {
      type: 'RelationshipPattern',
      position: pos(ctx),
      variable: variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined,
      types: (types?.oC_RelTypeName() ?? []).map((t) => this.schemaName(t.oC_SchemaName())),
      direction: left && !right ? 'left' : right && !left ? 'right' : 'both',
      range: parsedRange,
      properties: properties ? this.properties(properties) : undefined,
    };
  }

  private nodeLabels(ctx: OC_NodeLabelsContext | null): string[] {
    return (ctx?.oC_NodeLabel() ?? []).map((l) =>
      this.schemaName(l.oC_LabelName().oC_SchemaName()),
    );
  }

  private properties(ctx: OC_PropertiesContext): ast.Expression {
    const map = ctx.oC_MapLiteral();
    if (map) {
      return this.mapLiteral(map);
    }
    return this.parameter(ctx.oC_Parameter()!);
  }

  // ---- expressions ----------------------------------------------------------

  private expression(ctx: OC_ExpressionContext): ast.Expression {
    return this.orExpression(ctx.oC_OrExpression());
  }

  private orExpression(ctx: OC_OrExpressionContext): ast.Expression {
    return this.chain(
      ctx,
      ctx.oC_XorExpression().map((x) => this.xorExpression(x)),
      'OR',
    );
  }

  private xorExpression(ctx: OC_XorExpressionContext): ast.Expression {
    return this.chain(
      ctx,
      ctx.oC_AndExpression().map((a) => this.andExpression(a)),
      'XOR',
    );
  }

  private andExpression(ctx: OC_AndExpressionContext): ast.Expression {
    return this.chain(
      ctx,
      ctx.oC_NotExpression().map((n) => this.notExpression(n)),
      'AND',
    );
  }

  /** Left-associative chain of one boolean operator. */
  private chain(
    ctx: ParserRuleContext,
    operands: ast.Expression[],
    operator: ast.BooleanOperator,
  ): ast.Expression {
    return operands.reduce((left, right) => ({
      type: 'Binary',
      position: pos(ctx),
      operator,
      left,
      right,
    }));
  }

  private notExpression(ctx: OC_NotExpressionContext): ast.Expression {
    let expr = this.comparison(ctx.oC_ComparisonExpression());
    for (let i = 0; i < ctx.NOT().length; i++) {
      expr = { type: 'Not', position: pos(ctx), operand: expr };
    }
    return expr;
  }

  /** `a < b <= c` means `a < b AND b <= c`. */
  private comparison(ctx: OC_ComparisonExpressionContext): ast.Expression {
    let left = this.predicate(ctx.oC_StringListNullPredicateExpression());
    let result: ast.Expression | undefined;
    for (const partial of ctx.oC_PartialComparisonExpression()) {
      const right = this.predicate(partial.oC_StringListNullPredicateExpression()!);
      const comparison: ast.Expression = {
        type: 'Binary',
        position: pos(partial),
        operator: partial.getChild(0)!.getText() as ast.ComparisonOperator,
        left,
        right,
      };
      result = result
        ? { type: 'Binary', position: pos(ctx), operator: 'AND', left: result, right: comparison }
        : comparison;
      left = right;
    }
    return result ?? left;
  }

  private predicate(ctx: OC_StringListNullPredicateExpressionContext): ast.Expression {
    let expr = this.additive(ctx.oC_AddOrSubtractExpression());
    // The predicates apply left to right: `a IS NULL IS NULL`.
    for (const child of ctx.children.slice(1)) {
      if (child instanceof OC_StringPredicateExpressionContext) {
        const operator: ast.StringOperator = child.STARTS()
          ? 'STARTS WITH'
          : child.ENDS()
            ? 'ENDS WITH'
            : child.REGEX_MATCH()
              ? '=~'
              : 'CONTAINS';
        const right = this.additive(child.oC_AddOrSubtractExpression());
        expr = { type: 'Binary', position: pos(child), operator, left: expr, right };
      } else if (child instanceof OC_ListPredicateExpressionContext) {
        const right = this.additive(child.oC_AddOrSubtractExpression());
        expr = { type: 'Binary', position: pos(child), operator: 'IN', left: expr, right };
      } else if (child instanceof OC_NullPredicateExpressionContext) {
        expr = {
          type: 'IsNull',
          position: pos(child),
          operand: expr,
          negated: child.NOT() !== null,
        };
      }
    }
    return expr;
  }

  private additive(ctx: OC_AddOrSubtractExpressionContext): ast.Expression {
    return this.arithmetic(ctx, OC_MultiplyDivideModuloExpressionContext, (c) =>
      this.multiplicative(c),
    );
  }

  private multiplicative(ctx: OC_MultiplyDivideModuloExpressionContext): ast.Expression {
    return this.arithmetic(ctx, OC_PowerOfExpressionContext, (c) => this.power(c));
  }

  private power(ctx: OC_PowerOfExpressionContext): ast.Expression {
    return this.arithmetic(ctx, OC_UnaryAddOrSubtractExpressionContext, (c) => this.unary(c));
  }

  /**
   * A left-associative arithmetic level: operands of type `operandType`, with the
   * operator tokens (`+`, `*`, `^`, ...) between them.
   */
  private arithmetic<T extends ParserRuleContext>(
    ctx: ParserRuleContext,
    operandType: new (...args: never[]) => T,
    operand: (ctx: T) => ast.Expression,
  ): ast.Expression {
    let expr: ast.Expression | undefined;
    let operator: ast.ArithmeticOperator | undefined;
    for (const child of ctx.children) {
      if (child instanceof operandType) {
        const right = operand(child);
        expr =
          expr && operator
            ? { type: 'Binary', position: pos(ctx), operator, left: expr, right }
            : right;
      } else if (['+', '-', '*', '/', '%', '^'].includes(child.getText())) {
        operator = child.getText() as ast.ArithmeticOperator;
      }
    }
    return expr!;
  }

  private unary(ctx: OC_UnaryAddOrSubtractExpressionContext): ast.Expression {
    const sign = ctx.getChild(0)?.getText();
    const negate = sign === '-';
    const operand = ctx.oC_NonArithmeticOperatorExpression()!;
    // Property lookups and list operators, in the order written.
    const postfix = (operand.children ?? []).filter(
      (child) =>
        child instanceof OC_PropertyLookupContext ||
        child instanceof OC_ListOperatorExpressionContext,
    );

    // `-1` is a literal (so that the smallest integer can be written); any other
    // minus is an operator.
    const atom = operand.oC_Atom();
    const foldMinus =
      negate &&
      atom.oC_Literal()?.oC_NumberLiteral() != null &&
      postfix.length === 0 &&
      !operand.oC_NodeLabels();
    let expr = this.atom(atom, foldMinus);
    for (const op of postfix) {
      expr =
        op instanceof OC_PropertyLookupContext
          ? {
              type: 'PropertyAccess',
              position: pos(op),
              subject: expr,
              key: this.schemaName(op.oC_PropertyKeyName()!.oC_SchemaName()),
            }
          : this.listOperator(op, expr);
    }
    const labels = operand.oC_NodeLabels();
    if (labels) {
      expr = {
        type: 'HasLabels',
        position: pos(operand),
        subject: expr,
        labels: this.nodeLabels(labels),
      };
    }
    if (negate && !foldMinus) {
      expr = { type: 'Negate', position: pos(ctx), operand: expr };
    }
    return expr;
  }

  /** `subject[index]` or `subject[from..to]` (either bound may be missing). */
  private listOperator(
    ctx: OC_ListOperatorExpressionContext,
    subject: ast.Expression,
  ): ast.Expression {
    const children = ctx.children ?? [];
    const dots = children.findIndex(
      (child) => !(child instanceof ParserRuleContext) && child.getText() === '..',
    );
    if (dots < 0) {
      return {
        type: 'Index',
        position: pos(ctx),
        subject,
        index: this.expression(ctx.oC_Expression(0)!),
      };
    }
    const bound = (child: unknown): ast.Expression | undefined =>
      child instanceof OC_ExpressionContext ? this.expression(child) : undefined;
    return {
      type: 'Slice',
      position: pos(ctx),
      subject,
      from: children
        .slice(0, dots)
        .map(bound)
        .find((e) => e !== undefined),
      to: children
        .slice(dots + 1)
        .map(bound)
        .find((e) => e !== undefined),
    };
  }

  /** `variable IN list [WHERE condition]` of a list comprehension or quantifier. */
  private filterExpression(ctx: OC_FilterExpressionContext): {
    variable: string;
    list: ast.Expression;
    where: ast.Expression | undefined;
  } {
    const idInColl = ctx.oC_IdInColl();
    const where = ctx.oC_Where();
    return {
      variable: this.symbolicName(idInColl.oC_Variable().oC_SymbolicName()),
      list: this.expression(idInColl.oC_Expression()),
      where: where ? this.expression(where.oC_Expression()) : undefined,
    };
  }

  /** `negate` folds a leading unary minus into a number literal. */
  private atom(ctx: OC_AtomContext, negate: boolean): ast.Expression {
    const literal = ctx.oC_Literal();
    if (literal) {
      return this.literal(literal, negate);
    }
    if (negate) {
      return this.unsupported(ctx, 'unary minus');
    }
    const parameter = ctx.oC_Parameter();
    if (parameter) {
      return this.parameter(parameter);
    }
    const projection = ctx.oC_MapProjection();
    if (projection) {
      return this.mapProjection(projection);
    }
    const variable = ctx.oC_Variable();
    if (variable) {
      return {
        type: 'Variable',
        position: pos(ctx),
        name: this.symbolicName(variable.oC_SymbolicName()),
      };
    }
    const parenthesized = ctx.oC_ParenthesizedExpression();
    if (parenthesized) {
      return this.expression(parenthesized.oC_Expression());
    }
    const call = ctx.oC_FunctionInvocation();
    if (call) {
      const name = call.oC_FunctionName();
      const namespace = name
        .oC_Namespace()
        .oC_SymbolicName()
        .map((part) => `${this.symbolicName(part)}.`)
        .join('');
      return {
        type: 'FunctionCall',
        position: pos(ctx),
        name: namespace + this.symbolicName(name.oC_SymbolicName()),
        distinct: call.DISTINCT() !== null,
        args: call.oC_Expression().map((arg) => this.expression(arg)),
      };
    }
    if (ctx.COUNT()) {
      return { type: 'CountStar', position: pos(ctx) };
    }
    const comprehension = ctx.oC_ListComprehension();
    if (comprehension) {
      const projection = comprehension.oC_Expression();
      return {
        type: 'ListComprehension',
        position: pos(ctx),
        ...this.filterExpression(comprehension.oC_FilterExpression()),
        projection: projection ? this.expression(projection) : undefined,
      };
    }
    const quantifier = ctx.oC_Quantifier();
    if (quantifier) {
      return {
        type: 'Quantifier',
        position: pos(ctx),
        quantifier: quantifier.ALL()
          ? 'all'
          : quantifier.ANY()
            ? 'any'
            : quantifier.NONE()
              ? 'none'
              : 'single',
        ...this.filterExpression(quantifier.oC_FilterExpression()!),
      };
    }
    const caseExpr = ctx.oC_CaseExpression();
    if (caseExpr) {
      // Direct expressions: the subject (simple form only), then ELSE's.
      const exprs = caseExpr.oC_Expression();
      const otherwise = caseExpr.ELSE() ? exprs.pop() : undefined;
      return {
        type: 'Case',
        position: pos(ctx),
        subject: exprs[0] ? this.expression(exprs[0]) : undefined,
        alternatives: caseExpr.oC_CaseAlternative().map((alt) => ({
          when: this.expression(alt.oC_Expression(0)!),
          then: this.expression(alt.oC_Expression(1)!),
        })),
        otherwise: otherwise ? this.expression(otherwise) : undefined,
      };
    }
    const predicate = ctx.oC_PatternPredicate();
    if (predicate) {
      return {
        type: 'PatternPredicate',
        position: pos(ctx),
        pattern: this.relationshipsPattern(predicate.oC_RelationshipsPattern(), undefined),
      };
    }
    const patternComprehension = ctx.oC_PatternComprehension();
    if (patternComprehension) {
      const variable = patternComprehension.oC_Variable();
      const where = patternComprehension.oC_Where();
      return {
        type: 'PatternComprehension',
        position: pos(ctx),
        pattern: this.relationshipsPattern(
          patternComprehension.oC_RelationshipsPattern(),
          variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined,
        ),
        where: where ? this.expression(where.oC_Expression()) : undefined,
        projection: this.expression(patternComprehension.oC_Expression()),
      };
    }
    const exists = ctx.oC_ExistentialSubquery()!;
    const regular = exists.oC_RegularQuery();
    if (regular) {
      if (regular.oC_Union().length > 0) {
        throw new UnsupportedFeatureError('UNION is not supported yet', {
          position: pos(regular.oC_Union(0)!),
        });
      }
      return {
        type: 'Exists',
        position: pos(ctx),
        pattern: undefined,
        where: undefined,
        query: this.query(regular.oC_SingleQuery()),
      };
    }
    const body = exists.oC_ExistentialQueryBody();
    if (body) {
      // Without RETURN (a Neo4j extension): the query returns a constant.
      const clauses = body.children
        .filter((c) => c instanceof OC_ReadingClauseContext || c instanceof OC_WithContext)
        .map((c) => (c instanceof OC_WithContext ? this.withClause(c) : this.readingClause(c)));
      const position = pos(body);
      const one: ast.Expression = { type: 'Literal', position, value: 1n };
      clauses.push({
        type: 'Return',
        position,
        distinct: false,
        star: false,
        items: [{ position, expression: one, alias: undefined, name: '1' }],
        orderBy: [],
        skip: undefined,
        limit: undefined,
      });
      return {
        type: 'Exists',
        position: pos(ctx),
        pattern: undefined,
        where: undefined,
        query: { type: 'Query', position, clauses },
      };
    }
    const where = exists.oC_Where();
    return {
      type: 'Exists',
      position: pos(ctx),
      pattern: this.pattern(exists.oC_Pattern()!),
      where: where ? this.expression(where.oC_Expression()) : undefined,
      query: undefined,
    };
  }

  /** A relationships pattern (a node and at least one relationship) as a pattern part. */
  private relationshipsPattern(
    ctx: OC_RelationshipsPatternContext,
    variable: string | undefined,
  ): ast.PatternPart {
    const elements: ast.PatternElement[] = [this.nodePattern(ctx.oC_NodePattern())];
    for (const chain of ctx.oC_PatternElementChain()) {
      elements.push(this.relationshipPattern(chain.oC_RelationshipPattern()));
      elements.push(this.nodePattern(chain.oC_NodePattern()));
    }
    return { position: pos(ctx), variable, elements, shortest: undefined };
  }

  private literal(ctx: OC_LiteralContext, negate: boolean): ast.Expression {
    const position = pos(ctx);
    const number = ctx.oC_NumberLiteral();
    if (number) {
      const int = number.oC_IntegerLiteral();
      if (int) {
        let value = this.integerLiteral(int);
        if (negate) {
          value = -value;
        }
        if (value > MAX_INT64 || value < -MAX_INT64 - 1n) {
          throw new CypherSyntaxError(`Integer literal is too large: ${this.text(int)}`, {
            position,
          });
        }
        return { type: 'Literal', position, value };
      }
      const value = Number(number.getText());
      if (!Number.isFinite(value)) {
        throw new CypherSyntaxError(`Float literal is too large: ${number.getText()}`, {
          position,
        });
      }
      return { type: 'Literal', position, value: negate ? -value : value };
    }
    if (negate) {
      return this.unsupported(ctx, 'unary minus');
    }
    const bool = ctx.oC_BooleanLiteral();
    if (bool) {
      return { type: 'Literal', position, value: bool.TRUE() !== null };
    }
    if (ctx.NULL()) {
      return { type: 'Literal', position, value: null };
    }
    const str = ctx.StringLiteral();
    if (str) {
      return { type: 'Literal', position, value: unescapeString(str.getText()) };
    }
    const list = ctx.oC_ListLiteral();
    if (list) {
      return {
        type: 'List',
        position,
        items: list.oC_Expression().map((e) => this.expression(e)),
      };
    }
    return this.mapLiteral(ctx.oC_MapLiteral()!);
  }

  private integerLiteral(ctx: OC_IntegerLiteralContext): bigint {
    const text = ctx.getText();
    if (ctx.HexInteger()) {
      return BigInt(text);
    }
    if (ctx.OctalInteger()) {
      return BigInt(`0o${text.slice(2)}`);
    }
    return BigInt(text);
  }

  private mapLiteral(ctx: OC_MapLiteralContext): ast.MapExpression {
    const keys = ctx.oC_PropertyKeyName();
    const values = ctx.oC_Expression();
    return {
      type: 'Map',
      position: pos(ctx),
      entries: keys.map((key, i) => ({
        key: this.schemaName(key.oC_SchemaName()),
        value: this.expression(values[i]!),
      })),
    };
  }

  private parameter(
    ctx: {
      oC_SymbolicName(): OC_SymbolicNameContext | null;
      getText(): string;
    } & ParserRuleContext,
  ): ast.Parameter {
    const name = ctx.oC_SymbolicName();
    return {
      type: 'Parameter',
      position: pos(ctx),
      name: name ? this.symbolicName(name) : ctx.getText().slice(1),
    };
  }

  // ---- names ----------------------------------------------------------------

  private schemaName(ctx: OC_SchemaNameContext): string {
    const symbolic = ctx.oC_SymbolicName();
    return symbolic ? this.symbolicName(symbolic) : ctx.getText();
  }

  private symbolicName(ctx: OC_SymbolicNameContext): string {
    const escaped = ctx.EscapedSymbolicName();
    if (escaped) {
      // `a``b` -> a`b. Adjacent escaped parts (`a``b`) are one name in the grammar.
      return escaped.getText().slice(1, -1).replaceAll('``', '`');
    }
    return ctx.getText();
  }

  private unsupported(ctx: ParserRuleContext, description: string): ast.UnsupportedExpression {
    return { type: 'UnsupportedExpression', position: pos(ctx), description };
  }

  /** The original source text of a context, as written. */
  private text(ctx: ParserRuleContext): string {
    const start = ctx.start?.start ?? 0;
    const stop = ctx.stop?.stop ?? start - 1;
    return this.source.slice(start, stop + 1);
  }
}

function unescapeString(quoted: string): string {
  const body = quoted.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gs, (_match, esc: string): string => {
    switch (esc[0]) {
      case 'b':
      case 'B':
        return '\b';
      case 'f':
      case 'F':
        return '\f';
      case 'n':
      case 'N':
        return '\n';
      case 'r':
      case 'R':
        return '\r';
      case 't':
      case 'T':
        return '\t';
      case 'u':
      case 'U':
        return esc.length > 1 ? String.fromCodePoint(parseInt(esc.slice(1), 16)) : esc;
      default:
        return esc;
    }
  });
}
