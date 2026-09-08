/**
 * AST node rendering for md-tmpl templates against a layered scope.
 */

import type { Node } from "./ast.js";
import { Scope } from "./scope.js";
import {
  evaluateExpression,
  evaluateCondition,
  validateIncludeTypes,
  getVariantName,
  isOptionMatchNode,
} from "./evaluator.js";
import { parseBody } from "./parser.js";
import { parseFrontmatter } from "./frontmatter.js";
import { type Value, type TmplRef, display, TYPE_TMPL } from "./value.js";
import {
  TemplateError,
  TemplateSyntaxError,
  TemplatePanicError,
  UndefinedVariableError,
  IncludeNotFoundError,
} from "./errors.js";
import {
  type VarDecl,
  varTypeToString,
  stripStringLiteral,
} from "./frontmatter.js";
import {
  PIPE,
  TYPE_LIST,
  TYPE_STR,
  TYPE_STRUCT,
  TYPE_OPTION,
  TYPE_NONE,
  OPTION_SOME,
  NODE_TEXT,
  NODE_EXPR,
  NODE_COMMENT,
  NODE_FOR,
  NODE_IF,
  NODE_MATCH,
  NODE_RAW,
  NODE_INCLUDE,
  NODE_TMPL,
  NODE_PANIC,
  EXPR_START,
  EXPR_END,
  isValidResolvedPath,
  PREFIX_CONSTS_DOT,
  PREFIX_OPTS_DOT,
  PREFIX_OPTIONS_DOT,
  PREFIX_PARAMS_DOT,
  unescapeStringLiteral,
} from "./consts.js";

/**
 * Strip surrounding quotes from a case label if present and unescape it.
 * `"foo"` or `'foo'` → `foo`; `Active` → `Active`. Escaped quotes inside the
 * literal are unescaped to mirror Rust's matching label handling.
 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return unescapeStringLiteral(s.slice(1, -1));
    }
  }
  return s;
}

/** Check if a string is surrounded by quotes. */
function isQuotedLabel(s: string): boolean {
  if (s.length < 2) return false;
  return (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  );
}

/**
 * Extract the argument from a simple `has(x)` condition.
 * Returns the trimmed argument name or undefined if the condition is not
 * a bare `has(...)` call (e.g. contains `&&`, `||`, or `!`).
 */
function extractHasArg(condition: string): string | undefined {
  const trimmed = condition.trim();
  if (trimmed.startsWith("has(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(4, -1).trim();
    // Only simple identifiers/dotted paths — reject compound conditions
    if (inner.length > 0 && !inner.includes(" ")) {
      return inner;
    }
  }
  return undefined;
}

function extractNegatedHasArg(condition: string): string | undefined {
  const trimmed = condition.trim();
  if (trimmed.startsWith("!has(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(5, -1).trim();
    if (inner.length > 0 && !inner.includes(" ")) {
      return inner;
    }
  }
  return undefined;
}

/**
 * Check if a case arm label matches the active variant.
 *
 * Matching rules:
 * - Quoted label (`"Active"`): strip quotes, compare literally
 * - Unquoted label equal to variant: matches (enum variant name)
 * - Unquoted label (param-ref): resolve from scope, compare the
 *   resolved string value against `activeVariant`
 */
function armLabelMatches(
  label: string,
  variant: string,
  scope: Scope,
): boolean {
  // Quoted string literal: strip quotes and compare (with interpolation).
  if (isQuotedLabel(label)) {
    const inner = stripQuotes(label);
    if (inner.includes(EXPR_START)) {
      // Contains {{ expr }} — parse and render the interpolated string.
      try {
        const nodes = parseBody(inner, false, 0);
        const rendered = renderNodes(nodes, scope);
        return rendered === variant;
      } catch {
        return false;
      }
    }
    return inner === variant;
  }
  // Direct comparison (enum variant name, wildcard, etc.).
  if (label === variant) {
    return true;
  }
  // Param-ref: resolve label as a variable and compare its string value.
  try {
    const resolved = scope.resolvePath(label);
    if (resolved.type === TYPE_STR) {
      return resolved.value === variant;
    }
  } catch {
    // Label is not a resolvable variable — no match.
  }
  return false;
}

export interface RenderOptions {
  /** Inline template definitions available for `{% include %}`. */
  inlineTemplates?: Map<
    string,
    {
      declarations: readonly VarDecl[];
      body: string;
      consts: Map<string, Value>;
    }
  >;
  /** Loader for file inclusions `{% include "path" %}`. */
  templateLoader?: (
    path: string,
    basePath?: string,
  ) =>
    | [readonly Node[], ReadonlyMap<string, Value>, readonly VarDecl[], string?]
    | undefined;
  /** Current base directory path for resolving relative includes. */
  currentBasePath?: string;
  /** Maximum recursion depth for file includes (default 16). */
  maxIncludeDepth?: number;
}

/**
 * Render AST nodes against a scope and options.
 */
export function renderNodes(
  nodes: readonly Node[],
  scope: Scope,
  options?: RenderOptions,
): string {
  const parts: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined) continue;
    switch (node.kind) {
      case NODE_TEXT:
        parts.push(node.text);
        break;

      case NODE_EXPR: {
        if (node.trimBefore && parts.length > 0) {
          const last = parts[parts.length - 1];
          if (last !== undefined) {
            parts[parts.length - 1] = last.replace(/\s+$/, "");
          }
        }
        const val = evaluateExpression(node.expr, scope);
        if (node.expr.includes(PIPE)) {
          parts.push(display(val));
        } else if (val.type === TYPE_LIST) {
          throw new TemplateError(
            `cannot display list '${node.expr}' directly; use a {% for %} loop or | join() filter`,
          );
        } else if (val.type === TYPE_STRUCT) {
          throw new TemplateError(
            `cannot display struct '${node.expr}' directly; access specific fields`,
          );
        } else {
          parts.push(display(val));
        }
        if (node.trimAfter) {
          const nextNode = nodes[i + 1];
          if (nextNode?.kind === "text") {
            parts.push(nextNode.text.replace(/^[ \t]*(?:\r?\n)?/, ""));
            i++;
          }
        }
        break;
      }

      case NODE_COMMENT:
        break;

      case NODE_FOR: {
        const listVal = evaluateExpression(node.iterExpr, scope);
        if (listVal.type !== TYPE_LIST) {
          throw new TemplateSyntaxError(
            `for loop requires list, got ${listVal.type}`,
          );
        }
        if (listVal.items.length === 0) {
          if (node.elseBody) {
            parts.push(renderNodes(node.elseBody, scope, options));
          }
        } else {
          const layer = scope.pushLayer();
          try {
            for (let idx = 0; idx < listVal.items.length; idx++) {
              const item = listVal.items[idx];
              if (item === undefined) continue;
              layer.set(node.binding, item);
              scope.setLoopMeta(node.binding, { index: idx });
              parts.push(renderNodes(node.body, scope, options));
            }
          } finally {
            scope.popLayer();
          }
        }
        break;
      }

      case NODE_IF: {
        let matched = false;
        for (const branch of node.branches) {
          if (evaluateCondition(branch.condition, scope)) {
            // If the condition is a simple `has(x)` guard, narrow the option
            // param so inner match blocks see the unwrapped value.
            const hasArg = extractHasArg(branch.condition);
            if (hasArg && scope.isOptionParam(hasArg)) {
              scope.pushLayer();
              try {
                scope.narrowOption(hasArg);
                parts.push(renderNodes(branch.body, scope, options));
              } finally {
                scope.popLayer();
              }
            } else {
              parts.push(renderNodes(branch.body, scope, options));
            }
            matched = true;
            break;
          }
        }
        if (!matched && node.elseBody) {
          const negHasArg =
            node.branches.length === 1 && node.branches[0]
              ? extractNegatedHasArg(node.branches[0].condition)
              : undefined;
          if (negHasArg && scope.isOptionParam(negHasArg)) {
            scope.pushLayer();
            try {
              scope.narrowOption(negHasArg);
              parts.push(renderNodes(node.elseBody, scope, options));
            } finally {
              scope.popLayer();
            }
          } else {
            parts.push(renderNodes(node.elseBody, scope, options));
          }
        }
        break;
      }

      case NODE_MATCH: {
        const val = scope.resolvePath(node.expr);
        const isOpt = isOptionMatchNode(node) || scope.isOptionParam(node.expr);
        const variant = getVariantName(val, isOpt);

        if (node.inlineGuard) {
          const label = node.inlineGuard.variant;
          const guardMatches = armLabelMatches(label, variant, scope);
          if (guardMatches) {
            const layer = scope.pushLayer();
            try {
              if (variant === OPTION_SOME && val.type !== TYPE_NONE) {
                layer.set(node.expr, val);
                scope.narrowOption(node.expr);
              }
              parts.push(renderNodes(node.inlineGuard.body, scope, options));
            } finally {
              scope.popLayer();
            }
          } else if (node.elseArm) {
            parts.push(renderNodes(node.elseArm, scope, options));
          }
          break;
        }

        let matched = false;
        for (const arm of node.arms) {
          const armMatches = arm.variants.some((v) =>
            armLabelMatches(v, variant, scope),
          );
          if (armMatches) {
            const layer = scope.pushLayer();
            try {
              if (
                arm.variants.length === 1 &&
                arm.variants[0] === OPTION_SOME &&
                variant === OPTION_SOME &&
                val.type !== TYPE_NONE
              ) {
                layer.set(node.expr, val);
                scope.narrowOption(node.expr);
              }
              // If the arm has a guard, evaluate it
              if (arm.guard && !evaluateCondition(arm.guard, scope)) {
                continue;
              }
              parts.push(renderNodes(arm.body, scope, options));
            } finally {
              scope.popLayer();
            }
            matched = true;
            break;
          }
        }
        if (!matched && node.elseArm) {
          parts.push(renderNodes(node.elseArm, scope, options));
        }
        break;
      }

      case NODE_RAW:
        parts.push(node.text);
        break;

      case NODE_INCLUDE: {
        const maxDepth = options?.maxIncludeDepth ?? 16;
        let includedNodes: readonly Node[];
        let decls: readonly VarDecl[];
        let consts: ReadonlyMap<string, Value>;
        let fileChildOpts: RenderOptions | undefined;

        if (node.path !== undefined) {
          const resolvedPath = interpolateIncludePath(node.path, scope);
          if (!options?.templateLoader) {
            throw new TemplateError(
              `cannot resolve '{% include "${resolvedPath}" %}': file includes require a base directory (compile with fromFile or baseDir option)`,
            );
          }
          const loaded = options.templateLoader(
            resolvedPath,
            options.currentBasePath,
          );
          if (!loaded) {
            throw new IncludeNotFoundError(resolvedPath);
          }
          const [loadedNodes, loadedConsts, loadedDecls, loadedBasePath] =
            loaded;
          includedNodes = loadedNodes;
          decls = loadedDecls;
          consts = loadedConsts;
          // Scope inline templates to the child file: collect the child's
          // own {% tmpl %} definitions, NOT the parent's. (SPEC: "no leaking
          // downward")
          const childInline = collectChildInlineTemplates(loadedNodes);
          fileChildOpts = {
            ...options,
            inlineTemplates: childInline.size > 0 ? childInline : undefined,
            currentBasePath: loadedBasePath ?? options.currentBasePath,
            maxIncludeDepth: maxDepth - 1,
          };
        } else {
          // Try to resolve name from scope as a higher-order TmplValue
          let tmplRef: TmplRef | undefined;
          try {
            const resolved = scope.resolvePath(node.name);
            if (resolved.type === TYPE_TMPL) {
              tmplRef = resolved.ref;
            }
          } catch {
            // Not in scope — fall through to inline templates
          }

          if (tmplRef) {
            // Higher-order template: collect params and delegate to renderForInclude
            if (maxDepth <= 0) {
              throw new TemplateError(
                `maximum include depth exceeded when including '${node.name}'`,
              );
            }
            if (node.forBinding && node.forExpr) {
              const listVal = evaluateExpression(node.forExpr, scope);
              if (listVal.type !== TYPE_LIST) {
                throw new TemplateSyntaxError(
                  `include ... for ... in requires list, got ${listVal.type}`,
                );
              }
              const results: string[] = [];
              for (const item of listVal.items) {
                const iterCtx = new Map<string, Value>();
                iterCtx.set(node.forBinding, item);
                for (const [targetKey, sourceExpr] of node.withMappings) {
                  iterCtx.set(targetKey, evaluateExpression(sourceExpr, scope));
                }
                results.push(
                  tmplRef.renderForInclude(
                    iterCtx,
                    scope.allConsts(),
                    scope.optionParamNames(),
                    maxDepth - 1,
                    options?.templateLoader,
                    options?.currentBasePath,
                  ),
                );
              }
              parts.push(results.join(""));
              break;
            }
            const childCtx = new Map<string, Value>();
            for (const [targetKey, sourceExpr] of node.withMappings) {
              childCtx.set(targetKey, evaluateExpression(sourceExpr, scope));
            }
            parts.push(
              tmplRef.renderForInclude(
                childCtx,
                scope.allConsts(),
                scope.optionParamNames(),
                maxDepth - 1,
                options?.templateLoader,
                options?.currentBasePath,
              ),
            );
            break;
          }

          const inline = options?.inlineTemplates?.get(node.name);
          if (!inline) {
            throw new TemplateError(
              `undefined inline template '${node.name}' (available: ${Array.from(options?.inlineTemplates?.keys() ?? []).join(", ")})`,
            );
          }
          includedNodes = parseBody(inline.body, true);
          decls = inline.declarations;
          consts = inline.consts;
          fileChildOpts = {
            ...options,
            maxIncludeDepth: maxDepth - 1,
          };
        }

        if (maxDepth <= 0) {
          throw new TemplateError(
            `maximum include depth exceeded when including '${node.path ?? node.name}'`,
          );
        }

        if (node.forBinding && node.forExpr) {
          const listVal = evaluateExpression(node.forExpr, scope);
          if (listVal.type !== TYPE_LIST) {
            throw new TemplateSyntaxError(
              `include ... for ... in requires list, got ${listVal.type}`,
            );
          }
          const results: string[] = [];
          for (const item of listVal.items) {
            const iterCtx = new Map<string, Value>();
            iterCtx.set(node.forBinding, item);
            for (const [targetKey, sourceExpr] of node.withMappings) {
              iterCtx.set(targetKey, evaluateExpression(sourceExpr, scope));
            }
            validateIncludeTypes(decls, iterCtx, node.path ?? node.name);
            for (const decl of decls) {
              if (!iterCtx.has(decl.name) && decl.defaultValue !== undefined) {
                iterCtx.set(decl.name, decl.defaultValue);
              }
            }
            for (const decl of decls) {
              if (!iterCtx.has(decl.name)) {
                if (decl.varType.kind === TYPE_OPTION) {
                  iterCtx.set(decl.name, { type: TYPE_NONE });
                } else {
                  throw new TemplateError(
                    `missing required parameter '${decl.name}' for include '${node.path ?? node.name}' (expected ${varTypeToString(decl.varType)})`,
                  );
                }
              }
            }
            const optParams = new Set<string>();
            for (const decl of decls) {
              if (decl.varType.kind === TYPE_OPTION) {
                optParams.add(decl.name);
              }
            }
            // Merge parent consts into child scope so included templates
            // can reference imported consts (e.g. session_layout.*).
            const mergedConsts = mergeConsts(scope, consts);
            const childScope = new Scope(iterCtx, mergedConsts, optParams);
            results.push(renderNodes(includedNodes, childScope, fileChildOpts));
          }
          parts.push(results.join(""));
          break;
        }

        const childCtx = new Map<string, Value>();
        for (const [targetKey, sourceExpr] of node.withMappings) {
          childCtx.set(targetKey, evaluateExpression(sourceExpr, scope));
        }

        validateIncludeTypes(decls, childCtx, node.path ?? node.name);

        for (const decl of decls) {
          if (!childCtx.has(decl.name) && decl.defaultValue !== undefined) {
            childCtx.set(decl.name, decl.defaultValue);
          }
        }

        for (const decl of decls) {
          if (!childCtx.has(decl.name)) {
            if (decl.varType.kind === TYPE_OPTION) {
              childCtx.set(decl.name, { type: TYPE_NONE });
            } else {
              throw new TemplateError(
                `missing required parameter '${decl.name}' for include '${node.path ?? node.name}' (expected ${varTypeToString(decl.varType)})`,
              );
            }
          }
        }

        const optParams = new Set<string>();
        for (const decl of decls) {
          if (decl.varType.kind === TYPE_OPTION) {
            optParams.add(decl.name);
          }
        }

        // Merge parent consts into child scope so included templates
        // can reference imported consts (e.g. session_layout.*).
        const mergedConsts = mergeConsts(scope, consts);
        const childScope = new Scope(childCtx, mergedConsts, optParams);
        parts.push(renderNodes(includedNodes, childScope, fileChildOpts));
        break;
      }

      case NODE_PANIC: {
        const msg = renderNodes(node.body, scope, options);
        throw new TemplatePanicError(msg.trim());
      }

      case NODE_TMPL:
        // Template definitions are stored at parse time, not rendered inline
        break;
    }
  }

  return parts.join("");
}

/** Check if an unknown error is an UndefinedVariableError. */
function isUndefinedVariableError(err: unknown): boolean {
  return (
    err instanceof UndefinedVariableError ||
    (err instanceof Error && err.message.includes("undefined variable"))
  );
}

/**
 * Extract inline template definitions from a child file's parsed nodes.
 *
 * Each included file gets its own namespace of inline templates.
 * Parent inline templates do NOT leak to included files.
 */
function collectChildInlineTemplates(
  nodes: readonly Node[],
): Map<
  string,
  { declarations: readonly VarDecl[]; body: string; consts: Map<string, Value> }
> {
  const result = new Map<
    string,
    {
      declarations: readonly VarDecl[];
      body: string;
      consts: Map<string, Value>;
    }
  >();
  for (const n of nodes) {
    if (n.kind !== "tmpl") continue;
    if (n.source.trimStart().startsWith("---")) {
      const [inlineFm, inlineBody] = parseFrontmatter(n.source);
      const inlineConsts = new Map<string, Value>();
      for (const decl of inlineFm.consts) {
        if (decl.defaultValue !== undefined) {
          inlineConsts.set(decl.name, decl.defaultValue);
        }
      }
      result.set(n.name, {
        declarations: inlineFm.params,
        body: inlineBody,
        consts: inlineConsts,
      });
    } else {
      result.set(n.name, {
        declarations: [],
        body: n.source,
        consts: new Map(),
      });
    }
  }
  return result;
}

function interpolateIncludePath(path: string, scope: Scope): string {
  if (!path.includes(EXPR_START)) return path;
  let result = "";
  let remaining = path;
  let startIdx = remaining.indexOf(EXPR_START);
  while (startIdx !== -1) {
    result += remaining.slice(0, startIdx);
    const afterStart = remaining.slice(startIdx + EXPR_START.length);
    const endIdx = afterStart.indexOf(EXPR_END);
    if (endIdx === -1) {
      throw new TemplateSyntaxError(
        `unclosed '${EXPR_START}' in include path '${path}'`,
      );
    }
    const expr = afterStart.slice(0, endIdx).trim();
    if (expr === "") {
      throw new TemplateSyntaxError(
        `empty expression '${EXPR_START}${EXPR_END}' in include path '${path}'`,
      );
    }
    let valStr: string;
    const lit = stripStringLiteral(expr);
    if (lit !== expr) {
      valStr = lit;
    } else {
      try {
        let val: Value;
        try {
          val = evaluateExpression(expr, scope);
        } catch (err: unknown) {
          if (isUndefinedVariableError(err)) {
            let stripped = expr;
            if (stripped.startsWith(PREFIX_CONSTS_DOT))
              stripped = stripped.slice(PREFIX_CONSTS_DOT.length).trim();
            else if (stripped.startsWith(PREFIX_OPTS_DOT))
              stripped = stripped.slice(PREFIX_OPTS_DOT.length).trim();
            else if (stripped.startsWith(PREFIX_OPTIONS_DOT))
              stripped = stripped.slice(PREFIX_OPTIONS_DOT.length).trim();
            else if (stripped.startsWith(PREFIX_PARAMS_DOT))
              stripped = stripped.slice(PREFIX_PARAMS_DOT.length).trim();
            if (stripped !== expr) {
              try {
                val = evaluateExpression(stripped, scope);
              } catch {
                throw err;
              }
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
        valStr = display(val);
      } catch (err: unknown) {
        if (isUndefinedVariableError(err)) {
          throw new TemplateSyntaxError(
            `undeclared variable '${expr}' in include path '${path}'`,
          );
        }
        throw new TemplateSyntaxError(
          `unresolvable expression '${EXPR_START}${expr}${EXPR_END}' in include path '${path}'`,
        );
      }
    }
    result += valStr;
    remaining = afterStart.slice(endIdx + EXPR_END.length);
    startIdx = remaining.indexOf(EXPR_START);
  }
  result += remaining;
  if (!isValidResolvedPath(result) || result.includes(EXPR_START)) {
    throw new TemplateSyntaxError(
      `include path '${result}' must start with './', '../', or '/'`,
    );
  }
  return result;
}

/**
 * Merge parent scope's consts into child consts for include resolution.
 *
 * When a child template is included, it should inherit the parent's
 * imported consts (e.g. `session_layout.*`) so it can reference them.
 * Child consts take precedence over parent consts.
 */
function mergeConsts(
  parentScope: Scope,
  childConsts: ReadonlyMap<string, Value>,
): ReadonlyMap<string, Value> {
  const parentConsts = parentScope.allValues();
  // Start with parent's consts, then overlay child's own consts
  const merged = new Map<string, Value>();
  for (const [k, v] of parentConsts) {
    merged.set(k, v);
  }
  for (const [k, v] of childConsts) {
    merged.set(k, v);
  }
  return merged;
}
