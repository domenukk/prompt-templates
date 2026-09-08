//! Type environment for the compile-time type checker.
//!
//! Maps variable names to their declared types and tracks flow-sensitive
//! narrowing applied inside match arms and `has()` guards.

use alloc::string::{String, ToString};

use crate::{
    compat::{HashMap, HashSet},
    types::{VarDecl, VarType},
};

/// Maps variable names to their declared types.
///
/// Cheaply cloneable: inner map uses `Cow` references where possible.
/// When entering a match arm, the matched variable's type is temporarily
/// narrowed (replaced) and restored when leaving the arm.
#[derive(Clone)]
pub(crate) struct TypeEnv<'a> {
    /// Root variables from frontmatter declarations.
    vars: HashMap<&'a str, &'a VarType>,
    /// Type aliases defined via `types:` in frontmatter.
    type_aliases: HashMap<&'a str, &'a VarType>,
    /// Overrides applied inside match arms (narrowed enum types).
    /// Key is the root variable name, value is the narrowed `VarType`.
    pub(crate) narrowed: HashMap<String, VarType>,
    /// Names that are valid roots but opaque to field-level type checking
    /// (e.g. import stems for imported constants like `config.NOTEBOOK_FILENAME`).
    pub(super) opaque_roots: HashSet<String>,
    /// Whether to enforce static displayability checks (`{{ struct }}` / `{{ list }}`).
    pub(crate) check_displayability: bool,
}

impl<'a> TypeEnv<'a> {
    pub(super) fn from_declarations(declarations: &'a [VarDecl]) -> Self {
        let mut vars = HashMap::with_capacity(declarations.len());
        for decl in declarations {
            vars.insert(decl.name.as_str(), &decl.var_type);
        }
        Self {
            vars,
            type_aliases: HashMap::new(),
            narrowed: HashMap::new(),
            opaque_roots: HashSet::new(),
            check_displayability: true,
        }
    }

    pub(super) fn from_declarations_and_types(
        declarations: &'a [VarDecl],
        type_aliases: &'a HashMap<String, VarType>,
    ) -> Self {
        let mut vars = HashMap::with_capacity(declarations.len());
        for decl in declarations {
            vars.insert(decl.name.as_str(), &decl.var_type);
        }
        let mut aliases = HashMap::with_capacity(type_aliases.len());
        for (name, ty) in type_aliases {
            aliases.insert(name.as_str(), ty);
        }
        Self {
            vars,
            type_aliases: aliases,
            narrowed: HashMap::new(),
            opaque_roots: HashSet::new(),
            check_displayability: true,
        }
    }

    /// Resolve the type of a root variable, checking narrowed overrides first.
    pub(crate) fn lookup(&self, name: &str) -> Option<&VarType> {
        self.narrowed
            .get(name)
            .or_else(|| self.vars.get(name).copied())
            .or_else(|| self.type_aliases.get(name).copied())
    }

    /// Check if a name is a known opaque root (valid but not typed).
    pub(super) fn is_opaque(&self, name: &str) -> bool {
        self.opaque_roots.contains(name)
    }

    /// Insert a narrowed type override. Returns the previous value, if any.
    pub(super) fn narrow(&mut self, name: &str, ty: VarType) -> Option<VarType> {
        self.narrowed.insert(name.to_string(), ty)
    }

    /// Remove a narrowed type override.
    pub(super) fn unnarrow(&mut self, name: &str) {
        self.narrowed.remove(name);
    }
}
