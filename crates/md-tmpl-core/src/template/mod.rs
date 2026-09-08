use alloc::{
    string::{String, ToString},
    sync::Arc,
    vec::Vec,
};
#[cfg(feature = "std")]
use std::path::{Path, PathBuf};

use crate::{
    compat::{HashMap, HashSet},
    compiled::{self, CompiledInlineTemplate, Segment},
    context::Context,
    error::TemplateError,
    frontmatter::{self, Frontmatter},
    types::VarDecl,
    value::Value,
};

pub(crate) mod analysis;
mod render_methods;
#[cfg(not(feature = "std"))]
use self::analysis::hash_source_no_std;
use self::analysis::{
    check_bare_enum_access, check_internal_key_access, check_name_collisions,
    check_static_enum_in_conditions, check_undeclared_variables, check_unused_params,
    collect_enum_type_keys, inject_enum_type_constants,
};

/// Configuration for template compilation.
///
/// Collects all optional parameters that previously required separate
/// constructor functions. Use with [`Template::compile`] or
/// [`Template::compile_file`].
///
/// # Examples
///
/// ```
/// use md_tmpl_core::CompileOptions;
///
/// // Default options (strict mode):
/// let opts = CompileOptions::default();
///
/// // Allow unused declared parameters:
/// let opts = CompileOptions::default().allow_unused(true);
/// ```
#[non_exhaustive]
#[derive(Debug, Clone, Copy, Default)]
pub struct CompileOptions<'a> {
    /// When `true`, declared parameters that are never referenced in the
    /// template body are allowed instead of producing an error.
    ///
    /// Equivalent to `allow_unused: true` in frontmatter.
    pub allow_unused: bool,
    /// Base directory for resolving `{% include %}` and `{% import %}` directives.
    ///
    /// When `None`, includes are not resolved (suitable for in-memory templates).
    #[cfg(feature = "std")]
    pub base_dir: Option<&'a std::path::Path>,
    /// Compile-time environment variables (name-value pairs).
    /// Values are typed — they must match the type declared in `env:` frontmatter.
    /// String values for scalar types (int, bool, float) are auto-parsed.
    pub env: &'a [(&'a str, crate::Value)],
    // Lifetime anchor for no_std where base_dir doesn't exist.
    #[cfg(not(feature = "std"))]
    _phantom: core::marker::PhantomData<&'a ()>,
}

#[cfg(feature = "std")]
impl<'a> CompileOptions<'a> {
    /// Set the base directory for include resolution.
    #[must_use]
    pub fn base_dir(mut self, dir: &'a std::path::Path) -> Self {
        self.base_dir = Some(dir);
        self
    }
}

impl<'a> CompileOptions<'a> {
    /// Allow unused declared parameters.
    #[must_use]
    pub fn allow_unused(mut self, allow: bool) -> Self {
        self.allow_unused = allow;
        self
    }

    /// Set compile-time environment variables.
    #[must_use]
    pub fn env(mut self, pairs: &'a [(&'a str, crate::Value)]) -> Self {
        self.env = pairs;
        self
    }
}

/// A parsed template ready for rendering.
///
/// Templates can be loaded from files or parsed from in-memory strings.
/// Variable declarations from frontmatter are used for context validation
/// before rendering.
pub struct Template {
    /// The template body text (after stripping frontmatter).
    body: String,
    /// Template name (from frontmatter).
    name: Option<String>,
    /// Template description (from frontmatter).
    description: Option<String>,
    /// Pre-compiled segment instructions (the fast render path).
    segments: Arc<[Segment]>,
    /// Declared variables from frontmatter.
    declared_variables: Arc<[VarDecl]>,
    /// Base directory for resolving includes (from file path).
    #[cfg(feature = "std")]
    base_dir: Option<PathBuf>,
    /// Pre-compiled inline template definitions (`{% tmpl name %}...{% /tmpl %}`).
    inline_templates: Arc<HashMap<String, CompiledInlineTemplate>>,
    source_hash: u64,
    max_include_depth: usize,
    /// Pre-computed: true if any declared variable has a default value.
    has_defaults: bool,
    /// Constants defined in this template.
    consts: Arc<HashMap<String, crate::value::Value>>,
    /// Imported constants keyed by `stem.NAME`.
    imported_consts: Arc<HashMap<String, crate::value::Value>>,
    /// Pre-computed estimated output capacity (cached from segment tree walk).
    estimated_capacity: usize,
    /// Compile-time environment values, propagated to included files so their
    /// `env:` frontmatter declarations can be resolved.
    #[cfg(feature = "std")]
    env_values: alloc::sync::Arc<[(String, Value)]>,
    /// Pre-computed set of all declared variable names and constants.
    declared_names: Arc<HashSet<String>>,
    /// Cached `TypeId`s of Rust types that have passed validation.
    ///
    /// When `render::<T>()` is called, the first invocation runs full
    /// `validate_context`. If it passes, `TypeId::of::<T>()` is stored
    /// here so subsequent calls skip validation entirely.
    #[cfg(feature = "std")]
    checked_type_ids: std::sync::Mutex<Vec<core::any::TypeId>>,
}

impl core::fmt::Debug for Template {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Template")
            .field("body", &self.body)
            .field("name", &self.name)
            .field("description", &self.description)
            .field("segments", &self.segments)
            .field("declared_variables", &self.declared_variables)
            .field("source_hash", &self.source_hash)
            .finish_non_exhaustive()
    }
}

impl Clone for Template {
    fn clone(&self) -> Self {
        Self {
            body: self.body.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            segments: self.segments.clone(),
            declared_variables: self.declared_variables.clone(),
            #[cfg(feature = "std")]
            base_dir: self.base_dir.clone(),
            inline_templates: self.inline_templates.clone(),
            source_hash: self.source_hash,
            max_include_depth: self.max_include_depth,
            has_defaults: self.has_defaults,
            consts: self.consts.clone(),
            imported_consts: self.imported_consts.clone(),
            estimated_capacity: self.estimated_capacity,
            #[cfg(feature = "std")]
            env_values: self.env_values.clone(),
            declared_names: self.declared_names.clone(),
            // Clone inherits cached type IDs — the validation is
            // shape-based, not instance-based.
            #[cfg(feature = "std")]
            checked_type_ids: std::sync::Mutex::new(
                self.checked_type_ids
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone(),
            ),
        }
    }
}

/// Pre-compiled template data used to reconstruct a [`Template`] from cache.
///
/// See [`Template::from_cached`].
#[cfg(feature = "std")]
pub(crate) struct CachedTemplateData {
    /// Pre-compiled segment instructions.
    pub segments: Arc<[Segment]>,
    /// Declared variables from frontmatter.
    pub declared_variables: Arc<[VarDecl]>,
    /// Base directory for resolving includes.
    pub base_dir: Option<PathBuf>,
    /// Pre-compiled inline template definitions.
    pub inline_templates: Arc<HashMap<String, CompiledInlineTemplate>>,
    /// Content hash of the raw source.
    pub source_hash: u64,
    /// Constants defined in this template.
    pub consts: Arc<HashMap<String, crate::value::Value>>,
    /// Imported constants.
    pub imported_consts: Arc<HashMap<String, crate::value::Value>>,
    /// Template name.
    pub name: Option<String>,
    /// Template description.
    pub description: Option<String>,
}

/// Pre-compiled template data for compile-time macro integration.
///
/// See [`Template::from_precompiled`].
#[doc(hidden)]
pub struct PrecompiledTemplateData<'a> {
    /// Pre-compiled segment instructions.
    pub segments: &'a [Segment],
    /// Declared variables from frontmatter.
    pub declared_variables: &'a [VarDecl],
    /// Pre-compiled inline template definitions.
    pub inline_templates: &'a [(&'a str, CompiledInlineTemplate)],
    /// Content hash of the raw source.
    pub source_hash: u64,
    /// Constants defined in this template.
    pub consts: &'a [(&'a str, crate::value::Value)],
    /// Imported constants.
    pub imported_consts: &'a [(&'a str, crate::value::Value)],
    /// Template name.
    pub name: Option<&'a str>,
    /// Template description.
    pub description: Option<&'a str>,
}

fn build_declared_names(
    declarations: &[VarDecl],
    consts: &HashMap<String, Value>,
) -> Arc<HashSet<String>> {
    let mut names = HashSet::with_capacity(declarations.len() + consts.len());
    for d in declarations {
        names.insert(d.name.clone());
    }
    for k in consts.keys() {
        names.insert(k.clone());
    }
    Arc::new(names)
}

impl Template {
    /// Load a template from a file, stripping YAML frontmatter.
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::Io`] if the file cannot be read.
    #[cfg(feature = "std")]
    pub fn from_file(path: &Path) -> Result<Self, TemplateError> {
        let mut source = std::fs::read_to_string(path)?;
        // Normalize CRLF → LF for cross-platform consistency.
        if source.contains('\r') {
            source = source.replace("\r\n", "\n");
        }
        let (tmpl, _fm) =
            Self::compile_from_source(&source, Some(path.parent().unwrap_or(Path::new("."))))?;
        Ok(tmpl)
    }

    /// Parse a template from an in-memory string (no include resolution).
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::Syntax`] if the body contains a syntax error.
    pub fn from_source(source: &str) -> Result<Self, TemplateError> {
        // Normalize CRLF → LF for cross-platform consistency.
        let source = if source.contains('\r') {
            alloc::borrow::Cow::Owned(source.replace("\r\n", "\n"))
        } else {
            alloc::borrow::Cow::Borrowed(source)
        };
        #[cfg(feature = "std")]
        let (tmpl, _fm) = Self::compile_from_source(&source, None)?;
        #[cfg(not(feature = "std"))]
        let (tmpl, _fm) = Self::compile_from_source_no_std(&source)?;
        Ok(tmpl)
    }

    /// Parse a template from source with compile options, returning both the
    /// template and its frontmatter.
    ///
    /// This is the unified entry point that replaces the family of
    /// `from_source_*` constructors.
    ///
    /// # Examples
    ///
    /// ```
    /// use md_tmpl_core::{CompileOptions, Template};
    ///
    /// let (tmpl, fm) = Template::compile(
    ///     r#"---
    /// params: [name = str]
    /// ---
    /// Hello {{ name }}!"#,
    ///     CompileOptions::default(),
    /// )
    /// .unwrap();
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::Syntax`] if the body contains a syntax error.
    pub fn compile(
        source: &str,
        options: CompileOptions<'_>,
    ) -> Result<(Self, Frontmatter), TemplateError> {
        // Normalize CRLF → LF so templates read on Windows produce identical
        // output to Unix.  Uses `Cow` to avoid allocation when no `\r` present.
        let source = if source.contains('\r') {
            alloc::borrow::Cow::Owned(source.replace("\r\n", "\n"))
        } else {
            alloc::borrow::Cow::Borrowed(source)
        };
        #[cfg(feature = "std")]
        return Self::compile_inner(&source, options.base_dir, options.allow_unused, options.env);
        #[cfg(not(feature = "std"))]
        return Self::compile_inner_no_std(&source, options.allow_unused, options.env);
    }

    /// Load a template from a file with compile options, returning both the
    /// template and its frontmatter.
    ///
    /// The file's parent directory is used as the base directory for include
    /// resolution unless overridden in `options`.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use std::path::Path;
    ///
    /// use md_tmpl_core::{CompileOptions, Template};
    ///
    /// let (tmpl, fm) =
    ///     Template::compile_file(Path::new("template.tmpl.md"), CompileOptions::default()).unwrap();
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::Io`] if the file cannot be read.
    #[cfg(feature = "std")]
    pub fn compile_file(
        path: &Path,
        options: CompileOptions<'_>,
    ) -> Result<(Self, Frontmatter), TemplateError> {
        let mut source = std::fs::read_to_string(path)?;
        // Normalize CRLF → LF for cross-platform consistency.
        if source.contains('\r') {
            source = source.replace("\r\n", "\n");
        }
        let base_dir = options.base_dir.or_else(|| path.parent());
        Self::compile_inner(&source, base_dir, options.allow_unused, options.env)
    }

    /// Shared compilation entry point — honours `allow_unused` from frontmatter.
    #[cfg(feature = "std")]
    fn compile_from_source(
        source: &str,
        base_dir: Option<&Path>,
    ) -> Result<(Self, Frontmatter), TemplateError> {
        Self::compile_inner(source, base_dir, false, &[])
    }

    /// Core compilation: parse frontmatter → compile body → static analysis → build `Template`.
    ///
    /// When `force_allow_unused` is `true` the unused-params check is skipped
    /// regardless of the frontmatter setting.
    #[cfg(feature = "std")]
    fn compile_inner(
        source: &str,
        base_dir: Option<&Path>,
        force_allow_unused: bool,
        env_values: &[(&str, Value)],
    ) -> Result<(Self, Frontmatter), TemplateError> {
        let source_hash = crate::cache::hash_source(source);
        let (fm, body) = if let Some(dir) = base_dir {
            frontmatter::parse_frontmatter_with_base_dir(source, dir, env_values)?
        } else {
            frontmatter::parse_frontmatter_with_env(source, env_values)?
        };
        let body = body.to_string();
        let (segments, inline_templates) = compiled::compile(&body, &fm.type_aliases)?;

        // --- Static analysis ---
        run_static_analysis(&segments, &fm, &inline_templates, force_allow_unused)?;

        let has_defaults = fm.declarations.iter().any(|d| d.default_value.is_some());
        let mut consts: HashMap<String, Value> = fm
            .consts
            .iter()
            .filter_map(|d| d.default_value.clone().map(|v| (d.name.clone(), v)))
            .collect();
        // Inject resolved env values as constants.
        for d in &fm.env {
            if let Some(ref v) = d.default_value {
                consts.entry(d.name.clone()).or_insert_with(|| v.clone());
            }
        }
        // Inject enum type aliases as namespace constants (e.g. Stage.Design).
        inject_enum_type_constants(&fm.type_aliases, &mut consts);
        let segments: Arc<[Segment]> = Arc::from(segments);
        let estimated_capacity = compiled::render::estimate_output_capacity(&segments);
        let env_values: alloc::sync::Arc<[(String, Value)]> = env_values
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let declared_names = build_declared_names(&fm.declarations, &consts);
        let tmpl = Self {
            body,
            name: fm.name.clone(),
            description: fm.description.clone(),
            segments,
            declared_variables: Arc::from(fm.declarations.clone()),
            base_dir: base_dir.map(Path::to_path_buf),
            inline_templates: Arc::new(inline_templates),
            source_hash,
            max_include_depth: crate::scope::MAX_INCLUDE_DEPTH,
            has_defaults,
            consts: Arc::new(consts),
            imported_consts: Arc::new(fm.imported_consts.clone()),
            estimated_capacity,
            env_values,
            declared_names,
            checked_type_ids: std::sync::Mutex::new(Vec::new()),
        };
        Ok((tmpl, fm))
    }

    /// `no_std` compilation entry point (no base directory, no imports).
    #[cfg(not(feature = "std"))]
    fn compile_from_source_no_std(source: &str) -> Result<(Self, Frontmatter), TemplateError> {
        Self::compile_inner_no_std(source, false, &[])
    }

    /// `no_std` core compilation.
    #[cfg(not(feature = "std"))]
    fn compile_inner_no_std(
        source: &str,
        force_allow_unused: bool,
        env_values: &[(&str, Value)],
    ) -> Result<(Self, Frontmatter), TemplateError> {
        let source_hash = hash_source_no_std(source);
        let (fm, body) = frontmatter::parse_frontmatter_with_env(source, env_values)?;
        let body = body.to_string();
        let (segments, inline_templates) = compiled::compile(&body, &fm.type_aliases)?;

        run_static_analysis(&segments, &fm, &inline_templates, force_allow_unused)?;

        let has_defaults = fm.declarations.iter().any(|d| d.default_value.is_some());
        let mut consts: HashMap<String, Value> = fm
            .consts
            .iter()
            .filter_map(|d| d.default_value.clone().map(|v| (d.name.clone(), v)))
            .collect();
        // Inject resolved env values as constants.
        for d in &fm.env {
            if let Some(ref v) = d.default_value {
                consts.entry(d.name.clone()).or_insert_with(|| v.clone());
            }
        }
        // Inject enum type aliases as namespace constants (e.g. Stage.Design).
        inject_enum_type_constants(&fm.type_aliases, &mut consts);
        let segments: Arc<[Segment]> = Arc::from(segments);
        let estimated_capacity = compiled::render::estimate_output_capacity(&segments);
        let declared_names = build_declared_names(&fm.declarations, &consts);
        let tmpl = Self {
            body,
            name: fm.name.clone(),
            description: fm.description.clone(),
            segments,
            declared_variables: Arc::from(fm.declarations.clone()),
            inline_templates: Arc::new(inline_templates),
            source_hash,
            max_include_depth: crate::scope::MAX_INCLUDE_DEPTH,
            has_defaults,
            consts: Arc::new(consts),
            imported_consts: Arc::new(fm.imported_consts.clone()),
            estimated_capacity,
            declared_names,
        };
        Ok((tmpl, fm))
    }

    /// Construct a `Template` from pre-compiled segments (used by [`TemplateCache`]).
    ///
    /// Skips parsing and compilation entirely — the caller is responsible for
    /// providing correct, pre-compiled data.
    ///
    /// [`TemplateCache`]: crate::TemplateCache
    #[cfg(feature = "std")]
    pub(crate) fn from_cached(data: CachedTemplateData) -> Self {
        let has_defaults = data
            .declared_variables
            .iter()
            .any(|d| d.default_value.is_some());
        let estimated_capacity = compiled::render::estimate_output_capacity(&data.segments);
        let declared_names = build_declared_names(&data.declared_variables, &data.consts);
        Self {
            body: String::new(),
            name: data.name,
            description: data.description,
            segments: data.segments,
            declared_variables: data.declared_variables,
            base_dir: data.base_dir,
            inline_templates: data.inline_templates,
            source_hash: data.source_hash,
            max_include_depth: crate::scope::MAX_INCLUDE_DEPTH,
            has_defaults,
            consts: data.consts,
            imported_consts: data.imported_consts,
            estimated_capacity,
            env_values: alloc::sync::Arc::from([]),
            declared_names,
            checked_type_ids: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Construct a `Template` from pre-compiled static structures (used by compile-time macros).
    #[doc(hidden)]
    #[must_use]
    pub fn from_precompiled(data: &PrecompiledTemplateData<'_>) -> Self {
        let inline_map = data
            .inline_templates
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let const_map = data
            .consts
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let imported_const_map = data
            .imported_consts
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let has_defaults = data
            .declared_variables
            .iter()
            .any(|d| d.default_value.is_some());
        let segments: Arc<[Segment]> = Arc::from(data.segments);
        let estimated_capacity = compiled::render::estimate_output_capacity(&segments);
        let declared_names = build_declared_names(data.declared_variables, &const_map);
        Self {
            body: String::new(),
            name: data.name.map(String::from),
            description: data.description.map(String::from),
            segments,
            declared_variables: Arc::from(data.declared_variables),
            #[cfg(feature = "std")]
            base_dir: None,
            inline_templates: Arc::new(inline_map),
            source_hash: data.source_hash,
            max_include_depth: crate::scope::MAX_INCLUDE_DEPTH,
            has_defaults,
            consts: Arc::new(const_map),
            imported_consts: Arc::new(imported_const_map),
            estimated_capacity,
            #[cfg(feature = "std")]
            env_values: alloc::sync::Arc::from([]),
            declared_names,
            #[cfg(feature = "std")]
            checked_type_ids: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Validate context: check presence, types, AND no extra variables.
    ///
    /// By default the engine is strict: passing undeclared parameters is
    /// an error. Set `allow_extra` to `true` to suppress the extra-params
    /// check (useful when forwarding a shared context to multiple templates).
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::MissingParams`] if any declared variable
    /// is absent, [`TemplateError::TypeMismatch`] if a value has the
    /// wrong type, or [`TemplateError::ExtraParams`] if undeclared keys
    /// are present (and `allow_extra` is false).
    fn validate_context(&self, ctx: &Context, allow_extra: bool) -> Result<(), TemplateError> {
        let mut missing = Vec::new();
        let mut mismatch: Option<(String, crate::types::TypeCheckError)> = None;
        for decl in self.declared_variables.iter() {
            match ctx.get(&decl.name) {
                None => {
                    // Skip params with defaults — they'll be injected.
                    if decl.default_value.is_none() {
                        missing.push(decl.name.as_str());
                    }
                }
                Some(value) => {
                    if mismatch.is_none()
                        && let Err(e) = decl.var_type.check(value)
                    {
                        mismatch = Some((decl.name.clone(), e));
                    }
                }
            }
        }
        // Report missing params first (most fundamental).
        if !missing.is_empty() {
            return Err(TemplateError::MissingParams(
                missing.into_iter().map(String::from).collect(),
            ));
        }
        if let Some((name, check_err)) = mismatch {
            let detail = if check_err.path.is_empty() {
                String::new()
            } else {
                format!(" (at .{})", check_err.path)
            };
            return Err(TemplateError::TypeMismatch {
                name: format!("{name}{detail}"),
                expected: check_err.expected,
                actual: check_err.actual,
                actual_value: check_err.actual_value,
            });
        }
        // Reject extra (undeclared) parameters unless explicitly allowed.
        if !allow_extra
            && ctx
                .values
                .keys()
                .any(|k| !self.declared_names.contains(k.as_str()))
        {
            let extra: Vec<String> = ctx
                .values
                .keys()
                .filter(|k| !self.declared_names.contains(k.as_str()))
                .cloned()
                .collect();
            return Err(TemplateError::ExtraParams(extra));
        }
        Ok(())
    }

    /// Returns default values for all params that have them.
    #[must_use]
    pub fn defaults(&self) -> HashMap<String, crate::value::Value> {
        self.declared_variables
            .iter()
            .filter_map(|d| {
                d.default_value
                    .as_ref()
                    .map(|v| (d.name.clone(), v.clone()))
            })
            .collect()
    }

    /// Returns the default value for a single parameter, if it has one.
    #[must_use]
    pub fn default(&self, name: &str) -> Option<&crate::value::Value> {
        self.declared_variables
            .iter()
            .find(|d| d.name == name)
            .and_then(|d| d.default_value.as_ref())
    }

    /// Returns a [`Context`] pre-filled with all default values.
    ///
    /// Use this as a starting point, then override only the params you need:
    /// ```
    /// # use md_tmpl_core::{Template, Context};
    /// let tmpl = Template::from_source(
    ///     r#"---
    /// params:
    ///   - name = str
    ///   - count = int := 5
    /// ---
    /// {{ name }} ({{ count }})"#,
    /// )
    /// .unwrap();
    /// let mut ctx = tmpl.defaults_context();
    /// ctx.set("name", "Alice"); // count already has default 5
    /// assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "Alice (5)");
    /// ```
    #[must_use]
    pub fn defaults_context(&self) -> Context {
        let defaults = self.defaults();
        let mut ctx = Context::with_capacity(defaults.len());
        for (k, v) in defaults {
            ctx.set(k, v);
        }
        ctx
    }

    /// Return the raw template body text (after frontmatter stripping).
    ///
    /// Useful for compile-time validation and macro integration.
    #[must_use]
    pub fn body(&self) -> &str {
        &self.body
    }

    /// Returns the template's name, if defined in frontmatter.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// Returns the template's description, if defined in frontmatter.
    #[must_use]
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    /// Set the maximum include depth for rendering this template.
    pub fn set_max_include_depth(&mut self, depth: usize) {
        self.max_include_depth = depth;
    }

    /// Set the maximum include depth for rendering this template (builder style).
    #[must_use]
    pub fn with_max_include_depth(mut self, depth: usize) -> Self {
        self.max_include_depth = depth;
        self
    }

    /// Return the declared variables from frontmatter.
    ///
    /// Used by generated param structs to validate that a reloaded template
    /// still matches the compile-time variable declarations.
    #[must_use]
    pub fn declarations(&self) -> &[VarDecl] {
        &self.declared_variables
    }

    pub(crate) fn segments(&self) -> &[crate::compiled::Segment] {
        &self.segments
    }

    /// Returns the base directory used for resolving filesystem `{% include %}` paths.
    #[cfg(feature = "std")]
    #[must_use]
    pub fn base_dir(&self) -> Option<&Path> {
        self.base_dir.as_deref()
    }

    /// Returns the constants defined in this template's frontmatter.
    ///
    /// Constants are defined with `consts:` in frontmatter and are automatically
    /// available during rendering without being passed in the context.
    ///
    /// # Examples
    ///
    /// ```
    /// use md_tmpl_core::Template;
    ///
    /// let tmpl = Template::from_source(
    ///     r#"---
    /// consts:
    ///   - MAX = int := 100
    ///
    /// params: []
    /// ---
    /// {{ MAX }}"#,
    /// )
    /// .unwrap();
    /// let consts = tmpl.consts();
    /// assert_eq!(consts.get("MAX").unwrap().as_int(), Some(100));
    /// ```
    #[must_use]
    pub fn consts(&self) -> Arc<HashMap<String, Value>> {
        self.consts.clone()
    }

    /// Returns a borrowed reference to the constants defined in this
    /// template's frontmatter, avoiding the [`Arc`] clone of [`consts`](Self::consts).
    #[must_use]
    pub fn consts_ref(&self) -> &HashMap<String, Value> {
        &self.consts
    }

    /// Returns the imported constants (from `{% import %}` directives).
    ///
    /// These are constants imported from other template files and are
    /// automatically available during rendering alongside regular constants.
    #[must_use]
    pub fn imported_consts(&self) -> Arc<HashMap<String, Value>> {
        self.imported_consts.clone()
    }

    /// Returns a borrowed reference to the imported constants, avoiding
    /// the [`Arc`] clone of [`imported_consts`](Self::imported_consts).
    #[must_use]
    pub fn imported_consts_ref(&self) -> &HashMap<String, Value> {
        &self.imported_consts
    }

    pub(crate) fn inline_templates(&self) -> &HashMap<String, CompiledInlineTemplate> {
        &self.inline_templates
    }

    /// Content hash of the raw source — use to detect unchanged files on
    /// hot-reload without re-parsing.
    ///
    /// Same source → same hash.  Different source → (very likely) different
    /// hash.  This is a fast non-cryptographic hash, not suitable for
    /// security purposes.
    #[must_use]
    pub fn source_hash(&self) -> u64 {
        self.source_hash
    }

    /// Validate that a (possibly reloaded) template's variable declarations
    /// match an expected set.
    ///
    /// Call this after re-loading a template from disk to ensure that
    /// nobody (e.g. an autonomous agent editing markdown files at runtime)
    /// has modified the `params:` block in the frontmatter.
    ///
    /// The template body may be changed freely — only the variable
    /// declarations must remain stable.
    ///
    /// # Errors
    ///
    /// Returns [`TemplateError::DeclarationsMutated`] with a human-readable
    /// diff if the declarations don't match.
    pub fn validate_declarations(&self, expected: &[VarDecl]) -> Result<(), TemplateError> {
        let current: HashMap<&str, &crate::types::VarType> = self
            .declared_variables
            .iter()
            .map(|d| (d.name.as_str(), &d.var_type))
            .collect();
        let expected_map: HashMap<&str, &crate::types::VarType> = expected
            .iter()
            .map(|d| (d.name.as_str(), &d.var_type))
            .collect();

        let current_names: HashSet<&str> = current.keys().copied().collect();
        let expected_names: HashSet<&str> = expected_map.keys().copied().collect();

        let missing: Vec<&str> = expected_names.difference(&current_names).copied().collect();
        let extra: Vec<&str> = current_names.difference(&expected_names).copied().collect();

        // Check for type changes on variables that exist in both.
        let retyped: Vec<String> = current_names
            .intersection(&expected_names)
            .filter_map(|name| {
                let cur_type = current[name];
                let exp_type = expected_map[name];
                if cur_type == exp_type {
                    None
                } else {
                    Some(format!("{name}: {exp_type} → {cur_type}"))
                }
            })
            .collect();

        if missing.is_empty() && extra.is_empty() && retyped.is_empty() {
            return Ok(());
        }

        let mut parts = Vec::new();
        if !missing.is_empty() {
            parts.push(format!("removed: {}", missing.join(", ")));
        }
        if !extra.is_empty() {
            parts.push(format!("added: {}", extra.join(", ")));
        }
        if !retyped.is_empty() {
            parts.push(format!("retyped: {}", retyped.join(", ")));
        }

        Err(TemplateError::DeclarationsMutated {
            details: parts.join("; "),
        })
    }
}

// ---------------------------------------------------------------------------
// Trait impls for embedding Template in macro-generated structs
// ---------------------------------------------------------------------------

/// Two templates are considered equal if they were compiled from the same
/// source (compared via non-cryptographic 64-bit hash).
///
/// **Note:** This is an approximate comparison — different sources that
/// produce the same hash would incorrectly compare as equal.  Do not use
/// `Template` as a `HashMap` key or rely on `Eq` for deduplication in
/// security-sensitive contexts.  For exact source comparison, compare
/// [`body()`](Self::body) and [`declarations()`](Self::declarations).
impl PartialEq for Template {
    fn eq(&self, other: &Self) -> bool {
        self.source_hash == other.source_hash
    }
}

impl Eq for Template {}

/// Serialize a [`Template`] as a source-hash identifier.
///
/// Templates embedded in macro-generated parameter structs need `Serialize`
/// to satisfy derive bounds, even when the struct is never actually
/// serialized.  The hash lets debug/logging code produce something readable.
#[cfg(feature = "serde")]
impl serde::Serialize for Template {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("template:{:016x}", self.source_hash))
    }
}

/// Deserialize always fails — [`Template`] must be constructed from source.
///
/// This impl exists solely to satisfy derive bounds on macro-generated
/// parameter structs.  Actual deserialization of a compiled template is not
/// meaningful.
#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for Template {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // NOLINT: serde's IgnoredAny pattern — the value is intentionally discarded to consume input
        let _ = <serde::de::IgnoredAny as serde::Deserialize>::deserialize(deserializer)?;
        Err(serde::de::Error::custom(
            "Template cannot be deserialized; construct from source with \
             Template::from_source() or Template::from_file()",
        ))
    }
}

fn run_static_analysis(
    segments: &[Segment],
    fm: &Frontmatter,
    inline_templates: &HashMap<String, compiled::CompiledInlineTemplate>,
    force_allow_unused: bool,
) -> Result<(), TemplateError> {
    let referenced = compiled::collect_referenced_params(segments);
    let case_labels = compiled::collect_unquoted_case_labels(segments);
    check_undeclared_variables(&referenced, fm, inline_templates)?;
    check_unused_params(
        &fm.declarations,
        &referenced,
        &case_labels,
        force_allow_unused || fm.allow_unused,
    )?;
    check_name_collisions(fm, inline_templates, segments)?;
    let enum_keys = collect_enum_type_keys(fm);
    check_bare_enum_access(segments, &enum_keys)?;
    check_static_enum_in_conditions(segments, &fm.type_aliases)?;
    check_internal_key_access(segments)?;
    let label_errors =
        compiled::validate_match_labels(segments, &fm.declarations, &fm.type_aliases);
    if !label_errors.is_empty() {
        return Err(TemplateError::Syntax(label_errors.join("; ").into()));
    }
    Ok(())
}

/// Load a named template from a directory.
///
/// Looks for `<name>.tmpl.md` in `dir`.
///
/// # Errors
///
/// Returns [`TemplateError::Io`] if the file is not found or cannot be read.
#[cfg(feature = "std")]
pub fn load_template(dir: &Path, name: &str) -> Result<Template, TemplateError> {
    let path = dir.join(format!("{name}.tmpl.md"));
    Template::from_file(&path)
}

#[cfg(all(test, feature = "std"))]
mod adversarial_tests;
#[cfg(all(test, feature = "std"))]
mod collision_and_scope_tests;
#[cfg(all(test, feature = "std"))]
mod const_tests;
#[cfg(all(test, feature = "std"))]
mod error_diagnostic_tests;
#[cfg(all(test, feature = "std"))]
mod higher_order_tests;
#[cfg(all(test, feature = "std"))]
mod inline_edge_tests;
#[cfg(all(test, feature = "std"))]
mod render_integration_tests;
#[cfg(all(test, feature = "std"))]
mod shared_tests;
#[cfg(all(test, feature = "std"))]
mod tests;

#[cfg(all(test, feature = "std"))]
mod doc_example_tests;
