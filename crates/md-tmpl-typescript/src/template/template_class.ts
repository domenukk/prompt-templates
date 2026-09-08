/**
 * Main Template class — the public API for parsing and rendering templates.
 *
 * Mirrors the Python `Template` class API:
 * - `Template.fromSource(source)` — parse from string
 * - `Template.fromFile(path)` — load from file
 * - `template.render({ name: "world" })` — render with params
 * - `template.renderDict(params)` — render from a dict
 * - `template.declarations()` — get param declarations
 *
 * @module
 */

import { Context } from "../context.js";
import {
  DeclarationsMutatedError,
  ExtraParamsError,
  MissingParamsError,
  TemplateError,
  TemplateSyntaxError,
} from "../errors.js";
import {
  type Frontmatter,
  type VarDecl,
  type VarType,
  parseFrontmatter,
  varTypeToString,
} from "../frontmatter.js";
import {
  validateBodyCollisions,
  validateDisplayability,
  validateFrontmatter,
} from "../validation.js";
import {
  type Node,
  type RenderOptions,
  Scope as ScopeImpl,
  parseBody,
  renderNodes,
} from "../parser.js";
import {
  type TmplRef,
  type TmplValue,
  type Value,
  fromJs,
  tmplVal,
  valueToJs,
} from "../value.js";
import { type DirectRenderOptions, renderDirect } from "../direct_renderer.js";
import { ERR_UNDECLARED_PREFIX, TYPE_ENUM, TYPE_NONE } from "../consts.js";
import {
  type CachedInclude,
  type CompileOptions,
  type IncludeCacheEntry,
  type ITemplate,
} from "./types.js";
import { getFs, getPath, hashString } from "./utils.js";
import { jsToValue } from "./conversion.js";
import { collectOptionPaths } from "./option_paths.js";
import { typeCheckValue } from "./type_check.js";
import {
  injectEnumTypeConstants,
  resolveEnvDeclarations,
  resolveImportedConsts,
} from "./resolve.js";
import { resolveIncludeEntry } from "./includes.js";
import {
  collectInlineTemplateMap,
  collectInlineTemplateNames,
} from "./inline_templates.js";
import {
  walkNodesForBareEnumAccess,
  walkNodesForConditionSyntax,
  walkNodesForMatchTypeSafety,
} from "./compile_checks.js";
import {
  collectForBindings,
  collectReferencedParams,
  collectUnquotedCaseLabels,
  extractInterpolationRefs,
} from "./references.js";
import { type TemplateCache } from "./cache.js";

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Returns the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to transform `a` into `b`.
 * Mirrors the Rust core's `levenshtein_distance` so the "did you mean"
 * suggestions in undeclared-variable errors match byte-for-byte.
 */
function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  let prev: number[] = Array.from({ length: bLen + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(bLen + 1).fill(0);
  for (let i = 0; i < aLen; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < bLen; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      // Non-null: indices are within the pre-sized arrays above.
      curr[j + 1] = Math.min(
        (prev[j] ?? 0) + cost,
        (prev[j + 1] ?? 0) + 1,
        (curr[j] ?? 0) + 1,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bLen] ?? 0;
}

// ---------------------------------------------------------------------------
// Template class
// ---------------------------------------------------------------------------

/**
 * A parsed, validated template ready for rendering.
 *
 * Implements {@link ITemplate} — can be used interchangeably with the WASM backend.
 *
 * @example
 * ```ts
 * const tmpl = Template.fromSource(`
 * ---
 * params:
 *   - name = str
 * ---
 * Hello {{ name }}!
 * `);
 * console.log(tmpl.render({ name: "world" }));
 * // → "Hello world!"
 * ```
 */
export class Template implements ITemplate, TmplRef {
  private readonly fm: Frontmatter;
  private readonly bodyStr: string;
  private readonly nodes: Node[];
  private readonly hash: number;
  private readonly _basePath: string | undefined;
  /** Pre-computed set of declared parameter names. */
  private readonly declaredNames: ReadonlySet<string>;
  /** Pre-computed default values (as JS values). */
  private readonly defaultValues: ReadonlyMap<string, unknown>;
  /** Pre-computed constant values. */
  private readonly constValues: ReadonlyMap<string, Value>;
  /** Pre-computed constant values as plain JS (for direct renderer). */
  private readonly constJsValues: ReadonlyMap<string, unknown>;
  /** Pre-computed set of option-typed parameter names/paths. */
  private readonly optionParams: ReadonlySet<string>;
  private readonly nonEnumParams: ReadonlySet<string>;
  private readonly nonOptionParams: ReadonlySet<string>;
  private _maxIncludeDepth = 16;
  /** Optional reference to the TemplateCache that loaded this template. */
  _cache?: TemplateCache;
  /** Compile-time env values, stored for propagation to included templates. */
  private readonly _compileEnv: Record<string, unknown>;
  private readonly _includeCache = new Map<string, IncludeCacheEntry>();

  /** Get the base path for include resolution (if set). */
  get basePath(): string | undefined {
    return this._basePath;
  }

  /** Get the current max include depth. */
  get maxIncludeDepth(): number {
    return this._maxIncludeDepth;
  }

  private constructor(
    fm: Frontmatter,
    bodyStr: string,
    nodes: Node[],
    source: string,
    basePath?: string,
    compileEnv?: Record<string, unknown>,
  ) {
    this.fm = fm;
    this.bodyStr = bodyStr;
    this.nodes = nodes;
    this.hash = hashString(source);
    this._basePath = basePath;
    this._compileEnv = compileEnv ?? {};

    // Pre-compute immutable render data
    this.declaredNames = new Set(fm.params.map((d) => d.name));
    const defaults = new Map<string, unknown>();
    for (const decl of fm.params) {
      if (decl.defaultValue !== undefined) {
        defaults.set(decl.name, valueToJs(decl.defaultValue));
      }
    }
    this.defaultValues = defaults;
    const consts = new Map<string, Value>();
    for (const decl of fm.consts) {
      if (decl.defaultValue !== undefined) {
        consts.set(decl.name, decl.defaultValue);
      }
    }
    // Env declarations are resolved at compile time and behave like consts.
    for (const decl of fm.env) {
      if (decl.defaultValue !== undefined) {
        consts.set(decl.name, decl.defaultValue);
      }
    }
    for (const [key, jsVal] of Object.entries(fm.importedConsts)) {
      consts.set(key, fromJs(jsVal));
    }
    this.constValues = consts;
    const constsJs = new Map<string, unknown>();
    for (const decl of fm.consts) {
      if (decl.defaultValue !== undefined) {
        constsJs.set(decl.name, valueToJs(decl.defaultValue));
      }
    }
    // Env declarations are resolved at compile time and behave like consts.
    for (const decl of fm.env) {
      if (decl.defaultValue !== undefined) {
        constsJs.set(decl.name, valueToJs(decl.defaultValue));
      }
    }
    for (const [key, jsVal] of Object.entries(fm.importedConsts)) {
      constsJs.set(key, jsVal);
    }
    this.constJsValues = constsJs;

    // Pre-compute option-typed parameter names for kind()/match awareness
    const optParams = new Set<string>();
    const nonEnum = new Set<string>();
    const nonOpt = new Set<string>();
    for (const decl of fm.params) {
      collectOptionPaths(decl.name, decl.varType, fm.typeAliases, optParams);
      let vt = decl.varType;
      while (vt.kind === "alias") {
        const resolved = fm.typeAliases.get(vt.name);
        if (!resolved) break;
        vt = resolved;
      }
      const isOpt = vt.kind === "option" || optParams.has(decl.name);
      if (vt.kind !== "enum" && !isOpt) {
        nonEnum.add(decl.name);
      }
      if (!isOpt) {
        nonOpt.add(decl.name);
      }
    }
    this.optionParams = optParams;
    this.nonEnumParams = nonEnum;
    this.nonOptionParams = nonOpt;

    // Inject enum type constants from type aliases.
    // For each enum type (e.g., `Stage = enum(Design, Build)`), create a
    // constant dict mapping variant names → values, enabling expressions
    // like `{{ Stage.Design }}`.  User-defined constants are never overwritten.
    injectEnumTypeConstants(fm.typeAliases, consts, constsJs);
  }

  // ── Static constructors ──────────────────────────────────────────────

  /**
   * Parse a template from an in-memory string.
   *
   * Unused declared parameters (present in frontmatter but not in
   * the template body) are rejected. Use `fromSourceAllowingUnused()`
   * to suppress this check.
   *
   * @throws {TemplateSyntaxError} If the source contains syntax errors.
   */
  static fromSource(source: string): Template {
    const [fm, body] = parseFrontmatter(source);
    validateFrontmatter(fm);
    const nodes = parseBody(body, false, fm.bodyStartLine ?? 1);
    walkNodesForConditionSyntax(nodes);
    const tmpl = new Template(fm, body, nodes, source);
    tmpl.checkUndeclaredVariables(body);
    if (!fm.allowUnused) {
      tmpl.checkUnusedParams(body);
    }
    tmpl.checkBareEnumAccess();
    tmpl.checkMatchTypeSafety();
    validateBodyCollisions(
      fm,
      collectInlineTemplateNames(nodes),
      collectForBindings(nodes),
    );
    validateDisplayability(
      nodes,
      fm.params,
      fm.consts,
      fm.typeAliases,
      fm.importedNamespaceTypes,
    );
    return tmpl;
  }

  /**
   * Parse a template from source with full compile-time options.
   *
   * Resolves `env:` declarations using the provided `CompileOptions.env`
   * values, type-checks them, and injects them into the template scope.
   * Imports are resolved relative to `CompileOptions.baseDir`, and unused
   * declared parameters are permitted when `CompileOptions.allowUnused`
   * is set.
   *
   * @throws {TemplateSyntaxError} If an env var is missing without a default.
   * @throws {TemplateSyntaxError} If an env var value fails type checking.
   */
  static fromSourceWithOptions(
    source: string,
    options: CompileOptions,
  ): Template {
    const [fm, body] = parseFrontmatter(source);
    const envValues = options.env ?? {};
    let resolvedFm = resolveEnvDeclarations(fm, envValues);
    validateFrontmatter(resolvedFm);
    const baseDir = options.baseDir;
    if (baseDir) {
      resolvedFm = resolveImportedConsts(resolvedFm, baseDir);
    }
    const nodes = parseBody(body, false, resolvedFm.bodyStartLine ?? 1);
    walkNodesForConditionSyntax(nodes);
    const tmpl = new Template(
      resolvedFm,
      body,
      nodes,
      source,
      baseDir,
      envValues,
    );
    tmpl.checkUndeclaredVariables(body);
    if (!resolvedFm.allowUnused && !options.allowUnused) {
      tmpl.checkUnusedParams(body);
    }
    tmpl.checkBareEnumAccess();
    tmpl.checkMatchTypeSafety();
    validateBodyCollisions(
      resolvedFm,
      collectInlineTemplateNames(nodes),
      collectForBindings(nodes),
    );
    validateDisplayability(
      nodes,
      resolvedFm.params,
      resolvedFm.consts,
      resolvedFm.typeAliases,
      resolvedFm.importedNamespaceTypes,
    );
    return tmpl;
  }

  /**
   * Parse a template from source with compile-time environment variables.
   *
   * Convenience wrapper over {@link fromSourceWithOptions} that accepts a
   * flat `env` record directly. This mirrors the WASM backend's
   * `fromSourceWithEnv(source, env)` signature for cross-backend
   * consistency.
   *
   * @param source - The template source.
   * @param env - Values for `env:` frontmatter declarations.
   *
   * @throws {TemplateSyntaxError} If an env var is missing without a default.
   * @throws {TemplateSyntaxError} If an env var value fails type checking.
   */
  static fromSourceWithEnv(
    source: string,
    env: Record<string, unknown> = {},
  ): Template {
    return Template.fromSourceWithOptions(source, { env });
  }

  /**
   * Parse a template, allowing declared parameters that aren't used.
   */
  static fromSourceAllowingUnused(source: string): Template {
    const [fm, body] = parseFrontmatter(source);
    const nodes = parseBody(body, false, fm.bodyStartLine ?? 1);
    walkNodesForConditionSyntax(nodes);
    const tmpl = new Template(fm, body, nodes, source);
    tmpl.checkUndeclaredVariables(body);
    tmpl.checkBareEnumAccess();
    tmpl.checkMatchTypeSafety();
    validateDisplayability(
      nodes,
      fm.params,
      fm.consts,
      fm.typeAliases,
      fm.importedNamespaceTypes,
    );
    return tmpl;
  }

  /**
   * Parse a template with a base directory for include resolution.
   */
  static fromSourceWithBaseDir(source: string, baseDir: string): Template {
    const [fm, body] = parseFrontmatter(source);
    validateFrontmatter(fm);
    const resolvedFm = resolveImportedConsts(fm, baseDir);
    const nodes = parseBody(body, false, resolvedFm.bodyStartLine ?? 1);
    walkNodesForConditionSyntax(nodes);
    const tmpl = new Template(resolvedFm, body, nodes, source, baseDir);
    tmpl.checkUndeclaredVariables(body);
    if (!resolvedFm.allowUnused) {
      tmpl.checkUnusedParams(body);
    }
    tmpl.checkBareEnumAccess();
    tmpl.checkMatchTypeSafety();
    validateBodyCollisions(
      resolvedFm,
      collectInlineTemplateNames(nodes),
      collectForBindings(nodes),
    );
    validateDisplayability(
      nodes,
      resolvedFm.params,
      resolvedFm.consts,
      resolvedFm.typeAliases,
      resolvedFm.importedNamespaceTypes,
    );
    return tmpl;
  }

  /**
   * Load a template from a `.tmpl.md` file.
   *
   * @throws {TemplateError} If the file cannot be read.
   * @throws {TemplateSyntaxError} If the file contains syntax errors.
   */
  static fromFile(filePath: string): Template {
    return Template.fromFileWithEnv(filePath);
  }

  /**
   * Load a template from a `.tmpl.md` file with compile-time env values.
   *
   * Resolves `env:` declarations using the provided options before
   * resolving imports, so `{{ PROMPTS_DIR }}` can be used in import paths.
   *
   * @throws {TemplateError} If the file cannot be read.
   * @throws {TemplateSyntaxError} If the file contains syntax errors.
   * @throws {TemplateSyntaxError} If an env var is missing without a default.
   */
  static fromFileWithEnv(filePath: string, options?: CompileOptions): Template {
    let source: string;
    try {
      source = getFs().readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new TemplateError(
        `failed to load template: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const absPath = getPath().resolve(filePath);
    const baseDir = getPath().dirname(absPath);
    const [fm, body] = parseFrontmatter(source);
    // Resolve env declarations before import resolution so env values
    // (e.g. PROMPTS_DIR) are available in import paths.
    const envValues = options?.env ?? {};
    const envResolved = resolveEnvDeclarations(fm, envValues);
    validateFrontmatter(envResolved);
    const resolvedFm = resolveImportedConsts(envResolved, baseDir);
    const nodes = parseBody(body, false, resolvedFm.bodyStartLine ?? 1);
    walkNodesForConditionSyntax(nodes);
    const tmpl = new Template(
      resolvedFm,
      body,
      nodes,
      source,
      baseDir,
      envValues,
    );
    tmpl.checkUndeclaredVariables(body);
    if (!resolvedFm.allowUnused) {
      tmpl.checkUnusedParams(body);
    }
    tmpl.checkBareEnumAccess();
    tmpl.checkMatchTypeSafety();
    validateBodyCollisions(
      resolvedFm,
      collectInlineTemplateNames(nodes),
      collectForBindings(nodes),
    );
    validateDisplayability(
      nodes,
      resolvedFm.params,
      resolvedFm.consts,
      resolvedFm.typeAliases,
      resolvedFm.importedNamespaceTypes,
    );
    return tmpl;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  /**
   * Render the template with keyword arguments.
   *
   * All arguments are validated against frontmatter type declarations.
   * Extra undeclared parameters produce an error (use `allowExtra` to suppress).
   *
   * @param params - Template parameters as a plain object.
   * @param options - Render options.
   * @throws {MissingParamsError} If required parameters are missing.
   * @throws {TypeMismatchError} If a value has the wrong type.
   * @throws {ExtraParamsError} If undeclared parameters are provided.
   *
   * @example
   * ```ts
   * tmpl.render({ name: "world", count: 42 });
   * ```
   */
  render(
    params: Record<string, unknown> = {},
    options?: { allowExtra?: boolean },
  ): string {
    const ctx = this.buildContext(params, options?.allowExtra ?? false);
    return this.renderWithContext(ctx);
  }

  /**
   * Render without type validation — fastest path.
   *
   * Converts params to Values and renders directly, skipping all
   * type-checking. Use after you've validated once with `render()`,
   * or when rendering with `TypedTemplate<P>` and trusting
   * TypeScript's compile-time checks.
   *
   * @example
   * ```ts
   * // Validate once, then render fast in a loop:
   * tmpl.render(params);  // validates types
   * for (const p of manyParams) {
   *   tmpl.renderUnchecked(p);  // no validation overhead
   * }
   * ```
   */
  renderUnchecked(params: Record<string, unknown> = {}): string {
    // Build a flat Map<string, unknown> with defaults + provided params
    const flat = new Map<string, unknown>(this.defaultValues);
    for (const [key, value] of Object.entries(params)) {
      if (this.declaredNames.has(key)) {
        flat.set(key, value);
      }
    }
    // Use direct renderer — no Value conversion, no Map wrapping
    return renderDirect(
      this.nodes,
      flat,
      this.constJsValues,
      this.getDirectOptions(),
    );
  }

  /**
   * Render the template from a Map or Record of parameters.
   */
  renderDict(
    params: Record<string, unknown> | Map<string, unknown>,
    options?: { allowExtra?: boolean },
  ): string {
    const obj = params instanceof Map ? Object.fromEntries(params) : params;
    return this.render(obj, options);
  }

  /**
   * Render the template using a pre-built {@link Context}.
   *
   * This is an advanced escape hatch for callers that construct a
   * {@link Context} directly (e.g. to reuse converted {@link Value}s across
   * many renders). Like {@link renderUnchecked}, it does **not** re-run
   * parameter type validation — the context's values are used as-is.
   *
   * @example
   * ```ts
   * const ctx = Context.from({ name: "world" });
   * tmpl.renderContext(ctx); // => "Hello world!"
   * ```
   */
  renderContext(ctx: Context): string {
    return this.renderWithContext(ctx);
  }

  /**
   * Render a template that takes no user-provided parameters.
   *
   * If the template declares parameters, they must all have defaults.
   * Calling `renderEmpty()` on a template with required (no-default)
   * parameters throws an error.
   *
   * More efficient than `render({})` — skips context building and
   * validation entirely.
   *
   * @example
   * ```ts
   * const tmpl = Template.fromSource("Hello world!");
   * tmpl.renderEmpty(); // => "Hello world!"
   *
   * const tmpl2 = Template.fromSource(
   *   `---
params:
  - greeting = str := "Hi"
---
{{ greeting }}!`
   * );
   * tmpl2.renderEmpty(); // => "Hi!"
   * ```
   *
   * @throws {MissingParamsError} If any declared parameter lacks a default value.
   */
  renderEmpty(): string {
    // Check for required params (no default)
    const missing = this.fm.params
      .filter((d) => d.defaultValue === undefined)
      .map((d) => d.name);
    if (missing.length > 0) {
      throw new MissingParamsError(missing);
    }
    // All params have defaults — use direct renderer with just defaults + consts
    return renderDirect(
      this.nodes,
      this.defaultValues,
      this.constJsValues,
      this.getDirectOptions(),
    );
  }

  // ── Metadata ─────────────────────────────────────────────────────────

  /**
   * Return parameter declarations as `[name, typeString]` tuples.
   */
  declarations(): [string, string][] {
    return this.fm.params.map((d) => [d.name, varTypeToString(d.varType)]);
  }

  /**
   * Return raw parameter declarations with VarType objects.
   * Used by TmplRef for higher-order template signature validation.
   */
  rawDeclarations(): readonly {
    name: string;
    varType: VarType;
    defaultValue?: Value;
  }[] {
    return this.fm.params;
  }

  /**
   * Render this template when included as a higher-order tmpl value.
   *
   * Merges parent constants and option params, wires up template loading,
   * and renders the body with the provided params.
   */
  renderForInclude(
    params: ReadonlyMap<string, Value>,
    parentConsts: ReadonlyMap<string, Value>,
    parentOptionParams: ReadonlySet<string>,
    maxDepth: number,
    templateLoader?: unknown,
    basePath?: string,
  ): string {
    // Merge parent consts with our own
    const mergedConsts = new Map<string, Value>(parentConsts);
    for (const [k, v] of this.constValues) {
      mergedConsts.set(k, v);
    }
    const combinedOpts = new Set<string>(parentOptionParams);
    for (const p of this.optionParams) {
      combinedOpts.add(p);
    }
    const scope = new ScopeImpl(
      params,
      mergedConsts,
      combinedOpts,
      this.fm.typeAliases,
      this.nonEnumParams,
      this.nonOptionParams,
    );
    const opts: RenderOptions = {
      maxIncludeDepth: maxDepth,
    };
    // Set up inline templates from this template's body
    const inlineTmpls = collectInlineTemplateMap(this.nodes);
    if (inlineTmpls.size > 0) {
      opts.inlineTemplates = inlineTmpls;
    }
    // Wire up file includes if we have a base path
    const effectiveBase = this._basePath ?? basePath;
    if (effectiveBase || this._cache) {
      opts.templateLoader = this.makeTemplateLoader(effectiveBase ?? "");
      opts.currentBasePath = effectiveBase;
    } else if (templateLoader && typeof templateLoader === "function") {
      opts.templateLoader = templateLoader as RenderOptions["templateLoader"];
      opts.currentBasePath = basePath;
    }
    return renderNodes(this.nodes, scope, opts);
  }

  /** Convert this Template to a TmplValue for passing as a parameter. */
  toValue(): TmplValue {
    return tmplVal(this);
  }

  /**
   * Return a content hash of the template source.
   *
   * Two templates with the same source produce the same hash.
   */
  sourceHash(): number {
    return this.hash;
  }

  /**
   * Return default values for parameters that declare them.
   */
  defaults(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const decl of this.fm.params) {
      if (decl.defaultValue !== undefined) {
        if (decl.defaultValue.type === TYPE_NONE) {
          result[decl.name] = null;
        } else {
          result[decl.name] = valueToJs(decl.defaultValue);
        }
      }
    }
    return result;
  }

  /**
   * Return constants defined in the template's frontmatter.
   */
  consts(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const decl of this.fm.consts) {
      if (decl.defaultValue !== undefined) {
        result[decl.name] = valueToJs(decl.defaultValue);
      }
    }
    return result;
  }

  /**
   * Return constants imported from other templates.
   *
   * These are keyed by `stem.NAME` (e.g. `other.MAX_RETRIES`).
   * Only populated when the template is loaded from a file or
   * constructed with a base directory.
   */
  importedConsts(): Record<string, unknown> {
    return { ...this.fm.importedConsts };
  }

  /**
   * Return the raw template body after frontmatter stripping.
   */
  body(): string {
    return this.bodyStr;
  }

  /**
   * Set the maximum include depth for rendering.
   */
  setMaxIncludeDepth(depth: number): void {
    this._maxIncludeDepth = depth;
  }

  /**
   * Validate that this template's declarations match an expected set.
   *
   * @throws {DeclarationsMutatedError} If the declarations don't match.
   */
  validateDeclarationsAgainst(expected: [string, string][]): void {
    const current = this.declarations();
    if (current.length !== expected.length) {
      throw new DeclarationsMutatedError(
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(current)}`,
      );
    }
    for (const [i, cur] of current.entries()) {
      const exp = expected[i];
      if (cur[0] !== exp?.[0] || cur[1] !== exp[1]) {
        throw new DeclarationsMutatedError(
          `expected ${JSON.stringify(expected)}, got ${JSON.stringify(current)}`,
        );
      }
    }
  }

  /** String representation. */
  toString(): string {
    const decls = this.fm.params
      .map((d) => `${d.name}=${varTypeToString(d.varType)}`)
      .join(", ");
    return `Template(params=[${decls}])`;
  }

  /** Get the frontmatter (for type generation). */
  get frontmatter(): Frontmatter {
    return this.fm;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private buildContext(
    params: Record<string, unknown>,
    allowExtra: boolean,
  ): Context {
    const ctx = new Context();

    // Apply pre-computed defaults (with option auto-wrapping)
    for (const [name, value] of this.defaultValues) {
      const decl = this.fm.params.find((p) => p.name === name);
      if (decl) {
        ctx.setRaw(name, jsToValue(value, decl.varType, this.fm.typeAliases));
      } else {
        ctx.set(name, value);
      }
    }

    // Check for extra params
    const providedKeys = Object.keys(params);
    if (!allowExtra) {
      const extra = providedKeys.filter((k) => !this.declaredNames.has(k));
      if (extra.length > 0) {
        throw new ExtraParamsError(extra);
      }
    }

    // Set provided values (with option-transparent conversion)
    for (const [key, value] of Object.entries(params)) {
      if (this.declaredNames.has(key)) {
        const decl = this.fm.params.find((p) => p.name === key);
        if (decl) {
          ctx.setRaw(key, jsToValue(value, decl.varType, this.fm.typeAliases));
        } else {
          ctx.set(key, value);
        }
      }
    }

    // Check for missing required params (those without defaults)
    const missing: string[] = [];
    for (const decl of this.fm.params) {
      if (decl.defaultValue === undefined && !(decl.name in params)) {
        missing.push(decl.name);
      }
    }
    if (missing.length > 0) {
      throw new MissingParamsError(missing);
    }

    // Type-check all values
    for (const decl of this.fm.params) {
      const value = ctx.get(decl.name);
      if (value !== undefined) {
        typeCheckValue(decl.name, value, decl.varType, this.fm.typeAliases);
      }
    }

    return ctx;
  }

  private renderWithContext(ctx: Context): string {
    const scope = new ScopeImpl(
      ctx.values,
      this.constValues,
      this.optionParams,
      this.fm.typeAliases,
      this.nonEnumParams,
      this.nonOptionParams,
    );
    const options: RenderOptions = {
      maxIncludeDepth: this._maxIncludeDepth,
    };

    // Wire up file-based include resolution if we have a base path or cache
    if (this._basePath || this._cache) {
      options.templateLoader = this.makeTemplateLoader(this._basePath ?? "");
    }
    // Collect inline template definitions ({% tmpl name %}...{% /tmpl %})
    const inlineTmpls = collectInlineTemplateMap(this.nodes);
    if (inlineTmpls.size > 0) {
      options.inlineTemplates = inlineTmpls;
    }

    return renderNodes(this.nodes, scope, options);
  }

  private makeTemplateLoader(
    defaultBase: string,
  ): RenderOptions["templateLoader"] {
    return (
      includePath: string,
      basePath?: string,
    ):
      | [
          readonly Node[],
          ReadonlyMap<string, Value>,
          readonly VarDecl[],
          string?,
        ]
      | undefined => {
      const cached = this.resolveInclude(includePath, basePath ?? defaultBase);
      if (!cached) return undefined;
      return [cached.nodes, cached.consts, cached.declarations, cached.baseDir];
    };
  }

  private checkUnusedParams(_body: string): void {
    const referenced = collectReferencedParams(this.nodes);
    // Also scan {# comment #} tags for {{ var }} references.
    // The AST comment node doesn't store text, so we scan the raw body.
    // This mirrors Rust's extract_comment_variable_refs: only {{ expr }}
    // patterns inside comments count as references, not bare words.
    const commentPattern = /\{#(.*?)#\}/gs;
    let match;
    while ((match = commentPattern.exec(_body)) !== null) {
      const commentText = match[1] ?? "";
      extractInterpolationRefs(commentText, referenced, new Set());
    }
    // Collect unquoted case labels: if a declared param name appears as an
    // unquoted label in `{% case paramName %}`, the runtime reads that param's
    // value for comparison — it IS used. The reference collector can't do
    // this because it would confuse enum variant names with param names.
    const caseLabels = collectUnquotedCaseLabels(this.nodes);
    for (const decl of this.fm.params) {
      if (!referenced.has(decl.name) && !caseLabels.has(decl.name)) {
        throw new TemplateSyntaxError(
          `unused parameter '${decl.name}' declared but not referenced in body`,
          decl.loc?.line,
          decl.loc?.column,
          decl.loc?.snippet,
        );
      }
    }
  }

  /**
   * Reject references to variables that are not declared anywhere.
   *
   * Mirrors the Rust core's `check_undeclared_variables`: the referenced set
   * (body + comment interpolations) is compared against the union of declared
   * params, consts, env vars, import stems, enum type aliases, and inline
   * template names. Unknown references produce a syntax error with optional
   * Levenshtein "did you mean" suggestions, byte-for-byte identical to Rust.
   */
  private checkUndeclaredVariables(body: string): void {
    const referenced = collectReferencedParams(this.nodes);
    // Include {{ expr }} references inside {# comments #}: the Rust core stores
    // these as `Segment::Comment` refs, so they count as references too.
    const commentPattern = /\{#(.*?)#\}/gs;
    let match: RegExpExecArray | null;
    while ((match = commentPattern.exec(body)) !== null) {
      extractInterpolationRefs(match[1] ?? "", referenced, new Set());
    }

    const declared = new Set<string>();
    for (const decl of this.fm.params) declared.add(decl.name);
    for (const decl of this.fm.consts) declared.add(decl.name);
    for (const decl of this.fm.env) declared.add(decl.name);
    for (const imp of this.fm.imports) declared.add(imp.stem);
    for (const [name, ty] of this.fm.typeAliases) {
      if (ty.kind === TYPE_ENUM) declared.add(name);
    }
    for (const name of collectInlineTemplateNames(this.nodes)) {
      declared.add(name);
    }

    const undeclared: string[] = [];
    for (const name of referenced) {
      if (!declared.has(name)) undeclared.push(name);
    }
    if (undeclared.length === 0) return;
    undeclared.sort();

    const suggestions: string[] = [];
    for (const name of undeclared) {
      let best: { candidate: string; dist: number } | undefined;
      for (const candidate of declared) {
        const dist = levenshteinDistance(name, candidate);
        if (dist > 0 && dist <= 2 && (best === undefined || dist < best.dist)) {
          best = { candidate, dist };
        }
      }
      if (best) {
        suggestions.push(`'${name}' (did you mean '${best.candidate}'?)`);
      }
    }
    const suffix =
      suggestions.length === 0
        ? ""
        : `. Suggestions: ${suggestions.join(", ")}`;
    throw new TemplateSyntaxError(
      `${ERR_UNDECLARED_PREFIX}${undeclared.join(", ")}${suffix}`,
    );
  }

  private getDirectOptions(): DirectRenderOptions {
    const inlineTemplates = new Map<
      string,
      {
        declarations: readonly VarDecl[];
        nodes: readonly Node[];
        consts: Map<string, unknown>;
      }
    >();
    for (const n of this.nodes) {
      if (n.kind === "tmpl") {
        if (n.source.trimStart().startsWith("---")) {
          const [inlineFm, inlineBody] = parseFrontmatter(n.source);
          const inlineConsts = new Map<string, unknown>();
          for (const decl of inlineFm.consts) {
            if (decl.defaultValue !== undefined) {
              inlineConsts.set(decl.name, valueToJs(decl.defaultValue));
            }
          }
          inlineTemplates.set(n.name, {
            declarations: inlineFm.params,
            nodes: parseBody(inlineBody, true),
            consts: inlineConsts,
          });
        } else {
          inlineTemplates.set(n.name, {
            declarations: [],
            nodes: parseBody(n.source, true),
            consts: new Map(),
          });
        }
      }
    }

    const defaultBase = this._basePath ?? "";
    const templateLoader = (
      includePath: string,
      basePath?: string,
    ):
      | [
          readonly Node[],
          ReadonlyMap<string, unknown>,
          readonly VarDecl[],
          string?,
        ]
      | undefined => {
      const cached = this.resolveInclude(includePath, basePath ?? defaultBase);
      if (!cached) return undefined;
      const constsJs = new Map<string, unknown>();
      for (const [k, v] of cached.consts) {
        constsJs.set(k, valueToJs(v));
      }
      return [cached.nodes, constsJs, cached.declarations, cached.baseDir];
    };

    return {
      inlineTemplates: inlineTemplates.size > 0 ? inlineTemplates : undefined,
      templateLoader:
        this._basePath || this._cache ? templateLoader : undefined,
      maxIncludeDepth: this._maxIncludeDepth,
    };
  }

  /**
   * Reject bare enum literal expressions like `{{ Stage.Design }}`.
   *
   * Only `{{ kind(Stage.Design) }}` is allowed — using the enum
   * literal as a bare expression output is a compile error.
   */
  private checkBareEnumAccess(): void {
    const enumTypeNames = new Set<string>();
    for (const [name, varType] of this.fm.typeAliases) {
      if (varType.kind === "enum" && !varType.isOption) {
        enumTypeNames.add(name);
      }
    }
    if (enumTypeNames.size === 0) return;
    walkNodesForBareEnumAccess(this.nodes, enumTypeNames);
  }

  /**
   * Reject type-unsafe match/case combinations at compile time:
   * - unquoted case labels on str params (use quoted labels instead)
   * - quoted case labels on enum params (use unquoted variant names instead)
   */
  private checkMatchTypeSafety(): void {
    // Build a map of param name → resolved type kind for quick lookup.
    // Resolve type aliases so e.g. `status = Status` where `Status = enum(...)`
    // correctly maps to "enum".
    const paramTypes = new Map<string, string>();
    for (const decl of this.fm.params) {
      let vt = decl.varType;
      while (vt.kind === "alias") {
        const resolved = this.fm.typeAliases.get(vt.name);
        if (!resolved) break;
        vt = resolved;
      }
      paramTypes.set(decl.name, vt.kind);
    }
    walkNodesForMatchTypeSafety(this.nodes, paramTypes);
  }

  private resolveInclude(
    includePath: string,
    basePath?: string,
  ): CachedInclude | undefined {
    if (this._cache) {
      return this._cache.resolveInclude(
        includePath,
        basePath,
        this._compileEnv,
      );
    }
    const currentBase = basePath ?? this._basePath ?? "";
    return resolveIncludeEntry(
      this._includeCache,
      includePath,
      currentBase,
      undefined,
      this._compileEnv,
    );
  }
}
