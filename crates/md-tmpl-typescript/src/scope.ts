/**
 * Layered scope for variable resolution during rendering in md-tmpl.
 */

import type { LoopMeta } from "./ast.js";
import { type Value, getField } from "./value.js";
import { TemplateSyntaxError, UndefinedVariableError } from "./errors.js";
import {
  DOT,
  PREFIX_CONSTS_DOT,
  PREFIX_OPTS_DOT,
  PREFIX_OPTIONS_DOT,
  PREFIX_PARAMS_DOT,
} from "./consts.js";

/**
 * Layered scope for variable resolution during rendering.
 *
 * Constants → loop bindings → context, searched in that order.
 */
export class Scope {
  private readonly ctx: ReadonlyMap<string, Value>;
  private readonly layers: Map<string, Value>[] = [];
  private readonly loopMetas = new Map<string, LoopMeta>();
  /** Option params that have been narrowed to Some (unwrapped) in an enclosing
   *  match/if-has arm. One set per layer so narrowing is properly scoped. */
  private readonly narrowedOptions: Set<string>[] = [];
  private readonly consts: ReadonlyMap<string, Value>;
  private readonly optionParams: ReadonlySet<string>;
  private readonly typeAliases: ReadonlyMap<string, unknown>;
  private readonly nonEnumParams: ReadonlySet<string>;
  private readonly nonOptionParams: ReadonlySet<string>;

  constructor(
    ctx: ReadonlyMap<string, Value>,
    consts?: ReadonlyMap<string, Value>,
    optionParams?: ReadonlySet<string>,
    typeAliases?: ReadonlyMap<string, unknown>,
    nonEnumParams?: ReadonlySet<string>,
    nonOptionParams?: ReadonlySet<string>,
  ) {
    this.ctx = ctx;
    this.consts = consts ?? new Map();
    this.optionParams = optionParams ?? new Set();
    this.typeAliases = typeAliases ?? new Map();
    this.nonEnumParams = nonEnumParams ?? new Set();
    this.nonOptionParams = nonOptionParams ?? new Set();
  }

  isDeclaredNonEnum(path: string): boolean {
    return this.nonEnumParams.has(path);
  }

  isDeclaredNonOption(path: string): boolean {
    return this.nonOptionParams.has(path);
  }

  /**
   * Check if a variable path refers to an option-typed parameter.
   * Handles both simple names ("x") and dotted paths ("person.email").
   */
  isOptionParam(path: string): boolean {
    // Check exact match first
    if (!this.optionParams.has(path)) {
      // For dotted paths, check if the root is known as option
      const dotIdx = path.indexOf(DOT);
      if (dotIdx > 0) {
        if (!this.optionParams.has(path)) return false;
      } else {
        return false;
      }
    }
    // If narrowed (unwrapped via case Some / if has()), no longer option
    for (let i = this.narrowedOptions.length - 1; i >= 0; i--) {
      if (this.narrowedOptions[i]?.has(path)) return false;
    }
    return true;
  }

  /**
   * Mark an option param as narrowed (unwrapped) in the current scope.
   * After narrowing, `isOptionParam(name)` returns false so inner match blocks
   * see the unwrapped value instead of the option wrapper.
   */
  narrowOption(name: string): void {
    const top = this.narrowedOptions[this.narrowedOptions.length - 1];
    if (top) {
      top.add(name);
    }
  }

  getTypeAlias(name: string): unknown {
    return this.typeAliases.get(name);
  }

  pushLayer(): Map<string, Value> {
    const layer = new Map<string, Value>();
    this.layers.push(layer);
    this.narrowedOptions.push(new Set());
    return layer;
  }

  popLayer(): void {
    this.layers.pop();
    this.narrowedOptions.pop();
  }

  setLoopMeta(binding: string, meta: LoopMeta): void {
    this.loopMetas.set(binding, meta);
  }

  getLoopMeta(binding: string): LoopMeta | undefined {
    return this.loopMetas.get(binding);
  }

  resolve(key: string): Value | undefined {
    // 1. Constants
    const constVal = this.consts.get(key);
    if (constVal !== undefined) return constVal;

    // 2. Layers (innermost first)
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (layer === undefined) continue;
      const v = layer.get(key);
      if (v !== undefined) return v;
    }

    // 3. Context
    return this.ctx.get(key);
  }

  resolvePath(pathStr: string): Value {
    let path = pathStr.trim();
    if (path.startsWith(PREFIX_CONSTS_DOT))
      path = path.slice(PREFIX_CONSTS_DOT.length).trim();
    else if (path.startsWith(PREFIX_OPTS_DOT))
      path = path.slice(PREFIX_OPTS_DOT.length).trim();
    else if (path.startsWith(PREFIX_OPTIONS_DOT))
      path = path.slice(PREFIX_OPTIONS_DOT.length).trim();
    else if (path.startsWith(PREFIX_PARAMS_DOT))
      path = path.slice(PREFIX_PARAMS_DOT.length).trim();
    pathStr = path;

    // Fast path: no dot means simple variable lookup (very common)
    const firstDot = pathStr.indexOf(DOT);
    if (firstDot === -1) {
      const root = this.resolve(pathStr);
      if (root === undefined) {
        throw new UndefinedVariableError(pathStr);
      }
      return root;
    }

    // Check if pathStr directly matches a constant (e.g. imported constant like 'child.MAX' or 'child.Stage')
    const exactConst = this.consts.get(pathStr);
    if (exactConst !== undefined) return exactConst;

    // Check if a prefix matches an imported namespace struct (e.g. 'child.Stage' in 'child.Stage.Design')
    const secondDot = pathStr.indexOf(DOT, firstDot + 1);
    if (secondDot !== -1) {
      const stemKey = pathStr.slice(0, secondDot);
      const stemVal = this.consts.get(stemKey);
      if (stemVal !== undefined) {
        let current = stemVal;
        let start = secondDot + 1;
        while (start < pathStr.length) {
          const nextDot = pathStr.indexOf(DOT, start);
          const end = nextDot === -1 ? pathStr.length : nextDot;
          const part = pathStr.slice(start, end);
          const field = getField(current, part);
          if (field === undefined) {
            throw new UndefinedVariableError(
              `field '${part}' not found on ${current.type}`,
            );
          }
          current = field;
          start = end + 1;
        }
        return current;
      }
    }

    // Dotted path: scan for dots without allocating an array
    const rootKey = pathStr.slice(0, firstDot);
    if (this.isOptionParam(rootKey)) {
      const nextDot = pathStr.indexOf(DOT, firstDot + 1);
      const part = pathStr.slice(
        firstDot + 1,
        nextDot === -1 ? pathStr.length : nextDot,
      );
      throw new TemplateSyntaxError(
        `cannot access field '${part}' on option — unwrap with {% if has(${rootKey}) %} or {% match ${rootKey} %}`,
      );
    }
    const root = this.resolve(rootKey);
    if (root === undefined) {
      throw new UndefinedVariableError(rootKey);
    }
    let current = root;
    let start = firstDot + 1;
    while (start < pathStr.length) {
      const nextDot = pathStr.indexOf(DOT, start);
      const end = nextDot === -1 ? pathStr.length : nextDot;
      const part = pathStr.slice(start, end);
      const field = getField(current, part);
      if (field === undefined) {
        throw new UndefinedVariableError(
          `field '${part}' not found on ${current.type}`,
        );
      }
      current = field;
      start = end + 1;
    }
    return current;
  }

  /** Return all visible values (context + layers + consts) as a flat Map. */
  allValues(): Map<string, Value> {
    const result = new Map<string, Value>(this.ctx);
    for (const [k, v] of this.consts) {
      result.set(k, v);
    }
    for (const layer of this.layers) {
      for (const [k, v] of layer) {
        result.set(k, v);
      }
    }
    return result;
  }

  /** Return all constants visible in this scope. */
  allConsts(): ReadonlyMap<string, Value> {
    return this.consts;
  }

  /** Return the set of option-typed parameter names. */
  optionParamNames(): ReadonlySet<string> {
    return this.optionParams;
  }
}
