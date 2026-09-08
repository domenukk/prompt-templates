use alloc::{format, string::String, sync::Arc, vec::Vec};

use hashbrown::{HashMap, HashSet};

use crate::{
    compiled::{self, CompiledInlineTemplate, Segment},
    error::TemplateError,
    frontmatter::Frontmatter,
    types::{VarDecl, VarType},
    value::Value,
};

/// Inject enum type aliases as namespace constants.
///
/// For each enum type alias like `Stage = enum(Design, Build)`, this creates
/// a dict constant `Stage` → `{Design: "Design", Build: "Build"}`.
/// This enables expressions like `{{ kind(Stage.Design) }}` in templates.
/// Bare access like `{{ Stage.Design }}` is rejected at compile time —
/// users must wrap enum literals in `kind()` for explicit variant name extraction.
///
/// Unit variants map to `Value::Str(name)`. Struct variants map to a tagged
/// dict with just `__kind__` set (a partial value suitable for `kind()` and
/// match arms).
pub fn inject_enum_type_constants(
    type_aliases: &HashMap<String, VarType>,
    consts: &mut HashMap<String, Value>,
) {
    for (type_name, var_type) in type_aliases {
        let VarType::Enum(variants) = var_type else {
            continue;
        };
        if consts.contains_key(type_name) {
            continue;
        }
        let mut variant_map = HashMap::new();
        let mut variant_names = Vec::with_capacity(variants.len());
        for variant in variants {
            variant_names.push(Value::Str(variant.name.clone()));
            if variant.fields.is_empty() {
                variant_map.insert(variant.name.clone(), Value::Str(variant.name.clone()));
            } else {
                let mut partial = HashMap::new();
                partial.insert(
                    crate::consts::ENUM_TAG_KEY.into(),
                    Value::Str(variant.name.clone()),
                );
                variant_map.insert(variant.name.clone(), Value::Struct(Arc::new(partial)));
            }
        }
        variant_map.insert(
            crate::consts::ENUM_VARIANTS_KEY.into(),
            Value::List(Arc::new(variant_names)),
        );
        consts.insert(type_name.clone(), Value::Struct(Arc::new(variant_map)));
    }
}

/// Collect the set of enum type names (both local and imported).
pub(super) fn collect_enum_type_keys(fm: &Frontmatter) -> HashSet<String> {
    let mut keys = HashSet::new();
    for (name, ty) in &fm.type_aliases {
        if matches!(ty, VarType::Enum(_)) {
            keys.insert(name.clone());
        }
    }
    for key in &fm.imported_enum_type_keys {
        keys.insert(key.clone());
    }
    keys
}

/// Reject bare enum literal expressions like `{{ Stage.Design }}`.
pub(super) fn check_bare_enum_access(
    segments: &[Segment],
    enum_keys: &HashSet<String>,
) -> Result<(), TemplateError> {
    for seg in segments {
        match seg {
            Segment::Expr {
                expr: crate::compiled::CompiledExpr::Path(path),
                ..
            } => {
                let parts = path.parts();
                if parts.len() >= 2 && is_enum_path(parts, enum_keys) {
                    return Err(TemplateError::syntax(format!(
                        "bare enum literal '{}' is not allowed — \
                         use kind({}) to get the variant name as a string",
                        path.as_str(),
                        path.as_str(),
                    )));
                }
            }
            Segment::ForLoop { body, .. } => {
                check_bare_enum_access(body, enum_keys)?;
            }
            Segment::If {
                branches,
                else_body,
            } => {
                for (_, branch_body) in branches {
                    check_bare_enum_access(branch_body, enum_keys)?;
                }
                check_bare_enum_access(else_body, enum_keys)?;
            }
            Segment::Match { arms, .. } => {
                for arm in arms {
                    check_bare_enum_access(&arm.body, enum_keys)?;
                }
            }
            Segment::Include(inc) => {
                if let Some(ref inline) = inc.inline_compiled {
                    check_bare_enum_access(&inline.segments, enum_keys)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Recursively check a single condition for static enum `in` validation.
fn check_static_enum_in_condition(
    cond: &compiled::Condition,
    type_aliases: &HashMap<String, crate::types::VarType>,
) -> Result<(), TemplateError> {
    match cond {
        compiled::Condition::Comparison { left, op, right } => {
            if matches!(op, compiled::ComparisonOp::In) {
                if let compiled::ConditionOperand::Kinds(path) = right {
                    if let Some(crate::types::VarType::Enum(variants)) =
                        type_aliases.get(&path.parts()[0])
                    {
                        if let compiled::ConditionOperand::Literal(crate::value::Value::Str(
                            str_val,
                        )) = left
                        {
                            if !variants.iter().any(|v| v.name == *str_val) {
                                return Err(TemplateError::syntax(format!(
                                    "static string \"{str_val}\" is not a valid variant of enum '{}'",
                                    path.as_str()
                                )));
                            }
                        }
                    }
                }
            }
        }
        compiled::Condition::And(left, right) | compiled::Condition::Or(left, right) => {
            check_static_enum_in_condition(left, type_aliases)?;
            check_static_enum_in_condition(right, type_aliases)?;
        }
        compiled::Condition::Not(inner) => {
            check_static_enum_in_condition(inner, type_aliases)?;
        }
        compiled::Condition::Truthy(_) | compiled::Condition::MatchVariant { .. } => {}
    }
    Ok(())
}

pub(super) fn check_static_enum_in_conditions(
    segments: &[compiled::Segment],
    type_aliases: &HashMap<String, crate::types::VarType>,
) -> Result<(), TemplateError> {
    for seg in segments {
        match seg {
            compiled::Segment::If {
                branches,
                else_body,
            } => {
                for (cond, branch_body) in branches {
                    check_static_enum_in_condition(cond, type_aliases)?;
                    check_static_enum_in_conditions(branch_body, type_aliases)?;
                }
                check_static_enum_in_conditions(else_body, type_aliases)?;
            }
            compiled::Segment::ForLoop {
                body, else_body, ..
            } => {
                check_static_enum_in_conditions(body, type_aliases)?;
                check_static_enum_in_conditions(else_body, type_aliases)?;
            }
            compiled::Segment::Match { arms, .. } => {
                for arm in arms {
                    if let Some(ref guard) = arm.guard {
                        check_static_enum_in_condition(guard, type_aliases)?;
                    }
                    check_static_enum_in_conditions(&arm.body, type_aliases)?;
                }
            }
            compiled::Segment::Include(inc) => {
                if let Some(ref inline) = inc.inline_compiled {
                    check_static_enum_in_conditions(&inline.segments, type_aliases)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn is_enum_path(parts: &[String], enum_keys: &HashSet<String>) -> bool {
    if enum_keys.contains(&parts[0]) {
        return true;
    }
    if parts.len() >= 3 {
        let key = format!("{}.{}", parts[0], parts[1]);
        if enum_keys.contains(&key) {
            return true;
        }
    }
    false
}

/// Enforce that all parameters referenced in the body are declared.
pub(super) fn check_undeclared_variables(
    referenced: &HashSet<String>,
    fm: &Frontmatter,
    inline_templates: &HashMap<String, CompiledInlineTemplate>,
) -> Result<(), TemplateError> {
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
    for (name, ty) in &fm.type_aliases {
        if let VarType::Enum(variants) = ty {
            declared.insert(name.clone());
            // Enum variant names appear in `{% case Variant %}` labels and are
            // collected by `collect_referenced_params` alongside real variable
            // references. They are pattern labels, not variable references, so
            // we must mark them as "known" here.
            for variant in variants {
                declared.insert(variant.name.clone());
            }
        }
    }
    // Also whitelist variant names from inline enum types on params/consts
    // (e.g. `status = enum(Open, Closed)` without a type alias).
    for decl in fm.declarations.iter().chain(fm.consts.iter()) {
        if let VarType::Enum(variants) = &decl.var_type {
            for variant in variants {
                declared.insert(variant.name.clone());
            }
        }
    }
    for inline_name in inline_templates.keys() {
        declared.insert(inline_name.clone());
    }
    // `Some` and `None` are option-type sentinels used in `{% case Some %}`
    // and `{% case None %}` arms.
    declared.insert(crate::consts::OPTION_SOME.into());
    declared.insert(crate::consts::OPTION_NONE.into());

    let undeclared: Vec<&String> = referenced
        .iter()
        .filter(|v| !declared.contains(v.as_str()))
        .collect();
    if undeclared.is_empty() {
        return Ok(());
    }

    let mut names: Vec<&str> = undeclared.iter().map(|s| s.as_str()).collect();
    names.sort_unstable();

    let mut suggestions = Vec::new();
    for name in &names {
        let mut best: Option<(&str, usize)> = None;
        for candidate in &declared {
            let dist = crate::error::levenshtein_distance(name, candidate);
            if dist > 0 && dist <= 2 && best.is_none_or(|b| dist < b.1) {
                best = Some((candidate, dist));
            }
        }
        if let Some((suggestion, _)) = best {
            suggestions.push(format!("'{name}' (did you mean '{suggestion}'?)"));
        }
    }
    let suffix = if suggestions.is_empty() {
        String::new()
    } else {
        format!(". Suggestions: {}", suggestions.join(", "))
    };
    Err(TemplateError::syntax(format!(
        "{}{}{suffix}",
        crate::consts::ERR_UNDECLARED_PREFIX,
        names.join(", ")
    )))
}

/// Reject declared parameters that are never referenced in the body.
///
/// A parameter is considered "used" if it appears in the body-expression
/// reference set OR as an unquoted case label in a match arm (which reads
/// the param's value at runtime for comparison).
pub(super) fn check_unused_params(
    declarations: &[VarDecl],
    referenced: &HashSet<String>,
    case_labels: &HashSet<String>,
    allow_unused: bool,
) -> Result<(), TemplateError> {
    if allow_unused {
        return Ok(());
    }
    let unused: Vec<&str> = declarations
        .iter()
        .filter(|decl| !referenced.contains(&decl.name) && !case_labels.contains(&decl.name))
        .map(|decl| decl.name.as_str())
        .collect();
    if unused.is_empty() {
        return Ok(());
    }
    Err(TemplateError::syntax(format!(
        "unused declared parameter(s): {}. Reference them in the template body, \
         in a {{# comment #}}, or remove them from the frontmatter `params:` list. \
         To suppress this check, add `allow_unused: true` to the frontmatter",
        unused.join(", ")
    )))
}

/// Check for namespace collisions between imports, params/consts, and inline templates.
pub(super) fn check_name_collisions(
    fm: &Frontmatter,
    inline_templates: &HashMap<String, CompiledInlineTemplate>,
    segments: &[Segment],
) -> Result<(), TemplateError> {
    for import in &fm.imports {
        if inline_templates.contains_key(&import.stem) {
            return Err(TemplateError::syntax(format!(
                "import stem '{}' conflicts with inline template name",
                import.stem
            )));
        }
    }

    let param_and_const_names: HashSet<&str> = fm
        .params
        .iter()
        .map(String::as_str)
        .chain(fm.consts.iter().map(|c| c.name.as_str()))
        .chain(fm.env.iter().map(|e| e.name.as_str()))
        .collect();
    for inline_name in inline_templates.keys() {
        if param_and_const_names.contains(inline_name.as_str()) {
            return Err(TemplateError::syntax(format!(
                "inline template name '{inline_name}' conflicts with a declared parameter or constant"
            )));
        }
    }

    let protected_names: HashSet<&str> = fm
        .params
        .iter()
        .map(String::as_str)
        .chain(fm.consts.iter().map(|c| c.name.as_str()))
        .chain(fm.env.iter().map(|e| e.name.as_str()))
        .chain(fm.imports.iter().map(|i| i.stem.as_str()))
        .chain(inline_templates.keys().map(String::as_str))
        .collect();
    validate_for_bindings(segments, &protected_names)
}

fn validate_for_bindings(
    segments: &[Segment],
    protected: &HashSet<&str>,
) -> Result<(), TemplateError> {
    for seg in segments {
        match seg {
            Segment::ForLoop { binding, body, .. } => {
                if protected.contains(binding.as_ref()) {
                    return Err(TemplateError::syntax(format!(
                        "{} declared name '{binding}'",
                        crate::consts::ERR_FOR_BINDING_SHADOWS,
                    )));
                }
                validate_for_bindings(body, protected)?;
            }
            Segment::If {
                branches,
                else_body,
            } => {
                for (_cond, branch_body) in branches {
                    validate_for_bindings(branch_body, protected)?;
                }
                validate_for_bindings(else_body, protected)?;
            }
            Segment::Match { arms, .. } => {
                for arm in arms {
                    validate_for_bindings(&arm.body, protected)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Reject paths that reference the internal `__kind__` key.
///
/// The `ENUM_TAG_KEY` is an internal implementation detail used for enum
/// variant tagging. Users must use `kind(expr)` to access it. Rejecting
/// it at compile time allows the render hot path to skip the guard check
/// on every `get_field` call.
pub(super) fn check_internal_key_access(segments: &[Segment]) -> Result<(), TemplateError> {
    for seg in segments {
        check_internal_key_in_segment(seg)?;
    }
    Ok(())
}

fn check_internal_key_in_segment(seg: &Segment) -> Result<(), TemplateError> {
    match seg {
        Segment::Expr { expr, .. } => {
            check_internal_key_in_expr(expr)?;
        }
        Segment::ForLoop {
            body,
            else_body,
            list_expr,
            ..
        } => {
            check_internal_key_in_expr(list_expr)?;
            check_internal_key_access(body)?;
            check_internal_key_access(else_body)?;
        }
        Segment::If {
            branches,
            else_body,
        } => {
            for (cond, branch_body) in branches {
                check_internal_key_in_condition(cond)?;
                check_internal_key_access(branch_body)?;
            }
            check_internal_key_access(else_body)?;
        }
        Segment::Match { expr, arms, .. } => {
            check_internal_key_in_path(expr)?;
            for arm in arms {
                if let Some(ref guard) = arm.guard {
                    check_internal_key_in_condition(guard)?;
                }
                check_internal_key_access(&arm.body)?;
            }
        }
        Segment::Include(inc) => {
            if let Some(ref inline) = inc.inline_compiled {
                check_internal_key_access(&inline.segments)?;
            }
        }
        Segment::Panic(body) => {
            check_internal_key_access(body)?;
        }
        Segment::Static(_) | Segment::Raw(_) | Segment::Comment(_) => {}
    }
    Ok(())
}

fn check_internal_key_in_expr(expr: &crate::scope::CompiledExpr) -> Result<(), TemplateError> {
    match expr {
        crate::scope::CompiledExpr::Path(p)
        | crate::scope::CompiledExpr::Len(p)
        | crate::scope::CompiledExpr::Kind(p)
        | crate::scope::CompiledExpr::Kinds(p)
        | crate::scope::CompiledExpr::Has(p) => check_internal_key_in_path(p),
        // Literals and loop indices carry no path, so no internal key access.
        crate::scope::CompiledExpr::Literal(_) | crate::scope::CompiledExpr::Idx(_) => Ok(()),
    }
}

fn check_internal_key_in_path(path: &crate::scope::CompiledPath) -> Result<(), TemplateError> {
    let tag_key = crate::consts::ENUM_TAG_KEY;
    for part in path.parts() {
        if part == tag_key {
            return Err(TemplateError::syntax(format!(
                "access to internal key '{tag_key}' is not allowed — \
                 use kind({}) to get the enum variant name",
                path.as_str().replace(&format!(".{tag_key}"), ""),
            )));
        }
    }
    Ok(())
}

fn check_internal_key_in_condition(cond: &compiled::Condition) -> Result<(), TemplateError> {
    match cond {
        compiled::Condition::Truthy(op) => check_internal_key_in_operand(op),
        compiled::Condition::Not(inner) => check_internal_key_in_condition(inner),
        compiled::Condition::And(left, right) | compiled::Condition::Or(left, right) => {
            check_internal_key_in_condition(left)?;
            check_internal_key_in_condition(right)
        }
        compiled::Condition::Comparison { left, right, .. } => {
            check_internal_key_in_operand(left)?;
            check_internal_key_in_operand(right)
        }
        compiled::Condition::MatchVariant { expr, .. } => check_internal_key_in_path(expr),
    }
}

fn check_internal_key_in_operand(op: &compiled::ConditionOperand) -> Result<(), TemplateError> {
    match op {
        compiled::ConditionOperand::Path { path: p, .. }
        | compiled::ConditionOperand::Len(p)
        | compiled::ConditionOperand::Kind(p)
        | compiled::ConditionOperand::Kinds(p)
        | compiled::ConditionOperand::Has(p) => check_internal_key_in_path(p),
        compiled::ConditionOperand::Literal(_)
        | compiled::ConditionOperand::Idx(_)
        | compiled::ConditionOperand::InterpolatedStr(_) => Ok(()),
    }
}

#[cfg(not(feature = "std"))]
pub(crate) fn hash_source_no_std(source: &str) -> u64 {
    crate::__private::fnv1a_hash(source.as_bytes())
}
