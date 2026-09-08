//! Dynamic Python type generation from template frontmatter declarations.
//!
//! Reads [`VarDecl`] / [`VarType`] / [`VariantDecl`] from a parsed template
//! and generates Python classes at runtime using the strongly-typed
//! [`PyClassDef`](crate::pyclass_builder::PyClassDef) builder.

use std::fmt::Write;

use md_tmpl::{VarDecl, VarType, VariantDecl, to_pascal_case};
use pyo3::{Py, prelude::*, types::PyDict};

use crate::pyclass_builder::{ClassAttr, Field, PyClassDef, PyMethodDef};

/// Generate Python type classes for a template file.
///
/// Returns a dict mapping class names to their generated Python classes.
/// Called from the Python-side import hook and `template()` helper.
#[pyfunction]
pub(crate) fn generate_types_for_template(py: Python<'_>, path: &str) -> PyResult<Py<PyAny>> {
    let tmpl = crate::template::load_template(path)?;
    let decls = tmpl.inner().declarations();
    let result = PyDict::new(py);

    // Derive a base name from the file stem.
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Template");
    let base_name = stem.strip_suffix(".tmpl").unwrap_or(stem);
    let params_class_name = to_pascal_case(base_name);

    // Generate nested types first, then the top-level params class.
    let mut generated_types: Vec<(String, Py<PyAny>)> = Vec::new();
    for decl in decls {
        generate_types_for_decl(py, &params_class_name, decl, &mut generated_types)?;
    }

    // Generate types for explicit type aliases from the `types:` block.
    generate_types_for_aliases(py, &tmpl, &mut generated_types)?;

    // Build the params class — pass generated types so they're in scope for
    // type annotations (e.g. `outcome: Outcome`) in the __init__ signature.
    let params_cls = build_params_class(py, &params_class_name, decls, path, &generated_types)?;
    result.set_item(&params_class_name, &params_cls)?;

    for (name, cls) in &generated_types {
        result.set_item(name, cls)?;
    }

    Ok(result.into_any().unbind())
}

/// Recursively generate Python types for a single declaration.
fn generate_types_for_decl(
    py: Python<'_>,
    parent_name: &str,
    decl: &VarDecl,
    out: &mut Vec<(String, Py<PyAny>)>,
) -> PyResult<()> {
    match &decl.var_type {
        VarType::Enum(variants) => {
            let enum_name = to_pascal_case(&decl.name);
            let cls = build_enum_class(py, &enum_name, variants)?;
            out.push((enum_name, cls));
        }
        VarType::List(fields) if !fields.is_empty() => {
            let item_name = format!("{parent_name}{}Item", to_pascal_case(&decl.name));
            let cls = build_model_class(py, &item_name, fields)?;
            out.push((item_name.clone(), cls));
            for field in fields {
                generate_types_for_decl(py, &item_name, field, out)?;
            }
        }
        VarType::Struct(fields) if !fields.is_empty() => {
            let dict_name = to_pascal_case(&decl.name);
            let cls = build_model_class(py, &dict_name, fields)?;
            out.push((dict_name.clone(), cls));
            for field in fields {
                generate_types_for_decl(py, &dict_name, field, out)?;
            }
        }
        // Scalar types and empty compound types need no Python class generation.
        VarType::Str
        | VarType::Bool
        | VarType::Int
        | VarType::Float
        | VarType::Tmpl(_)
        | VarType::List(_)
        | VarType::Struct(_) => {}
        // Option<T>: generate types for the inner type.
        VarType::Option(inner) => {
            let inner_decl = VarDecl {
                name: decl.name.clone(),
                var_type: (**inner).clone(),
                default_value: None,
            };
            generate_types_for_decl(py, parent_name, &inner_decl, out)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Enum class generation
// ---------------------------------------------------------------------------

/// Build a Python enum class from variant declarations.
///
/// Unit variants become sentinel attributes on a shared `_Variant` inner class.
/// Struct variants become **distinct nested classes** with `__match_args__`
/// for Python 3.10+ pattern matching.
fn build_enum_class(py: Python<'_>, name: &str, variants: &[VariantDecl]) -> PyResult<Py<PyAny>> {
    let has_unit_variants = variants.iter().any(|v| v.fields.is_empty());

    // Build docstring.
    let mut doc = String::from("Enum type generated from template frontmatter.\n\n    Variants:\n");
    for var in variants {
        if var.fields.is_empty() {
            writeln!(
                doc,
                "        {vn}: Unit variant (use as ``{name}.{vn}``).",
                vn = var.name
            )
            .expect("write to String");
        } else {
            let fields: Vec<String> = var
                .fields
                .iter()
                .map(|f| format!("{}={}", f.name, f.var_type))
                .collect();
            writeln!(
                doc,
                "        {}({}): Struct variant.",
                var.name,
                fields.join(", ")
            )
            .expect("write to String");
        }
    }

    let mut cls = PyClassDef::build(name).doc(doc);

    // _Variant inner class for unit sentinels (only if needed).
    if has_unit_variants {
        let tag_field = Field::new("tag", "str");
        let unit_sentinel = PyClassDef::build("_Variant")
            .doc("A unit variant sentinel. Compared by tag value.")
            .slots(vec![
                Field::new("_md_tmpl_tag", "str"),
                Field::new("_md_tmpl_fields", "dict"),
            ])
            .method(
                PyMethodDef::builder()
                    .name("__init__")
                    .params(vec![tag_field])
                    .body(vec![
                        "self._md_tmpl_tag = tag".into(),
                        "self._md_tmpl_fields = {}".into(),
                    ])
                    .build(),
            )
            .method(
                PyMethodDef::builder()
                    .name("__repr__")
                    .return_annotation("str")
                    .body(vec!["return self._md_tmpl_tag".into()])
                    .build(),
            )
            .method(
                PyMethodDef::builder()
                    .name("__eq__")
                    .params(vec![Field::new("other", "")])
                    .return_annotation("bool")
                    .body(vec![
                        "if not isinstance(other, type(self)):".into(),
                        "    return NotImplemented".into(),
                        "return self._md_tmpl_tag == other._md_tmpl_tag".into(),
                    ])
                    .build(),
            )
            .method(
                PyMethodDef::builder()
                    .name("__hash__")
                    .return_annotation("int")
                    .body(vec!["return hash(self._md_tmpl_tag)".into()])
                    .build(),
            );

        cls = cls.inner_class(unit_sentinel);
    }

    // Generate each variant as either a sentinel attribute or a nested class.
    for var in variants {
        if var.fields.is_empty() {
            cls = cls.attr(ClassAttr::new(
                &var.name,
                format!("_Variant('{}')", var.name),
            ));
        } else {
            let struct_cls = build_struct_variant_def(&var.name, &var.fields);
            cls = cls.inner_class(struct_cls);
        }
    }

    cls.exec(py)
}

/// Build a [`PyClassDef`] for a struct variant with `__match_args__`.
fn build_struct_variant_def(name: &str, fields: &[VarDecl]) -> PyClassDef {
    let typed_fields: Vec<Field> = fields
        .iter()
        .map(|f| {
            Field::new(
                &f.name,
                vartype_to_python_annotation(&f.var_type, name, &f.name),
            )
        })
        .collect();

    let field_sig = typed_fields
        .iter()
        .map(|f| format!("{}: {}", f.name, f.annotation))
        .collect::<Vec<_>>()
        .join(", ");

    PyClassDef::build(name)
        .doc(format!("Struct variant: {name}({field_sig})."))
        .match_args(typed_fields.clone())
        .slots(typed_fields.clone())
        .attr(ClassAttr::new("_md_tmpl_tag", format!("'{name}'")))
        .with_init(&typed_fields)
        .with_fields_property(&typed_fields)
        .with_repr(name, &typed_fields)
        .with_eq(&typed_fields)
        .with_hash(name, &typed_fields)
}

// ---------------------------------------------------------------------------
// Model class generation
// ---------------------------------------------------------------------------

/// Build a Python model class (like a dataclass) from field declarations.
fn build_model_class(py: Python<'_>, name: &str, fields: &[VarDecl]) -> PyResult<Py<PyAny>> {
    let typed_fields: Vec<Field> = fields
        .iter()
        .map(|f| {
            Field::new(
                &f.name,
                vartype_to_python_annotation(&f.var_type, name, &f.name),
            )
        })
        .collect();

    let mut doc = String::from("Model type generated from template frontmatter.\n\n    Fields:\n");
    for f in &typed_fields {
        writeln!(doc, "        {}: {}", f.name, f.annotation).expect("write to String");
    }

    PyClassDef::build(name)
        .doc(doc)
        .slots(typed_fields.clone())
        .with_init(&typed_fields)
        .with_repr(name, &typed_fields)
        .with_eq(&typed_fields)
        .with_dict_property(&typed_fields)
        .exec(py)
}

// ---------------------------------------------------------------------------
// Params class generation
// ---------------------------------------------------------------------------

/// Build the top-level params class with a `render()` method.
fn build_params_class(
    py: Python<'_>,
    name: &str,
    decls: &[VarDecl],
    template_path: &str,
    generated_types: &[(String, Py<PyAny>)],
) -> PyResult<Py<PyAny>> {
    let typed_fields: Vec<Field> = decls
        .iter()
        .map(|d| {
            Field::new(
                &d.name,
                vartype_to_python_annotation(&d.var_type, name, &d.name),
            )
        })
        .collect();

    let mut doc = format!("Typed parameters for template '{template_path}'.\n\n    Parameters:\n");
    for f in &typed_fields {
        writeln!(doc, "        {}: {}", f.name, f.annotation).expect("write to String");
    }

    // Build render() method body.
    let kwarg_items: Vec<String> = decls
        .iter()
        .map(|d| format!("'{n}': self.{n}", n = d.name))
        .collect();
    let render_body = vec![
        "from md_tmpl._md_tmpl import Template as _NativeTemplate".into(),
        "if template is None:".into(),
        format!("    template = _NativeTemplate.from_file('{template_path}')"),
        format!("_kwargs = {{{}}}", kwarg_items.join(", ")),
        "return template.render_dict(_kwargs)".into(),
    ];

    // Build init body with default handling.
    let init_body: Vec<String> = decls
        .iter()
        .map(|d| format!("self.{n} = {n}", n = d.name))
        .collect();

    // Custom init with optional defaults.
    let init_params: Vec<Field> = decls
        .iter()
        .map(|d| {
            let annotation = vartype_to_python_annotation(&d.var_type, name, &d.name);
            Field::new(&d.name, annotation)
        })
        .collect();

    // __repr__
    let repr_parts: Vec<String> = decls
        .iter()
        .map(|d| format!("{}={{self.{}!r}}", d.name, d.name))
        .collect();

    let cls = PyClassDef::build(name)
        .doc(doc)
        .attr(ClassAttr::new(
            "_template_path",
            format!("'{template_path}'"),
        ))
        .slots(typed_fields.clone())
        .method(
            PyMethodDef::builder()
                .name("__init__")
                .params(init_params)
                .body(init_body)
                .build(),
        )
        .method(
            PyMethodDef::builder()
                .name("__repr__")
                .return_annotation("str")
                .body(vec![format!("return f'{name}({})'", repr_parts.join(", "))])
                .build(),
        )
        .method(
            PyMethodDef::builder()
                .name("render")
                .params(vec![Field::new("template", "")])
                .return_annotation("str")
                .doc("Render this params object into a template.")
                .body(render_body)
                .build(),
        )
        .with_dict_property(&typed_fields);

    cls.exec_with_locals(py, Some(generated_types))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a `VarType` to a Python type annotation string.
///
/// For compound types (struct, list, enum), the annotation references the
/// actual generated class name derived from `parent_name` and `field_name`.
fn vartype_to_python_annotation(vt: &VarType, parent_name: &str, field_name: &str) -> String {
    match vt {
        VarType::Str => "str".into(),
        VarType::Bool => "bool".into(),
        VarType::Int => "int".into(),
        VarType::Float => "float".into(),
        VarType::List(fields) if fields.is_empty() => "list".into(),
        VarType::List(_) => format!("list[{}{}Item]", parent_name, to_pascal_case(field_name)),
        VarType::Struct(fields) if fields.is_empty() => "dict".into(),
        VarType::Struct(_) | VarType::Enum(_) => to_pascal_case(field_name),
        VarType::Tmpl(_) => "object".into(),
        VarType::Option(inner) => {
            let inner_ann = vartype_to_python_annotation(inner, parent_name, field_name);
            format!("Optional[{inner_ann}]")
        }
    }
}

/// Generate Python types for explicit `types:` block aliases.
///
/// For each type alias that maps to a compound type (enum, list, dict),
/// generate a corresponding Python class if one hasn't already been
/// generated by the param-based type generation.
fn generate_types_for_aliases(
    py: Python<'_>,
    tmpl: &crate::template::PyTemplate,
    out: &mut Vec<(String, Py<PyAny>)>,
) -> PyResult<()> {
    let existing_names: std::collections::HashSet<String> =
        out.iter().map(|(name, _)| name.clone()).collect();
    for (alias_name, var_type) in tmpl.type_aliases() {
        let class_name = to_pascal_case(alias_name);
        if existing_names.contains(&class_name) {
            continue; // Already generated by param-based codegen.
        }
        let synthetic_decl = VarDecl {
            name: alias_name.clone(),
            var_type: var_type.clone(),
            default_value: None,
        };
        generate_types_for_decl(py, "", &synthetic_decl, out)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Source code generation (for static type checkers)
// ---------------------------------------------------------------------------

/// Generate Python source code with typed classes for a template file.
///
/// Returns source code that can be written to a `.py` file for mypy/pyright.
/// Uses `@dataclass` for model classes and `Variants` subclasses for enums.
///
/// The generated params class has a typed `render()` method, so type checkers
/// catch missing or mistyped arguments at analysis time.
#[pyfunction]
pub(crate) fn generate_python_source_for_template(path: &str) -> PyResult<String> {
    let tmpl = crate::template::load_template(path)?;
    let decls = tmpl.inner().declarations();

    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Template");
    let base_name = stem.strip_suffix(".tmpl").unwrap_or(stem);
    let params_class_name = to_pascal_case(base_name);

    // Check what imports we need.
    let needs_optional = decls_need_optional(decls);
    let needs_field = decls_need_field(decls);

    let mut out = String::new();
    writeln!(out, "\"\"\"Auto-generated typed stubs for {path}.").expect("write to String");
    writeln!(out).expect("write to String");
    writeln!(
        out,
        "Do not edit — regenerate with ``generate_types_source()``."
    )
    .expect("write to String");
    writeln!(out, "\"\"\"").expect("write to String");
    writeln!(out, "from __future__ import annotations").expect("write to String");
    writeln!(out).expect("write to String");

    // Build import line for dataclasses.
    if needs_field {
        writeln!(out, "from dataclasses import dataclass, field").expect("write to String");
    } else {
        writeln!(out, "from dataclasses import dataclass").expect("write to String");
    }

    // Build typing imports.
    let mut typing_imports = vec!["Any"];
    if needs_optional {
        typing_imports.push("Optional");
    }
    writeln!(out, "from typing import {}", typing_imports.join(", ")).expect("write to String");
    writeln!(out).expect("write to String");
    writeln!(out, "from md_tmpl import Template, Variants").expect("write to String");
    writeln!(out).expect("write to String");

    // Collect nested type definitions first.
    let mut nested_defs: Vec<GeneratedTypeDef> = Vec::new();
    let mut enum_aliases: Vec<(Vec<VariantDecl>, String)> = Vec::new();

    for (alias_name, var_type) in tmpl.type_aliases() {
        if let VarType::Enum(variants) = var_type {
            enum_aliases.push((variants.clone(), to_pascal_case(alias_name)));
        }
    }

    for decl in decls {
        source_gen_types_for_decl(
            &params_class_name,
            decl,
            &mut nested_defs,
            &mut enum_aliases,
        );
    }

    // Generate types for explicit type aliases from the `types:` block.
    let existing_names: std::collections::HashSet<String> =
        nested_defs.iter().map(|d| d.class_name.clone()).collect();

    for (alias_name, var_type) in tmpl.type_aliases() {
        if matches!(var_type, VarType::List(_)) {
            continue;
        }
        let class_name = to_pascal_case(alias_name);
        if existing_names.contains(&class_name) {
            continue;
        }
        let synthetic_decl = VarDecl {
            name: alias_name.clone(),
            var_type: var_type.clone(),
            default_value: None,
        };
        source_gen_types_for_decl("", &synthetic_decl, &mut nested_defs, &mut enum_aliases);
    }

    deduplicate_nested_defs(&mut nested_defs);

    // Write nested types before the params class (forward reference order).
    for def in &nested_defs {
        writeln!(out, "{}", def.source).expect("write to String");
    }

    // Write the params class.
    source_gen_params_class(&mut out, &params_class_name, decls, path, &enum_aliases);

    // Write __all__.
    // Also export nested type names.
    let nested_names: Vec<String> = nested_defs.iter().map(|d| d.class_name.clone()).collect();
    let mut all_names: Vec<String> = vec![params_class_name.clone()];
    all_names.extend(nested_names);

    writeln!(out).expect("write to String");
    let quoted: Vec<String> = all_names.iter().map(|n| format!("\"{n}\"")).collect();
    writeln!(out, "__all__ = [{}]", quoted.join(", ")).expect("write to String");

    Ok(out)
}

struct GeneratedTypeDef {
    class_name: String,
    source: String,
}

/// Recursively generate Python source definitions for a single declaration.
fn source_gen_types_for_decl(
    parent_name: &str,
    decl: &VarDecl,
    out: &mut Vec<GeneratedTypeDef>,
    enum_aliases: &mut Vec<(Vec<VariantDecl>, String)>,
) {
    match &decl.var_type {
        VarType::Enum(variants) => {
            let enum_name =
                if let Some((_, existing)) = enum_aliases.iter().find(|(v, _)| v == variants) {
                    existing.clone()
                } else {
                    let name = to_pascal_case(&decl.name);
                    enum_aliases.push((variants.clone(), name.clone()));
                    name
                };
            out.push(GeneratedTypeDef {
                class_name: enum_name.clone(),
                source: source_gen_enum_class(&enum_name, variants, enum_aliases),
            });
        }
        VarType::List(fields) if !fields.is_empty() => {
            let item_name = format!("{parent_name}{}Item", to_pascal_case(&decl.name));
            // Recurse for nested types within list items first.
            for field in fields {
                source_gen_types_for_decl(&item_name, field, out, enum_aliases);
            }
            out.push(GeneratedTypeDef {
                class_name: item_name.clone(),
                source: source_gen_model_class(&item_name, fields, enum_aliases),
            });
        }
        VarType::Struct(fields) if !fields.is_empty() => {
            let struct_name = to_pascal_case(&decl.name);
            for field in fields {
                source_gen_types_for_decl(&struct_name, field, out, enum_aliases);
            }
            out.push(GeneratedTypeDef {
                class_name: struct_name.clone(),
                source: source_gen_model_class(&struct_name, fields, enum_aliases),
            });
        }
        VarType::Option(inner) => {
            let inner_decl = VarDecl {
                name: decl.name.clone(),
                var_type: (**inner).clone(),
                default_value: None,
            };
            source_gen_types_for_decl(parent_name, &inner_decl, out, enum_aliases);
        }
        _ => {}
    }
}

/// Generate Python source for a `Variants` enum subclass.
fn source_gen_enum_class(
    name: &str,
    variants: &[VariantDecl],
    enum_aliases: &[(Vec<VariantDecl>, String)],
) -> String {
    let mut s = String::new();
    writeln!(s, "class {name}(Variants):").expect("write to String");
    if variants.is_empty() {
        writeln!(s, "    pass").expect("write to String");
        return s;
    }
    for var in variants {
        if var.fields.is_empty() {
            writeln!(s, "    {} = ()", var.name).expect("write to String");
        } else {
            let fields: Vec<String> = var
                .fields
                .iter()
                .map(|f| {
                    format!(
                        "\"{}\": {}",
                        f.name,
                        vartype_to_python_source_annotation(
                            &f.var_type,
                            name,
                            &f.name,
                            enum_aliases
                        )
                    )
                })
                .collect();
            writeln!(s, "    {} = {{{}}}", var.name, fields.join(", ")).expect("write to String");
        }
    }
    s
}

/// Generate Python source for a `@dataclass` model class.
fn source_gen_model_class(
    name: &str,
    fields: &[VarDecl],
    enum_aliases: &[(Vec<VariantDecl>, String)],
) -> String {
    let mut s = String::new();
    writeln!(s, "@dataclass").expect("write to String");
    writeln!(s, "class {name}:").expect("write to String");
    if fields.is_empty() {
        writeln!(s, "    pass").expect("write to String");
        return s;
    }
    for f in fields {
        writeln!(
            s,
            "    {}: {}",
            f.name,
            vartype_to_python_source_annotation(&f.var_type, name, &f.name, enum_aliases)
        )
        .expect("write to String");
    }
    s
}

/// Generate the params `@dataclass` with a typed `render()` method.
fn source_gen_params_class(
    out: &mut String,
    name: &str,
    decls: &[VarDecl],
    template_path: &str,
    enum_aliases: &[(Vec<VariantDecl>, String)],
) {
    writeln!(out, "@dataclass").expect("write to String");
    writeln!(out, "class {name}:").expect("write to String");
    writeln!(
        out,
        "    \"\"\"Typed parameters for template ``{template_path}``.\"\"\""
    )
    .expect("write to String");

    if decls.is_empty() {
        writeln!(out).expect("write to String");
        // Still need render() even with no params.
        source_gen_render_method(out, template_path);
        return;
    }

    writeln!(out).expect("write to String");

    // Fields without defaults first, then fields with defaults (dataclass rule).
    let (required, optional): (Vec<&VarDecl>, Vec<&VarDecl>) =
        decls.iter().partition(|d| d.default_value.is_none());

    for d in &required {
        writeln!(
            out,
            "    {}: {}",
            d.name,
            vartype_to_python_source_annotation(&d.var_type, name, &d.name, enum_aliases)
        )
        .expect("write to String");
    }

    for d in &optional {
        let ann = vartype_to_python_source_annotation(&d.var_type, name, &d.name, enum_aliases);
        let Some(default_val) = d.default_value.as_ref() else {
            continue;
        };
        let default_repr = default_to_python_repr(default_val);
        writeln!(
            out,
            "    {}: {} = field(default={})",
            d.name, ann, default_repr
        )
        .expect("write to String");
    }

    writeln!(out).expect("write to String");
    source_gen_render_method(out, template_path);
}

/// Emit the `render()` method for the params dataclass.
fn source_gen_render_method(out: &mut String, template_path: &str) {
    writeln!(
        out,
        "    def render(self, template: Template | None = None) -> str:"
    )
    .expect("write to String");
    writeln!(
        out,
        "        \"\"\"Render this params object into its template.\"\"\""
    )
    .expect("write to String");
    writeln!(out, "        if template is None:").expect("write to String");
    writeln!(
        out,
        "            template = Template.from_file(\"{template_path}\")"
    )
    .expect("write to String");
    writeln!(out, "        import dataclasses").expect("write to String");
    writeln!(
        out,
        "        return template.render_dict(dataclasses.asdict(self))"
    )
    .expect("write to String");
}

/// Check if any declaration uses `Option<T>`.
fn decls_need_optional(decls: &[VarDecl]) -> bool {
    decls
        .iter()
        .any(|d| matches!(&d.var_type, VarType::Option(_)))
}

/// Check if any declaration has a default value (needs `field(default=...)`).
fn decls_need_field(decls: &[VarDecl]) -> bool {
    decls.iter().any(|d| d.default_value.is_some())
}

/// Convert a default [`Value`] to its Python literal repr string.
fn default_to_python_repr(val: &md_tmpl::Value) -> String {
    use md_tmpl::Value;
    match val {
        Value::Str(s) => format!("{s:?}"),
        Value::Int(i) => i.to_string(),
        Value::Float(f) => {
            let s = f.to_string();
            if s.contains('.') { s } else { format!("{s}.0") }
        }
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::List(items) => {
            if items.is_empty() {
                "[]".into()
            } else {
                let elems: Vec<String> = items.iter().map(default_to_python_repr).collect();
                format!("[{}]", elems.join(", "))
            }
        }
        Value::Struct(map) => {
            if map.is_empty() {
                "{}".into()
            } else {
                let entries: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("{k:?}: {}", default_to_python_repr(v)))
                    .collect();
                format!("{{{}}}", entries.join(", "))
            }
        }
        // None and Tmpl can't be represented as Python literals.
        Value::None | Value::Tmpl(_) => "None".into(),
    }
}

fn deduplicate_nested_defs(nested_defs: &mut Vec<GeneratedTypeDef>) {
    let mut seen_classes = std::collections::HashSet::new();
    nested_defs.retain(|def| seen_classes.insert(def.class_name.clone()));
}

/// Python annotation for source-code generation (reuses `enum_aliases` when present).
fn vartype_to_python_source_annotation(
    vt: &VarType,
    parent_name: &str,
    field_name: &str,
    enum_aliases: &[(Vec<VariantDecl>, String)],
) -> String {
    match vt {
        VarType::Enum(variants) => match enum_aliases.iter().find(|(v, _)| v == variants) {
            Some((_, alias_name)) => alias_name.clone(),
            None => to_pascal_case(field_name),
        },
        VarType::Option(inner) => format!(
            "{} | None",
            vartype_to_python_source_annotation(inner, parent_name, field_name, enum_aliases)
        ),
        _ => vartype_to_python_annotation(vt, parent_name, field_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascal_case_via_core_crate() {
        assert_eq!(to_pascal_case("code_review"), "CodeReview");
        assert_eq!(to_pascal_case("simple_greeting"), "SimpleGreeting");
        assert_eq!(to_pascal_case("task-report"), "TaskReport");
        assert_eq!(to_pascal_case("single"), "Single");
        assert_eq!(to_pascal_case(""), "");
        assert_eq!(to_pascal_case("already_PascalCase"), "AlreadyPascalCase");
    }

    #[test]
    fn vartype_annotations() {
        // Scalar types ignore parent/field context.
        assert_eq!(
            vartype_to_python_annotation(&VarType::Str, "Parent", "field"),
            "str"
        );
        assert_eq!(
            vartype_to_python_annotation(&VarType::Int, "Parent", "field"),
            "int"
        );
        assert_eq!(
            vartype_to_python_annotation(&VarType::Float, "Parent", "field"),
            "float"
        );
        assert_eq!(
            vartype_to_python_annotation(&VarType::Bool, "Parent", "field"),
            "bool"
        );

        // Empty compound types.
        assert_eq!(
            vartype_to_python_annotation(&VarType::List(vec![]), "Parent", "items"),
            "list"
        );
        assert_eq!(
            vartype_to_python_annotation(&VarType::Struct(vec![]), "Parent", "config"),
            "dict"
        );

        // Non-empty list → list[ParentItemsItem].
        assert_eq!(
            vartype_to_python_annotation(
                &VarType::List(vec![VarDecl {
                    name: "x".into(),
                    var_type: VarType::Str,
                    default_value: None,
                }]),
                "Params",
                "items"
            ),
            "list[ParamsItemsItem]"
        );

        // Non-empty struct → PascalCase(field_name).
        assert_eq!(
            vartype_to_python_annotation(
                &VarType::Struct(vec![VarDecl {
                    name: "x".into(),
                    var_type: VarType::Str,
                    default_value: None,
                }]),
                "Params",
                "config"
            ),
            "Config"
        );

        // Enum → PascalCase(field_name).
        assert_eq!(
            vartype_to_python_annotation(&VarType::Enum(vec![]), "Params", "status"),
            "Status"
        );

        // Tmpl stays opaque.
        assert_eq!(
            vartype_to_python_annotation(&VarType::Tmpl(vec![]), "Params", "body"),
            "object"
        );
    }

    #[test]
    fn source_gen_enum() {
        let source = source_gen_enum_class(
            "Status",
            &[
                VariantDecl {
                    name: "Approved".into(),
                    fields: vec![],
                },
                VariantDecl {
                    name: "Rejected".into(),
                    fields: vec![],
                },
                VariantDecl {
                    name: "NeedsChanges".into(),
                    fields: vec![VarDecl {
                        name: "reason".into(),
                        var_type: VarType::Str,
                        default_value: None,
                    }],
                },
            ],
            &[],
        );
        assert!(source.contains("class Status(Variants):"));
        assert!(source.contains("Approved = ()"));
        assert!(source.contains("Rejected = ()"));
        assert!(source.contains("NeedsChanges = {\"reason\": str}"));
    }

    #[test]
    fn source_gen_model() {
        let source = source_gen_model_class(
            "ReviewItem",
            &[
                VarDecl {
                    name: "name".into(),
                    var_type: VarType::Str,
                    default_value: None,
                },
                VarDecl {
                    name: "score".into(),
                    var_type: VarType::Int,
                    default_value: None,
                },
            ],
            &[],
        );
        assert!(source.contains("@dataclass"));
        assert!(source.contains("class ReviewItem:"));
        assert!(source.contains("    name: str"));
        assert!(source.contains("    score: int"));
    }

    #[test]
    fn source_gen_params() {
        let mut out = String::new();
        source_gen_params_class(
            &mut out,
            "ReviewParams",
            &[
                VarDecl {
                    name: "reviewer".into(),
                    var_type: VarType::Str,
                    default_value: None,
                },
                VarDecl {
                    name: "score".into(),
                    var_type: VarType::Float,
                    default_value: None,
                },
            ],
            "prompts/review.tmpl.md",
            &[],
        );
        assert!(out.contains("@dataclass"));
        assert!(out.contains("class ReviewParams:"));
        assert!(out.contains("    reviewer: str"));
        assert!(out.contains("    score: float"));
    }

    #[test]
    fn source_gen_params_has_render_method() {
        let mut out = String::new();
        source_gen_params_class(
            &mut out,
            "Greeting",
            &[VarDecl {
                name: "name".into(),
                var_type: VarType::Str,
                default_value: None,
            }],
            "prompts/greeting.tmpl.md",
            &[],
        );
        assert!(
            out.contains("def render(self, template: Template | None = None) -> str:"),
            "missing render method, got: {out}"
        );
        assert!(
            out.contains("Template.from_file("),
            "render should load from file, got: {out}"
        );
        assert!(
            out.contains("render_dict(dataclasses.asdict(self))"),
            "render should use render_dict, got: {out}"
        );
    }

    #[test]
    fn source_gen_params_empty_still_has_render() {
        let mut out = String::new();
        source_gen_params_class(&mut out, "Empty", &[], "empty.tmpl.md", &[]);
        assert!(
            out.contains("def render(self"),
            "empty params class should still have render(), got: {out}"
        );
    }

    #[test]
    fn source_gen_params_with_defaults() {
        let mut out = String::new();
        source_gen_params_class(
            &mut out,
            "Greeting",
            &[
                VarDecl {
                    name: "name".into(),
                    var_type: VarType::Str,
                    default_value: Some(md_tmpl::Value::Str("World".into())),
                },
                VarDecl {
                    name: "count".into(),
                    var_type: VarType::Int,
                    default_value: Some(md_tmpl::Value::Int(1)),
                },
            ],
            "greeting.tmpl.md",
            &[],
        );
        assert!(
            out.contains("name: str = field(default=\"World\")"),
            "missing default for name, got: {out}"
        );
        assert!(
            out.contains("count: int = field(default=1)"),
            "missing default for count, got: {out}"
        );
    }

    #[test]
    fn source_gen_params_required_before_optional() {
        let mut out = String::new();
        source_gen_params_class(
            &mut out,
            "Mixed",
            &[
                VarDecl {
                    name: "optional_first".into(),
                    var_type: VarType::Str,
                    default_value: Some(md_tmpl::Value::Str("default".into())),
                },
                VarDecl {
                    name: "required".into(),
                    var_type: VarType::Str,
                    default_value: None,
                },
            ],
            "mixed.tmpl.md",
            &[],
        );
        // Required fields must come before optional in the output.
        let req_pos = out.find("required: str").expect("should have required");
        let opt_pos = out
            .find("optional_first: str = field")
            .expect("should have optional");
        assert!(
            req_pos < opt_pos,
            "required field must come before optional, got: {out}"
        );
    }

    #[test]
    fn source_gen_option_type_annotation() {
        assert_eq!(
            vartype_to_python_annotation(
                &VarType::Option(Box::new(VarType::Str)),
                "Parent",
                "name"
            ),
            "Optional[str]"
        );
        assert_eq!(
            vartype_to_python_annotation(
                &VarType::Option(Box::new(VarType::Int)),
                "Parent",
                "count"
            ),
            "Optional[int]"
        );
    }

    #[test]
    fn decls_need_optional_detects_option() {
        assert!(decls_need_optional(&[VarDecl {
            name: "x".into(),
            var_type: VarType::Option(Box::new(VarType::Str)),
            default_value: None,
        }]));
        assert!(!decls_need_optional(&[VarDecl {
            name: "x".into(),
            var_type: VarType::Str,
            default_value: None,
        }]));
    }

    #[test]
    fn decls_need_field_detects_defaults() {
        assert!(decls_need_field(&[VarDecl {
            name: "x".into(),
            var_type: VarType::Str,
            default_value: Some(md_tmpl::Value::Str("hi".into())),
        }]));
        assert!(!decls_need_field(&[VarDecl {
            name: "x".into(),
            var_type: VarType::Str,
            default_value: None,
        }]));
    }

    #[test]
    fn default_to_python_repr_scalars() {
        use md_tmpl::Value;
        assert_eq!(
            default_to_python_repr(&Value::Str("hello".into())),
            "\"hello\""
        );
        assert_eq!(default_to_python_repr(&Value::Int(42)), "42");
        assert_eq!(default_to_python_repr(&Value::Float(2.72)), "2.72");
        assert_eq!(default_to_python_repr(&Value::Bool(true)), "True");
        assert_eq!(default_to_python_repr(&Value::Bool(false)), "False");
        assert_eq!(default_to_python_repr(&Value::None), "None");
    }

    #[test]
    fn default_to_python_repr_collections() {
        use std::sync::Arc;

        use md_tmpl::Value;

        assert_eq!(
            default_to_python_repr(&Value::List(Arc::new(vec![Value::Int(1), Value::Int(2),]))),
            "[1, 2]"
        );
        assert_eq!(default_to_python_repr(&Value::List(Arc::new(vec![]))), "[]");
    }
}
