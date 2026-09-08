use std::path::PathBuf;

use hashbrown::{HashMap, HashSet};

/// Extract the file stem from a template path, stripping `.tmpl.md` or
/// `.tmpl` suffixes.
pub(crate) fn stem_from_path(path: &str) -> String {
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    // Strip known double extensions first.
    filename
        .strip_suffix(".tmpl.md")
        .or_else(|| filename.strip_suffix(".tmpl"))
        .unwrap_or_else(|| {
            // Fallback: strip last extension.
            filename.rsplit_once('.').map_or(filename, |(stem, _)| stem)
        })
        .to_string()
}

pub(crate) fn hash_source(source: &str) -> u64 {
    md_tmpl_core::__private::fnv1a_hash(source.as_bytes())
}

/// Result of compiling a template at macro expansion time.
pub(crate) struct CompiledTemplateAst {
    pub(crate) frontmatter: md_tmpl_core::Frontmatter,
    pub(crate) segments: Vec<md_tmpl_core::compiled::Segment>,
    pub(crate) inline_templates: HashMap<String, md_tmpl_core::compiled::CompiledInlineTemplate>,
    pub(crate) source_hash: u64,
    /// Absolute paths of every file read while compiling this template
    /// (imported and `{% include %}`d templates, transitively). The generated
    /// code emits an `include_str!` for each so Cargo rebuilds when any of
    /// them changes.
    pub(crate) dependency_paths: Vec<PathBuf>,
}

/// Read a template file relative to `CARGO_MANIFEST_DIR`, compile it,
/// and return both the resolved full path and the compiled AST.
pub(crate) fn load_and_compile(
    rel_path: &str,
    env_values: &[(&str, md_tmpl_core::Value)],
) -> Result<(std::path::PathBuf, CompiledTemplateAst), String> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let full_path = std::path::Path::new(&manifest_dir).join(rel_path);
    let source = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("failed to read template '{}': {e}", full_path.display()))?;
    let base_dir = full_path.parent().unwrap_or(std::path::Path::new("."));
    let ast = compile_template_to_ast(&source, base_dir, env_values)?;
    Ok((full_path, ast))
}

pub(crate) fn compile_template_to_ast(
    source: &str,
    base_dir: &std::path::Path,
    env_values: &[(&str, md_tmpl_core::Value)],
) -> Result<CompiledTemplateAst, String> {
    let source_hash = hash_source(source);
    let (mut fm, body) =
        md_tmpl_core::parse_frontmatter_with_base_dir(source, base_dir, env_values)
            .map_err(|e| e.to_string())?;

    // Track every file read at macro-expansion time so the generated code can
    // emit `include_str!` for each. Without this, Cargo would not rebuild when
    // an imported or `{% include %}`d dependency changes, silently embedding
    // stale content and skipping build-time validation of the edited file.
    let mut dependency_paths: Vec<PathBuf> = Vec::new();
    collect_import_deps(&fm, base_dir, &mut dependency_paths);

    let (mut segments, inline_templates) =
        md_tmpl_core::compiled::compile(body, &fm.type_aliases).map_err(|e| e.to_string())?;

    // Static analysis: Enforce that all parameters referenced in the body are declared.
    check_undeclared_variables(&fm, &inline_templates, &segments)?;

    // Recursively resolve includes at compile time.
    resolve_compile_time_includes(
        &mut segments,
        base_dir,
        &fm,
        &inline_templates,
        &mut dependency_paths,
    )?;

    // Flow-sensitive type check: validate variant names and field access.
    validate_types(&fm, &segments)?;

    // Inject enum type alias constants so that kind(TypeName.Variant)
    // and kinds(TypeName) work at render time. Reuses the same function
    // as the runtime `from_source` path (DRY).
    md_tmpl_core::__private::inject_enum_type_constants(&fm.type_aliases, &mut fm.imported_consts);

    dependency_paths.sort();
    dependency_paths.dedup();

    Ok(CompiledTemplateAst {
        frontmatter: fm,
        segments,
        inline_templates,
        source_hash,
        dependency_paths,
    })
}

/// Record the on-disk paths of a frontmatter's `imports:` entries as build
/// dependencies. Import paths are resolved relative to `base_dir` (matching the
/// core import resolver); absolute paths are recorded as-is.
fn collect_import_deps(
    fm: &md_tmpl_core::Frontmatter,
    base_dir: &std::path::Path,
    deps: &mut Vec<PathBuf>,
) {
    for import in &fm.imports {
        let resolved = if import.path.is_absolute() {
            import.path.clone()
        } else {
            base_dir.join(&import.path)
        };
        deps.push(resolved);
    }
}

/// Check that all parameters referenced in the template body are declared
/// in the frontmatter (params, consts, env, imports, inline templates,
/// or type aliases).
fn check_undeclared_variables(
    fm: &md_tmpl_core::Frontmatter,
    inline_templates: &HashMap<String, md_tmpl_core::compiled::CompiledInlineTemplate>,
    segments: &[md_tmpl_core::compiled::Segment],
) -> Result<(), String> {
    let referenced = md_tmpl_core::compiled::collect_referenced_params(segments);
    let mut declared: HashSet<String> = fm.params.iter().cloned().collect();
    for c in &fm.consts {
        declared.insert(c.name.clone());
    }
    for e in &fm.env {
        declared.insert(e.name.clone());
    }
    for import in &fm.imports {
        declared.insert(import.stem.clone());
    }
    // Inline template names ({% tmpl NAME %}) are valid targets for
    // {% include NAME %} and should not be flagged as undeclared variables.
    for inline_name in inline_templates.keys() {
        declared.insert(inline_name.clone());
    }
    // Type alias names are valid references in kind()/kinds() expressions
    // (e.g., `kind(Status.Active)`, `kinds(Role)`).
    // Enum variant names (e.g. `Active`, `Paused`) appear as unquoted labels
    // in match arms and are collected by the analysis — they must not be
    // flagged as undeclared variables.  We only add top-level enum variants
    // (not recursively nested ones) to avoid masking real typos.
    for (type_name, var_type) in &fm.type_aliases {
        if let md_tmpl_core::VarType::Enum(variants) = var_type {
            declared.insert(type_name.clone());
            for variant in variants {
                declared.insert(variant.name.clone());
            }
        }
    }
    // Variant names from inline enum types on params/consts
    // (e.g. `status = enum(Open, Closed)` without a type alias).
    for decl in fm.declarations.iter().chain(fm.consts.iter()) {
        if let md_tmpl_core::VarType::Enum(variants) = &decl.var_type {
            for variant in variants {
                declared.insert(variant.name.clone());
            }
        }
    }
    // Boolean literals `true`/`false` in `{% case true %}` are pattern syntax,
    // not variable references.
    declared.insert("true".to_string());
    declared.insert("false".to_string());
    // `Some` and `None` are option-type sentinels used in `{% case Some %}`
    // and `{% case None %}` arms.
    declared.insert("Some".to_string());
    declared.insert("None".to_string());
    let undeclared: Vec<&String> = referenced
        .iter()
        .filter(|v| !declared.contains(v.as_str()))
        .collect();
    if !undeclared.is_empty() {
        let mut names: Vec<&str> = undeclared.iter().map(|s| s.as_str()).collect();
        names.sort_unstable();
        return Err(format!(
            "undeclared variable(s) referenced in body: {}",
            names.join(", ")
        ));
    }
    Ok(())
}

/// Recursively resolve includes at compile time, collecting declared
/// `tmpl()` parameter names to skip dynamic includes.
fn resolve_compile_time_includes(
    segments: &mut [md_tmpl_core::compiled::Segment],
    base_dir: &std::path::Path,
    fm: &md_tmpl_core::Frontmatter,
    inline_templates: &HashMap<String, md_tmpl_core::compiled::CompiledInlineTemplate>,
    deps: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let tmpl_params: HashSet<String> = fm
        .declarations
        .iter()
        .filter(|d| matches!(d.var_type, md_tmpl_core::VarType::Tmpl(_)))
        .map(|d| d.name.clone())
        .collect();
    let mut visited_paths = HashSet::new();
    resolve_includes_recursive(
        segments,
        base_dir,
        &mut visited_paths,
        inline_templates,
        &tmpl_params,
        deps,
        0,
    )
}

/// Flow-sensitive type check: validate variant names and field access
/// using the full type alias map.
///
/// Delegates to [`md_tmpl_core::Frontmatter::validate_field_types`], the single
/// source of truth shared with the runtime and cross-backend test runners.
fn validate_types(
    fm: &md_tmpl_core::Frontmatter,
    segments: &[md_tmpl_core::compiled::Segment],
) -> Result<(), String> {
    let type_errors = fm.validate_field_types(segments);
    if !type_errors.is_empty() {
        return Err(type_errors.join("\n"));
    }
    Ok(())
}

/// Maximum compile-time include depth. Prevents pathological non-circular
/// chains from causing excessive compilation time. Override with the
/// `MD_TMPL_MAX_INCLUDE_DEPTH` environment variable.
const DEFAULT_MAX_COMPILE_INCLUDE_DEPTH: usize = 64;

pub(crate) fn max_compile_include_depth() -> usize {
    std::env::var("MD_TMPL_MAX_INCLUDE_DEPTH")
        // NOLINT: missing or invalid env var is expected — fall back to compiled default
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_COMPILE_INCLUDE_DEPTH)
}

pub(crate) fn resolve_includes_recursive(
    segments: &mut [md_tmpl_core::compiled::Segment],
    base_dir: &std::path::Path,
    visited_paths: &mut HashSet<PathBuf>,
    inline_templates: &HashMap<String, md_tmpl_core::compiled::CompiledInlineTemplate>,
    tmpl_params: &HashSet<String>,
    deps: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    let max_depth = max_compile_include_depth();
    if depth > max_depth {
        return Err(format!(
            "compile-time include depth ({depth}) exceeds maximum ({max_depth}). \
             Set MD_TMPL_MAX_INCLUDE_DEPTH to increase the limit"
        ));
    }

    for seg in segments {
        match seg {
            md_tmpl_core::compiled::Segment::Include(inc) => {
                // Dynamic tmpl() parameter — resolved at runtime, not compile time.
                if tmpl_params.contains(inc.path.as_ref()) {
                    continue;
                }

                // Check inline templates (scoped to THIS file).
                if let Some(compiled) = inline_templates.get(inc.path.as_ref()) {
                    inc.inline_compiled = Some(compiled.clone());
                    continue;
                }

                let include_path = base_dir.join(inc.path.as_ref());
                let canonical = include_path
                    .canonicalize()
                    .unwrap_or_else(|_| include_path.clone());

                if !visited_paths.insert(canonical.clone()) {
                    // Cycle detected — load declarations for boundary checking
                    // but don't recurse into the body.
                    load_include_declarations(inc, &include_path, deps)?;
                    continue;
                }

                resolve_single_include(inc, base_dir, visited_paths, deps, depth + 1)?;
                visited_paths.remove(&canonical);
            }
            md_tmpl_core::compiled::Segment::ForLoop { body, .. } => {
                resolve_includes_recursive(
                    body,
                    base_dir,
                    visited_paths,
                    inline_templates,
                    tmpl_params,
                    deps,
                    depth,
                )?;
            }
            md_tmpl_core::compiled::Segment::If {
                branches,
                else_body,
            } => {
                for (_, branch_body) in branches {
                    resolve_includes_recursive(
                        branch_body,
                        base_dir,
                        visited_paths,
                        inline_templates,
                        tmpl_params,
                        deps,
                        depth,
                    )?;
                }
                resolve_includes_recursive(
                    else_body,
                    base_dir,
                    visited_paths,
                    inline_templates,
                    tmpl_params,
                    deps,
                    depth,
                )?;
            }
            md_tmpl_core::compiled::Segment::Match { arms, .. } => {
                for arm in arms {
                    resolve_includes_recursive(
                        &mut arm.body,
                        base_dir,
                        visited_paths,
                        inline_templates,
                        tmpl_params,
                        deps,
                        depth,
                    )?;
                }
            }
            md_tmpl_core::compiled::Segment::Static(_)
            | md_tmpl_core::compiled::Segment::Expr { .. }
            | md_tmpl_core::compiled::Segment::Raw(_)
            | md_tmpl_core::compiled::Segment::Comment(_)
            | md_tmpl_core::compiled::Segment::Panic(_) => {}
        }
    }
    Ok(())
}

/// Load and compile an included template file into its `inline_compiled` field.
///
/// Used for the cycle case: we need the declarations for boundary type checking
/// but don't recurse into the body's own includes.
pub(crate) fn load_include_declarations(
    inc: &mut md_tmpl_core::compiled::CompiledInclude,
    include_path: &std::path::Path,
    deps: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if inc.inline_compiled.is_some() {
        return Ok(());
    }
    let included_source = std::fs::read_to_string(include_path)
        .map_err(|e| format!("cannot read include {}: {e}", include_path.display()))?;
    deps.push(include_path.to_path_buf());
    let included_base_dir = include_path.parent().unwrap_or(std::path::Path::new("."));
    let (included_fm, included_body) =
        md_tmpl_core::parse_frontmatter_with_base_dir(&included_source, included_base_dir, &[])
            .map_err(|e| format!("syntax error in include {}: {e}", include_path.display()))?;
    collect_import_deps(&included_fm, included_base_dir, deps);
    let (included_segments, _) =
        md_tmpl_core::compiled::compile(included_body, &included_fm.type_aliases).map_err(|e| {
            format!(
                "compilation error in include {}: {e}",
                include_path.display()
            )
        })?;
    // Build const values map from included file's own consts.
    let mut included_consts = hashbrown::HashMap::new();
    for d in &included_fm.consts {
        if let Some(ref v) = d.default_value {
            included_consts.insert(d.name.clone(), v.clone());
        }
    }
    inc.inline_compiled = Some(md_tmpl_core::compiled::CompiledInlineTemplate {
        segments: std::sync::Arc::from(included_segments),
        declarations: std::sync::Arc::from(included_fm.declarations),
        consts: std::sync::Arc::new(included_consts),
        imported_consts: std::sync::Arc::new(included_fm.imported_consts),
    });
    Ok(())
}

/// Process a single include directive: load, compile, and recurse into
/// the included template's own includes.
///
/// Contract and type checking is now handled by `validate_field_accesses`
/// after all includes are resolved.
pub(crate) fn resolve_single_include(
    inc: &mut md_tmpl_core::compiled::CompiledInclude,
    base_dir: &std::path::Path,
    visited_paths: &mut HashSet<PathBuf>,
    deps: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    let include_path = base_dir.join(inc.path.as_ref());
    let included_source = std::fs::read_to_string(&include_path)
        .map_err(|e| format!("cannot read include {}: {e}", include_path.display()))?;
    deps.push(include_path.clone());

    let included_base_dir = include_path.parent().unwrap_or(base_dir);
    let (included_fm, included_body) =
        md_tmpl_core::parse_frontmatter_with_base_dir(&included_source, included_base_dir, &[])
            .map_err(|e| format!("syntax error in include {}: {e}", include_path.display()))?;
    collect_import_deps(&included_fm, included_base_dir, deps);

    // Compile the included file and extract ITS OWN inline templates.
    // Each file has its own {% tmpl %} namespace — parent templates do NOT
    // leak into includes, and included file templates don't leak to parents.
    let (mut included_segments, included_inline_templates) =
        md_tmpl_core::compiled::compile(included_body, &included_fm.type_aliases).map_err(|e| {
            format!(
                "compilation error in include {}: {e}",
                include_path.display()
            )
        })?;

    let child_base_dir = include_path.parent().unwrap_or(base_dir);
    // Use the INCLUDED FILE'S own inline templates, not the parent's.
    // Block scope ensures `child_tmpl_params` is dropped before
    // `included_fm.declarations` is moved into an Arc.
    {
        let child_tmpl_params: HashSet<String> = included_fm
            .declarations
            .iter()
            .filter(|d| matches!(d.var_type, md_tmpl_core::VarType::Tmpl(_)))
            .map(|d| d.name.clone())
            .collect();
        resolve_includes_recursive(
            &mut included_segments,
            child_base_dir,
            visited_paths,
            &included_inline_templates,
            &child_tmpl_params,
            deps,
            depth,
        )?;
    }

    // Build const values map from included file's own consts.
    let mut included_consts = hashbrown::HashMap::new();
    for d in &included_fm.consts {
        if let Some(ref v) = d.default_value {
            included_consts.insert(d.name.clone(), v.clone());
        }
    }
    inc.inline_compiled = Some(md_tmpl_core::compiled::CompiledInlineTemplate {
        segments: std::sync::Arc::from(included_segments),
        declarations: std::sync::Arc::from(included_fm.declarations),
        consts: std::sync::Arc::new(included_consts),
        imported_consts: std::sync::Arc::new(included_fm.imported_consts),
    });
    Ok(())
}
