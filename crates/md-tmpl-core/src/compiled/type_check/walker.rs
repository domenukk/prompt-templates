//! Segment tree walker.
//!
//! Recursively walks the compiled segment tree, dispatching each segment to
//! the appropriate validation routine and threading the flow-sensitive type
//! environment through loops, conditionals, matches, and includes.

use alloc::{
    string::{String, ToString},
    vec::Vec,
};

use super::{
    conditions::{extract_all_has_narrowings, extract_not_has_narrowing, validate_condition},
    environment::TypeEnv,
    includes::validate_include,
    matching::validate_match,
    paths::validate_compiled_path,
};
use crate::{
    compat::HashSet,
    compiled::{
        Condition, Segment,
        type_resolve::{resolve_compiled_expr_type, resolve_compiled_path_type},
    },
    scope::CompiledExpr,
    types::VarType,
};

pub(super) fn walk_segments(
    segments: &[Segment],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    for seg in segments {
        walk_segment(seg, env, errors, visited);
    }
}

fn walk_segment(
    seg: &Segment,
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    match seg {
        Segment::Static(_) | Segment::Raw(_) | Segment::Comment(_) => {}
        Segment::Panic(segs) => {
            for s in segs {
                walk_segment(s, env, errors, visited);
            }
        }

        Segment::Expr { expr, filters, .. } => match expr {
            CompiledExpr::Path(path) => {
                validate_compiled_path(path, env, errors);
                if env.check_displayability && filters.is_empty() {
                    if let Some(resolved) = resolve_compiled_path_type(path, env) {
                        if !resolved.is_displayable() {
                            let hint = match resolved {
                                VarType::List(_) => "use {% for %} to iterate, or | join()",
                                VarType::Struct(_) => {
                                    "access fields with dot notation, e.g. {{ x.field }}"
                                }
                                VarType::Enum(_) => {
                                    "use kind(x) for the variant name, or {% match %}"
                                }
                                VarType::Tmpl(_) => "use {% include %} to render a template",
                                VarType::Option(_) => {
                                    "use {% if has(x) %} to unwrap, or {% match %}"
                                }
                                _ => "only str, int, float, bool can be displayed",
                            };
                            errors.push(format!(
                                "'{}': cannot display value of type {resolved} — {hint}",
                                path.as_str()
                            ));
                        }
                    }
                }
            }
            CompiledExpr::Len(_)
            | CompiledExpr::Kind(_)
            | CompiledExpr::Has(_)
            | CompiledExpr::Kinds(_) => {
                resolve_compiled_expr_type(expr, env, errors);
            }
            // Literals are always displayable scalars and loop indices are
            // always ints — neither needs validation.
            CompiledExpr::Literal(_) | CompiledExpr::Idx(_) => {}
        },

        Segment::ForLoop {
            binding,
            list_expr,
            body,
            else_body,
        } => {
            validate_for_loop(binding, list_expr, body, else_body, env, errors, visited);
        }

        Segment::If {
            branches,
            else_body,
        } => {
            validate_if_segment(branches, else_body, env, errors, visited);
        }

        Segment::Match { expr, arms, .. } => {
            validate_match(expr, arms, env, errors, visited);
        }

        Segment::Include(inc) => {
            validate_include(inc, env, errors, visited);
        }
    }
}

fn validate_for_loop(
    binding: &str,
    list_expr: &CompiledExpr,
    body: &[Segment],
    else_body: &[Segment],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    let resolved = resolve_compiled_expr_type(list_expr, env, errors);
    match resolved {
        Some(VarType::List(ref fields)) => {
            let elem_ty = if fields.len() == 1 && fields[0].name.is_empty() {
                fields[0].var_type.clone()
            } else {
                VarType::Struct(fields.clone())
            };
            let prev = env.narrow(binding, elem_ty);
            walk_segments(body, env, errors, visited);
            match prev {
                Some(t) => {
                    env.narrow(binding, t);
                }
                None => {
                    env.unnarrow(binding);
                }
            }
        }
        Some(other) => {
            let expr_str = match list_expr {
                CompiledExpr::Path(p)
                | CompiledExpr::Len(p)
                | CompiledExpr::Kind(p)
                | CompiledExpr::Kinds(p)
                | CompiledExpr::Has(p) => p.as_str(),
                CompiledExpr::Literal(_) => "literal",
                CompiledExpr::Idx(b) => b.as_ref(),
            };
            if matches!(other, VarType::Enum(_)) {
                errors.push(format!(
                    "for loop over '{expr_str}': expected list, got enum — use kinds({expr_str}) to iterate over variant names"
                ));
            } else {
                errors.push(format!(
                    "for loop over '{expr_str}': expected list, got {other}"
                ));
            }
            walk_segments(body, env, errors, visited);
        }
        None => {
            // The element type is unknown. If the iterable is rooted at an
            // opaque root (e.g. an imported constant like
            // `artist.SEVERITY_LADDER`, whose structure is resolved at runtime
            // rather than statically typed), the loop binding is likewise
            // opaque: skip field-level validation on it inside the body,
            // consistent with how field access on the imported constant itself
            // is skipped. Without this, every `binding.field` access in the
            // body would be spuriously flagged as an undeclared variable.
            let binding_is_opaque =
                for_loop_iterable_root(list_expr).is_some_and(|root| env.is_opaque(root));
            if binding_is_opaque {
                let newly_inserted = env.opaque_roots.insert(binding.to_string());
                walk_segments(body, env, errors, visited);
                if newly_inserted {
                    env.opaque_roots.remove(binding);
                }
            } else {
                walk_segments(body, env, errors, visited);
            }
        }
    }
    walk_segments(else_body, env, errors, visited);
}

/// Return the root variable name of a for-loop iterable expression when it is
/// a plain path (or path-like builtin). Used to detect loops over opaque
/// imported constants so the loop binding can inherit their opacity.
fn for_loop_iterable_root(list_expr: &CompiledExpr) -> Option<&str> {
    let path = match list_expr {
        CompiledExpr::Path(p)
        | CompiledExpr::Len(p)
        | CompiledExpr::Kind(p)
        | CompiledExpr::Kinds(p)
        | CompiledExpr::Has(p) => p,
        CompiledExpr::Literal(_) | CompiledExpr::Idx(_) => return None,
    };
    path.parts().first().map(String::as_str)
}

fn validate_if_segment(
    branches: &[(Condition, Vec<Segment>)],
    else_body: &[Segment],
    env: &mut TypeEnv<'_>,
    errors: &mut Vec<String>,
    visited: &mut HashSet<String>,
) {
    // Narrowings carried into fall-through positions. When an earlier branch
    // condition is `!has(o)`, the option `o` is guaranteed present in every
    // later branch and in the final `{% else %}`, so it can be used as a value
    // there. Positive `has()` narrowings, by contrast, apply only to their own
    // branch body and are never carried.
    let mut carry: Vec<(String, VarType)> = Vec::new();

    for (condition, branch_body) in branches {
        validate_condition(condition, env, errors);

        // Positive narrowings from `has()` in this condition (incl. `&&` chains)
        // plus any carried negative narrowings from earlier branches.
        let positive = extract_all_has_narrowings(condition, env);
        let applied = apply_narrowings(env, carry.iter().chain(positive.iter()));
        walk_segments(branch_body, env, errors, visited);
        restore_narrowings(env, applied);

        // If this branch is `!has(o)`, then once it is skipped we know `o` is
        // present — carry that into subsequent branches and the else body.
        if let Some(neg) = extract_not_has_narrowing(condition, env) {
            carry.push(neg);
        }
    }

    let applied = apply_narrowings(env, carry.iter());
    walk_segments(else_body, env, errors, visited);
    restore_narrowings(env, applied);
}

/// Apply a sequence of `(path, narrowed_type)` overrides to `env`, returning
/// the previous bindings so they can be restored in reverse order.
fn apply_narrowings<'a, I>(env: &mut TypeEnv<'_>, narrowings: I) -> Vec<(String, Option<VarType>)>
where
    I: IntoIterator<Item = &'a (String, VarType)>,
{
    let mut applied = Vec::new();
    for (path_str, narrowed_type) in narrowings {
        let prev = env.narrow(path_str, narrowed_type.clone());
        applied.push((path_str.clone(), prev));
    }
    applied
}

/// Restore bindings captured by [`apply_narrowings`], in reverse order.
fn restore_narrowings(env: &mut TypeEnv<'_>, applied: Vec<(String, Option<VarType>)>) {
    for (path_str, prev) in applied.into_iter().rev() {
        match prev {
            Some(t) => {
                env.narrow(&path_str, t);
            }
            None => {
                env.unnarrow(&path_str);
            }
        }
    }
}
