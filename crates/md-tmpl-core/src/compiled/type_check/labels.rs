//! Match-label-only validation.
//!
//! A lightweight pass that validates only `{% match %}` label semantics
//! (`kind()` misuse, quoted labels on enums, scalar case-label typing, and
//! exhaustiveness) without touching field accesses or undeclared variables.
//! Safe to run during `compile_inner` without false positives from loop
//! bindings, inline templates, etc.

use alloc::{string::String, vec::Vec};

use super::{
    environment::TypeEnv,
    matching::{check_exhaustiveness, validate_scalar_case_label},
};
use crate::{
    compat::HashMap,
    compiled::{Segment, type_resolve::resolve_compiled_path_type},
    types::{VarDecl, VarType},
};

/// Validate only match-label semantics in the compiled segment tree.
///
/// Checks:
/// - `kind()` in match expressions (→ error)
/// - Quoted labels on enum types (→ error)
/// - Case label type consistency (numeric on str, quoted on int, etc.)
///
/// Does NOT check field accesses, undeclared variables, or body nodes.
/// Safe to run during `compile_inner` without false positives from
/// loop bindings, inline templates, etc.
#[must_use]
pub fn validate_match_labels(
    segments: &[Segment],
    declarations: &[VarDecl],
    type_aliases: &HashMap<String, VarType>,
) -> Vec<String> {
    let mut type_env = TypeEnv::from_declarations_and_types(declarations, type_aliases);
    let mut errors = Vec::new();
    walk_match_labels_only(segments, &mut type_env, &mut errors);
    errors
}

/// Validate a single `Segment::Match` in the match-labels pass.
fn validate_match_segment_labels(
    expr: &crate::compiled::CompiledPath,
    arms: &[crate::compiled::MatchArm],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
) {
    let mut option_inner = None;
    let raw = expr.as_str().trim();
    if raw.starts_with(crate::consts::FN_KIND_PREFIX) && raw.ends_with(crate::consts::PAREN_CLOSE) {
        let inner = &raw[crate::consts::FN_KIND_PREFIX.len()..raw.len() - 1];
        let hint = format!("use {{% match {inner} %}} with unquoted variant names instead");
        errors.push(format!(
            "match on '{raw}': matching on kind() converts the enum to a string — {hint} for exhaustiveness checking and type safety"
        ));
    } else {
        let expr_type = resolve_compiled_path_type(expr, env).cloned();
        match expr_type {
            Some(VarType::Enum(ref declared)) => {
                for arm in arms {
                    for v in &arm.variants {
                        let label = v.as_ref();
                        if is_quoted_label(label) {
                            errors.push(format!(
                                "match on '{}': quoted string '{}' cannot match enum variants — remove the quotes to match variant name directly",
                                expr.as_str(),
                                label
                            ));
                        }
                    }
                }
                let has_default = arms.iter().any(|a| {
                    a.variants
                        .iter()
                        .any(|v| v.as_ref() == crate::consts::MATCH_DEFAULT)
                });
                check_exhaustiveness(expr, declared, arms, has_default, errors);
            }
            Some(VarType::Option(ref inner)) => {
                option_inner = Some(inner.as_ref().clone());
                let has_default = arms.iter().any(|a| {
                    a.guard.is_none()
                        && a.variants
                            .iter()
                            .any(|v| v.as_ref() == crate::consts::MATCH_DEFAULT)
                });
                let option_variants = [
                    crate::types::VariantDecl {
                        name: String::from(crate::consts::OPTION_SOME),
                        fields: vec![],
                    },
                    crate::types::VariantDecl {
                        name: String::from(crate::consts::OPTION_NONE),
                        fields: vec![],
                    },
                ];
                check_exhaustiveness(expr, &option_variants, arms, has_default, errors);
            }
            Some(VarType::Str | VarType::Int | VarType::Bool | VarType::Float) => {
                let type_name = match expr_type.as_ref().unwrap() {
                    VarType::Str => crate::consts::TYPE_STR,
                    VarType::Int => crate::consts::TYPE_INT,
                    VarType::Bool => crate::consts::TYPE_BOOL,
                    VarType::Float => crate::consts::TYPE_FLOAT,
                    _ => unreachable!(),
                };
                for arm in arms {
                    for v in &arm.variants {
                        let label = v.as_ref();
                        if label != crate::consts::MATCH_DEFAULT {
                            validate_scalar_case_label(expr, type_name, label, errors);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for arm in arms {
        let is_some =
            arm.variants.len() == 1 && arm.variants[0].as_ref() == crate::consts::OPTION_SOME;
        if let (true, Some(inner_ty)) = (is_some, option_inner.as_ref()) {
            let prev = env.narrow(expr.as_str(), inner_ty.clone());
            walk_match_labels_only(&arm.body, env, errors);
            match prev {
                Some(t) => {
                    env.narrow(expr.as_str(), t);
                }
                None => {
                    env.unnarrow(expr.as_str());
                }
            }
        } else {
            walk_match_labels_only(&arm.body, env, errors);
        }
    }
}

/// Walk segments recursively, but ONLY validate match-label semantics.
fn walk_match_labels_only(segments: &[Segment], env: &mut TypeEnv<'_>, errors: &mut Vec<String>) {
    for seg in segments {
        match seg {
            Segment::Match { expr, arms, .. } => {
                validate_match_segment_labels(expr, arms, env, errors);
            }
            Segment::If {
                branches,
                else_body,
                ..
            } => {
                for branch in branches {
                    let narrowed_opt = if let crate::compiled::Condition::Truthy(
                        crate::compiled::ConditionOperand::Has(path),
                    ) = &branch.0
                    {
                        if let Some(VarType::Option(inner)) = resolve_compiled_path_type(path, env)
                        {
                            Some((path.as_str(), inner.as_ref().clone()))
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    if let Some((path_str, inner_ty)) = narrowed_opt {
                        let prev = env.narrow(path_str, inner_ty);
                        walk_match_labels_only(&branch.1, env, errors);
                        match prev {
                            Some(t) => {
                                env.narrow(path_str, t);
                            }
                            None => {
                                env.unnarrow(path_str);
                            }
                        }
                    } else {
                        walk_match_labels_only(&branch.1, env, errors);
                    }
                }
                walk_match_labels_only(else_body, env, errors);
            }
            Segment::ForLoop {
                body, else_body, ..
            } => {
                walk_match_labels_only(body, env, errors);
                walk_match_labels_only(else_body, env, errors);
            }
            Segment::Panic(body) => {
                walk_match_labels_only(body, env, errors);
            }
            _ => {}
        }
    }
}

/// Check if a label string is quoted (single or double).
fn is_quoted_label(label: &str) -> bool {
    label.len() >= 2
        && ((label.starts_with(crate::consts::QUOTE_DOUBLE)
            && label.ends_with(crate::consts::QUOTE_DOUBLE))
            || (label.starts_with(crate::consts::QUOTE_SINGLE)
                && label.ends_with(crate::consts::QUOTE_SINGLE)))
}
