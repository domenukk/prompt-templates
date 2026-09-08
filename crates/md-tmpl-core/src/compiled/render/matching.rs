//! Rendering of compiled `{% match %}` blocks and variant resolution.

use alloc::{borrow::Cow, string::String};

use super::{condition::eval_condition, segments::render_interpolated_str};
use crate::{
    compiled::MatchArm,
    error::TemplateError,
    scope::{CompiledPath, Scope},
    value::Value,
};

/// Render a compiled match block.
///
/// Resolves the expression to determine the active enum variant, then
/// renders the body of the matching `{% case %}` arm. Silently produces
/// no output if no arm matches (non-exhaustive matches are caught at
/// compile time by the type system).
#[cfg(feature = "std")]
pub(super) fn render_match(
    expr: &CompiledPath,
    arms: &[MatchArm],
    is_option: bool,
    scope: &mut Scope<'_>,
    base_dir: Option<&std::path::Path>,
    output: &mut String,
) -> Result<(), TemplateError> {
    let active_variant = resolve_match_variant(expr, is_option, scope)?;

    for arm in arms {
        let variant_matches = arm_matches(&active_variant, &arm.variants, scope);
        if variant_matches {
            // Evaluate guard if present.
            if let Some(ref guard) = arm.guard {
                if !eval_condition(guard, scope)? {
                    continue;
                }
            }
            // Narrow option so inner kind()/match see the unwrapped value.
            let narrowed = is_option
                && active_variant == crate::consts::OPTION_SOME
                && arm.variants.len() == 1
                && arm.variants[0].as_ref() == crate::consts::OPTION_SOME;
            if narrowed {
                scope.narrow_option(expr.as_str());
            }
            let result = super::segments::render_segments_into(&arm.body, scope, base_dir, output);
            if narrowed {
                scope.unnarrow_option(expr.as_str());
            }
            return result;
        }
    }

    // No arm matched — silently skip (non-exhaustive is valid for
    // inline `{% match x case Y %}` single-arm guards).
    Ok(())
}

/// Render a compiled match block (`no_std` variant).
#[cfg(not(feature = "std"))]
pub(super) fn render_match_no_std(
    expr: &CompiledPath,
    arms: &[MatchArm],
    is_option: bool,
    scope: &mut Scope<'_>,
    output: &mut String,
) -> Result<(), TemplateError> {
    let active_variant = resolve_match_variant(expr, is_option, scope)?;

    for arm in arms {
        let variant_matches = arm_matches(&active_variant, &arm.variants, scope);
        if variant_matches {
            if let Some(ref guard) = arm.guard {
                if !eval_condition(guard, scope)? {
                    continue;
                }
            }
            let narrowed = is_option
                && active_variant == crate::consts::OPTION_SOME
                && arm.variants.len() == 1
                && arm.variants[0].as_ref() == crate::consts::OPTION_SOME;
            if narrowed {
                scope.narrow_option(expr.as_str());
            }
            let result = super::segments::render_segments_into_no_std(&arm.body, scope, output);
            if narrowed {
                scope.unnarrow_option(expr.as_str());
            }
            return result;
        }
    }

    Ok(())
}

/// Check if any arm variant matches the active variant.
///
/// Matching rules:
/// - `_` (`MATCH_DEFAULT`): always matches
/// - Quoted label (e.g. `"Active"`): strip quotes, compare literally
/// - Unquoted label matching an enum variant: compare literally
/// - Unquoted label (param-ref on str match): resolve the param value
///   from scope and compare the resolved value against `active_variant`
fn arm_matches(active_variant: &str, variants: &[Cow<'_, str>], scope: &Scope<'_>) -> bool {
    for v in variants {
        let label = v.as_ref();
        if label == crate::consts::MATCH_DEFAULT {
            return true;
        }
        // Quoted string literal: strip quotes, unescape, interpolate if needed,
        // and compare.
        if let Some(inner) = crate::consts::strip_string_literal(label) {
            let inner = crate::consts::unescape_string_literal(inner);
            if inner.contains(crate::consts::EXPR_START) {
                // Contains {{ expr }} — compile and render the interpolated string.
                // NOLINT: compile/render failure means the label doesn't match — fall through to literal comparison
                if let Ok(segments) = crate::compiled::compile_body(&inner) {
                    // NOLINT: render failure means the interpolated label is unresolvable — not a match
                    if let Ok(rendered) = render_interpolated_str(&segments, scope) {
                        if active_variant == rendered.as_str() {
                            return true;
                        }
                    }
                }
            } else if active_variant == inner.as_str() {
                return true;
            }
            continue;
        }
        // Direct comparison (enum variant name).
        if active_variant == label {
            return true;
        }
        // Param-ref: resolve label as a variable and compare its string value.
        if let Some(Value::Str(s)) = scope.resolve(label) {
            if active_variant == s.as_str() {
                return true;
            }
        }
    }
    false
}

/// Resolve the active variant name for a match expression.
///
/// - **enum**: returns the variant tag (unit or struct variant).
/// - **option**: returns `"Some"` or `"None"`.
/// - **str**: returns the string value itself.
/// - **int/bool/float**: returns the value formatted as a string.
pub(super) fn resolve_match_variant<'a>(
    expr: &CompiledPath,
    is_option: bool,
    scope: &'a Scope<'_>,
) -> Result<Cow<'a, str>, TemplateError> {
    let value = scope.resolve_path(expr)?;

    match value {
        // Absent option value → "None" variant.
        Value::None => Ok(Cow::Borrowed(crate::consts::OPTION_NONE)),
        // For option(T): any non-None value is the "Some" branch.
        _ if is_option => Ok(Cow::Borrowed(crate::consts::OPTION_SOME)),
        // Unit enum variant stored as plain string.
        Value::Str(s) => Ok(Cow::Borrowed(s.as_str())),
        // Struct variant stored as dict with "tag" key.
        Value::Struct(map) => {
            let tag_key = crate::consts::ENUM_TAG_KEY;
            match map.get(tag_key) {
                Some(Value::Str(tag)) => Ok(Cow::Borrowed(tag.as_str())),
                _ => Err(TemplateError::syntax(alloc::format!(
                    "match: '{}' is a dict without a 'tag' field",
                    expr.as_str()
                ))),
            }
        }
        // Scalar types: format as string for label comparison.
        Value::Int(n) => Ok(Cow::Owned(alloc::format!("{n}"))),
        Value::Float(f) => Ok(Cow::Owned(alloc::format!("{f}"))),
        Value::Bool(b) => Ok(Cow::Borrowed(if *b {
            crate::consts::LIT_TRUE
        } else {
            crate::consts::LIT_FALSE
        })),
        Value::List(_) => Err(TemplateError::syntax(alloc::format!(
            "match: '{}' is a list — match requires a scalar or enum value",
            expr.as_str(),
        ))),
        Value::Tmpl(_) => Err(TemplateError::syntax(alloc::format!(
            "match: '{}' is not an enum value (got {})",
            expr.as_str(),
            value.type_name()
        ))),
    }
}
