//! Frontmatter type declarations and validation.

use alloc::{
    boxed::Box,
    string::{String, ToString},
    vec::Vec,
};
use core::fmt;

use crate::value::Value;

/// Expected type of a template variable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarType {
    /// `str` — expects a string value.
    Str,
    /// `bool` — expects a boolean value.
    Bool,
    /// `int` — expects an integer value.
    Int,
    /// `float` — expects a floating-point value.
    Float,
    /// `list(field = type, ...)` — required fields per item.
    List(Vec<VarDecl>),
    /// `struct(field = type, ...)` — required fields.
    Struct(Vec<VarDecl>),
    /// `enum(Option1, Option2, ...)` — expects one of these variants.
    Enum(Vec<VariantDecl>),
    /// `tmpl(field = type, ...)` — expects a template with matching params.
    Tmpl(Vec<VarDecl>),
    /// `option(T)` — syntactic sugar for `enum(Some(val = T), None)`.
    /// Accepts `Value::None` or the inner `T` type directly.
    Option(Box<VarType>),
}

/// Write a comma-separated `name = type` field list.
fn fmt_fields(fields: &[VarDecl], f: &mut fmt::Formatter<'_>) -> fmt::Result {
    for (i, decl) in fields.iter().enumerate() {
        if i > 0 {
            write!(f, ", ")?;
        }
        if decl.name.is_empty() {
            write!(f, "{}", decl.var_type)?;
        } else {
            write!(f, "{} = {}", decl.name, decl.var_type)?;
        }
    }
    Ok(())
}

impl fmt::Display for VarType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Str => f.write_str(crate::consts::TYPE_STR),
            Self::Bool => f.write_str(crate::consts::TYPE_BOOL),
            Self::Int => f.write_str(crate::consts::TYPE_INT),
            Self::Float => f.write_str(crate::consts::TYPE_FLOAT),
            Self::List(fields) => {
                f.write_str(crate::consts::TYPE_LIST_PREFIX)?;
                fmt_fields(fields, f)?;
                write!(f, ")")
            }
            Self::Struct(fields) => {
                f.write_str(crate::consts::TYPE_STRUCT_PREFIX)?;
                fmt_fields(fields, f)?;
                write!(f, ")")
            }
            Self::Enum(variants) => {
                f.write_str(crate::consts::TYPE_ENUM_PREFIX)?;
                for (i, var) in variants.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{}", var.name)?;
                    if !var.fields.is_empty() {
                        write!(f, "(")?;
                        fmt_fields(&var.fields, f)?;
                        write!(f, ")")?;
                    }
                }
                write!(f, ")")
            }
            Self::Tmpl(fields) => {
                f.write_str(crate::consts::TYPE_TMPL_PREFIX)?;
                fmt_fields(fields, f)?;
                write!(f, ")")
            }
            Self::Option(inner) => write!(f, "{}{inner})", crate::consts::TYPE_OPTION_PREFIX),
        }
    }
}

impl VarType {
    /// Returns `true` if this type can be directly displayed via `{{ expr }}`.
    ///
    /// Only scalar types (`str`, `int`, `float`, `bool`) are displayable.
    /// Compound types (`list`, `struct`, `enum`, `tmpl`, `option`) must be
    /// accessed through iteration, field access, `kind()`, `has()`, or
    /// `{% match %}` instead.
    #[must_use]
    pub fn is_displayable(&self) -> bool {
        matches!(
            self,
            Self::Str | Self::Int | Self::Float | Self::Bool | Self::Enum(_)
        )
    }

    /// Returns `true` if `value` is compatible with this declared type.
    ///
    /// - Scalar types match their corresponding `Value` variant.
    /// - `List(fields)` matches `Value::List`; if `fields` is non-empty,
    ///   **every** item must be a `Struct` with all required keys **and**
    ///   matching value types (recursive).
    /// - `Struct(fields)` matches `Value::Struct`; required keys must be present
    ///   with matching value types (recursive).
    /// - `Enum(variants)` matches unit variants as `Value::Str`, struct
    ///   variants as `Value::Struct` with `__kind__` + typed fields.
    #[must_use]
    pub fn matches(&self, value: &Value) -> bool {
        self.check(value).is_ok()
    }

    /// Validate `value` against this type, returning a structured error with
    /// the path to the first mismatch on failure.
    ///
    /// Uses a two-pass strategy: a fast discriminant-only check first (zero
    /// allocations), falling back to the full path-building check only when
    /// a mismatch is detected.
    ///
    /// # Errors
    ///
    /// Returns [`TypeCheckError`] with the dotted path to the mismatched field,
    /// the expected type, the actual type, and a preview of the actual value.
    pub fn check(&self, value: &Value) -> Result<(), TypeCheckError> {
        // Fast path: discriminant-only check, zero allocations.
        if self.check_fast(value) {
            return Ok(());
        }
        // Slow path: build the full error path.
        self.check_inner(value, String::new())
    }

    /// Fast discriminant-only type check — returns `true` if the value matches.
    ///
    /// This avoids all `String` allocations (no path building, no error
    /// formatting) and is used as the first pass in [`check`](Self::check).
    /// For deeply nested types with many list items, this is dramatically
    /// faster than the full `check_inner` path on the success case.
    #[inline]
    fn check_fast(&self, value: &Value) -> bool {
        match self {
            Self::Str => matches!(value, Value::Str(_)),
            Self::Bool => matches!(value, Value::Bool(_)),
            Self::Int => matches!(value, Value::Int(_)),
            // Accept Int as Float (lossless widening) — important for
            // JS/JSON backends where 5.0 is indistinguishable from 5.
            Self::Float => matches!(value, Value::Float(_) | Value::Int(_)),
            Self::List(fields) => Self::check_fast_list(fields, value),
            Self::Struct(fields) => Self::check_fast_struct(fields, value),
            Self::Enum(variants) => Self::check_fast_enum(variants, value),
            Self::Tmpl(expected) => Self::check_fast_tmpl(expected, value),
            Self::Option(inner) => matches!(value, Value::None) || inner.check_fast(value),
        }
    }

    /// Fast check for `List` types: each item must match the declared fields.
    fn check_fast_list(fields: &[VarDecl], value: &Value) -> bool {
        let Value::List(items) = value else {
            return false;
        };
        if fields.is_empty() {
            return true;
        }
        for item in items.iter() {
            if fields.len() == 1 && fields[0].name.is_empty() {
                if !fields[0].var_type.check_fast(item) {
                    return false;
                }
                continue;
            }
            let Value::Struct(map) = item else {
                return false;
            };
            if !Self::check_fast_struct_fields(fields, map) {
                return false;
            }
        }
        true
    }

    /// Fast check for `Struct` types: extract the map and delegate to field checking.
    fn check_fast_struct(fields: &[VarDecl], value: &Value) -> bool {
        let Value::Struct(map) = value else {
            return false;
        };
        Self::check_fast_struct_fields(fields, map)
    }

    /// Shared struct field checking: every declared field must be present with a
    /// matching value type (recursive).
    fn check_fast_struct_fields(
        fields: &[VarDecl],
        map: &crate::compat::HashMap<String, Value>,
    ) -> bool {
        for decl in fields {
            match map.get(&decl.name) {
                Some(v) => {
                    if !decl.var_type.check_fast(v) {
                        return false;
                    }
                }
                None => return false,
            }
        }
        true
    }

    /// Fast check for `Enum` types: unit variants match strings, struct variants
    /// match dicts with an `ENUM_TAG_KEY` field and typed fields.
    fn check_fast_enum(variants: &[VariantDecl], value: &Value) -> bool {
        match value {
            Value::Str(s) => variants.iter().any(|v| v.name == *s && v.fields.is_empty()),
            Value::Struct(map) => {
                let tag_key = crate::consts::ENUM_TAG_KEY;
                let Some(Value::Str(tag)) = map.get(tag_key) else {
                    return false;
                };
                let Some(var) = variants.iter().find(|v| v.name == *tag) else {
                    return false;
                };
                for decl in &var.fields {
                    match map.get(&decl.name) {
                        Some(v) => {
                            if !decl.var_type.check_fast(v) {
                                return false;
                            }
                        }
                        None => return false,
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// Fast check for `Tmpl` types: the template's parameters must match the
    /// expected signature.
    fn check_fast_tmpl(expected: &[VarDecl], value: &Value) -> bool {
        let Value::Tmpl(tmpl) = value else {
            return false;
        };
        let actual_decls = tmpl.declarations();
        for exp in expected {
            match actual_decls.iter().find(|d| d.name == exp.name) {
                Some(act) => {
                    if act.var_type != exp.var_type {
                        return false;
                    }
                }
                None => return false,
            }
        }
        for act in actual_decls {
            if act.default_value.is_none() && !expected.iter().any(|e| e.name == act.name) {
                return false;
            }
        }
        true
    }

    fn check_inner(&self, value: &Value, path: String) -> Result<(), TypeCheckError> {
        match self {
            Self::Str => {
                if matches!(value, Value::Str(_)) {
                    Ok(())
                } else {
                    Err(TypeCheckError::new(path, crate::consts::TYPE_STR, value))
                }
            }
            Self::Bool => {
                if matches!(value, Value::Bool(_)) {
                    Ok(())
                } else {
                    Err(TypeCheckError::new(path, crate::consts::TYPE_BOOL, value))
                }
            }
            Self::Int => {
                if matches!(value, Value::Int(_)) {
                    Ok(())
                } else {
                    Err(TypeCheckError::new(path, crate::consts::TYPE_INT, value))
                }
            }
            Self::Float => {
                // Accept Int as Float (lossless widening) — important for
                // JS/JSON backends where 5.0 is indistinguishable from 5.
                if matches!(value, Value::Float(_) | Value::Int(_)) {
                    Ok(())
                } else {
                    Err(TypeCheckError::new(path, crate::consts::TYPE_FLOAT, value))
                }
            }
            Self::List(fields) => Self::check_list(fields, value, path),
            Self::Struct(fields) => Self::check_dict(fields, value, path),
            Self::Enum(variants) => Self::check_enum(variants, value, path),
            Self::Tmpl(params) => Self::check_tmpl(params, value, path),
            Self::Option(inner) => {
                if matches!(value, Value::None) {
                    Ok(())
                } else {
                    inner.check_inner(value, path)
                }
            }
        }
    }

    /// Validate a `List` type: each item must be a dict with all required fields.
    fn check_list(fields: &[VarDecl], value: &Value, path: String) -> Result<(), TypeCheckError> {
        let Value::List(items) = value else {
            return Err(TypeCheckError::new(path, crate::consts::TYPE_LIST, value));
        };
        if fields.is_empty() {
            return Ok(());
        }
        for (i, item) in items.iter().enumerate() {
            if fields.len() == 1 && fields[0].name.is_empty() {
                // Scalar list: each item must match the first field's type.
                fields[0]
                    .var_type
                    .check_inner(item, format!("{path}[{i}]"))?;
                continue;
            }
            let Value::Struct(map) = item else {
                return Err(TypeCheckError::new(
                    format!("{path}[{i}]"),
                    crate::consts::TYPE_STRUCT,
                    item,
                ));
            };
            for decl in fields {
                let field_path = if path.is_empty() {
                    format!("[{i}].{}", decl.name)
                } else {
                    format!("{path}[{i}].{}", decl.name)
                };
                match map.get(&decl.name) {
                    Some(v) => decl.var_type.check_inner(v, field_path)?,
                    None => {
                        return Err(TypeCheckError {
                            path: field_path,
                            expected: decl.var_type.to_string(),
                            actual: "missing".into(),
                            actual_value: String::new(),
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// Validate a `Struct` type: all required keys must be present with matching types.
    fn check_dict(fields: &[VarDecl], value: &Value, path: String) -> Result<(), TypeCheckError> {
        let Value::Struct(map) = value else {
            return Err(TypeCheckError::new(path, crate::consts::TYPE_STRUCT, value));
        };
        for decl in fields {
            let field_path = if path.is_empty() {
                decl.name.clone()
            } else {
                format!("{path}.{}", decl.name)
            };
            match map.get(&decl.name) {
                Some(v) => decl.var_type.check_inner(v, field_path)?,
                None => {
                    return Err(TypeCheckError {
                        path: field_path,
                        expected: decl.var_type.to_string(),
                        actual: "missing".into(),
                        actual_value: String::new(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Validate an `Enum` type: unit variants match strings, struct variants
    /// match dicts with an `ENUM_TAG_KEY` field and typed fields.
    fn check_enum(
        variants: &[VariantDecl],
        value: &Value,
        path: String,
    ) -> Result<(), TypeCheckError> {
        match value {
            Value::Str(s) => {
                if variants.iter().any(|v| v.name == *s && v.fields.is_empty()) {
                    Ok(())
                } else {
                    let variant_names: Vec<&str> =
                        variants.iter().map(|v| v.name.as_str()).collect();
                    Err(TypeCheckError {
                        path,
                        expected: format!("enum({})", variant_names.join(", ")),
                        actual: format!("str({s})"),
                        actual_value: s.clone(),
                    })
                }
            }
            Value::Struct(map) => {
                let tag_key = crate::consts::ENUM_TAG_KEY;
                let Some(Value::Str(tag)) = map.get(tag_key) else {
                    return Err(TypeCheckError {
                        path,
                        expected: format!("enum dict with '{tag_key}' field"),
                        actual: value.type_name().into(),
                        actual_value: value.to_string(),
                    });
                };
                let Some(var) = variants.iter().find(|v| v.name == *tag) else {
                    let variant_names: Vec<&str> =
                        variants.iter().map(|v| v.name.as_str()).collect();
                    return Err(TypeCheckError {
                        path: format!("{path}.{tag_key}"),
                        expected: format!("one of [{}]", variant_names.join(", ")),
                        actual: format!("'{tag}'"),
                        actual_value: tag.clone(),
                    });
                };
                for decl in &var.fields {
                    let field_path = if path.is_empty() {
                        decl.name.clone()
                    } else {
                        format!("{path}.{}", decl.name)
                    };
                    match map.get(&decl.name) {
                        Some(v) => decl.var_type.check_inner(v, field_path)?,
                        None => {
                            return Err(TypeCheckError {
                                path: field_path,
                                expected: decl.var_type.to_string(),
                                actual: "missing".into(),
                                actual_value: String::new(),
                            });
                        }
                    }
                }
                Ok(())
            }
            _ => Err(TypeCheckError::new(
                path,
                &VarType::Enum(variants.to_vec()).to_string(),
                value,
            )),
        }
    }

    /// Validate a `Tmpl` type: the value must be a template whose parameters
    /// match the expected signature.
    fn check_tmpl(expected: &[VarDecl], value: &Value, path: String) -> Result<(), TypeCheckError> {
        let Value::Tmpl(tmpl) = value else {
            return Err(TypeCheckError::new(path, crate::consts::TYPE_TMPL, value));
        };

        // Check if the template's parameters match the expected signature.
        // Rule: The template must accept ALL parameters defined in the signature
        // with matching types. It may have additional parameters IF they have
        // default values.
        let actual_decls = tmpl.declarations();

        for exp in expected {
            let found = actual_decls.iter().find(|d| d.name == exp.name);
            match found {
                Some(act) => {
                    if act.var_type != exp.var_type {
                        return Err(TypeCheckError {
                            path: if path.is_empty() {
                                exp.name.clone()
                            } else {
                                format!("{path}.{}", exp.name)
                            },
                            expected: exp.var_type.to_string(),
                            actual: act.var_type.to_string(),
                            actual_value: String::new(),
                        });
                    }
                }
                None => {
                    return Err(TypeCheckError {
                        path: if path.is_empty() {
                            exp.name.clone()
                        } else {
                            format!("{path}.{}", exp.name)
                        },
                        expected: exp.var_type.to_string(),
                        actual: "missing".into(),
                        actual_value: String::new(),
                    });
                }
            }
        }

        // Also check if the template has any REQUIRED parameters not in the signature.
        for act in actual_decls {
            if act.default_value.is_none() && !expected.iter().any(|e| e.name == act.name) {
                return Err(TypeCheckError {
                    path: if path.is_empty() {
                        act.name.clone()
                    } else {
                        format!("{path}.{}", act.name)
                    },
                    expected: "in signature".into(),
                    actual: "missing".into(),
                    actual_value: String::new(),
                });
            }
        }

        Ok(())
    }
}

/// Structured error from [`VarType::check`] with the path to the mismatch.
#[derive(Debug, Clone)]
pub struct TypeCheckError {
    /// Dotted path to the mismatched field (e.g. `"tasks[2].title"`).
    pub path: String,
    /// The expected type at that path.
    pub expected: String,
    /// The actual type found.
    pub actual: String,
    /// Preview of the actual value.
    pub actual_value: String,
}

/// Maximum length for the actual-value preview in error messages.
const MAX_PREVIEW_LEN: usize = 60;

impl TypeCheckError {
    fn new(path: String, expected: &str, value: &Value) -> Self {
        let preview = value.to_string();
        let actual_value = if preview.len() > MAX_PREVIEW_LEN {
            // Truncate at a character boundary to avoid panicking on multi-byte UTF-8.
            let truncate_at = preview
                .char_indices()
                .map(|(i, _)| i)
                .take_while(|&i| i <= MAX_PREVIEW_LEN - 3)
                .last()
                // NOLINT: empty iterator means string has no chars — 0 is the correct truncation point
                .unwrap_or(0);
            format!("{}…", &preview[..truncate_at])
        } else {
            preview
        };
        Self {
            path,
            expected: expected.into(),
            actual: value.type_name().into(),
            actual_value,
        }
    }
}

impl fmt::Display for TypeCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "expected {}, got {}", self.expected, self.actual)?;
        } else {
            write!(
                f,
                "at '{}': expected {}, got {}",
                self.path, self.expected, self.actual
            )?;
        }
        if !self.actual_value.is_empty() {
            write!(f, " ({})", self.actual_value)?;
        }
        Ok(())
    }
}

/// A variant declaration inside an enum type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantDecl {
    /// Variant name.
    pub name: String,
    /// Optional associated fields for struct variants.
    pub fields: Vec<VarDecl>,
}

/// A variable declaration: name + type + optional default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VarDecl {
    /// Variable name.
    pub name: String,
    /// Expected type.
    pub var_type: VarType,
    /// Optional default value for this parameter (or mandatory value for a constant).
    pub default_value: Option<crate::value::Value>,
}

impl VarDecl {
    /// Returns the default value for this declaration, if any.
    #[must_use]
    pub fn default_value(&self) -> Option<&crate::value::Value> {
        self.default_value.as_ref()
    }
}

impl VarType {
    /// Returns `true` if this type is an `option(T)`.
    ///
    /// `option` is a first-class type: a literal `enum(Some(val = T), None)`
    /// is an ordinary enum, not an option. Use `option(T)` for options.
    #[must_use]
    pub fn is_option(&self) -> bool {
        matches!(self, VarType::Option(_))
    }

    /// If this type is `option(T)`, returns the inner `T` type.
    #[must_use]
    pub fn option_inner_type(&self) -> Option<&VarType> {
        match self {
            VarType::Option(inner) => Some(inner),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Built-in type names
// ---------------------------------------------------------------------------

/// Names of all built-in types. Used for shadowing checks in validation.
pub const BUILTIN_TYPE_NAMES: &[&str] = &[
    crate::consts::TYPE_STR,
    crate::consts::TYPE_BOOL,
    crate::consts::TYPE_INT,
    crate::consts::TYPE_FLOAT,
    crate::consts::TYPE_LIST,
    crate::consts::TYPE_STRUCT,
    crate::consts::TYPE_ENUM,
    crate::consts::TYPE_TMPL,
    crate::consts::TYPE_OPTION,
    crate::consts::TYPE_NONE,
];

// ---------------------------------------------------------------------------
// PascalCase conversion
// ---------------------------------------------------------------------------

/// Convert a `snake_case`, `kebab-case`, or other string to `PascalCase`.
///
/// Splits on `_` and `-`, capitalises the first character of each segment,
/// and preserves the remaining characters.
///
/// # Examples
///
/// ```
/// use md_tmpl_core::to_pascal_case;
/// assert_eq!(to_pascal_case("code_review"), "CodeReview");
/// assert_eq!(to_pascal_case("task-report"), "TaskReport");
/// ```
#[must_use]
pub fn to_pascal_case(s: &str) -> String {
    s.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let upper: String = first.to_uppercase().collect();
                    format!("{upper}{}", chars.as_str())
                }
                None => String::new(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "std"))]
#[path = "types_tests.rs"]
mod tests;
