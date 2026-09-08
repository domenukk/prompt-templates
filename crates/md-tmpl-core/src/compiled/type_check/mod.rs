//! Compile-time flow-sensitive type checker for enum field access.
//!
//! Validates several properties:
//!
//! 1. **Variant names** in `{% case Variant %}` are checked against the
//!    enum's declared variants — typos become compile errors.
//! 2. **Field access** on enum values is flow-sensitive:
//!    - Outside a `{% match %}`, only fields present on **all** variants
//!      are accessible.
//!    - Inside `{% case A %}`, fields of variant `A` are accessible.
//!    - Inside `{% case A | B %}`, only fields present on **both** `A`
//!      and `B` are accessible.
//! 3. **Match exhaustiveness**: multi-arm match must cover all variants.
//! 4. **For-loop type**: `{% for x in y %}` requires `y` to be a list.
//! 5. **Scalar field access**: `x.field` on `str`/`int`/`bool`/`float` is an error.
//! 6. **Undeclared variables**: any reference to an undeclared variable is an error.
//!
//! The implementation is split across focused submodules:
//! - [`environment`]: the flow-sensitive [`TypeEnv`].
//! - [`walker`]: the recursive segment-tree walker.
//! - [`matching`]: `{% match %}` arm validation and exhaustiveness.
//! - [`paths`]: dotted-path validation and field resolution.
//! - [`conditions`]: condition, `in`-comparison, and `has()` narrowing.
//! - [`includes`]: cross-boundary `{% include %}` validation.
//! - [`labels`]: the lightweight match-label-only pass.

mod conditions;
mod environment;
mod includes;
mod labels;
mod matching;
mod paths;
mod walker;

use alloc::{string::String, vec::Vec};

#[cfg(all(test, feature = "std"))]
use conditions::types_compatible;
pub(crate) use environment::TypeEnv;
pub(crate) use includes::find_missing_include_params;
pub use labels::validate_match_labels;
pub(crate) use paths::{FieldResult, resolve_field, validate_compiled_path};
use walker::walk_segments;

use super::Segment;
use crate::{
    compat::{HashMap, HashSet},
    types::{VarDecl, VarType},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Validate all field accesses in the compiled segment tree.
///
/// Returns a list of human-readable error messages (empty = valid).
///
/// This runs at **compile time** inside the proc macro — keep it
/// allocation-light on the happy path.
#[must_use]
pub fn validate_field_accesses(segments: &[Segment], declarations: &[VarDecl]) -> Vec<String> {
    validate_field_accesses_with_opaque(segments, declarations, &HashSet::new())
}

/// Like [`validate_field_accesses`], but also accepts a set of "opaque roots" —
/// names that are valid variables but whose internal structure is not
/// statically typed (e.g. import stems for imported constants).
/// Paths rooted at opaque names skip field-level validation.
#[must_use]
pub fn validate_field_accesses_with_opaque(
    segments: &[Segment],
    declarations: &[VarDecl],
    opaque_roots: &HashSet<String>,
) -> Vec<String> {
    validate_field_accesses_full(segments, declarations, &HashMap::new(), opaque_roots)
}

/// Full field-level validation including type aliases from frontmatter.
#[must_use]
pub fn validate_field_accesses_full(
    segments: &[Segment],
    declarations: &[VarDecl],
    type_aliases: &HashMap<String, VarType>,
    opaque_roots: &HashSet<String>,
) -> Vec<String> {
    let mut type_env = TypeEnv::from_declarations_and_types(declarations, type_aliases);
    type_env.opaque_roots.clone_from(opaque_roots);
    let mut errors = Vec::new();
    let mut visited = HashSet::new();
    walk_segments(segments, &mut type_env, &mut errors, &mut visited);
    errors
}

/// Like [`validate_field_accesses_full`], but defers displayability checks
/// (`{{ struct }}`, `{{ list }}`, `{{ option }}`) to render time.
///
/// Used by `Template::from_source` so runtime templates enforce full static
/// type checking on built-in functions (`kind()`, `has()`, `len()`), field
/// accesses, and match exhaustiveness/narrowing across all language bindings.
#[must_use]
pub fn validate_field_accesses_runtime(
    segments: &[Segment],
    declarations: &[VarDecl],
    type_aliases: &HashMap<String, VarType>,
    opaque_roots: &HashSet<String>,
) -> Vec<String> {
    let mut type_env = TypeEnv::from_declarations_and_types(declarations, type_aliases);
    type_env.opaque_roots.clone_from(opaque_roots);
    type_env.check_displayability = false;
    let mut errors = Vec::new();
    let mut visited = HashSet::new();
    walk_segments(segments, &mut type_env, &mut errors, &mut visited);
    errors
}

#[cfg(all(test, feature = "std"))]
#[path = "type_check_tests.rs"]
mod type_check_tests;
