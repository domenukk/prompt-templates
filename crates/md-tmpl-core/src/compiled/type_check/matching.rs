//! Match segment validation.
//!
//! Validates `{% match %}` segments: variant-name checks, flow-sensitive
//! narrowing of enum/option types inside arms, scalar case-label typing,
//! and exhaustiveness.

use alloc::{borrow::Cow, string::String, vec::Vec};

use super::{conditions::validate_condition, environment::TypeEnv, walker::walk_segments};
use crate::{
    compat::HashSet,
    compiled::{MatchArm, type_resolve::resolve_compiled_path_type},
    scope::CompiledPath,
    types::{VarType, VariantDecl},
};

pub(super) fn validate_match(
    expr: &CompiledPath,
    arms: &[MatchArm],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    // A match without any case is always wrong.
    if arms.is_empty() {
        errors.push(format!(
            "match on '{}': no case arms — add at least one {{% case %}}",
            expr.as_str()
        ));
        return;
    }

    // Resolve the full path type (e.g. `task.cat` → enum, not just `task` → dict).
    let expr_type = resolve_compiled_path_type(expr, env).cloned();

    // Detect kind() in match expression — users should match on the enum directly.
    {
        let raw = expr.as_str().trim();
        if raw.starts_with(crate::consts::FN_KIND_PREFIX)
            && raw.ends_with(crate::consts::PAREN_CLOSE)
        {
            let inner = &raw[crate::consts::FN_KIND_PREFIX.len()..raw.len() - 1];
            let hint = format!("use {{% match {inner} %}} with unquoted variant names instead");
            errors.push(format!(
                "match on '{raw}': matching on kind() converts the enum to a string — {hint} for exhaustiveness checking and type safety"
            ));
            // Still walk arm bodies for further analysis.
            for arm in arms {
                walk_segments(&arm.body, env, errors, visited);
            }
            return;
        }
    }

    match expr_type {
        Some(VarType::Enum(ref declared)) => {
            // For narrowing, we need to track by the full expr path so that
            // `task.cat.label` resolves correctly inside the arm body.
            // We narrow by the root variable name and replace its type with
            // one where the matched field is narrowed.
            validate_match_arms_with_narrowing(expr, declared, arms, env, errors, visited);
        }
        Some(VarType::Option(ref inner)) => {
            validate_option_match_arms(expr, inner, arms, env, errors, visited);
        }
        Some(VarType::Str | VarType::Int | VarType::Bool | VarType::Float) => {
            validate_scalar_match_arms(
                expr,
                expr_type.as_ref().unwrap(),
                arms,
                env,
                errors,
                visited,
            );
        }
        Some(ref other) => {
            errors.push(format!(
                "match on '{}': expected enum, option, or scalar type, got {other}",
                expr.as_str()
            ));
            for arm in arms {
                walk_segments(&arm.body, env, errors, visited);
            }
        }
        None => {
            let root = &expr.parts()[0];
            if !env.is_opaque(root) {
                errors.push(format!(
                    "match on '{}': undeclared variable '{root}'",
                    expr.as_str()
                ));
            }
        }
    }
}

/// Validate match arms for `option(T)`.
fn validate_option_match_arms(
    expr: &CompiledPath,
    inner: &VarType,
    arms: &[MatchArm],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    let mut has_default = false;
    for arm in arms {
        let is_some =
            arm.variants.len() == 1 && arm.variants[0].as_ref() == crate::consts::OPTION_SOME;
        for v in &arm.variants {
            let name = v.as_ref();
            if name == crate::consts::MATCH_DEFAULT && arm.guard.is_none() {
                has_default = true;
            }
            if name != crate::consts::OPTION_SOME
                && name != crate::consts::OPTION_NONE
                && name != crate::consts::MATCH_DEFAULT
            {
                errors.push(format!(
                    "match on '{}': invalid option variant '{name}' — \
                     expected 'Some', 'None', or '_'",
                    expr.as_str()
                ));
            }
        }
        if let Some(ref guard) = arm.guard {
            validate_condition(guard, env, errors);
        }
        if is_some {
            let prev = env.narrow(expr.as_str(), inner.clone());
            walk_segments(&arm.body, env, errors, visited);
            match prev {
                Some(t) => {
                    env.narrow(expr.as_str(), t);
                }
                None => {
                    env.unnarrow(expr.as_str());
                }
            }
        } else {
            walk_segments(&arm.body, env, errors, visited);
        }
    }
    let option_variants = [
        VariantDecl {
            name: String::from(crate::consts::OPTION_SOME),
            fields: vec![],
        },
        VariantDecl {
            name: String::from(crate::consts::OPTION_NONE),
            fields: vec![],
        },
    ];
    check_exhaustiveness(expr, &option_variants, arms, has_default, errors);
}

/// Validate match arms for scalar types (str, int, bool, float).
///
/// Each label is validated against the expression's scalar type.
fn validate_scalar_match_arms(
    expr: &CompiledPath,
    var_type: &VarType,
    arms: &[MatchArm],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    let type_name = match var_type {
        VarType::Str => crate::consts::TYPE_STR,
        VarType::Int => crate::consts::TYPE_INT,
        VarType::Bool => crate::consts::TYPE_BOOL,
        VarType::Float => crate::consts::TYPE_FLOAT,
        _ => unreachable!(),
    };
    for arm in arms {
        for v in &arm.variants {
            let label = v.as_ref();
            if label == crate::consts::MATCH_DEFAULT {
                continue;
            }
            validate_scalar_case_label(expr, type_name, label, errors);
        }
        if let Some(ref guard) = arm.guard {
            validate_condition(guard, env, errors);
        }
        walk_segments(&arm.body, env, errors, visited);
    }
}

/// Classify a case label token as a specific type for validation.
#[derive(Debug, PartialEq)]
enum LabelKind {
    /// Quoted string literal: `"foo"` or `'foo'`
    QuotedStr,
    /// Interpolated quoted string: `"{{ expr }}"`
    InterpolatedStr,
    /// Boolean literal: `true` or `false`
    BoolLit,
    /// Integer literal: `42`, `-1`
    IntLit,
    /// Float literal: `3.14`, `-0.5`
    FloatLit,
    /// Identifier (enum variant, param-ref, or unquoted string literal)
    Ident,
}

fn classify_label(label: &str) -> LabelKind {
    if let Some(inner) = crate::consts::strip_string_literal(label) {
        if inner.contains(crate::consts::EXPR_START) {
            return LabelKind::InterpolatedStr;
        }
        return LabelKind::QuotedStr;
    }
    if label == crate::consts::LIT_TRUE || label == crate::consts::LIT_FALSE {
        return LabelKind::BoolLit;
    }
    if label.parse::<i64>().is_ok() {
        return LabelKind::IntLit;
    }
    if label.parse::<f64>().is_ok() {
        return LabelKind::FloatLit;
    }
    LabelKind::Ident
}

/// Validate a case label against the match expression's scalar type.
pub(super) fn validate_scalar_case_label(
    expr: &CompiledPath,
    type_name: &str,
    label: &str,
    errors: &mut Vec<String>,
) {
    const HINT_BOOL: &str = "use {% case true %} or {% case false %}";

    let kind = classify_label(label);
    let e = expr.as_str();

    match (type_name, &kind) {
        // str: quoted strings, interpolated strings, identifiers ok.
        (crate::consts::TYPE_STR, LabelKind::IntLit | LabelKind::FloatLit) => {
            let hint = format!("use {{% case \"{label}\" %}}");
            errors.push(format!(
                "match on '{e}': case label '{label}' is a numeric literal, but '{e}' is a str — {hint} for a string literal"
            ));
        }
        (crate::consts::TYPE_STR, LabelKind::BoolLit) => {
            let hint = format!("use {{% case \"{label}\" %}}");
            errors.push(format!(
                "match on '{e}': case label '{label}' is a bool literal, but '{e}' is a str — {hint} for a string literal"
            ));
        }

        // int: integer literals and identifiers ok.
        (crate::consts::TYPE_INT, LabelKind::QuotedStr | LabelKind::InterpolatedStr) => {
            let inner = crate::consts::strip_string_literal(label).unwrap_or(label);
            let hint = format!("use {{% case {inner} %}}");
            errors.push(format!(
                "match on '{e}': quoted string '{label}' cannot match int values — {hint} for an integer literal"
            ));
        }
        (crate::consts::TYPE_INT, LabelKind::BoolLit) => {
            errors.push(format!(
                "match on '{e}': case label '{label}' is a bool literal, but '{e}' is an int"
            ));
        }
        (crate::consts::TYPE_INT, LabelKind::FloatLit) => {
            errors.push(format!(
                "match on '{e}': case label '{label}' is a float literal, but '{e}' is an int"
            ));
        }

        // float: float/int literals and identifiers ok.
        (crate::consts::TYPE_FLOAT, LabelKind::QuotedStr | LabelKind::InterpolatedStr) => {
            let inner = crate::consts::strip_string_literal(label).unwrap_or(label);
            let hint = format!("use {{% case {inner} %}}");
            errors.push(format!(
                "match on '{e}': quoted string '{label}' cannot match float values — {hint} for a numeric literal"
            ));
        }
        (crate::consts::TYPE_FLOAT, LabelKind::BoolLit) => {
            errors.push(format!(
                "match on '{e}': case label '{label}' is a bool literal, but '{e}' is a float"
            ));
        }

        // bool: true/false and identifiers ok.
        (crate::consts::TYPE_BOOL, LabelKind::QuotedStr | LabelKind::InterpolatedStr) => {
            errors.push(format!(
                "match on '{e}': quoted string '{label}' cannot match bool values — {HINT_BOOL}"
            ));
        }
        (crate::consts::TYPE_BOOL, LabelKind::IntLit | LabelKind::FloatLit) => {
            errors.push(format!(
                "match on '{e}': case label '{label}' is a numeric literal, but '{e}' is a bool — {HINT_BOOL}"
            ));
        }

        _ => {}
    }
}

/// Validate arms of a match on a known enum type.
///
/// Narrows the matched expression's type inside each arm so that field
/// accesses are validated against the correct variant(s).
fn validate_match_arms_with_narrowing(
    expr: &CompiledPath,
    declared: &[VariantDecl],
    arms: &[MatchArm],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    let mut covered_variants: Vec<&str> = Vec::new();
    let mut has_default = false;

    for arm in arms {
        let is_default_arm = arm
            .variants
            .iter()
            .any(|v| v.as_ref() == crate::consts::MATCH_DEFAULT);

        if is_default_arm {
            has_default = true;

            // Narrow to the remaining (uncovered) variants for the default body.
            let remaining_variants: Vec<VariantDecl> = declared
                .iter()
                .filter(|v| !covered_variants.contains(&v.name.as_str()))
                .cloned()
                .collect();

            if remaining_variants.is_empty() {
                validate_arm_body(arm, None, expr, env, errors, visited);
            } else {
                validate_arm_body(
                    arm,
                    Some(VarType::Enum(remaining_variants)),
                    expr,
                    env,
                    errors,
                    visited,
                );
            }
            continue;
        }

        // Check that all case variant names exist in the enum.
        for case_name in &arm.variants {
            let name_ref = case_name.as_ref();
            if declared.iter().any(|v| v.name == name_ref) {
                covered_variants.push(name_ref);
            } else if crate::consts::strip_string_literal(name_ref).is_some() {
                // Quoted label on enum: specific error with guidance.
                errors.push(format!(
                    "match on '{}': quoted string '{}' cannot match enum variants \
                     — remove the quotes to match variant name directly",
                    expr.as_str(),
                    name_ref,
                ));
            } else {
                let valid: Vec<&str> = declared.iter().map(|v| v.name.as_str()).collect();
                errors.push(format!(
                    "match on '{}': unknown variant '{name_ref}' \
                     (declared variants: {})",
                    expr.as_str(),
                    valid.join(", ")
                ));
            }
        }

        // Narrow the matched expression for this arm's body.
        let narrowed_variants: Vec<VariantDecl> = declared
            .iter()
            .filter(|v| arm.variants.iter().any(|c| c.as_ref() == v.name))
            .cloned()
            .collect();

        let narrowed_type = if narrowed_variants.is_empty() {
            None
        } else {
            Some(VarType::Enum(narrowed_variants))
        };
        validate_arm_body(arm, narrowed_type, expr, env, errors, visited);
    }

    check_exhaustiveness(expr, declared, arms, has_default, errors);
}

/// Validate guard and body of a single match arm, optionally narrowing
/// the expression's type during the body walk.
fn validate_arm_body(
    arm: &MatchArm,
    narrowed_type: Option<VarType>,
    expr: &CompiledPath,
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    if let Some(nt) = narrowed_type {
        let prev = env.narrow(expr.as_str(), nt);
        // Validate guard AFTER narrowing so that field accesses like
        // `status.score` are valid when narrowed to the Active variant.
        if let Some(ref guard) = arm.guard {
            validate_condition(guard, env, errors);
        }
        walk_segments(&arm.body, env, errors, visited);
        match prev {
            Some(t) => {
                env.narrow(expr.as_str(), t);
            }
            None => {
                env.unnarrow(expr.as_str());
            }
        }
    } else {
        if let Some(ref guard) = arm.guard {
            validate_condition(guard, env, errors);
        }
        walk_segments(&arm.body, env, errors, visited);
    }
}

/// Check that a multi-arm match covers all declared variants.
pub(super) fn check_exhaustiveness(
    expr: &CompiledPath,
    declared: &[VariantDecl],
    arms: &[MatchArm],
    has_default: bool,
    errors: &mut Vec<String>,
) {
    if arms.len() <= 1 || has_default {
        return;
    }

    let covered: Vec<&str> = arms
        .iter()
        .flat_map(|a| a.variants.iter())
        .map(Cow::as_ref)
        .collect();

    let missing: Vec<&str> = declared
        .iter()
        .filter(|v| !covered.contains(&v.name.as_str()))
        .map(|v| v.name.as_str())
        .collect();
    if !missing.is_empty() {
        let cases = missing
            .iter()
            .map(|m| format!("{{% case {m} %}}"))
            .collect::<Vec<_>>()
            .join(" ");
        let suggestion = if missing.len() > 1 {
            let combined = missing.join(" | ");
            format!("Try adding explicit arms: {cases} or combined arm: {{% case {combined} %}}")
        } else {
            format!("Try adding explicit arm: {cases}")
        };
        errors.push(format!(
            "match on '{}': non-exhaustive — missing variant(s): {}. {suggestion}",
            expr.as_str(),
            missing.join(", ")
        ));
    }
}
