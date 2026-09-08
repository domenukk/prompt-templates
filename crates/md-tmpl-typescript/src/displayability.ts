import { TemplateSyntaxError } from "./errors.js";
import type { VarDecl, VarType } from "./frontmatter.js";
import {
  TYPE_STR,
  TYPE_BOOL,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_LIST,
  TYPE_STRUCT,
  TYPE_ENUM,
  TYPE_TMPL,
  TYPE_OPTION,
  TYPE_ALIAS,
  TYPE_SCALAR_LIST,
  TYPE_UNTYPED_LIST,
  PIPE,
  QUOTE_DOUBLE,
  QUOTE_SINGLE,
  OPTION_SOME,
  MATCH_DEFAULT,
  DOT,
  OP_IN_SPACED,
  NODE_EXPR,
  NODE_IF,
  NODE_MATCH,
  NODE_FOR,
} from "./consts.js";

// ---------------------------------------------------------------------------
// Type environment for flow-sensitive narrowing
// ---------------------------------------------------------------------------
// Compile-time displayability check (with flow-sensitive narrowing)
// ---------------------------------------------------------------------------

/** Scalar types that can appear in {{ expr }} interpolations. */
function isDisplayableType(ty: VarType): boolean {
  // Alias types can't be resolved here (we'd need the full type alias map).
  // Conservatively allow them — the resolved type may be scalar.
  if (ty.kind === TYPE_ALIAS) return true;
  // Enum types with only unit variants (no fields) are displayable since
  // they're just string values at runtime (e.g., enum(admin, guest)).
  if (ty.kind === TYPE_ENUM) {
    return ty.variants.every((v) => v.fields.length === 0);
  }
  return (
    ty.kind === TYPE_STR ||
    ty.kind === TYPE_INT ||
    ty.kind === TYPE_FLOAT ||
    ty.kind === TYPE_BOOL
  );
}

/** Built-in functions that always return a scalar (displayable) value. */
const SCALAR_FUNCTIONS = new Set(["len", "idx", "kind", "has", TYPE_STR]);

/** Human-readable label for a VarType. */
function varTypeLabel(ty: VarType): string {
  switch (ty.kind) {
    case TYPE_LIST:
    case TYPE_SCALAR_LIST:
    case TYPE_UNTYPED_LIST:
      return TYPE_LIST;
    case TYPE_TMPL:
    case TYPE_STRUCT:
      return TYPE_STRUCT;
    case TYPE_ENUM:
      return TYPE_ENUM;
    case TYPE_OPTION:
      return TYPE_OPTION;
    default:
      return ty.kind;
  }
}

/** Hint message for non-displayable types. */
function displayHint(ty: VarType): string {
  switch (ty.kind) {
    case TYPE_LIST:
    case TYPE_SCALAR_LIST:
    case TYPE_UNTYPED_LIST:
      return "use {% for %} to iterate, or | join()";
    case TYPE_TMPL:
    case TYPE_STRUCT:
      return "access fields with dot notation, e.g. {{ x.field }}";
    case TYPE_ENUM:
      return "use kind(x) for the variant name, or {% match %}";
    case TYPE_OPTION:
      return "use {% if has(x) %} to unwrap, or {% match %}";
    default:
      return "only str, int, float, bool can be displayed";
  }
}

/**
 * Returns a diagnostic message if `ty` has no truthiness and therefore cannot
 * be used directly as a bare `{% if %}` / `{% elif %}` condition. `struct`,
 * (non-option) `enum`, and `tmpl` have no truthiness; all other types do.
 * Mirrors the Rust core's `non_truthy_message`.
 */
function nonTruthyMessage(ty: VarType): string | undefined {
  if (ty.kind === TYPE_STRUCT) {
    return "cannot evaluate truthiness of struct — access a field or compare it instead";
  }
  if (ty.kind === TYPE_ENUM && !ty.isOption) {
    return "cannot evaluate truthiness of enum — use {% match %} instead";
  }
  if (ty.kind === TYPE_TMPL) {
    return "cannot evaluate truthiness of template handle — use {% include %} instead";
  }
  if (ty.kind === TYPE_OPTION || (ty.kind === TYPE_ENUM && ty.isOption)) {
    return "cannot evaluate truthiness of option — use has(x) to check presence";
  }
  return undefined;
}

// ---------------------------------------------------------------------------

/**
 * Immutable type environment that tracks declarations and narrowings.
 * Each scope level can override types for specific variable paths.
 */
class TypeEnv {
  private readonly decls: readonly VarDecl[];
  private readonly narrowings: ReadonlyMap<string, VarType>;
  private readonly typeAliases?: ReadonlyMap<string, VarType>;

  constructor(
    decls: readonly VarDecl[],
    narrowings?: ReadonlyMap<string, VarType>,
    typeAliases?: ReadonlyMap<string, VarType>,
  ) {
    this.decls = decls;
    this.narrowings = narrowings ?? new Map();
    this.typeAliases = typeAliases;
  }

  /** Create a new env with an additional narrowing. */
  withNarrowing(path: string, ty: VarType): TypeEnv {
    const next = new Map(this.narrowings);
    next.set(path, ty);
    return new TypeEnv(this.decls, next, this.typeAliases);
  }

  /** Create a new env with an additional variable binding (e.g. for-loop). */
  withBinding(name: string, ty: VarType): TypeEnv {
    const nextDecls = [...this.decls, { name, varType: ty }];
    return new TypeEnv(nextDecls, this.narrowings, this.typeAliases);
  }

  /**
   * Resolve the type of a dotted path expression.
   *
   * Returns `undefined` if the path cannot be resolved (unknown variable,
   * unresolvable field). Only returns a concrete VarType when the full path
   * can be statically typed.
   */
  resolveExprType(expr: string): VarType | undefined {
    // If filters are applied, skip — filters may transform the type.
    if (expr.includes(PIPE)) return undefined;

    const pathStr = expr.trim();

    // Skip string/numeric literals
    if (
      pathStr.startsWith(QUOTE_DOUBLE) ||
      pathStr.startsWith(QUOTE_SINGLE) ||
      /^\d/.test(pathStr)
    ) {
      return undefined;
    }

    // Skip built-in functions — they return scalars. Match a leading
    // `name(` function-call form and check it against the scalar builtins.
    const funcMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(pathStr);
    const funcName = funcMatch?.[1];
    if (funcName !== undefined && SCALAR_FUNCTIONS.has(funcName)) {
      return undefined;
    }

    // Check narrowings first (full path match)
    const narrowed = this.narrowings.get(pathStr);
    if (narrowed !== undefined) return narrowed;

    // Split dotted path: "user.address.city" → ["user", "address", "city"]
    const parts = pathStr.split(DOT);
    const root = parts[0];
    if (root === undefined) return undefined;

    // Check if a prefix is narrowed (e.g. "x" narrowed, resolving "x.field")
    const rootNarrowed = this.narrowings.get(root);
    let currentType: VarType;
    if (rootNarrowed !== undefined) {
      currentType = rootNarrowed;
    } else {
      const rootDecl = this.decls.find((d) => d.name === root);
      if (!rootDecl) {
        const alias = this.typeAliases?.get(root);
        if (!alias) return undefined;
        currentType = alias;
      } else {
        currentType = rootDecl.varType;
      }
    }

    while (currentType.kind === TYPE_ALIAS && this.typeAliases) {
      const aliasType = this.typeAliases.get(currentType.name);
      if (!aliasType) break;
      currentType = aliasType;
    }

    // Walk remaining path segments
    for (let i = 1; i < parts.length; i++) {
      const field = parts[i];
      if (field === undefined) continue;
      const resolved = resolveFieldType(currentType, field);
      if (resolved === undefined) return undefined;
      currentType = resolved;
      while (currentType.kind === TYPE_ALIAS && this.typeAliases) {
        const aliasType = this.typeAliases.get(currentType.name);
        if (!aliasType) break;
        currentType = aliasType;
      }
    }

    return currentType;
  }
}

/**
 * Resolve a field access on a type. Returns the field's type,
 * or undefined if the type doesn't support field access.
 */
function resolveFieldType(ty: VarType, field: string): VarType | undefined {
  switch (ty.kind) {
    case TYPE_TMPL:
    case TYPE_STRUCT:
    case TYPE_LIST: {
      const fieldDecl = ty.fields.find((f) => f.name === field);
      return fieldDecl?.varType;
    }
    case TYPE_ENUM: {
      // A field is accessible if ALL variants have it
      const allHave = ty.variants.every((v) =>
        v.fields.some((f) => f.name === field),
      );
      if (!allHave) return undefined;
      for (const v of ty.variants) {
        const f = v.fields.find((f) => f.name === field);
        if (f) return f.varType;
      }
      return undefined;
    }
    case TYPE_OPTION: {
      // Transparent access through option: option(struct(x = str)).x → str
      return resolveFieldType(ty.innerType, field);
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Flow-sensitive AST walker
// ---------------------------------------------------------------------------

/**
 * Extract has() narrowing from a condition string.
 *
 * If the condition is `has(path)`, and `path` resolves to `option(T)` in the
 * current environment, returns `[path, T]` — the narrowed type.
 */
function extractHasNarrowing(
  condition: string,
  env: TypeEnv,
): [string, VarType] | undefined {
  const trimmed = condition.trim();
  const match = /^has\(\s*([^)]+?)\s*\)$/.exec(trimmed);
  if (!match?.[1]) return undefined;
  const path = match[1].trim();

  const ty = env.resolveExprType(path);
  if (!ty) return undefined;

  if (ty.kind === TYPE_OPTION) {
    return [path, ty.innerType];
  }

  if (ty.kind === TYPE_ENUM && ty.isOption) {
    const someVariant = ty.variants.find((v) => v.name === OPTION_SOME);
    if (someVariant?.fields.length === 1) {
      const someField = someVariant.fields[0];
      if (someField !== undefined) {
        return [path, someField.varType];
      }
    }
  }

  return undefined;
}

function extractAllHasNarrowings(
  condition: string,
  env: TypeEnv,
): [string, VarType][] {
  const results: [string, VarType][] = [];
  const opIdx = findTopLevelOp(condition, ["&&"]);
  if (opIdx !== -1) {
    const left = condition.slice(0, opIdx).trim();
    const right = condition.slice(opIdx + 2).trim();
    results.push(...extractAllHasNarrowings(left, env));
    results.push(...extractAllHasNarrowings(right, env));
  } else {
    const n = extractHasNarrowing(condition, env);
    if (n) results.push(n);
  }
  return results;
}

/**
 * Extract !has() or !option_var negative narrowing.
 * When `!has(path)` or `!path` occurs in a branch, `path: option(T)` is proven
 * to be `Some(T)` in all subsequent fall-through branches and `else` blocks.
 */
function extractNotHasNarrowing(
  condition: string,
  env: TypeEnv,
): [string, VarType] | undefined {
  const trimmed = condition.trim();
  if (trimmed.startsWith("!")) {
    const inner = trimmed.slice(1).trim();
    return extractHasNarrowing(inner, env);
  }
  return undefined;
}

interface ValidationError {
  message: string;
  loc?: import("./parser.js").SourceLocation;
}

/** Validate static condition checks at compile time (e.g., literal in kinds(Enum), condition operand types). */
function validateStaticCondition(
  condition: string,
  env: TypeEnv,
  errors: ValidationError[],
  loc?: import("./parser.js").SourceLocation,
): void {
  const trimmed = condition.trim();

  const inIdx = trimmed.indexOf(OP_IN_SPACED);
  if (inIdx !== -1) {
    const left = trimmed.slice(0, inIdx).trim();
    const right = trimmed.slice(inIdx + OP_IN_SPACED.length).trim();
    const kindsMatch = /^kinds\(\s*([a-zA-Z0-9_-]+)\s*\)$/.exec(right);
    if (kindsMatch?.[1] !== undefined) {
      const enumName = kindsMatch[1];
      const enumType = env.resolveExprType(enumName);
      if (enumType?.kind === TYPE_ENUM) {
        if (left.startsWith('"') && left.endsWith('"') && left.length >= 2) {
          const strVal = left.slice(1, -1);
          if (!enumType.variants.some((v) => v.name === strVal)) {
            errors.push({
              message: `static string "${strVal}" is not a valid variant of enum '${enumName}'`,
              loc,
            });
          }
        }
      }
    }
  }

  function checkLeaf(sub: string, currentEnv: TypeEnv): void {
    let s = sub.trim();
    while (s.startsWith("(") && s.endsWith(")")) {
      s = s.slice(1, -1).trim();
    }
    while (s.startsWith("!")) {
      s = s.slice(1).trim();
      while (s.startsWith("(") && s.endsWith(")")) {
        s = s.slice(1, -1).trim();
      }
    }
    if (!s) return;

    const opIdx = findTopLevelOp(s, ["&&", "||"]);
    if (opIdx !== -1) {
      const op = s.slice(opIdx, opIdx + 2);
      const leftStr = s.slice(0, opIdx).trim();
      const rightStr = s.slice(opIdx + 2).trim();
      checkLeaf(leftStr, currentEnv);
      let rightEnv = currentEnv;
      if (op === "&&") {
        const hasMatch = /^has\(\s*([^)]+?)\s*\)$/.exec(leftStr);
        if (hasMatch?.[1]) {
          const target = hasMatch[1].trim();
          const targetType = currentEnv.resolveExprType(target);
          if (
            targetType &&
            (targetType.kind === TYPE_OPTION ||
              (targetType.kind === TYPE_ENUM && targetType.isOption))
          ) {
            const inner =
              targetType.kind === TYPE_OPTION
                ? targetType.innerType
                : targetType.variants.find((v) => v.name === "Some")?.fields[0]
                    ?.varType;
            if (inner) {
              rightEnv = currentEnv.withNarrowing(target, inner);
            }
          }
        }
      }
      checkLeaf(rightStr, rightEnv);
      return;
    }

    if (
      s.includes("==") ||
      s.includes("!=") ||
      s.includes("<") ||
      s.includes(">") ||
      s.includes(" in ") ||
      s.startsWith("match ")
    ) {
      return;
    }

    const hasMatch = /^has\(\s*([^)]+?)\s*\)$/.exec(s);
    if (hasMatch?.[1] !== undefined) {
      const target = hasMatch[1].trim();
      const targetType = currentEnv.resolveExprType(target);
      if (targetType) {
        const isOpt =
          targetType.kind === TYPE_OPTION ||
          (targetType.kind === TYPE_ENUM && targetType.isOption);
        if (!isOpt) {
          errors.push({
            message: `'has()' requires an option type (e.g. 'option(str)'), got ${varTypeLabel(targetType)} on '${target}' — for string or list presence, use bare condition ('if ${target}'), '!= ""', or 'len(...) > 0'`,
            loc,
          });
        }
      }
      return;
    }

    // Bare truthiness: struct, enum (non-option), tmpl, and option have no
    // truthiness and cannot be used directly as a condition.
    const leafType = currentEnv.resolveExprType(s);
    if (leafType) {
      const nonTruthy = nonTruthyMessage(leafType);
      if (nonTruthy) {
        errors.push({
          message: `type error in condition: ${nonTruthy}, got ${varTypeLabel(leafType)}`,
          loc,
        });
      }
    }
  }

  checkLeaf(trimmed, env);
}

function findTopLevelOp(str: string, ops: string[]): number {
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < str.length - 1; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === stringChar && str[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (parenDepth === 0) {
      const pair = str.slice(i, i + 2);
      if (ops.includes(pair)) return i;
    }
  }
  return -1;
}

/**
 * Walk AST nodes with flow-sensitive narrowing, collecting displayability errors.
 *
 * This is the core of the compile-time type checker for the TS backend.
 * It mirrors the Rust `walk_segments` + `validate_compiled_path` logic.
 */
function walkNodesWithNarrowing(
  nodes: readonly import("./parser.js").Node[],
  env: TypeEnv,
  errors: ValidationError[],
): void {
  for (const node of nodes) {
    switch (node.kind) {
      case NODE_EXPR: {
        const resolvedType = env.resolveExprType(node.expr);
        if (resolvedType === undefined) continue;
        if (!isDisplayableType(resolvedType)) {
          const hint = displayHint(resolvedType);
          errors.push({
            message: `'${node.expr.trim()}': cannot display value of type ${varTypeLabel(resolvedType)} — ${hint}`,
            loc: node.loc,
          });
        }
        break;
      }

      case NODE_IF: {
        let currentEnv = env;
        for (const branch of node.branches) {
          validateStaticCondition(
            branch.condition,
            currentEnv,
            errors,
            node.loc,
          );
          const posNarrowings = extractAllHasNarrowings(
            branch.condition,
            currentEnv,
          );
          let branchBodyEnv = currentEnv;
          for (const [path, innerType] of posNarrowings) {
            branchBodyEnv = branchBodyEnv.withNarrowing(path, innerType);
          }
          walkNodesWithNarrowing(branch.body, branchBodyEnv, errors);

          const negNarrowing = extractNotHasNarrowing(
            branch.condition,
            currentEnv,
          );
          if (negNarrowing) {
            currentEnv = currentEnv.withNarrowing(
              negNarrowing[0],
              negNarrowing[1],
            );
          }
        }
        if (node.elseBody) {
          walkNodesWithNarrowing(node.elseBody, currentEnv, errors);
        }
        break;
      }

      case NODE_MATCH: {
        const exprPath = node.expr.trim();
        const exprType = env.resolveExprType(exprPath);

        if (exprType?.kind === TYPE_ENUM) {
          // Narrow each arm to only the matched variant(s)
          for (const arm of node.arms) {
            const matchedVariants = exprType.variants.filter((v) =>
              arm.variants.includes(v.name),
            );
            if (matchedVariants.length > 0) {
              const narrowedType: VarType = {
                kind: TYPE_ENUM,
                variants: matchedVariants,
              };
              const narrowedEnv = env.withNarrowing(exprPath, narrowedType);
              walkNodesWithNarrowing(arm.body, narrowedEnv, errors);
            } else if (
              arm.variants.length === 1 &&
              arm.variants[0] === MATCH_DEFAULT
            ) {
              // Default arm — no narrowing
              walkNodesWithNarrowing(arm.body, env, errors);
            } else {
              walkNodesWithNarrowing(arm.body, env, errors);
            }
          }
          if (
            node.arms.length > 1 &&
            !node.elseArm &&
            !node.arms.some((a) => a.variants.includes(MATCH_DEFAULT))
          ) {
            const covered = new Set<string>();
            for (const arm of node.arms) {
              for (const v of arm.variants) covered.add(v);
            }
            const missing = exprType.variants
              .filter((v) => !covered.has(v.name))
              .map((v) => v.name);
            if (missing.length > 0) {
              const cases = missing.map((m) => `{% case ${m} %}`).join(" ");
              const suggestion =
                missing.length > 1
                  ? `Try adding explicit arms: ${cases} or combined arm: {% case ${missing.join(" | ")} %}`
                  : `Try adding explicit arm: ${cases}`;
              errors.push({
                message: `match on '${exprPath}': non-exhaustive — missing variant(s): ${missing.join(", ")}. ${suggestion}`,
                loc: node.loc,
              });
            }
          }
        } else if (exprType?.kind === TYPE_OPTION) {
          for (const arm of node.arms) {
            if (arm.variants.includes(OPTION_SOME)) {
              // Narrow option to inner type
              const narrowedEnv = env.withNarrowing(
                exprPath,
                exprType.innerType,
              );
              walkNodesWithNarrowing(arm.body, narrowedEnv, errors);
            } else {
              walkNodesWithNarrowing(arm.body, env, errors);
            }
          }
        } else {
          // Can't resolve match expression type — walk arms without narrowing
          for (const arm of node.arms) {
            walkNodesWithNarrowing(arm.body, env, errors);
          }
        }

        if (node.elseArm) {
          walkNodesWithNarrowing(node.elseArm, env, errors);
        }

        // Inline guard
        if (node.inlineGuard) {
          const guard = node.inlineGuard;
          if (exprType?.kind === TYPE_ENUM) {
            const matchedVariants = exprType.variants.filter(
              (v) => v.name === guard.variant,
            );
            if (matchedVariants.length > 0) {
              const narrowedType: VarType = {
                kind: TYPE_ENUM,
                variants: matchedVariants,
              };
              const narrowedEnv = env.withNarrowing(exprPath, narrowedType);
              walkNodesWithNarrowing(
                node.inlineGuard.body,
                narrowedEnv,
                errors,
              );
            } else {
              walkNodesWithNarrowing(node.inlineGuard.body, env, errors);
            }
          } else {
            walkNodesWithNarrowing(node.inlineGuard.body, env, errors);
          }
        }
        break;
      }

      case NODE_FOR: {
        // Resolve the iterator expression type to determine element type
        const iterType = env.resolveExprType(node.iterExpr);
        if (iterType) {
          let elementType: VarType | undefined;
          if (iterType.kind === TYPE_LIST) {
            // list(name = str, ...) → struct(name = str, ...)
            elementType = { kind: TYPE_STRUCT, fields: iterType.fields };
          } else if (iterType.kind === TYPE_SCALAR_LIST) {
            elementType = iterType.elementType;
          } else if (iterType.kind === TYPE_UNTYPED_LIST) {
            // Can't determine element type
            elementType = undefined;
          }
          if (elementType) {
            const forEnv = env.withBinding(node.binding, elementType);
            walkNodesWithNarrowing(node.body, forEnv, errors);
          } else {
            walkNodesWithNarrowing(node.body, env, errors);
          }
        } else {
          walkNodesWithNarrowing(node.body, env, errors);
        }

        if (node.elseBody) {
          walkNodesWithNarrowing(node.elseBody, env, errors);
        }
        break;
      }

      default:
        // text, comment, raw, include, tmpl — no expressions to check
        break;
    }
  }
}

/**
 * Validate that all `{{ expr }}` interpolations resolve to displayable
 * (scalar) types, with proper flow-sensitive narrowing through:
 *
 * - `{% if has(x) %}` — narrows `option(T)` to `T` in the true branch
 * - `{% match x %}{% case V %}` — narrows enum to matched variant
 * - `{% for item in list %}` — introduces element binding
 *
 * This is a compile-time check — called during `fromSource()`.
 *
 * @param nodes - Parsed AST nodes from the template body.
 * @param declarations - Parameter declarations from frontmatter.
 * @param consts - Constant declarations from frontmatter.
 * @param typeAliases - Type alias map from frontmatter.
 * @param importedNamespaceTypes - Typed import namespace map (stem → struct type).
 * @throws {TemplateSyntaxError} If an expression resolves to a non-displayable type.
 */
export function validateDisplayability(
  nodes: readonly import("./parser.js").Node[],
  declarations: readonly VarDecl[],
  consts?: readonly VarDecl[],
  typeAliases?: ReadonlyMap<string, VarType>,
  importedNamespaceTypes?: ReadonlyMap<string, VarType>,
): void {
  const allDecls: VarDecl[] = consts
    ? [...declarations, ...consts]
    : [...declarations];
  // Register typed import stems as declarations so the type checker can
  // resolve field accesses on imported consts (e.g. `artist.SEVERITY_LADDER`).
  if (importedNamespaceTypes) {
    for (const [stem, nsType] of importedNamespaceTypes) {
      allDecls.push({ name: stem, varType: nsType });
    }
  }
  const env = new TypeEnv(allDecls, undefined, typeAliases);
  const errors: ValidationError[] = [];

  walkNodesWithNarrowing(nodes, env, errors);

  if (errors.length > 0) {
    const err = errors[0];
    if (err !== undefined) {
      throw new TemplateSyntaxError(
        err.message,
        err.loc?.line,
        err.loc?.column,
        err.loc?.snippet,
      );
    }
  }
}
