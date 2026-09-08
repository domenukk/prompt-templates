/**
 * Expression evaluation and condition testing for md-tmpl templates.
 */

import type { Scope } from "./scope.js";
import {
  type Value,
  ENUM_TAG_KEY,
  ENUM_VARIANTS_KEY,
  str,
  int,
  isTruthy,
  typeName,
  display,
} from "./value.js";
import {
  TemplateError,
  TemplateSyntaxError,
  TypeMismatchError,
} from "./errors.js";
import { applyFilter, parseFilter } from "./filters.js";
import { type VarDecl, type VarType } from "./frontmatter.js";
import {
  TokKind,
  type Token,
  tokenizeCondition,
} from "./condition_tokenizer.js";
export { isOptionMatchNode } from "./consts.js";
import {
  PIPE,
  OP_EQ,
  OP_NE,
  OP_LT,
  OP_GT,
  OP_LE,
  OP_GE,
  FN_IDX,
  FN_LEN,
  FN_KIND,
  FN_KINDS,
  FN_HAS,
  TYPE_BOOL,
  TYPE_FLOAT,
  TYPE_INT,
  TYPE_LIST,
  TYPE_NONE,
  TYPE_STR,
  TYPE_STRUCT,
  TYPE_TMPL,
  TYPE_ENUM,
  TYPE_OPTION,
  OPTION_NONE,
  OPTION_SOME,
  EXPR_START,
  EXPR_END,
  unescapeStringLiteral,
  LIT_TRUE,
  LIT_FALSE,
} from "./consts.js";

export function evaluateExpression(expr: string, scope: Scope): Value {
  // Fast path: no pipe means no filters (the vast majority of expressions)
  const pipeIdx = expr.indexOf(PIPE);
  if (pipeIdx === -1) {
    // No filters — resolve directly, trim only if needed
    const trimmed =
      expr.charCodeAt(0) === 32 || expr.charCodeAt(expr.length - 1) === 32
        ? expr.trim()
        : expr;
    return resolveExpr(trimmed, scope);
  }

  const trimmed = expr.trim();
  // Split by pipe, respecting parentheses
  const parts = splitPipes(trimmed);
  const pathPart = (parts[0] ?? "").trim();

  let value = resolveExpr(pathPart, scope);

  // Apply filter chain
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const filterStr = part.trim();
    const [filterName, filterArgs] = parseFilter(filterStr);
    value = applyFilter(value, filterName, filterArgs);
  }

  return value;
}

/** Pre-compiled regex for function calls. */
const FUNC_CALL_RE = /^(\w+)\((.+)\)$/;

/**
 * Strict numeric-literal shape: optional leading `-`, digits, optional
 * fractional part with digits on both sides of the dot. Requiring digits
 * around the dot ensures variable names and malformed tokens (`.5`, `3.`,
 * `3.1.4`) never parse as numbers — they fall through to path resolution.
 */
const NUM_LITERAL_RE = /^-?[0-9]+(?:\.[0-9]+)?$/;

/**
 * Construct a `Value` from a numeric-literal token: integer-valued numbers
 * become ints, everything else becomes a float. Single source of truth for
 * numeric-literal parsing, shared by `resolveExpr` (output / filter-input /
 * panic / string-interpolation positions) and `evaluateOperandValue`
 * (condition / comparison positions).
 */
function numericLiteralToValue(token: string): Value {
  const num = Number(token);
  return Number.isInteger(num) ? int(num) : { type: TYPE_FLOAT, value: num };
}

/** Resolve a single expression (path, function call, or literal). */
function resolveExpr(expr: string, scope: Scope): Value {
  // String literal: "..." or '...' — with optional {{ expr }} interpolation.
  const first = expr.charCodeAt(0);
  if (
    (first === 34 /* '"' */ || first === 39) /* "'" */ &&
    expr.charCodeAt(expr.length - 1) === first
  ) {
    const inner = unescapeStringLiteral(expr.slice(1, -1));
    if (inner.includes(EXPR_START)) {
      return str(interpolateString(inner, scope));
    }
    return str(inner);
  }

  // Bare bool literal — usable in every expression position (option B), so
  // `{{ true }}` / `{{ false }}` render like a bool variable would.
  if (expr === LIT_TRUE) return { type: TYPE_BOOL, value: true };
  if (expr === LIT_FALSE) return { type: TYPE_BOOL, value: false };

  // Bare numeric literal (int or float). The strict shape check keeps
  // variable names and malformed tokens out of the literal path, letting
  // them fall through to path resolution (reported as undefined variables).
  if (NUM_LITERAL_RE.test(expr)) {
    return numericLiteralToValue(expr);
  }

  // Fast path: if expr doesn't end with ')' it can't be a function call
  if (expr.charCodeAt(expr.length - 1) !== 41 /* ')' */) {
    return scope.resolvePath(expr);
  }

  // Function calls: idx(binding), len(expr), kind(expr)
  const funcMatch = FUNC_CALL_RE.exec(expr);
  if (funcMatch?.[1] && funcMatch[2]) {
    const funcName = funcMatch[1];
    const arg = funcMatch[2].trim();
    switch (funcName) {
      case FN_IDX: {
        const meta = scope.getLoopMeta(arg);
        if (meta === undefined) {
          throw new TemplateSyntaxError(
            `idx() requires active loop binding '${arg}'`,
          );
        }
        return int(meta.index);
      }
      case FN_LEN: {
        const val = scope.resolvePath(arg);
        if (val.type === TYPE_LIST) return int(val.items.length);
        if (val.type === TYPE_STR) return int(val.value.length);
        throw new TemplateSyntaxError(
          `len() requires a list or string, got ${typeName(val)}`,
        );
      }
      case FN_KIND: {
        const val = scope.resolvePath(arg);
        const isOpt = scope.isOptionParam(arg);
        if (!isOpt && val.type === TYPE_STR && scope.isDeclaredNonEnum(arg)) {
          throw new TemplateSyntaxError(
            `kind() requires an enum or option value, got str on '${arg}'`,
          );
        }
        const name = getVariantName(val, isOpt);
        return str(name);
      }
      case FN_KINDS: {
        const val = scope.resolvePath(arg);
        if (val.type === TYPE_STRUCT) {
          const variants = val.fields.get(ENUM_VARIANTS_KEY);
          if (variants !== undefined) return variants;
        }
        throw new TemplateSyntaxError(
          `kinds() requires an enum type namespace, got ${typeName(val)}`,
        );
      }
      case FN_HAS: {
        if (scope.isDeclaredNonOption(arg)) {
          throw new TemplateSyntaxError(
            `has() requires an option value, got non-option on '${arg}'`,
          );
        }
        const val = scope.resolvePath(arg);
        if (scope.isOptionParam(arg)) {
          if (val.type === TYPE_NONE) {
            return { type: TYPE_BOOL, value: false };
          }
          return { type: TYPE_BOOL, value: true };
        } else {
          let hasVal = true;
          if (val.type === TYPE_NONE) hasVal = false;
          else if (val.type === TYPE_STR) hasVal = val.value.length > 0;
          else if (val.type === TYPE_LIST) hasVal = val.items.length > 0;
          return { type: TYPE_BOOL, value: hasVal };
        }
      }
      default:
        throw new TemplateSyntaxError(`unknown function '${funcName}'`);
    }
  }

  // Dotted path (or expression that looked like a function but wasn't)
  return scope.resolvePath(expr);
}

/**
 * Get the variant name from an enum or string value.
 *
 * For NoneValue: returns "None".
 * For non-None values used in option match: returns "Some".
 * For string values: returns the string itself — this covers both:
 *   - Unit enum variants (stored as plain strings at runtime)
 *   - String matching with quoted case labels ({% case "value" %})
 *   Type safety between these two is enforced at compile time, not runtime.
 */
export function getVariantName(val: Value, isOption: boolean): string {
  if (val.type === TYPE_NONE) return OPTION_NONE;
  // In option context, any non-None value is "Some"
  if (isOption) return OPTION_SOME;
  // Str covers both unit enum variants and string literal matching.
  // The type checker ensures unquoted case labels only appear with enum
  // params and quoted labels only appear with str params.
  if (val.type === TYPE_STR) return val.value;
  if (val.type === TYPE_STRUCT) {
    const tag = val.fields.get(ENUM_TAG_KEY);
    if (tag?.type === TYPE_STR) return tag.value;
    throw new TemplateSyntaxError(
      "kind() requires an enum value (struct with variant tag)",
    );
  }
  // Scalar types: convert to string for label comparison.
  if (val.type === TYPE_INT || val.type === TYPE_FLOAT) {
    return String(val.value);
  }
  if (val.type === TYPE_BOOL) {
    return val.value ? "true" : "false";
  }
  throw new TemplateSyntaxError(
    `cannot determine variant name for value of type '${val.type}' — expected enum (str or dict with tag) or option`,
  );
}

/** Evaluate a condition expression for `{% if %}`. */
export function evaluateCondition(condition: string, scope: Scope): boolean {
  const trimmed = condition.trim();
  if (trimmed.length === 0) {
    throw new TemplateSyntaxError("empty condition expression");
  }
  const tokens = tokenizeCondition(trimmed);
  const ctx: ParseCtx = { tokens, pos: 0, scope };
  const result = parseOrExpr(ctx);
  if (ctx.pos < ctx.tokens.length) {
    const remaining = ctx.tokens[ctx.pos];
    if (remaining !== undefined) {
      throw new TemplateSyntaxError(
        `unexpected token '${remaining.value}' in condition`,
      );
    }
  }
  return result;
}

// Compile-time condition syntax validation — extracted to its own module.
export { validateConditionSyntax } from "./condition_validate.js";

// ---------------------------------------------------------------------------
// Recursive descent parser/evaluator (evaluates in-place)
// ---------------------------------------------------------------------------

interface ParseCtx {
  tokens: Token[];
  pos: number;
  scope: Scope;
}

function peek(ctx: ParseCtx): Token | undefined {
  return ctx.tokens[ctx.pos];
}

function advance(ctx: ParseCtx): Token {
  const t = ctx.tokens[ctx.pos];
  if (!t)
    throw new TemplateSyntaxError("unexpected end of condition expression");
  ctx.pos++;
  return t;
}

/** OrExpr := AndExpr ( "||" AndExpr )* — with short-circuit */
function parseOrExpr(ctx: ParseCtx): boolean {
  let result = parseAndExpr(ctx);
  while (peek(ctx)?.kind === TokKind.Or) {
    advance(ctx); // consume ||
    if (!result) {
      // Left is false, need to evaluate right
      const right = parseAndExpr(ctx);
      result = right;
    } else {
      // Short-circuit: left is true, skip right side
      skipAndExpr(ctx);
      // result stays true
    }
  }
  return result;
}

/** AndExpr := UnaryExpr ( "&&" UnaryExpr )* — with short-circuit */
function parseAndExpr(ctx: ParseCtx): boolean {
  let result = parseUnaryExpr(ctx);
  while (peek(ctx)?.kind === TokKind.And) {
    advance(ctx); // consume &&
    if (result) {
      // Left is true, need to evaluate right
      const right = parseUnaryExpr(ctx);
      result = right;
    } else {
      // Short-circuit: left is false, but still need to parse right to consume tokens
      skipUnaryExpr(ctx);
      // result stays false
    }
  }
  return result;
}

/** UnaryExpr := "!" UnaryExpr | Atom */
function parseUnaryExpr(ctx: ParseCtx): boolean {
  const t = peek(ctx);
  if (t?.kind === TokKind.Not) {
    advance(ctx); // consume !
    return !parseUnaryExpr(ctx);
  }

  return parseAtom(ctx);
}

/**
 * Atom := "(" OrExpr ")" | MatchCond | Comparison | Truthy
 *
 * MatchCond := "match" Operand "case" VariantName(s)
 * Comparison := Operand CompOp Operand
 * Truthy := Operand
 */
function parseAtom(ctx: ParseCtx): boolean {
  const t = peek(ctx);
  if (!t) {
    throw new TemplateSyntaxError("unexpected end of condition expression");
  }

  // Grouped expression
  if (t.kind === TokKind.LParen) {
    advance(ctx); // consume (
    if (peek(ctx)?.kind === TokKind.RParen) {
      throw new TemplateSyntaxError(
        "empty parentheses '()' in condition expression",
      );
    }
    const result = parseOrExpr(ctx);
    const closing = peek(ctx);
    if (closing?.kind !== TokKind.RParen) {
      throw new TemplateSyntaxError(
        "unclosed parenthesis ')' expected in condition",
      );
    }
    advance(ctx); // consume )
    return result;
  }

  // Match-as-condition: match X case Y
  if (t.kind === TokKind.Match) {
    return parseMatchCondition(ctx);
  }

  // Otherwise: operand, possibly followed by a comparison operator
  const operand = parseOperand(ctx);

  const next = peek(ctx);
  if (next && isComparisonOp(next.kind)) {
    const op = advance(ctx); // consume comparison operator

    const rightOperand = parseOperand(ctx);
    const left = evaluateOperandValue(operand, ctx.scope);
    const right = evaluateOperandValue(rightOperand, ctx.scope);
    return evaluateComparison(left, right, op.kind);
  }

  // Truthy evaluation
  const val = evaluateOperandValue(operand, ctx.scope);
  if (val.type === TYPE_NONE) {
    throw new TemplateError(
      "cannot evaluate truthiness of option — use has(x) to check presence",
      "type_mismatch",
    );
  }
  return isTruthy(val);
}

/** Parse 'match EXPR case VARIANT [| VARIANT]*' as boolean condition */
function parseMatchCondition(ctx: ParseCtx): boolean {
  advance(ctx); // consume 'match'

  // Parse the match target expression (an operand)
  const targetOperand = parseOperand(ctx);
  const targetVal = evaluateOperandValue(targetOperand, ctx.scope);

  // Expect 'case' keyword
  const caseToken = peek(ctx);
  if (caseToken?.kind !== TokKind.Case) {
    throw new TemplateSyntaxError(
      "expected 'case' keyword after 'match' expression",
    );
  }
  advance(ctx); // consume 'case'

  // Parse variant name(s), separated by |
  const variants: string[] = [];
  const firstVariant = peek(ctx);
  if (firstVariant?.kind !== TokKind.Ident) {
    throw new TemplateSyntaxError("expected variant name after 'case'");
  }
  variants.push(advance(ctx).value);

  while (peek(ctx)?.kind === TokKind.Pipe) {
    advance(ctx); // consume |
    const nextVar = peek(ctx);
    if (nextVar?.kind !== TokKind.Ident) {
      throw new TemplateSyntaxError("expected variant name after '|'");
    }
    variants.push(advance(ctx).value);
  }

  // Evaluate: get the variant name of the target value
  const isOpt = variants.some((v) => v === OPTION_SOME || v === OPTION_NONE);
  const variantName = getVariantName(targetVal, isOpt);
  return variants.includes(variantName);
}

type OperandToken = Token;

/** Parse a single operand token (ident, string literal, number, bool). */
function parseOperand(ctx: ParseCtx): OperandToken {
  const t = peek(ctx);
  if (!t) {
    throw new TemplateSyntaxError("unexpected end of condition expression");
  }
  if (
    t.kind === TokKind.Ident ||
    t.kind === TokKind.StrLit ||
    t.kind === TokKind.NumLit ||
    t.kind === TokKind.BoolLit
  ) {
    return advance(ctx);
  }
  throw new TemplateSyntaxError(
    `expected expression, got '${t.value}' in condition`,
  );
}

/** Evaluate an operand token to a Value. */
function evaluateOperandValue(operand: OperandToken, scope: Scope): Value {
  switch (operand.kind) {
    case TokKind.StrLit: {
      const inner = unescapeStringLiteral(operand.value.slice(1, -1));
      if (inner.includes(EXPR_START)) {
        return str(interpolateString(inner, scope));
      }
      return str(inner);
    }
    case TokKind.BoolLit:
      return { type: TYPE_BOOL, value: operand.value === LIT_TRUE };
    case TokKind.NumLit:
      return numericLiteralToValue(operand.value);
    case TokKind.Ident:
      return evaluateExpression(operand.value, scope);
    default:
      throw new TemplateSyntaxError(`unexpected operand type: ${operand.kind}`);
  }
}

/**
 * Interpolate `{{ expr }}` references inside a string literal.
 *
 * Evaluates each `{{ expr }}` by calling `evaluateExpression` and `display`,
 * returning the fully-rendered string. Plain segments are preserved as-is.
 */
function interpolateString(input: string, scope: Scope): string {
  let result = "";
  let remaining = input;
  let startIdx = remaining.indexOf(EXPR_START);
  while (startIdx !== -1) {
    result += remaining.slice(0, startIdx);
    const afterStart = remaining.slice(startIdx + EXPR_START.length);
    const endIdx = afterStart.indexOf(EXPR_END);
    if (endIdx === -1) {
      throw new TemplateSyntaxError(
        `unclosed '${EXPR_START}' in interpolated string`,
      );
    }
    const expr = afterStart.slice(0, endIdx).trim();
    if (expr === "") {
      throw new TemplateSyntaxError(
        `empty expression '${EXPR_START}${EXPR_END}' in interpolated string`,
      );
    }
    const val = evaluateExpression(expr, scope);
    result += display(val);
    remaining = afterStart.slice(endIdx + EXPR_END.length);
    startIdx = remaining.indexOf(EXPR_START);
  }
  result += remaining;
  return result;
}

function isComparisonOp(kind: TokKind): boolean {
  return (
    kind === TokKind.Eq ||
    kind === TokKind.Ne ||
    kind === TokKind.Le ||
    kind === TokKind.Ge ||
    kind === TokKind.Lt ||
    kind === TokKind.Gt ||
    kind === TokKind.In
  );
}

function evaluateComparison(left: Value, right: Value, op: TokKind): boolean {
  if (op === TokKind.In) {
    return compareIn(left, right, false);
  }
  const opStr =
    op === TokKind.Eq
      ? OP_EQ
      : op === TokKind.Ne
        ? OP_NE
        : op === TokKind.Le
          ? OP_LE
          : op === TokKind.Ge
            ? OP_GE
            : op === TokKind.Lt
              ? OP_LT
              : OP_GT;
  return compareValues(left, right, opStr);
}

// ---------------------------------------------------------------------------
// Short-circuit skip helpers — parse without evaluating
// ---------------------------------------------------------------------------

/** Skip a unary expression (consume tokens without evaluating). */
function skipUnaryExpr(ctx: ParseCtx): void {
  const t = peek(ctx);
  if (t?.kind === TokKind.Not) {
    advance(ctx);
    skipUnaryExpr(ctx);
    return;
  }
  skipAtom(ctx);
}

/** Skip an atom (consume tokens without evaluating). */
function skipAtom(ctx: ParseCtx): void {
  const t = peek(ctx);
  if (!t)
    throw new TemplateSyntaxError("unexpected end of condition expression");

  if (t.kind === TokKind.LParen) {
    advance(ctx);
    skipOrExpr(ctx);
    if (peek(ctx)?.kind !== TokKind.RParen) {
      throw new TemplateSyntaxError(
        "unclosed parenthesis ')' expected in condition",
      );
    }
    advance(ctx);
    return;
  }

  if (t.kind === TokKind.Match) {
    advance(ctx); // match
    skipOperand(ctx); // expr
    if (peek(ctx)?.kind === TokKind.Case) {
      advance(ctx); // case
      skipOperand(ctx); // variant
      while (peek(ctx)?.kind === TokKind.Pipe) {
        advance(ctx);
        skipOperand(ctx);
      }
    }
    return;
  }

  skipOperand(ctx); // operand
  const next = peek(ctx);
  if (next && isComparisonOp(next.kind)) {
    advance(ctx); // op
    skipOperand(ctx); // right operand
  }
}

function skipOrExpr(ctx: ParseCtx): void {
  skipAndExpr(ctx);
  while (peek(ctx)?.kind === TokKind.Or) {
    advance(ctx);
    skipAndExpr(ctx);
  }
}

function skipAndExpr(ctx: ParseCtx): void {
  skipUnaryExpr(ctx);
  while (peek(ctx)?.kind === TokKind.And) {
    advance(ctx);
    skipUnaryExpr(ctx);
  }
}

function skipOperand(ctx: ParseCtx): void {
  const t = peek(ctx);
  if (
    t &&
    (t.kind === TokKind.Ident ||
      t.kind === TokKind.StrLit ||
      t.kind === TokKind.NumLit ||
      t.kind === TokKind.BoolLit)
  ) {
    advance(ctx);
    return;
  }
  if (t) {
    advance(ctx); // consume anyway for error recovery
  }
}

/** Compare two values with a comparison operator. */
function compareValues(
  left: Value,
  right: Value,
  op:
    | typeof OP_EQ
    | typeof OP_NE
    | typeof OP_LT
    | typeof OP_GT
    | typeof OP_LE
    | typeof OP_GE,
): boolean {
  const l = coerceForComparison(left);
  const r = coerceForComparison(right);

  switch (op) {
    case OP_EQ:
      return l === r;
    case OP_NE:
      return l !== r;
    case OP_LT:
      return l < r;
    case OP_GT:
      return l > r;
    case OP_LE:
      return l <= r;
    case OP_GE:
      return l >= r;
    default:
      throw new TemplateSyntaxError(
        `unknown comparison operator '${String(op)}'`,
      );
  }
}

/** Compare two values for in / not in membership or subset inclusion. */
function compareIn(left: Value, right: Value, negate: boolean): boolean {
  let res: boolean;
  if (right.type === TYPE_LIST) {
    if (left.type === TYPE_LIST) {
      // Subset check
      res = left.items.every((subItem) =>
        right.items.some((superItem) =>
          compareValues(subItem, superItem, OP_EQ),
        ),
      );
    } else {
      // Membership check
      res = right.items.some((item) => compareValues(left, item, OP_EQ));
    }
  } else if (right.type === TYPE_STR) {
    if (left.type !== TYPE_STR) {
      throw new TypeMismatchError("left operand of 'in'", TYPE_STR, left.type);
    }
    res = right.value.includes(left.value);
  } else {
    throw new TypeMismatchError(
      "right operand of 'in'",
      `${TYPE_LIST} or ${TYPE_STR}`,
      right.type,
    );
  }
  return negate ? !res : res;
}

/** Coerce a value to a primitive for comparison. */
function coerceForComparison(v: Value): string | number | boolean {
  switch (v.type) {
    case TYPE_STR:
      return v.value;
    case TYPE_BOOL:
      return v.value;
    case TYPE_INT:
      return v.value;
    case TYPE_FLOAT:
      return v.value;
    default:
      return display(v);
  }
}

/** Split expression by pipe, respecting parentheses. Uses slice instead of char-by-char concatenation. */
export function splitPipes(expr: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr.charCodeAt(i);
    if (ch === 40 /* ( */ || ch === 60 /* < */) {
      depth++;
    } else if (ch === 41 /* ) */ || ch === 62 /* > */) {
      depth--;
    } else if (ch === 124 /* | */ && depth === 0) {
      result.push(expr.slice(start, i));
      start = i + 1;
    }
  }

  if (start < expr.length) {
    result.push(expr.slice(start));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Include type validation
// ---------------------------------------------------------------------------

/**
 * Validate resolved values against an included template's declarations.
 *
 * Checks that each declared parameter has a value matching its declared type.
 * Throws `TypeMismatchError` on the first mismatch found.
 */
export function validateIncludeTypes(
  declarations: readonly VarDecl[],
  values: ReadonlyMap<string, Value>,
  includeName: string,
): void {
  for (const decl of declarations) {
    const value = values.get(decl.name);
    if (value === undefined) continue;
    checkIncludeValueType(decl.name, value, decl.varType, includeName);
  }
}

/**
 * Recursively check that a value matches a declared VarType.
 * Throws TypeMismatchError on mismatch.
 */
function checkIncludeValueType(
  path: string,
  value: Value,
  varType: VarType,
  includeName: string,
): void {
  switch (varType.kind) {
    case TYPE_STR:
      if (value.type !== TYPE_STR) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_STR,
          value.type,
        );
      }
      break;
    case TYPE_BOOL:
      if (value.type !== TYPE_BOOL) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_BOOL,
          value.type,
        );
      }
      break;
    case TYPE_INT:
      if (value.type !== TYPE_INT) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_INT,
          value.type,
        );
      }
      break;
    case TYPE_FLOAT:
      if (value.type !== TYPE_FLOAT && value.type !== TYPE_INT) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_FLOAT,
          value.type,
        );
      }
      break;
    case TYPE_LIST:
      if (value.type !== TYPE_LIST) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_LIST,
          value.type,
        );
      }
      break;
    case "scalar_list":
      if (value.type !== TYPE_LIST) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_LIST,
          value.type,
        );
      }
      break;
    case TYPE_TMPL:
    case TYPE_STRUCT:
      if (value.type !== TYPE_STRUCT) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_STRUCT,
          value.type,
        );
      }
      break;
    case TYPE_OPTION:
      if (value.type === TYPE_NONE) break;
      checkIncludeValueType(path, value, varType.innerType, includeName);
      break;
    case TYPE_ENUM:
      if (value.type === TYPE_STR) {
        // Validate that the string matches a valid variant name.
        const validVariants = varType.variants.map((v) => v.name);
        if (!validVariants.includes(value.value)) {
          throw new TypeMismatchError(
            `${path} (in include '${includeName}')`,
            `enum variant (${validVariants.join(" | ")})`,
            `str "${value.value}"`,
          );
        }
      } else if (value.type !== TYPE_STRUCT) {
        throw new TypeMismatchError(
          `${path} (in include '${includeName}')`,
          TYPE_ENUM,
          value.type,
        );
      }
      break;
    case "alias":
    case "untyped_list":
      // Cannot validate without alias resolution context; skip
      break;
  }
}
