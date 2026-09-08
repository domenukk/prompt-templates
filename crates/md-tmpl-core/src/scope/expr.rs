//! Compiled expressions, paths, and condition operands.

use alloc::{
    borrow::Cow,
    string::{String, ToString},
    sync::Arc,
    vec::Vec,
};

use super::Scope;
use crate::{compiled::ParsedFilter, error::TemplateError, value::Value};

/// A pre-split and compiled dotted path (e.g. `item.nested.field`).
///
/// Parsing once at compile time avoids string splitting, trimming,
/// and allocations during rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledPath {
    pub(crate) raw: Cow<'static, str>,
    pub(crate) parts: Arc<[String]>,
}

impl CompiledPath {
    /// Compile a raw path string into a `CompiledPath`.
    #[must_use]
    pub fn compile(raw: &str) -> Self {
        let raw: Cow<'static, str> = Cow::Owned(raw.to_string());
        let parts: Arc<[String]> = raw
            .split(crate::consts::PATH_SEP)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Self { raw, parts }
    }

    /// Build a `CompiledPath` from a raw string and pre-split parts.
    ///
    /// Used by compile-time macros to avoid re-splitting at runtime.
    /// Both `raw` and each element of `parts` are `&'static str` from
    /// string literals baked into the binary.
    #[must_use]
    pub fn from_static(raw: &'static str, parts: &[&'static str]) -> Self {
        Self {
            raw: Cow::Borrowed(raw),
            parts: parts.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    /// Get the original raw path string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.raw.as_ref()
    }

    /// Get the pre-split path parts.
    #[must_use]
    pub fn parts(&self) -> &[String] {
        &self.parts
    }
}

/// A pre-compiled expression (path or built-in function call).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompiledExpr {
    /// A dotted variable path lookup.
    Path(CompiledPath),
    /// A literal scalar value (string, int, float, or bool).
    Literal(Value),
    /// Loop index lookup `idx(binding)`.
    Idx(Cow<'static, str>),
    /// Length lookup `len(path)`.
    Len(CompiledPath),
    /// Variant name lookup `kind(path)`.
    Kind(CompiledPath),
    /// Enum variant names list lookup `kinds(path)`.
    Kinds(CompiledPath),
    /// Option presence check `has(path)` — returns `true` if option is `Some`.
    Has(CompiledPath),
}

impl CompiledExpr {
    /// Compile a raw expression token into a `CompiledExpr`.
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError`] if the token is empty or represents
    /// an unknown function.
    pub fn compile(raw: &str) -> Result<Self, TemplateError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(TemplateError::syntax("empty token in expression"));
        }

        // Literals mirror `ConditionOperand::compile` branches 1-4 so that a
        // literal is a valid expression in every general position (output,
        // filter input, panic, interpolation), exactly like a variable of that
        // type. Conditions/compare/case already accept literals via
        // `ConditionOperand`; this keeps `{{ }}`-style positions consistent.
        //
        // 1. String literals. A display-position string literal never carries
        //    `{{ expr }}` interpolation (the tag parser splits on the first
        //    `}}`, so an interpolating literal cannot arrive here intact), so
        //    it is always a plain string value.
        if let Some(inner) = crate::consts::strip_string_literal(raw) {
            return Ok(Self::Literal(Value::Str(
                crate::consts::unescape_string_literal(inner),
            )));
        }
        // 2. Boolean literals.
        if raw == crate::consts::LIT_TRUE {
            return Ok(Self::Literal(Value::Bool(true)));
        }
        if raw == crate::consts::LIT_FALSE {
            return Ok(Self::Literal(Value::Bool(false)));
        }
        // 3. Numeric literals, using the strict grammar shared with the TS
        //    backend (see `parse_number_literal`). Malformed numerics (`3.`,
        //    `.5`, `1e3`, `0x10`, ...) are rejected here and fall through to a
        //    path lookup, which then errors — matching the reference engine.
        if let Some(num) = parse_number_literal(raw) {
            return Ok(Self::Literal(num));
        }

        if let Some((func_name, arg)) = parse_function_call(raw) {
            match func_name {
                crate::consts::FN_IDX => Ok(Self::Idx(Cow::Owned(arg.to_string()))),
                crate::consts::FN_LEN => Ok(Self::Len(CompiledPath::compile(arg))),
                crate::consts::FN_KIND => Ok(Self::Kind(CompiledPath::compile(arg))),
                crate::consts::FN_KINDS => Ok(Self::Kinds(CompiledPath::compile(arg))),
                crate::consts::FN_HAS => Ok(Self::Has(CompiledPath::compile(arg))),
                _ => Err(TemplateError::syntax(format!(
                    "unknown function '{func_name}'"
                ))),
            }
        } else {
            Ok(Self::Path(CompiledPath::compile(raw)))
        }
    }
}

/// A pre-compiled condition operand.
#[derive(Debug, Clone)]
pub enum ConditionOperand {
    /// A literal value (string, int, float, bool).
    Literal(Value),
    /// An interpolated string literal containing `{{ expr }}` segments.
    /// Compiled at parse time, evaluated at render time.
    InterpolatedStr(alloc::vec::Vec<crate::compiled::Segment>),
    /// A dotted path lookup, optionally followed by filters.
    Path {
        /// Dotted path.
        path: CompiledPath,
        /// Filter chain.
        filters: Vec<ParsedFilter>,
    },
    /// Loop index lookup `idx(binding)`.
    Idx(Cow<'static, str>),
    /// Length lookup `len(path)`.
    Len(CompiledPath),
    /// Variant name lookup `kind(path)`.
    Kind(CompiledPath),
    /// Enum variant names list lookup `kinds(path)`.
    Kinds(CompiledPath),
    /// Option presence check `has(path)` — returns `true` if option is `Some`.
    Has(CompiledPath),
}

impl ConditionOperand {
    /// Compile a raw condition operand token into a `ConditionOperand`.
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError`] if the token is empty or invalid.
    pub fn compile(token: &str) -> Result<Self, TemplateError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(TemplateError::syntax("empty token in expression"));
        }

        // 1. String literals (with optional {{ expr }} interpolation)
        if let Some(inner) = crate::consts::strip_string_literal(token) {
            let inner = crate::consts::unescape_string_literal(inner);
            if inner.contains(crate::consts::EXPR_START) {
                let segments = crate::compiled::compile_body(&inner)?;
                return Ok(Self::InterpolatedStr(segments));
            }
            return Ok(Self::Literal(Value::Str(inner)));
        }

        // 2. Boolean literals
        if token == crate::consts::LIT_TRUE {
            return Ok(Self::Literal(Value::Bool(true)));
        }
        if token == crate::consts::LIT_FALSE {
            return Ok(Self::Literal(Value::Bool(false)));
        }

        // 3. Numeric literals (strict grammar shared with the TS backend and
        //    with `CompiledExpr::compile`, so a literal parses identically in
        //    every position).
        if let Some(num) = parse_number_literal(token) {
            return Ok(Self::Literal(num));
        }

        // 5. Function calls: idx(binding), len(list), kind(enum)
        if let Some((func_name, arg)) = parse_function_call(token) {
            match func_name {
                crate::consts::FN_IDX => return Ok(Self::Idx(Cow::Owned(arg.to_string()))),
                crate::consts::FN_LEN => return Ok(Self::Len(CompiledPath::compile(arg))),
                crate::consts::FN_KIND => return Ok(Self::Kind(CompiledPath::compile(arg))),
                crate::consts::FN_KINDS => return Ok(Self::Kinds(CompiledPath::compile(arg))),
                crate::consts::FN_HAS => return Ok(Self::Has(CompiledPath::compile(arg))),
                _ => {
                    return Err(TemplateError::syntax(format!(
                        "unknown function '{func_name}'"
                    )));
                }
            }
        }

        // 6. Dotted path (possibly with filters)
        let (path_part, filter_chain) = crate::parser::split_pipe_aware(token);
        let path = CompiledPath::compile(path_part.trim());
        let mut filters = Vec::new();
        if !filter_chain.is_empty() {
            for filter_str in crate::parser::split_filters_aware(filter_chain) {
                let filter_str = filter_str.trim();
                if filter_str.is_empty() {
                    continue;
                }
                let (name, args) = crate::filter::parse_filter(filter_str);
                let kind = crate::compiled::parse_filter_kind(name)?;
                let parsed_num = args.and_then(|a| a.parse::<usize>().ok());
                filters.push(ParsedFilter {
                    kind,
                    args: args.map(|a| Cow::Owned(a.to_string())),
                    parsed_num,
                });
            }
        }
        Ok(Self::Path { path, filters })
    }

    /// Resolve this operand against the scope.
    ///
    /// Returns a [`Cow`] to avoid cloning in the common case where the
    /// operand is a literal or a path without filters.
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError`] if variable resolution or filter execution fails.
    pub fn resolve<'s>(&'s self, scope: &'s Scope<'_>) -> Result<Cow<'s, Value>, TemplateError> {
        match self {
            Self::Literal(val) => Ok(Cow::Borrowed(val)),
            Self::InterpolatedStr(segments) => {
                let rendered = crate::compiled::render_interpolated_str(segments, scope)?;
                Ok(Cow::Owned(Value::Str(rendered)))
            }
            Self::Path { path, filters } => {
                let value = scope.resolve_path(path)?;
                if filters.is_empty() {
                    Ok(Cow::Borrowed(value))
                } else {
                    let mut owned_value = value.clone();
                    for f in filters {
                        owned_value = crate::filter::apply_filter_typed(
                            f.kind,
                            &owned_value,
                            f.args.as_ref().map(AsRef::as_ref),
                        )?;
                    }
                    Ok(Cow::Owned(owned_value))
                }
            }
            Self::Idx(binding) => {
                let meta = scope.get_loop_meta(binding).ok_or_else(|| {
                    TemplateError::syntax(format!("idx() requires active loop binding '{binding}'"))
                })?;
                Ok(Cow::Owned(Value::Int(meta.index)))
            }
            Self::Len(path) => {
                let val = scope.resolve_path(path)?;
                let count = match val {
                    Value::List(l) => i64::try_from(l.len())
                        .map_err(|_| TemplateError::syntax("list length exceeds i64::MAX"))?,
                    Value::Str(s) => i64::try_from(s.len())
                        .map_err(|_| TemplateError::syntax("string length exceeds i64::MAX"))?,
                    _ => {
                        return Err(TemplateError::syntax("len() requires a list or string"));
                    }
                };

                Ok(Cow::Owned(Value::Int(count)))
            }
            Self::Kind(path) => resolve_kind_operand(path, scope),
            Self::Kinds(path) => resolve_kinds_operand(path, scope),
            Self::Has(path) => {
                if let Some(decl_ty) = scope.resolve_declared_type(path.as_str())
                    && !decl_ty.is_option()
                {
                    return Err(TemplateError::syntax(format!(
                        "has() requires an option value, got {decl_ty} on '{}'",
                        path.as_str()
                    )));
                }
                let val = scope.resolve_path(path)?;
                let is_has = if scope.is_option_path(path.as_str()) {
                    Scope::is_option_some(val)
                } else {
                    match val {
                        Value::Str(s) => !s.is_empty(),
                        Value::List(l) => !l.is_empty(),
                        Value::None => false,
                        _ => true,
                    }
                };
                Ok(Cow::Owned(Value::Bool(is_has)))
            }
        }
    }
}

/// Resolve a `kind(path)` operand to its variant-name string value.
///
/// Extracted from [`ConditionOperand::resolve`] to keep that method within
/// the complexity budget. Options report `Some`/`None`; enum structs report
/// their variant tag; plain strings pass through.
fn resolve_kind_operand<'s>(
    path: &CompiledPath,
    scope: &'s Scope<'_>,
) -> Result<Cow<'s, Value>, TemplateError> {
    let val = scope.resolve_path(path)?;
    if scope.is_option_path(path.as_str()) {
        return match val {
            Value::None => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_NONE.into()))),
            _ => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_SOME.into()))),
        };
    }
    match val {
        Value::Struct(d) => {
            if let Some(Value::Str(kind)) = d.get(crate::consts::ENUM_TAG_KEY) {
                Ok(Cow::Owned(Value::Str(kind.clone())))
            } else {
                Err(TemplateError::syntax(
                    "kind() requires an enum value (dict with variant tag)",
                ))
            }
        }
        Value::Str(s) => {
            if let Some(decl_ty) = scope.resolve_declared_type(path.as_str()) {
                let is_enum_or_option_enum = match decl_ty {
                    crate::types::VarType::Enum(_) => true,
                    crate::types::VarType::Option(inner) => {
                        matches!(inner.as_ref(), crate::types::VarType::Enum(_))
                    }
                    _ => false,
                };
                if !is_enum_or_option_enum {
                    return Err(TemplateError::syntax(format!(
                        "kind() requires an enum or option value, got {decl_ty} on '{}'",
                        path.as_str()
                    )));
                }
            }
            Ok(Cow::Owned(Value::Str(s.clone())))
        }
        Value::None => Ok(Cow::Owned(Value::Str(crate::consts::OPTION_NONE.into()))),
        _ => Err(TemplateError::syntax(format!(
            "kind() requires an enum value, got {}",
            val.type_name()
        ))),
    }
}

/// Resolve a `kinds(path)` operand to the list of enum variant names.
///
/// Extracted from [`ConditionOperand::resolve`] to keep that method within
/// the complexity budget.
fn resolve_kinds_operand<'s>(
    path: &CompiledPath,
    scope: &'s Scope<'_>,
) -> Result<Cow<'s, Value>, TemplateError> {
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
        _ => Err(TemplateError::syntax(format!(
            "kinds() requires an enum type namespace, got {}",
            val.type_name()
        ))),
    }
}

/// Parse a function call expression like `idx(item)` or `len(items)`.
///
/// Returns `(func_name, arg)` if the expression matches `identifier(expression)`,
/// or `None` if it doesn't look like a function call.
pub(crate) fn parse_function_call(expr: &str) -> Option<(&str, &str)> {
    let expr = expr.trim();
    let open = expr.find(crate::consts::PAREN_OPEN)?;
    if !expr.ends_with(crate::consts::PAREN_CLOSE) {
        return None;
    }
    let func_name = expr[..open].trim();
    let arg = expr[open + 1..expr.len() - 1].trim();
    if func_name.is_empty() || arg.is_empty() {
        return None;
    }
    // Ensure func_name is a valid identifier (no dots, pipes, etc.).
    if !func_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some((func_name, arg))
}

/// Parse a numeric literal using the strict grammar `^-?[0-9]+(?:\.[0-9]+)?$`.
///
/// This deliberately rejects everything Rust's `str::parse` would otherwise
/// accept but the TypeScript backend does not — scientific notation (`1e3`),
/// hex (`0x10`), unary plus (`+5`), infinities/NaN, and bare leading/trailing
/// dots (`.5`, `3.`). Digits are required on both sides of the decimal point,
/// and at most one dot is allowed (so `3.1.4` is rejected). Leading zeros are
/// permitted and normalized by the numeric parse (`007` → `7`), matching
/// JavaScript's `Number()` semantics.
///
/// Returns [`Value::Int`] for integer literals and [`Value::Float`] for
/// decimals, or `None` when `raw` is not a valid numeric literal.
pub(crate) fn parse_number_literal(raw: &str) -> Option<Value> {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    if digits.is_empty() {
        return None;
    }
    if let Some((int_part, frac_part)) = digits.split_once('.') {
        // Float: exactly one dot, with digits required on both sides.
        let both_sides_are_digits = !int_part.is_empty()
            && !frac_part.is_empty()
            && int_part.bytes().all(|b| b.is_ascii_digit())
            && frac_part.bytes().all(|b| b.is_ascii_digit());
        if !both_sides_are_digits {
            return None;
        }
        raw.parse::<f64>().ok().map(Value::Float)
    } else {
        // Integer: digits only.
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        raw.parse::<i64>().ok().map(Value::Int)
    }
}
