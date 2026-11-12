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
  OC_ListPredicateExpressionContext,
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
  type OC_ExpressionContext,
  type OC_NotExpressionContext,
  type OC_OrExpressionContext,
  type OC_StringListNullPredicateExpressionContext,
  type OC_XorExpressionContext,
  type OC_IntegerLiteralContext,
  type OC_LiteralContext,
  type OC_MapLiteralContext,
  type OC_MatchContext,
  type OC_MultiPartQueryContext,
  type OC_NodeLabelsContext,
  type OC_NodePatternContext,
  type OC_PatternContext,
  type OC_PatternElementContext,
  type OC_ProjectionBodyContext,
  type OC_PropertiesContext,
  type OC_ReadingClauseContext,
  type OC_RelationshipPatternContext,
  type OC_SchemaNameContext,
  type OC_SinglePartQueryContext,
  type OC_SymbolicNameContext,
  type OC_UpdatingClauseContext,
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
    const single = ctx.oC_SinglePartQuery();
    if (!single) {
      const multi = ctx.oC_MultiPartQuery()!;
      throw new UnsupportedFeatureError('WITH is not supported yet', {
        position: pos(multi.oC_With(0)!),
      });
    }
    const clauses: ast.Clause[] = [];
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
    let name: string;
    if (ctx.oC_Merge()) {
      name = 'MERGE';
    } else if (ctx.oC_Set()) {
      name = 'SET';
    } else if (ctx.oC_Remove()) {
      name = 'REMOVE';
    } else {
      name = ctx.oC_Delete()?.DETACH() ? 'DETACH DELETE' : 'DELETE';
    }
    return { type: 'UnsupportedClause', position: pos(ctx), name, write: true };
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
    return ctx.oC_PatternPart().map((part) => {
      const variable = part.oC_Variable();
      return {
        position: pos(part),
        variable: variable ? this.symbolicName(variable.oC_SymbolicName()) : undefined,
        elements: this.patternElement(part.oC_AnonymousPatternPart()!.oC_PatternElement()),
      };
    });
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

    if (operand.oC_ListOperatorExpression().length > 0) {
      return this.unsupported(operand, 'list indexing and slicing');
    }

    // `-1` is a literal (so that the smallest integer can be written); any other
    // minus is an operator.
    const atom = operand.oC_Atom();
    const foldMinus =
      negate &&
      atom.oC_Literal()?.oC_NumberLiteral() != null &&
      operand.oC_PropertyLookup().length === 0 &&
      !operand.oC_NodeLabels();
    let expr = this.atom(atom, foldMinus);
    for (const lookup of operand.oC_PropertyLookup()) {
      expr = {
        type: 'PropertyAccess',
        position: pos(lookup),
        subject: expr,
        key: this.schemaName(lookup.oC_PropertyKeyName()!.oC_SchemaName()),
      };
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
    let description: string;
    if (ctx.oC_CaseExpression()) {
      description = 'CASE expressions';
    } else if (ctx.COUNT()) {
      description = 'count(*)';
    } else if (ctx.oC_ListComprehension()) {
      description = 'list comprehensions';
    } else if (ctx.oC_PatternComprehension()) {
      description = 'pattern comprehensions';
    } else if (ctx.oC_Quantifier()) {
      description = 'list quantifiers (all, any, none, single)';
    } else if (ctx.oC_PatternPredicate()) {
      description = 'pattern predicates';
    } else {
      description = 'EXISTS subqueries';
    }
    return this.unsupported(ctx, description);
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
