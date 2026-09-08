use alloc::{string::String, vec, vec::Vec};

use super::type_check::{FieldResult, TypeEnv, resolve_field, validate_compiled_path};
use crate::{
    scope::{CompiledExpr, CompiledPath, ConditionOperand},
    types::{VarDecl, VarType},
    value::Value,
};

// ---------------------------------------------------------------------------
// Type Resolution Helpers
// ---------------------------------------------------------------------------

/// Resolve a dotted path to its declared type.
///
/// Returns `None` if the root variable is unknown or if any field
/// in the path doesn't resolve to a known type.
///
/// Also checks narrowed overrides at each level, so `task.cat` can be
/// narrowed inside a match arm and `task.cat.label` resolves correctly.
pub(super) fn resolve_path_type<'a>(path: &str, env: &'a TypeEnv<'_>) -> Option<&'a VarType> {
    let compiled = CompiledPath::compile(path);
    resolve_compiled_path_type(&compiled, env)
}

pub(super) fn resolve_compiled_path_type<'a>(
    path: &CompiledPath,
    env: &'a TypeEnv<'_>,
) -> Option<&'a VarType> {
    let root = &path.parts()[0];
    let mut current = env.lookup(root)?;
    let mut traversed = root.clone();

    for field in &path.parts()[1..] {
        // Before resolving the field, check if the full path so far + field
        // has a narrowed override (e.g. "task.cat" narrowed inside a match).
        traversed.push(crate::consts::PATH_SEP);
        traversed.push_str(field);
        if let Some(narrowed) = env.narrowed.get(&traversed) {
            current = narrowed;
            continue;
        }

        match resolve_field(current, field) {
            FieldResult::Ok(ty) => current = ty,
            _ => return None,
        }
    }

    Some(current)
}

pub(super) fn resolve_compiled_expr_type(
    expr: &CompiledExpr,
    env: &TypeEnv<'_>,
    errors: &mut Vec<String>,
) -> Option<VarType> {
    match expr {
        CompiledExpr::Path(path) => {
            validate_compiled_path(path, env, errors);
            resolve_compiled_path_type(path, env).cloned()
        }
        CompiledExpr::Idx(_) => Some(VarType::Int),
        CompiledExpr::Literal(value) => Some(match value {
            Value::Str(_) => VarType::Str,
            Value::Int(_) => VarType::Int,
            Value::Float(_) => VarType::Float,
            Value::Bool(_) => VarType::Bool,
            // `CompiledExpr::compile` only ever produces scalar literals; other
            // variants cannot occur here, so treat them as untyped.
            _ => return None,
        }),
        CompiledExpr::Len(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !matches!(ty, VarType::List(_) | VarType::Str)
            {
                errors.push(format!(
                    "'len()' requires a list or str type, got {ty} on '{}'",
                    path.as_str()
                ));
            }
            Some(VarType::Int)
        }
        CompiledExpr::Kind(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !matches!(ty, VarType::Enum(_) | VarType::Option(_))
            {
                errors.push(format!(
                    "'kind()' requires an enum or option type, got {ty} on '{}'",
                    path.as_str()
                ));
            }
            Some(VarType::Str)
        }
        CompiledExpr::Kinds(path) => {
            validate_compiled_path(path, env, errors);
            let ty = resolve_compiled_path_type(path, env)?;
            if !matches!(ty, VarType::Enum(_)) {
                errors.push(format!(
                    "kinds('{}'): expected enum type namespace, got {ty}",
                    path.as_str()
                ));
            }
            Some(VarType::List(vec![VarDecl {
                name: String::new(),
                var_type: VarType::Str,
                default_value: None,
            }]))
        }
        CompiledExpr::Has(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !ty.is_option()
            {
                errors.push(format!(
                    "'has()' requires an option type, got {ty} on '{}'",
                    path.as_str()
                ));
            }
            Some(VarType::Bool)
        }
    }
}

pub(super) fn resolve_operand_type<'a>(
    operand: &ConditionOperand,
    env: &'a TypeEnv<'_>,
) -> Option<&'a VarType> {
    // Leaked statics for returning references to function-return types.
    // These are cheap and live for the program's duration.
    static STR_TYPE: VarType = VarType::Str;
    static INT_TYPE: VarType = VarType::Int;
    static BOOL_TYPE: VarType = VarType::Bool;

    match operand {
        ConditionOperand::Path { path, .. } => resolve_compiled_path_type(path, env),
        // kind() always returns a string (the variant name).
        ConditionOperand::Kind(_) => Some(&STR_TYPE),
        // len() and idx() always return an integer.
        ConditionOperand::Len(_) | ConditionOperand::Idx(_) => Some(&INT_TYPE),
        // has() always returns a boolean.
        ConditionOperand::Has(_) => Some(&BOOL_TYPE),
        // kinds() returns a list of strings; fall back to None for type checking.
        // Literals and interpolated strings also have no declared type.
        ConditionOperand::Literal(_)
        | ConditionOperand::InterpolatedStr(_)
        | ConditionOperand::Kinds(_) => None,
    }
}

pub(super) fn operand_to_str(operand: &ConditionOperand) -> &str {
    match operand {
        ConditionOperand::Literal(_) => "literal",
        ConditionOperand::InterpolatedStr(_) => "interpolated string",
        ConditionOperand::Path { path, .. }
        | ConditionOperand::Len(path)
        | ConditionOperand::Kind(path)
        | ConditionOperand::Kinds(path)
        | ConditionOperand::Has(path) => path.as_str(),
        ConditionOperand::Idx(binding) => binding.as_ref(),
    }
}

pub(super) fn validate_operand(
    operand: &ConditionOperand,
    env: &TypeEnv<'_>,
    errors: &mut Vec<String>,
) {
    match operand {
        ConditionOperand::Literal(_)
        | ConditionOperand::Idx(_)
        | ConditionOperand::InterpolatedStr(_) => {}
        ConditionOperand::Path { path, .. } => {
            validate_compiled_path(path, env, errors);
        }
        ConditionOperand::Len(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !matches!(ty, VarType::List(_) | VarType::Str)
            {
                errors.push(format!(
                    "'len()' requires a list or str type, got {ty} on '{}'",
                    path.as_str()
                ));
            }
        }
        ConditionOperand::Kind(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !matches!(ty, VarType::Enum(_) | VarType::Option(_))
            {
                errors.push(format!(
                    "'kind()' requires an enum or option type, got {ty} on '{}'",
                    path.as_str()
                ));
            }
        }
        ConditionOperand::Kinds(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env)
                && !matches!(ty, VarType::Enum(_))
            {
                errors.push(format!(
                    "kinds('{}'): expected enum type namespace, got {ty}",
                    path.as_str()
                ));
            }
        }
        ConditionOperand::Has(path) => {
            validate_compiled_path(path, env, errors);
            if let Some(ty) = resolve_compiled_path_type(path, env) {
                if !ty.is_option() {
                    errors.push(format!(
                        "'has()' requires an option type, got {ty} on '{}'",
                        path.as_str()
                    ));
                }
            }
        }
    }
}
