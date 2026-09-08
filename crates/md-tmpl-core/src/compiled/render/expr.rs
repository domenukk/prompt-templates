//! Compiled expression evaluation and filter application.

use alloc::{borrow::Cow, string::String};

use super::{float::write_fixed_float, value::render_value_into};
use crate::{
    compiled::{FilterKind, ParsedFilter},
    error::TemplateError,
    scope::{CompiledExpr, Scope},
    value::Value,
};

/// Evaluate a pre-compiled expression (path + filters) and write
/// the result directly into `output`, avoiding intermediate `String`
/// allocations in the common no-filter path.
pub(super) fn eval_compiled_expr_into(
    expr: &CompiledExpr,
    filters: &[ParsedFilter],
    scope: &Scope<'_>,
    output: &mut String,
) -> Result<(), TemplateError> {
    if try_fast_path_fixed_filter(expr, filters, scope, output)? {
        return Ok(());
    }

    if filters.is_empty() {
        if let CompiledExpr::Path(path) = expr {
            let val = scope.resolve_path(path)?;
            return render_value_into(val, output);
        }
        if let CompiledExpr::Kind(path) = expr {
            let val = scope.resolve_path(path)?;
            if scope.is_option_path(path.as_str()) {
                match val {
                    Value::None => output.push_str(crate::consts::OPTION_NONE),
                    _ => output.push_str(crate::consts::OPTION_SOME),
                }
                return Ok(());
            }
            match val {
                Value::Struct(d) => {
                    if let Some(Value::Str(k)) = d.get(crate::consts::ENUM_TAG_KEY) {
                        output.push_str(k);
                        return Ok(());
                    }
                    return Err(TemplateError::syntax(
                        "kind() requires an enum value (dict with variant tag)",
                    ));
                }
                Value::Str(s) => {
                    check_kind_declared_type(path.as_str(), scope)?;
                    output.push_str(s);
                    return Ok(());
                }
                Value::None => {
                    output.push_str(crate::consts::OPTION_NONE);
                    return Ok(());
                }
                _ => {
                    return Err(TemplateError::syntax(alloc::format!(
                        "kind() requires an enum value, got {}",
                        val.type_name()
                    )));
                }
            }
        }
    }

    let value = eval_compiled_expr_val(expr, scope)?;
    apply_filters_and_render(value, filters, output)
}

/// Fast path: single `fixed(n)` filter on a numeric value — write directly
/// into `output` without allocating an intermediate String or Value.
#[inline]
fn try_fast_path_fixed_filter(
    expr: &CompiledExpr,
    filters: &[ParsedFilter],
    scope: &Scope<'_>,
    output: &mut String,
) -> Result<bool, TemplateError> {
    if filters.len() == 1 && filters[0].kind == FilterKind::Fixed {
        if let CompiledExpr::Path(path) = expr {
            if let Some(precision) = filters[0].parsed_num {
                let val = scope.resolve_path(path)?;
                match val {
                    Value::Float(f) => {
                        write_fixed_float(*f, precision, output);
                        return Ok(true);
                    }
                    Value::Int(i) => {
                        // Use itoa for the integer part to avoid
                        // i64→f64 precision loss for values > 2^53.
                        let mut buf = itoa::Buffer::new();
                        let int_str = buf.format(*i);
                        output.push_str(int_str);
                        if precision > 0 {
                            output.push('.');
                            for _ in 0..precision {
                                output.push('0');
                            }
                        }
                        return Ok(true);
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(false)
}

pub(super) fn eval_compiled_expr_val<'a>(
    expr: &'a CompiledExpr,
    scope: &'a Scope<'_>,
) -> Result<Cow<'a, Value>, TemplateError> {
    match expr {
        CompiledExpr::Path(path) => scope.resolve_path(path).map(Cow::Borrowed),
        CompiledExpr::Literal(value) => Ok(Cow::Borrowed(value)),
        CompiledExpr::Idx(binding) => {
            let meta = scope.get_loop_meta(binding).ok_or_else(|| {
                TemplateError::syntax(alloc::format!(
                    "idx() requires active loop binding '{binding}'"
                ))
            })?;
            Ok(Cow::Owned(Value::Int(meta.index)))
        }
        CompiledExpr::Len(path) => {
            let val = scope.resolve_path(path)?;
            let count = match val {
                Value::List(l) => i64::try_from(l.len()).expect("collection length fits i64"),
                Value::Str(s) => i64::try_from(s.len()).expect("string length fits i64"),
                _ => {
                    return Err(TemplateError::syntax("len() requires a list or string"));
                }
            };
            Ok(Cow::Owned(Value::Int(count)))
        }
        CompiledExpr::Kind(path) => {
            let val = scope.resolve_path(path)?;
            if scope.is_option_path(path.as_str()) {
                return match val {
                    Value::None => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_NONE.into()))),
                    _ => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_SOME.into()))),
                };
            }
            match val {
                Value::Struct(d) => {
                    if let Some(Value::Str(k)) = d.get(crate::consts::ENUM_TAG_KEY) {
                        Ok(Cow::Owned(Value::Str(k.clone())))
                    } else {
                        Err(TemplateError::syntax(
                            "kind() requires an enum value (dict with variant tag)",
                        ))
                    }
                }
                Value::Str(s) => {
                    check_kind_declared_type(path.as_str(), scope)?;
                    Ok(Cow::Owned(Value::Str(s.clone())))
                }
                Value::None => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_NONE.into()))),
                _ => Err(TemplateError::syntax(alloc::format!(
                    "kind() requires an enum value, got {}",
                    val.type_name()
                ))),
            }
        }
        CompiledExpr::Kinds(path) => {
            let val = scope.resolve_path(path)?;
            match val {
                Value::Struct(d) => {
                    if let Some(list_val) = d.get(crate::consts::ENUM_VARIANTS_KEY) {
                        Ok(Cow::Borrowed(list_val))
                    } else {
                        Err(TemplateError::syntax(
                            "kinds() requires an enum type namespace",
                        ))
                    }
                }
                _ => Err(TemplateError::syntax(alloc::format!(
                    "kinds() requires an enum type namespace, got {}",
                    val.type_name()
                ))),
            }
        }
        CompiledExpr::Has(path) => {
            check_has_declared_type(path.as_str(), scope)?;
            let val = scope.resolve_path(path)?;
            Ok(Cow::Owned(Value::Bool(Scope::is_option_some(val))))
        }
    }
}

fn check_kind_declared_type(path: &str, scope: &Scope<'_>) -> Result<(), TemplateError> {
    if let Some(decl_ty) = scope.resolve_declared_type(path) {
        let is_enum_or_option_enum = match decl_ty {
            crate::types::VarType::Enum(_) => true,
            crate::types::VarType::Option(inner) => {
                matches!(inner.as_ref(), crate::types::VarType::Enum(_))
            }
            _ => false,
        };
        if !is_enum_or_option_enum {
            return Err(TemplateError::syntax(alloc::format!(
                "kind() requires an enum or option value, got {decl_ty} on '{path}'",
            )));
        }
    }
    Ok(())
}

fn check_has_declared_type(path: &str, scope: &Scope<'_>) -> Result<(), TemplateError> {
    if let Some(decl_ty) = scope.resolve_declared_type(path)
        && !decl_ty.is_option()
    {
        return Err(TemplateError::syntax(alloc::format!(
            "has() requires an option value, got {decl_ty} on '{path}'",
        )));
    }
    Ok(())
}

/// Apply filters to a resolved value and render the result.
fn apply_filters_and_render(
    value: Cow<'_, Value>,
    filters: &[ParsedFilter],
    output: &mut String,
) -> Result<(), TemplateError> {
    if filters.is_empty() {
        render_value_into(&value, output)
    } else {
        let mut owned_value = value.into_owned();
        for f in filters {
            owned_value = crate::filter::apply_filter_typed(
                f.kind,
                &owned_value,
                f.args.as_ref().map(AsRef::as_ref),
            )?;
        }
        render_value_into(&owned_value, output)
    }
}
