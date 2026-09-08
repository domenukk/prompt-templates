//! YAML-style frontmatter parsing for `.tmpl.md` files.
//!
//! Extracts template metadata (name, description, typed variable declarations)
//! from the `---`-delimited block at the start of a template source string.
//!
//! ## Frontmatter v2 format
//!
//! Uses `=` for name-type pairs, `<>` for type parameters, `:=` for defaults:
//!
//! ```text
//! ---
//! name: my_template
//! params:
//!   - name = str
//!   - count = int := 42
//!   - tasks = list(title = str, priority = int)
//! ---
//! ```

mod imports;
mod params;
mod type_aliases;
mod validation;

use alloc::{
    string::{String, ToString},
    vec::Vec,
};
#[cfg(feature = "std")]
use std::path::PathBuf;

pub use imports::*;
pub use params::parse_type_annotation;
pub(crate) use params::*;
pub(crate) use type_aliases::*;
pub(crate) use validation::*;

use crate::{
    compat::HashMap,
    consts::{
        FM_ALLOW_UNUSED_PREFIX, FM_CONSTS_PREFIX, FM_DELIMITER, FM_DELIMITER_NEWLINE,
        FM_DESC_PREFIX, FM_ENV_PREFIX, FM_IMPORTS_PREFIX, FM_NAME_PREFIX, FM_PARAMS_PREFIX,
        FM_TYPES_PREFIX,
    },
    error::TemplateError,
    frontmatter::params::parse_declarations,
    types::{VarDecl, VarType},
};

/// A template import declaration: `[stem](path.tmpl.md)`.
#[derive(Debug, Clone)]
pub struct Import {
    /// Short alias used as namespace prefix, e.g. `other`.
    pub stem: String,
    /// Relative path to the imported template file.
    #[cfg(feature = "std")]
    pub path: PathBuf,
    /// Relative path as a string (always available).
    #[cfg(not(feature = "std"))]
    pub path: alloc::string::String,
}

/// Resolved namespace from an imported template.
#[derive(Debug, Clone, Default)]
pub struct ImportedNamespace {
    /// Type aliases exported by the imported template.
    pub type_aliases: HashMap<String, VarType>,
    /// Parameter types (for cross-template type references).
    pub param_types: HashMap<String, VarType>,
    /// Constants exported by the imported template.
    pub consts: HashMap<String, crate::value::Value>,
    /// Type declarations for each exported constant.
    ///
    /// Enables the type checker to resolve field accesses on imported
    /// consts (e.g. `{% for row in lib.ITEMS %}{{ row.name }}{% /for %}`)
    /// instead of treating the import stem as opaque.
    pub const_types: HashMap<String, VarType>,
}

/// Parsed YAML frontmatter from a `.tmpl.md` file.
#[derive(Debug, Clone, Default)]
pub struct Frontmatter {
    /// Template name (matches SKILL.md `name:` convention).
    pub name: Option<String>,
    /// Description of the template's purpose.
    pub description: Option<String>,
    /// List of expected variable declarations (name + type + optional default).
    pub declarations: Vec<VarDecl>,
    /// Convenience: parameter names only (derived from `declarations`).
    pub params: Vec<String>,
    /// Whether the params: block was present in frontmatter.
    pub has_params: bool,
    /// Allow declared parameters that are never referenced in the body.
    ///
    /// Set via `allow_unused: true` in frontmatter. Useful for
    /// dynamically-loaded templates where params may be conditionally used.
    pub allow_unused: bool,
    /// Type aliases defined via `types:` in frontmatter.
    ///
    /// Maps alias names (e.g. `Priority`) to their resolved [`VarType`].
    pub type_aliases: HashMap<String, VarType>,
    /// Import declarations defined via `imports:` in frontmatter.
    pub imports: Vec<Import>,
    /// Constants defined via `consts:` in frontmatter.
    pub consts: Vec<VarDecl>,
    /// Compile-time environment variable declarations.
    /// Provided via `CompileOptions::env()` at compile time.
    pub env: Vec<VarDecl>,
    /// Resolved constants from imports, keyed by `stem.NAME`.
    pub imported_consts: HashMap<String, crate::value::Value>,
    /// Keys in `imported_consts` that are enum type namespace dicts
    /// (injected from imported enum type aliases). Used by the bare-enum-access
    /// check to distinguish enum namespaces from struct constants.
    pub imported_enum_type_keys: Vec<String>,
    /// Type information for imported namespaces, keyed by import stem.
    ///
    /// Each entry maps a stem name (e.g. `"artist"`) to a `Struct` type
    /// whose fields correspond to the imported template's typed consts.
    /// Used by the type checker to validate field accesses and for-loop
    /// iteration over imported consts.
    pub imported_namespace_types: HashMap<String, VarType>,
    /// For params whose top-level type is a dotted import reference resolving
    /// to an enum (`stem.TypeName`), maps the param name to
    /// `(import_stem, imported_type_name)`.
    ///
    /// Lets codegen backends (currently the Rust proc-macro) reference the
    /// imported, already-generated type directly instead of emitting a
    /// duplicate per-template copy. Empty when no such params exist.
    pub imported_type_params: HashMap<String, (String, String)>,
}

impl Frontmatter {
    /// Validate enum-variant names and field accesses across a template body,
    /// using the full set of typed declarations derived from this frontmatter.
    ///
    /// This is the single source of truth for compile-time field-type checking,
    /// shared by the `template!` proc-macro and the shared cross-backend test
    /// runners, so their behavior can never drift apart.
    ///
    /// Declarations included (all receive full field-level validation):
    /// - `params:` declarations,
    /// - typed import stems (imports whose consts carry type info) — this is
    ///   what enables `{% for row in stem.LIST_CONST %}{{ row.field }}{% /for %}`,
    /// - local `consts:`,
    /// - `env:` variables.
    ///
    /// Import stems lacking const type info remain opaque (valid but untyped).
    ///
    /// Returns a list of human-readable error strings (empty when valid).
    #[must_use]
    pub fn validate_field_types(&self, segments: &[crate::compiled::Segment]) -> Vec<String> {
        let mut opaque_roots: crate::compat::HashSet<String> = crate::compat::HashSet::new();
        let mut declarations: Vec<VarDecl> = self.declarations.clone();

        for import in &self.imports {
            // Always register the stem as an opaque root. Includes build their
            // child `TypeEnv` from the included template's own declarations and
            // inherit the parent's `opaque_roots` — but NOT the parent's typed
            // namespace `vars`. Without the stem in `opaque_roots`, an included
            // body referencing `stem.CONST` (e.g. `artist.SEVERITY_LADDER`)
            // would be spuriously flagged as an undeclared variable.
            opaque_roots.insert(import.stem.clone());
            // When the import additionally carries typed const info, register a
            // typed declaration so field access and for-loop element types
            // resolve precisely at this level. `lookup()` (vars) takes
            // precedence over `opaque_roots`, so top-level field/typo checking
            // is unaffected; the opaque entry is only the fallback consulted
            // inside includes (where the typed `vars` are not in scope).
            if let Some(ns_type) = self.imported_namespace_types.get(&import.stem) {
                declarations.push(VarDecl {
                    name: import.stem.clone(),
                    var_type: ns_type.clone(),
                    default_value: None,
                });
            }
        }
        for c in &self.consts {
            declarations.push(c.clone());
        }
        for e in &self.env {
            declarations.push(e.clone());
        }

        crate::compiled::validate_field_accesses_full(
            segments,
            &declarations,
            &self.type_aliases,
            &opaque_roots,
        )
    }

    /// Validate field types, built-in function argument types, and match
    /// exhaustiveness/narrowing for runtime templates (`Template::from_source`).
    ///
    /// Identical to [`Self::validate_field_types`], except static displayability
    /// checks (`{{ struct }}`, `{{ list }}`, `{{ option }}`) are deferred to
    /// render time.
    #[must_use]
    pub fn validate_runtime_types(&self, segments: &[crate::compiled::Segment]) -> Vec<String> {
        let mut opaque_roots: crate::compat::HashSet<String> = crate::compat::HashSet::new();
        let mut declarations: Vec<VarDecl> = self.declarations.clone();

        for import in &self.imports {
            opaque_roots.insert(import.stem.clone());
            if let Some(ns_type) = self.imported_namespace_types.get(&import.stem) {
                declarations.push(VarDecl {
                    name: import.stem.clone(),
                    var_type: ns_type.clone(),
                    default_value: None,
                });
            }
        }
        for c in &self.consts {
            declarations.push(c.clone());
        }
        for e in &self.env {
            declarations.push(e.clone());
        }

        crate::compiled::validate_field_accesses_runtime(
            segments,
            &declarations,
            &self.type_aliases,
            &opaque_roots,
        )
    }
}

/// Strip YAML frontmatter delimited by `---` and return only the body text.
///
/// # Errors
///
/// Returns [`TemplateError::Syntax`] if the frontmatter block is missing or invalid.
pub fn strip_frontmatter(source: &str) -> Result<&str, TemplateError> {
    parse_frontmatter(source).map(|(_, body)| body)
}

/// Parse YAML frontmatter delimited by `---` lines.
///
/// Returns the parsed [`Frontmatter`] and a string slice pointing to the
/// template body after the closing `---`.
///
/// # Errors
///
/// Returns [`TemplateError::Syntax`] if the frontmatter block is
/// missing, unclosed, or contains invalid declarations.
pub fn parse_frontmatter(source: &str) -> Result<(Frontmatter, &str), TemplateError> {
    parse_frontmatter_impl(
        source,
        #[cfg(feature = "std")]
        None,
        None,
        false,
        &[],
    )
}

/// Parse YAML frontmatter with compile-time environment values.
///
/// Like [`parse_frontmatter`], but resolves `env:` declarations against
/// the provided name-value pairs.
///
/// # Errors
///
/// Returns [`TemplateError::Syntax`] if the frontmatter block is
/// missing, unclosed, or contains invalid declarations, or if an
/// `env:` variable has no value and no default.
pub fn parse_frontmatter_with_env<'a>(
    source: &'a str,
    env_values: &[(&str, crate::value::Value)],
) -> Result<(Frontmatter, &'a str), TemplateError> {
    parse_frontmatter_impl(
        source,
        #[cfg(feature = "std")]
        None,
        None,
        false,
        env_values,
    )
}

/// Parse YAML frontmatter with cross-template import resolution.
///
/// Like [`parse_frontmatter`], but additionally resolves `imports:` entries
/// by reading referenced template files from disk relative to `base_dir`.
/// This allows params to reference imported types (e.g. `types.Severity`).
///
/// # Errors
///
/// Returns [`TemplateError::Syntax`] if the frontmatter block is invalid,
/// an imported file cannot be read, or imported types cannot be resolved.
#[cfg(feature = "std")]
pub fn parse_frontmatter_with_base_dir<'a>(
    source: &'a str,
    base_dir: &std::path::Path,
    env_values: &[(&str, crate::value::Value)],
) -> Result<(Frontmatter, &'a str), TemplateError> {
    parse_frontmatter_impl(source, Some(base_dir), None, false, env_values)
}

/// Parse YAML frontmatter with access to a parent template's type aliases.
///
/// Used for inline template definitions (`{% tmpl %}`) that can reference
/// type aliases from the enclosing template.
pub fn parse_frontmatter_with_parent_scope<'a>(
    source: &'a str,
    parent_type_aliases: &HashMap<String, VarType>,
) -> Result<(Frontmatter, &'a str), TemplateError> {
    parse_frontmatter_impl(
        source,
        #[cfg(feature = "std")]
        None,
        Some(parent_type_aliases),
        true,
        &[],
    )
}

fn extract_yaml_logical_lines(
    source: &str,
    allow_missing_fm: bool,
) -> Result<(Vec<String>, &str), TemplateError> {
    let trimmed = source.trim_start();
    if !trimmed.starts_with(FM_DELIMITER) {
        if allow_missing_fm {
            return Ok((Vec::new(), source));
        }
        return Err(TemplateError::syntax(
            crate::consts::ERR_MISSING_FM.to_string(),
        ));
    }

    let after_first = trimmed[FM_DELIMITER.len()..].trim_start_matches(['\r', '\n']);
    // An empty block: the closing delimiter follows the opener immediately
    // (its separator newlines were consumed above), so the `\n---` search
    // below cannot see it and would misreport the block as unclosed.
    let (yaml_block, after_close) = if after_first.starts_with(FM_DELIMITER)
        && matches!(
            after_first.as_bytes().get(FM_DELIMITER.len()),
            None | Some(b'\n' | b'\r')
        ) {
        ("", FM_DELIMITER.len())
    } else {
        let Some(end) = after_first.find(FM_DELIMITER_NEWLINE) else {
            return Err(TemplateError::syntax(
                crate::consts::ERR_UNCLOSED_FM.to_string(),
            ));
        };
        (&after_first[..end], end + FM_DELIMITER_NEWLINE.len())
    };
    let body_start = if after_first[after_close..].starts_with('\n') {
        after_close + 1
    } else if after_first[after_close..].starts_with("\r\n") {
        after_close + 2
    } else {
        after_close
    };
    let body = &after_first[body_start..];

    let mut in_block_list = false;
    let mut had_blank_line = true;
    for line in yaml_block.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            had_blank_line = true;
            continue;
        }
        let starts_with_section = line.starts_with(FM_NAME_PREFIX)
            || line.starts_with(FM_DESC_PREFIX)
            || line.starts_with(FM_TYPES_PREFIX)
            || line.starts_with(FM_IMPORTS_PREFIX)
            || line.starts_with(FM_PARAMS_PREFIX)
            || line.starts_with(FM_CONSTS_PREFIX)
            || line.starts_with(FM_ENV_PREFIX)
            || line.starts_with(FM_ALLOW_UNUSED_PREFIX);

        if starts_with_section {
            if in_block_list && !had_blank_line {
                return Err(TemplateError::syntax(format!(
                    "A blank line is required after a block list before '{trimmed}' so raw markdown renders correctly"
                )));
            }
            in_block_list = false;
        } else if trimmed.starts_with('-') {
            in_block_list = true;
        }
        had_blank_line = false;
    }

    Ok((join_continuation_lines(yaml_block), body))
}

type FmResolutionResult = Result<
    (
        HashMap<String, VarType>,
        HashMap<String, ImportedNamespace>,
        HashMap<String, crate::value::Value>,
    ),
    TemplateError,
>;

/// Validate and coerce a provided [`Value`](crate::value::Value) to match the declared type.
///
/// If the value is already the correct type, it is returned as-is.
/// If the value is `Value::Str` but the declared type is a scalar
/// (int, bool, float), the string is auto-parsed for convenience.
fn validate_env_value(
    name: &str,
    value: &crate::value::Value,
    var_type: &VarType,
) -> Result<crate::value::Value, TemplateError> {
    use crate::value::Value;
    match (value, var_type) {
        // String auto-parse for scalar types.
        (Value::Str(raw), VarType::Int) => raw
            .parse::<i64>()
            .map(Value::Int)
            .map_err(|_| TemplateError::syntax(format!("env '{name}': expected int, got '{raw}'"))),
        (Value::Str(raw), VarType::Bool) => match raw.as_str() {
            crate::consts::LIT_TRUE => Ok(Value::Bool(true)),
            crate::consts::LIT_FALSE => Ok(Value::Bool(false)),
            _ => Err(TemplateError::syntax(format!(
                "env '{name}': expected bool, got '{raw}'"
            ))),
        },
        (Value::Str(raw), VarType::Float) => raw.parse::<f64>().map(Value::Float).map_err(|_| {
            TemplateError::syntax(format!("env '{name}': expected float, got '{raw}'"))
        }),
        // Direct type matches and unknown combos: accept as-is.
        // The template engine validates at render time via type declarations.
        _ => Ok(value.clone()),
    }
}

fn resolve_fm_consts_and_imports(
    fm: &mut Frontmatter,
    consts_raw: Option<&str>,
    env_raw: Option<&str>,
    env_values: &[(&str, crate::value::Value)],
    parent_type_aliases: Option<&HashMap<String, VarType>>,
    #[cfg(feature = "std")] base_dir: Option<&std::path::Path>,
) -> FmResolutionResult {
    let mut merged_aliases = if let Some(parent_aliases) = parent_type_aliases {
        parent_aliases.clone()
    } else {
        HashMap::new()
    };
    for (k, v) in &fm.type_aliases {
        merged_aliases.insert(k.clone(), v.clone());
    }

    let mut prelim_consts = HashMap::new();
    let empty_imports = HashMap::new();
    let empty_consts = HashMap::new();

    // Resolve env declarations first so they're available for import path interpolation.
    if let Some(raw) = env_raw {
        let (mut env_decls, _) =
            parse_declarations(raw, &merged_aliases, &empty_imports, false, &empty_consts)?;
        for decl in &mut env_decls {
            // Look up in provided env_values.
            if let Some((_, provided_val)) = env_values.iter().find(|(k, _)| *k == decl.name) {
                let val = validate_env_value(&decl.name, provided_val, &decl.var_type)?;
                prelim_consts.insert(decl.name.clone(), val.clone());
                decl.default_value = Some(val);
            } else if let Some(ref default) = decl.default_value {
                prelim_consts.insert(decl.name.clone(), default.clone());
            } else {
                return Err(TemplateError::syntax(format!(
                    "env '{}': no value provided and no default",
                    decl.name
                )));
            }
        }
        fm.env = env_decls;
    }

    if let Some(raw) = consts_raw {
        // NOLINT: const parsing failure here is non-fatal — full validation catches errors later
        if let Ok((decls, _)) =
            parse_declarations(raw, &merged_aliases, &empty_imports, true, &prelim_consts)
        {
            let const_map = build_available_consts(&decls, &HashMap::new());
            for (k, v) in const_map {
                prelim_consts.insert(k, v);
            }
        }
    }

    #[cfg(feature = "std")]
    let resolved_imports = if let Some(dir) = base_dir {
        if fm.imports.is_empty() {
            HashMap::new()
        } else {
            let mut visited = std::collections::HashSet::new();
            resolve_imports_with_consts(&mut fm.imports, dir, &mut visited, &prelim_consts)?
        }
    } else {
        if !fm.imports.is_empty() {
            interpolate_imports(&mut fm.imports, &prelim_consts)?;
        }
        HashMap::new()
    };

    #[cfg(not(feature = "std"))]
    let resolved_imports = {
        if !fm.imports.is_empty() {
            interpolate_imports(&mut fm.imports, &prelim_consts)?;
        }
        HashMap::new()
    };

    #[cfg(feature = "std")]
    inject_imported_consts(fm, &resolved_imports);

    if let Some(raw) = consts_raw {
        fm.consts = parse_declarations(
            raw,
            &merged_aliases,
            &resolved_imports,
            true,
            &prelim_consts,
        )?
        .0;
    }

    let mut available_consts = build_available_consts(&fm.consts, &fm.imported_consts);
    // Merge env values into available_consts so params can reference them.
    for decl in &fm.env {
        if let Some(val) = prelim_consts.get(&decl.name) {
            available_consts
                .entry(decl.name.clone())
                .or_insert_with(|| val.clone());
        }
    }
    Ok((merged_aliases, resolved_imports, available_consts))
}

fn parse_frontmatter_impl<'a>(
    source: &'a str,
    #[cfg(feature = "std")] base_dir: Option<&std::path::Path>,
    parent_type_aliases: Option<&HashMap<String, VarType>>,
    allow_missing_fm: bool,
    env_values: &[(&str, crate::value::Value)],
) -> Result<(Frontmatter, &'a str), TemplateError> {
    let (logical_lines, body) = extract_yaml_logical_lines(source, allow_missing_fm)?;
    if logical_lines.is_empty()
        && allow_missing_fm
        && !source.trim_start().starts_with(FM_DELIMITER)
    {
        return Ok((Frontmatter::default(), body));
    }

    let mut fm = Frontmatter::default();
    let mut params_raw: Option<String> = None;
    let mut consts_raw: Option<String> = None;
    let mut env_raw: Option<String> = None;

    for line in &logical_lines {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(FM_NAME_PREFIX) {
            fm.name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix(FM_DESC_PREFIX) {
            fm.description = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix(FM_TYPES_PREFIX) {
            fm.type_aliases = parse_types_value(rest)?;
        } else if let Some(rest) = line.strip_prefix(FM_IMPORTS_PREFIX) {
            fm.imports = parse_imports_value(rest)?;
        } else if let Some(rest) = line.strip_prefix(FM_PARAMS_PREFIX) {
            params_raw = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix(FM_CONSTS_PREFIX) {
            consts_raw = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix(FM_ENV_PREFIX) {
            env_raw = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix(FM_ALLOW_UNUSED_PREFIX) {
            fm.allow_unused = rest.trim() == crate::consts::LIT_TRUE;
        }
    }

    let (merged_aliases, resolved_imports, available_consts) = resolve_fm_consts_and_imports(
        &mut fm,
        consts_raw.as_deref(),
        env_raw.as_deref(),
        env_values,
        parent_type_aliases,
        #[cfg(feature = "std")]
        base_dir,
    )?;

    if let Some(raw) = params_raw {
        let (decls, import_refs) = parse_declarations(
            &raw,
            &merged_aliases,
            &resolved_imports,
            false,
            &available_consts,
        )?;
        fm.params = decls.iter().map(|d| d.name.clone()).collect();
        fm.declarations = decls;
        fm.has_params = true;
        fm.imported_type_params = import_refs;
    }

    validate_collision_rules(&fm)?;
    add_implicit_param_types(&mut fm);

    Ok((fm, body))
}

/// Inject imported constants and enum type namespace dicts into `fm`.
///
/// For each import namespace, copies over user-defined constants and
/// synthesizes enum type namespace dicts so that `{{ lib.EnumType.Variant }}`
/// expressions work.
#[cfg(feature = "std")]
fn inject_imported_consts(
    fm: &mut Frontmatter,
    resolved_imports: &HashMap<String, ImportedNamespace>,
) {
    for (stem, ns) in resolved_imports {
        for (name, val) in &ns.consts {
            fm.imported_consts
                .insert(format!("{stem}.{name}"), val.clone());
        }
        // Inject enum type aliases from the imported namespace as constants,
        // enabling `{{ lib.EnumType.Variant }}` expressions.
        for (type_name, var_type) in &ns.type_aliases {
            let VarType::Enum(variants) = var_type else {
                continue;
            };
            let key = format!("{stem}.{type_name}");
            // Don't overwrite a user-defined constant with the same name.
            if fm.imported_consts.contains_key(&key) {
                continue;
            }
            let mut variant_map = HashMap::new();
            let mut variant_names = Vec::with_capacity(variants.len());
            for variant in variants {
                variant_names.push(crate::value::Value::Str(variant.name.clone()));
                if variant.fields.is_empty() {
                    variant_map.insert(
                        variant.name.clone(),
                        crate::value::Value::Str(variant.name.clone()),
                    );
                } else {
                    let mut partial = HashMap::new();
                    partial.insert(
                        crate::consts::ENUM_TAG_KEY.into(),
                        crate::value::Value::Str(variant.name.clone()),
                    );
                    variant_map.insert(
                        variant.name.clone(),
                        crate::value::Value::Struct(alloc::sync::Arc::new(partial)),
                    );
                }
            }
            variant_map.insert(
                crate::consts::ENUM_VARIANTS_KEY.into(),
                crate::value::Value::List(alloc::sync::Arc::new(variant_names)),
            );
            fm.imported_consts.insert(
                key.clone(),
                crate::value::Value::Struct(alloc::sync::Arc::new(variant_map)),
            );
            fm.imported_enum_type_keys.push(key);
        }
        // Build a typed namespace struct so the type checker can resolve paths
        // through the import stem (e.g. `artist.SEVERITY_LADDER`) instead of
        // treating it as opaque.
        //
        // The struct must model *every* name reachable via the stem — not just
        // consts — otherwise typing the stem would break access to imported
        // types/enums (e.g. `kinds(lib.Priority)` or `lib.Status.Paused`).
        // We therefore include type aliases and implicit param types alongside
        // const types. Const types take precedence on any name collision.
        //
        // Scoped to imports that actually export typed consts: type-only imports
        // remain opaque, preserving their established resolution behavior.
        if !ns.const_types.is_empty() {
            let mut field_types: HashMap<String, VarType> = HashMap::new();
            for (name, var_type) in &ns.param_types {
                field_types.insert(name.clone(), var_type.clone());
            }
            for (name, var_type) in &ns.type_aliases {
                field_types.insert(name.clone(), var_type.clone());
            }
            for (name, var_type) in &ns.const_types {
                field_types.insert(name.clone(), var_type.clone());
            }
            let fields: Vec<VarDecl> = field_types
                .into_iter()
                .map(|(name, var_type)| VarDecl {
                    name,
                    var_type,
                    default_value: None,
                })
                .collect();
            fm.imported_namespace_types
                .insert(stem.clone(), VarType::Struct(fields));
        }
    }
}

/// Build a lookup map of available constants for use as param default values.
///
/// Merges local constants (from `consts:` declarations) with imported constants
/// (from `imports:`) into a single flat map. Local consts are keyed by their
/// bare name (e.g. `MAX`), imported consts are already keyed by `stem.NAME`
/// (e.g. `lib.LIMIT`).
fn build_available_consts(
    consts: &[crate::types::VarDecl],
    imported_consts: &HashMap<String, crate::value::Value>,
) -> HashMap<String, crate::value::Value> {
    let mut available = HashMap::with_capacity(consts.len() + imported_consts.len());
    // Add local consts.
    for d in consts {
        if let Some(ref v) = d.default_value {
            available.insert(d.name.clone(), v.clone());
        }
    }
    // Add imported consts (stem.NAME keys).
    for (k, v) in imported_consts {
        available.insert(k.clone(), v.clone());
    }
    available
}

#[cfg(test)]
mod tests;
