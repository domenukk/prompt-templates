/**
 * Validation rules for parsed frontmatter.
 *
 * Checks collision rules between params, type aliases, and imports,
 * matching the Rust crate's `validation.rs` logic.
 *
 * Rules checked:
 * - Reserved keywords cannot be used as param, const, or type alias names.
 * - Duplicate param names, const names, and type alias names are rejected.
 * - A parameter and a constant cannot share the same name.
 * - PascalCase param/const name vs type alias collision (with type-match exception).
 * - Type alias name cannot shadow an import stem.
 * - Param/const PascalCase name cannot shadow an import stem.
 * - Type aliases cannot shadow built-in type names.
 * - Unused type aliases are rejected unless `allow_unused: true`.
 *
 * @module
 */

import { TemplateSyntaxError } from "./errors.js";
import type { Frontmatter, VarDecl, VarType } from "./frontmatter.js";
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
  OPTION_SOME,
  OPTION_NONE,
  MATCH_DEFAULT,
  ENUM_TAG_KEY,
  ENUM_VARIANTS_KEY,
  LIT_TRUE,
  LIT_FALSE,
} from "./consts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reserved keywords that cannot be used as parameter, constant, or type alias names. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // Type names
  TYPE_STR,
  TYPE_BOOL,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_LIST,
  TYPE_STRUCT,
  TYPE_ENUM,
  TYPE_TMPL,
  TYPE_OPTION,
  // Namespace
  "params",
  // Pattern-syntax keywords (match/case arm labels)
  LIT_TRUE,
  LIT_FALSE,
  OPTION_SOME,
  OPTION_NONE,
  MATCH_DEFAULT,
  // Internal enum keys
  ENUM_TAG_KEY,
  ENUM_VARIANTS_KEY,
  // Codegen collision guards — Rust codegen renames self → __self etc.
  "__self",
  "__Self",
  "__super",
  "__crate",
]);

/** Built-in type names. A type alias cannot shadow any of these. */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
  TYPE_STR,
  TYPE_BOOL,
  TYPE_INT,
  TYPE_FLOAT,
  TYPE_LIST,
  TYPE_STRUCT,
  TYPE_ENUM,
  TYPE_TMPL,
  TYPE_OPTION,
]);

// ---------------------------------------------------------------------------
// PascalCase conversion
// ---------------------------------------------------------------------------

/**
 * Convert a `snake_case`, `kebab-case`, or other string to `PascalCase`.
 *
 * Splits on `_` and `-`, capitalises the first character of each segment,
 * and preserves the remaining characters.
 *
 * @example
 * ```ts
 * toPascalCase("code_review") // → "CodeReview"
 * toPascalCase("task-report")  // → "TaskReport"
 * ```
 */
export function toPascalCase(s: string): string {
  return s
    .split(/[_-]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// VarType equality (structural)
// ---------------------------------------------------------------------------

/** Deep structural equality check for two VarType values. */
function varTypeEquals(a: VarType, b: VarType): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case TYPE_STR:
    case TYPE_BOOL:
    case TYPE_INT:
    case TYPE_FLOAT:
    case TYPE_UNTYPED_LIST:
      return true;
    case TYPE_ALIAS:
      return (b as typeof a).name === a.name;
    case TYPE_SCALAR_LIST:
      return varTypeEquals(a.elementType, (b as typeof a).elementType);
    case TYPE_LIST:
    case TYPE_TMPL:
    case TYPE_STRUCT: {
      const bFields = (b as typeof a).fields;
      if (a.fields.length !== bFields.length) return false;
      return a.fields.every((f, i) => {
        const bf = bFields[i];
        if (bf === undefined) return false;
        return f.name === bf.name && varTypeEquals(f.varType, bf.varType);
      });
    }
    case TYPE_ENUM: {
      const bVariants = (b as typeof a).variants;
      if (a.variants.length !== bVariants.length) return false;
      return a.variants.every((v, i) => {
        const bv = bVariants[i];
        if (bv === undefined) return false;
        if (v.name !== bv.name || v.fields.length !== bv.fields.length)
          return false;
        return v.fields.every((f, j) => {
          const bf = bv.fields[j];
          if (bf === undefined) return false;
          return f.name === bf.name && varTypeEquals(f.varType, bf.varType);
        });
      });
    }
    case TYPE_OPTION:
      return varTypeEquals(a.innerType, (b as typeof a).innerType);
    default: {
      const _exhaustive: never = a;
      throw new Error(
        `unexpected VarType kind: ${(_exhaustive as VarType).kind}`,
      );
    }
  }
}

/**
 * Check if a VarType references a specific type alias.
 * Matches by structural equality OR by alias name reference.
 * Recursively descends into list, struct, and enum fields.
 */
function varTypeReferencesAlias(
  ty: VarType,
  aliasType: VarType,
  aliasName?: string,
): boolean {
  if (varTypeEquals(ty, aliasType)) return true;
  // An alias reference (kind: TYPE_ALIAS) matches if the name is the same
  if (ty.kind === TYPE_ALIAS && aliasName && ty.name === aliasName) return true;

  switch (ty.kind) {
    case TYPE_SCALAR_LIST:
      return varTypeReferencesAlias(ty.elementType, aliasType, aliasName);
    case TYPE_LIST:
    case TYPE_TMPL:
    case TYPE_STRUCT:
      return ty.fields.some((f) =>
        varTypeReferencesAlias(f.varType, aliasType, aliasName),
      );
    case TYPE_ENUM:
      return ty.variants.some((v) =>
        v.fields.some((f) =>
          varTypeReferencesAlias(f.varType, aliasType, aliasName),
        ),
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function throwErr(
  msg: string,
  loc?: { line: number; column?: number; snippet?: string },
): never {
  throw new TemplateSyntaxError(msg, loc?.line, loc?.column, loc?.snippet);
}

/**
 * Recursively check that no nested struct/list/enum field name is reserved.
 * This prevents collision guard names like `__self` from appearing in codegen.
 */
function checkNestedFieldNames(vt: VarType): void {
  switch (vt.kind) {
    case "list":
    case "struct":
    case "tmpl":
      for (const f of vt.fields) {
        if (f.name && RESERVED_NAMES.has(f.name)) {
          throw new TemplateSyntaxError(
            `reserved keyword used as name: '${f.name}'`,
          );
        }
        checkNestedFieldNames(f.varType);
      }
      break;
    case "enum":
      for (const v of vt.variants) {
        for (const f of v.fields) {
          if (f.name && RESERVED_NAMES.has(f.name)) {
            throw new TemplateSyntaxError(
              `reserved keyword used as name: '${f.name}'`,
            );
          }
          checkNestedFieldNames(f.varType);
        }
      }
      break;
    case "option":
      checkNestedFieldNames(vt.innerType);
      break;
    default:
      break;
  }
}

/**
 * Validate frontmatter collision and naming rules.
 *
 * Throws `TemplateSyntaxError` for any violation.
 *
 * @param fm - Parsed frontmatter to validate.
 * @throws {TemplateSyntaxError} On any naming collision or rule violation.
 */
export function validateFrontmatter(fm: Frontmatter): void {
  // ── Reserved keyword check ──────────────────────────────────────────
  for (const decl of fm.params) {
    if (RESERVED_NAMES.has(decl.name)) {
      throwErr(`reserved keyword used as name: '${decl.name}'`, decl.loc);
    }
    checkNestedFieldNames(decl.varType);
  }
  for (const decl of fm.consts) {
    if (RESERVED_NAMES.has(decl.name)) {
      throwErr(`reserved keyword used as name: '${decl.name}'`, decl.loc);
    }
    checkNestedFieldNames(decl.varType);
  }
  for (const decl of fm.env) {
    if (RESERVED_NAMES.has(decl.name)) {
      throwErr(`reserved keyword used as name: '${decl.name}'`, decl.loc);
    }
  }
  for (const aliasName of fm.typeAliases.keys()) {
    // Check reserved keywords first (matches Rust backend order).
    if (RESERVED_NAMES.has(aliasName)) {
      throw new TemplateSyntaxError(
        `reserved keyword used as name: '${aliasName}'`,
      );
    }
    // Check built-in type shadowing (case-insensitive, catches e.g. "Str").
    if (BUILTIN_TYPE_NAMES.has(aliasName.toLowerCase())) {
      throw new TemplateSyntaxError(
        `type alias shadows built-in type name: '${aliasName}'`,
      );
    }
  }

  // ── Duplicate name check ────────────────────────────────────────────
  {
    const seenParams = new Set<string>();
    for (const decl of fm.params) {
      if (seenParams.has(decl.name)) {
        throwErr(`duplicate parameter name: '${decl.name}'`, decl.loc);
      }
      seenParams.add(decl.name);
    }
  }
  {
    const seenConsts = new Set<string>();
    for (const decl of fm.consts) {
      if (seenConsts.has(decl.name)) {
        throwErr(`duplicate constant name: '${decl.name}'`, decl.loc);
      }
      seenConsts.add(decl.name);
    }
  }
  {
    const seenEnv = new Set<string>();
    for (const decl of fm.env) {
      if (seenEnv.has(decl.name)) {
        throwErr(`duplicate env variable name: '${decl.name}'`, decl.loc);
      }
      seenEnv.add(decl.name);
    }
  }
  // Note: duplicate type aliases are caught during parsing in frontmatter.ts
  // since Map.set overwrites. We check here for consistency.
  // (The Rust crate checks during parsing too, but we can't easily detect
  // duplicates from a Map after parsing. We rely on parse-time checks.)

  // ── Param ↔ const conflict (exact match) ────────────────────────────
  for (const param of fm.params) {
    for (const cst of fm.consts) {
      if (param.name === cst.name) {
        throwErr(
          `parameter name conflicts with constant name: '${param.name}' is declared as both a param and a constant`,
          param.loc,
        );
      }
    }
    for (const env of fm.env) {
      if (param.name === env.name) {
        throwErr(
          `parameter name conflicts with env variable name: '${param.name}' is declared as both a param and an env variable`,
          param.loc,
        );
      }
    }
  }
  for (const cst of fm.consts) {
    for (const env of fm.env) {
      if (cst.name === env.name) {
        throwErr(
          `constant name conflicts with env variable name: '${cst.name}' is declared as both a constant and an env variable`,
          cst.loc,
        );
      }
    }
  }

  // ── R1: PascalCase param/const vs type alias collision ──────────────
  const allDecls: readonly VarDecl[] = [...fm.params, ...fm.consts, ...fm.env];
  for (const decl of allDecls) {
    const declPascal = toPascalCase(decl.name);
    for (const [aliasName, aliasType] of fm.typeAliases) {
      if (declPascal === aliasName) {
        // Exception: if the declaration's type exactly matches the alias type
        // OR if the declaration uses this alias by name, allow it.
        if (varTypeEquals(decl.varType, aliasType)) {
          continue;
        }
        if (
          decl.varType.kind === TYPE_ALIAS &&
          decl.varType.name === aliasName
        ) {
          continue;
        }
        // Enum type aliases are auto-injected as constants, so a user-defined
        // constant with the same name simply takes priority — not a conflict.
        if (aliasType.kind === TYPE_ENUM) {
          continue;
        }
        const label = fm.consts.some((c) => c.name === decl.name)
          ? "constant"
          : "param";
        throwErr(
          `type alias name conflicts with parameter name (PascalCase collision): ${label} '${decl.name}' (PascalCase: '${declPascal}') conflicts with type alias '${aliasName}'`,
          decl.loc,
        );
      }
    }
  }

  // ── R2: Type alias shadows import stem ──────────────────────────────
  for (const imp of fm.imports) {
    for (const aliasName of fm.typeAliases.keys()) {
      if (aliasName === imp.stem) {
        throwErr(
          `type alias shadows import alias: '${aliasName}' shadows '${imp.stem}'`,
          imp.loc,
        );
      }
    }
  }

  // ── R2b: Param/const PascalCase name shadows import stem ────────────
  for (const imp of fm.imports) {
    for (const decl of allDecls) {
      const declPascal = toPascalCase(decl.name);
      if (declPascal === imp.stem) {
        const label = fm.consts.some((c) => c.name === decl.name)
          ? "constant"
          : "param";
        throwErr(
          `parameter name (PascalCase) shadows import alias: ${label} '${decl.name}' (PascalCase: '${declPascal}') shadows import '${imp.stem}'`,
          decl.loc,
        );
      }
    }
  }

  // ── R4: Unused type aliases ─────────────────────────────────────────
  if (
    !fm.allowUnused &&
    fm.typeAliases.size > 0 &&
    (fm.params.length > 0 || fm.consts.length > 0)
  ) {
    for (const [aliasName, aliasType] of fm.typeAliases) {
      // Enum types are always used — they're auto-injected as constants.
      if (aliasType.kind === TYPE_ENUM) continue;
      // Check if any param/const/env declaration references this alias.
      const isUsedByDecl = allDecls.some((d) =>
        varTypeReferencesAlias(d.varType, aliasType, aliasName),
      );
      if (isUsedByDecl) continue;
      // Check if any other type alias references this alias (chained aliases).
      let isUsedByAlias = false;
      for (const [otherName, otherType] of fm.typeAliases) {
        if (otherName === aliasName) continue;
        if (varTypeReferencesAlias(otherType, aliasType, aliasName)) {
          isUsedByAlias = true;
          break;
        }
      }
      if (!isUsedByAlias) {
        throw new TemplateSyntaxError(`unused type alias: '${aliasName}'`);
      }
    }
  }
}

/**
 * Validate body-level naming collisions (rules 9-11).
 *
 * These checks require knowledge of inline template names and for-loop
 * bindings, which are only available after parsing the template body.
 *
 * @param fm - Parsed frontmatter.
 * @param inlineTemplateNames - Names of inline templates defined in the body.
 * @param forBindings - For-loop binding names used in the body.
 */
export function validateBodyCollisions(
  fm: Frontmatter,
  inlineTemplateNames: ReadonlySet<string>,
  forBindings: ReadonlySet<string>,
): void {
  // ── Rule 9: Import stem ↔ inline template name collision ──────────
  for (const imp of fm.imports) {
    if (inlineTemplateNames.has(imp.stem)) {
      throwErr(
        `inline template name conflicts with import stem: '${imp.stem}'`,
        imp.loc,
      );
    }
  }

  // ── Rule 10: Param/const ↔ inline template name collision ─────────
  for (const decl of fm.params) {
    if (inlineTemplateNames.has(decl.name)) {
      throwErr(
        `inline template name conflicts with parameter name: '${decl.name}'`,
        decl.loc,
      );
    }
  }
  for (const decl of fm.consts) {
    if (inlineTemplateNames.has(decl.name)) {
      throwErr(
        `inline template name conflicts with constant name: '${decl.name}'`,
        decl.loc,
      );
    }
  }
  for (const decl of fm.env) {
    if (inlineTemplateNames.has(decl.name)) {
      throwErr(
        `inline template name conflicts with env variable name: '${decl.name}'`,
        decl.loc,
      );
    }
  }

  // ── Rule 11: For-loop binding shadowing ───────────────────────────
  const declaredNames = new Set<string>([
    ...fm.params.map((d) => d.name),
    ...fm.consts.map((d) => d.name),
    ...fm.env.map((d) => d.name),
    ...fm.imports.map((i) => i.stem),
  ]);
  for (const binding of forBindings) {
    if (declaredNames.has(binding)) {
      throw new TemplateSyntaxError(
        `for-loop binding '${binding}' shadows a declared name (param, const, or import stem)`,
      );
    }
  }
}

export { validateDisplayability } from "./displayability.js";
