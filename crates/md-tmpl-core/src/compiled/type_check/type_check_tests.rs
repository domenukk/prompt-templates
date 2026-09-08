use super::*;
use crate::{
    compiled::{CompiledInclude, CompiledInlineTemplate, Segment},
    scope::{CompiledExpr, CompiledPath},
    types::{VarDecl, VarType, VariantDecl},
};

/// Helper: build declarations from a shorthand.
fn enum_decl(name: &str, variants: Vec<VariantDecl>) -> VarDecl {
    VarDecl {
        name: name.to_string(),
        var_type: VarType::Enum(variants),
        default_value: None,
    }
}

fn variant(name: &str, fields: Vec<(&str, VarType)>) -> VariantDecl {
    VariantDecl {
        name: name.to_string(),
        fields: fields
            .into_iter()
            .map(|(n, t)| VarDecl {
                name: n.to_string(),
                var_type: t,
                default_value: None,
            })
            .collect(),
    }
}

fn unit_variant(name: &str) -> VariantDecl {
    variant(name, vec![])
}

fn compile_and_check(template: &str, decls: &[VarDecl]) -> Vec<String> {
    let (_fm, body) = crate::parse_frontmatter(template).expect("parse");
    let empty_aliases = crate::compat::HashMap::new();
    let (segments, _) = crate::compiled::compile(body, &empty_aliases).expect("compile");
    validate_field_accesses(&segments, decls)
}

// -- Variant name validation -----------------------------------------

#[test]
fn match_valid_variant_names() {
    let decls = vec![enum_decl(
        "outcome",
        vec![unit_variant("Confirmed"), unit_variant("NotConfirmed")],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed, NotConfirmed)
---
> {% match outcome %}{% case Confirmed %}yes{% case NotConfirmed %}no{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "unexpected errors: {errors:?}");
}

#[test]
fn match_unknown_variant_name() {
    let decls = vec![enum_decl(
        "outcome",
        vec![unit_variant("Confirmed"), unit_variant("NotConfirmed")],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed, NotConfirmed)
---
> {% match outcome %}{% case Confrimed %}yes{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected 1 error, got: {errors:?}");
    assert!(
        errors[0].contains("unknown variant 'Confrimed'"),
        "got: {}",
        errors[0]
    );
    assert!(
        errors[0].contains("Confirmed, NotConfirmed"),
        "should list valid variants: {}",
        errors[0]
    );
}

// -- Field access outside match (must be on ALL variants) ------------

#[test]
fn field_on_all_variants_ok() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("reason", VarType::Str)]),
            variant("Rejected", vec![("reason", VarType::Str)]),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(reason = str), Rejected(reason = str))
---
{{ outcome.reason }}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "unexpected: {errors:?}");
}

#[test]
fn field_not_on_all_variants_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
{{ outcome.evidence }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected 1 error, got: {errors:?}");
    assert!(
        errors[0].contains("not available on variant") && errors[0].contains("NotConfirmed"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn tag_field_is_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
{{ outcome.tag }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, ".tag should be an error: {errors:?}");
    assert!(
        errors[0].contains("tag") && errors[0].contains("does not exist"),
        "got: {}",
        errors[0]
    );
}

// -- Field access inside match arm (narrowed) ------------------------

#[test]
fn field_in_matching_arm_ok() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
> {% match outcome %}{% case Confirmed %}{{ outcome.evidence }}{% case NotConfirmed %}none{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "narrowed access should work: {errors:?}");
}

#[test]
fn field_in_wrong_arm_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
> {% match outcome %}{% case NotConfirmed %}{{ outcome.evidence }}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("evidence") && errors[0].contains("NotConfirmed"),
        "got: {}",
        errors[0]
    );
}

// -- Multi-variant case: intersection of fields ----------------------

#[test]
fn multi_variant_shared_field_ok() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant(
                "Confirmed",
                vec![("reason", VarType::Str), ("evidence", VarType::Str)],
            ),
            variant("ConfirmedWithCaveats", vec![("reason", VarType::Str)]),
            unit_variant("Rejected"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(reason = str, evidence = str), ConfirmedWithCaveats(reason = str), Rejected)
---
> {% match outcome %}{% case Confirmed | ConfirmedWithCaveats %}{{ outcome.reason }}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "shared field 'reason' should work: {errors:?}"
    );
}

#[test]
fn multi_variant_non_shared_field_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant(
                "Confirmed",
                vec![("reason", VarType::Str), ("evidence", VarType::Str)],
            ),
            variant("ConfirmedWithCaveats", vec![("reason", VarType::Str)]),
            unit_variant("Rejected"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(reason = str, evidence = str), ConfirmedWithCaveats(reason = str), Rejected)
---
> {% match outcome %}{% case Confirmed | ConfirmedWithCaveats %}{{ outcome.evidence }}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("evidence") && errors[0].contains("ConfirmedWithCaveats"),
        "got: {}",
        errors[0]
    );
}

// -- Inline match case -----------------------------------------------

#[test]
fn inline_match_case_field_ok() {
    let decls = vec![enum_decl(
        "vt",
        vec![
            variant("Known", vec![("label", VarType::Str)]),
            unit_variant("Unknown"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - vt = enum(Known(label = str), Unknown)
---
> {% match vt case Known %}{{ vt.label }}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "inline narrowing: {errors:?}");
}

// -- Nested match ----------------------------------------------------

#[test]
fn nested_match_narrows_independently() {
    let decls = vec![
        enum_decl(
            "a",
            vec![
                variant("X", vec![("x_val", VarType::Str)]),
                unit_variant("Y"),
            ],
        ),
        enum_decl(
            "b",
            vec![
                variant("P", vec![("p_val", VarType::Str)]),
                unit_variant("Q"),
            ],
        ),
    ];
    let tmpl = r"---
name: t
params:
  - a = enum(X(x_val = str), Y)
  - b = enum(P(p_val = str), Q)
---
> {% match a %}{% case X %}> {% match b %}{% case P %}{{ a.x_val }} {{ b.p_val }}{% /match %}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "nested narrowing: {errors:?}");
}

// -- Match on non-enum rejects at compile time ----------------------

#[test]
fn match_on_str_compiles_ok() {
    let decls = vec![VarDecl {
        name: "status".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl = r#"---
name: t
params:
  - status = str
---
> {% match status %}{% case "Active" %}active{% /match %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "expected no errors: {errors:?}");
}

#[test]
fn match_on_int_compiles_ok() {
    let decls = vec![VarDecl {
        name: "count".to_string(),
        var_type: VarType::Int,
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - count = int
---
> {% match count %}{% case 0 %}zero{% case 1 %}one{% else %}many{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "match on int should compile: {errors:?}");
}

#[test]
fn match_on_bool_compiles_ok() {
    let decls = vec![VarDecl {
        name: "flag".to_string(),
        var_type: VarType::Bool,
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - flag = bool
---
> {% match flag %}{% case true %}yes{% case false %}no{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "match on bool should compile: {errors:?}"
    );
}

// -- Condition paths inside if inside match --------------------------

#[test]
fn condition_inside_match_arm_validated() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r#"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
> {% match outcome %}{% case Confirmed %}{% if outcome.evidence == "secret" %}yes{% /if %}{% /match %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "condition in arm: {errors:?}");
}

// -- Enum comparison rejection ----------------------------------------

#[test]
fn eq_on_unit_enum_is_compile_error() {
    let decls = vec![enum_decl(
        "role",
        vec![
            unit_variant("Builder"),
            unit_variant("Analyst"),
            unit_variant("Chainer"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - role = enum(Builder, Analyst, Chainer)
---
> {% if role == Builder %}yes{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot compare enum") && errors[0].contains("match"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn eq_on_struct_enum_is_compile_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("Rejected"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), Rejected)
---
> {% if outcome == Confirmed %}yes{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot compare enum"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn ne_on_enum_is_compile_error() {
    let decls = vec![enum_decl(
        "status",
        vec![unit_variant("Active"), unit_variant("Inactive")],
    )];
    let tmpl = r"---
name: t
params:
  - status = enum(Active, Inactive)
---
> {% if status != Active %}no{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot compare enum"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn eq_enum_string_literal_is_compile_error() {
    // Even comparing an enum to a string literal should be rejected.
    let decls = vec![enum_decl(
        "role",
        vec![unit_variant("Builder"), unit_variant("Analyst")],
    )];
    let tmpl = r#"---
name: t
params:
  - role = enum(Builder, Analyst)
---
> {% if role == "Builder" %}yes{% /if %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot compare enum") && errors[0].contains("match"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn elif_on_enum_is_compile_error() {
    // Full if/elif chain on an enum should be rejected.
    let decls = vec![enum_decl(
        "role",
        vec![
            unit_variant("Builder"),
            unit_variant("Analyst"),
            unit_variant("Support"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - role = enum(Builder, Analyst, Support)
---
> {% if role == Builder %}b{% elif role == Analyst %}a{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 2, "expected 2 errors (if + elif): {errors:?}");
    assert!(
        errors.iter().all(|e| e.contains("cannot compare enum")),
        "got: {errors:?}",
    );
}

// -- Field doesn't exist on any variant ------------------------------

#[test]
fn field_nonexistent_on_all_variants() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("A", vec![("x", VarType::Str)]),
            variant("B", vec![("y", VarType::Str)]),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(A(x = str), B(y = str))
---
> {% match outcome %}{% case A %}{{ outcome.z }}{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1);
    assert!(
        errors[0].contains("'z'") && errors[0].contains("does not exist"),
        "got: {}",
        errors[0]
    );
}

// -- Loop binding type tracking --------------------------------------

#[test]
fn for_loop_binding_typed_from_list() {
    let decls = vec![VarDecl {
        name: "tasks".to_string(),
        var_type: VarType::List(vec![
            VarDecl {
                name: "title".to_string(),
                var_type: VarType::Str,
                default_value: None,
            },
            VarDecl {
                name: "vt".to_string(),
                var_type: VarType::Enum(vec![
                    variant("Known", vec![("label", VarType::Str)]),
                    unit_variant("Unknown"),
                ]),
                default_value: None,
            },
        ]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - tasks = list(title = str, vt = enum(Known(label = str), Unknown))
---
> {% for task in tasks %}{% match task.vt case Known %}{{ task.vt.label }}{% /match %}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "loop binding should be typed: {errors:?}"
    );
}

#[test]
fn for_loop_binding_field_access_validated() {
    let decls = vec![VarDecl {
        name: "tasks".to_string(),
        var_type: VarType::List(vec![
            VarDecl {
                name: "title".to_string(),
                var_type: VarType::Str,
                default_value: None,
            },
            VarDecl {
                name: "vt".to_string(),
                var_type: VarType::Enum(vec![
                    variant("Known", vec![("label", VarType::Str)]),
                    unit_variant("Unknown"),
                ]),
                default_value: None,
            },
        ]),
        default_value: None,
    }];
    // Access .label outside match — should fail since Unknown has no label.
    let tmpl = r"---
name: t
params:
  - tasks = list(title = str, vt = enum(Known(label = str), Unknown))
---
> {% for task in tasks %}{{ task.vt.label }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("label") && errors[0].contains("Unknown"),
        "got: {}",
        errors[0]
    );
}

// -- Loop over opaque imported constant --------------------------------

#[test]
fn for_loop_over_opaque_import_binding_is_opaque() {
    // Iterating an imported constant (an opaque root whose element type is
    // not statically known) must not flag `row.field` accesses in the body
    // as undeclared variables. Regression test for loops over
    // `<import>.CONST` such as `artist.SEVERITY_LADDER`.
    let tmpl = r"---
name: t
params:
---
> {% for row in cfg.LADDER %}

{{ row.short }}: {{ row.name }}

> {% /for %}";
    let (_fm, body) = crate::parse_frontmatter(tmpl).expect("parse");
    let empty_aliases = crate::compat::HashMap::new();
    let (segments, _) = crate::compiled::compile(body, &empty_aliases).expect("compile");
    let mut opaque = crate::compat::HashSet::new();
    opaque.insert("cfg".to_string());
    let errors = validate_field_accesses_with_opaque(&segments, &[], &opaque);
    assert!(
        errors.is_empty(),
        "loop over opaque import should type-check: {errors:?}"
    );
}

#[test]
fn for_loop_over_undeclared_non_opaque_still_errors() {
    // Guard: the opacity relaxation is scoped to opaque roots only. A loop
    // over a genuinely undeclared (non-opaque) iterable must still surface an
    // undeclared-variable error.
    let tmpl = r"---
name: t
params:
---
> {% for row in ghost %}

{{ row.short }}

> {% /for %}";
    let (_fm, body) = crate::parse_frontmatter(tmpl).expect("parse");
    let empty_aliases = crate::compat::HashMap::new();
    let (segments, _) = crate::compiled::compile(body, &empty_aliases).expect("compile");
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "undeclared iterable should still error: {errors:?}"
    );
}

#[test]
fn undeclared_variable_in_match_is_error() {
    let decls = vec![];
    let tmpl = r"---
name: t
params:
---
> {% match ghost %}{% case X %}x{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "expected undeclared error: {errors:?}"
    );
}

#[test]
fn undeclared_variable_in_expr_is_error() {
    let decls = vec![];
    let tmpl = r"---
name: t
params:
---
{{ ghost.field }}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "expected undeclared error: {errors:?}"
    );
}

// -- Exhaustiveness --------------------------------------------------

#[test]
fn multi_arm_match_exhaustive_ok() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("NotConfirmed"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), NotConfirmed)
---
> {% match outcome %}{% case Confirmed %}yes{% case NotConfirmed %}no{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "exhaustive match: {errors:?}");
}

#[test]
fn multi_arm_match_non_exhaustive_error() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("A", vec![("x", VarType::Str)]),
            unit_variant("B"),
            unit_variant("C"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(A(x = str), B, C)
---
> {% match outcome %}{% case A %}a{% case B %}b{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected exhaustiveness error: {errors:?}");
    assert!(
        errors[0].contains("non-exhaustive") && errors[0].contains('C'),
        "got: {}",
        errors[0]
    );
}

#[test]
fn single_arm_inline_not_exhaustive_ok() {
    let decls = vec![enum_decl(
        "outcome",
        vec![unit_variant("A"), unit_variant("B")],
    )];
    // Single inline arm — intentionally non-exhaustive guard.
    let tmpl = r"---
name: t
params:
  - outcome = enum(A, B)
---
> {% match outcome case A %}a{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "inline guard: {errors:?}");
}

#[test]
fn match_with_no_arms_is_error() {
    // Construct directly since the parser might not produce this.
    let decls = vec![enum_decl("x", vec![unit_variant("A"), unit_variant("B")])];
    let segments = vec![Segment::Match {
        expr: CompiledPath::compile("x"),
        arms: vec![],
        is_option: false,
    }];
    let errors = validate_field_accesses(&segments, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(errors[0].contains("no case arms"), "got: {}", errors[0]);
}

// -- Else arm (catch-all) -----------------------------------------

#[test]
fn else_arm_satisfies_exhaustiveness() {
    let decls = vec![enum_decl(
        "outcome",
        vec![
            variant("Confirmed", vec![("evidence", VarType::Str)]),
            unit_variant("Rejected"),
            unit_variant("Pending"),
        ],
    )];
    let tmpl = r"---
name: t
params:
  - outcome = enum(Confirmed(evidence = str), Rejected, Pending)
---
> {% match outcome %}{% case Confirmed %}yes{% else %}other{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "else should satisfy exhaustiveness: {errors:?}"
    );
}

#[test]
fn else_alone_satisfies_exhaustiveness() {
    let decls = vec![enum_decl(
        "status",
        vec![unit_variant("A"), unit_variant("B"), unit_variant("C")],
    )];
    let tmpl = r"---
name: t
params:
  - status = enum(A, B, C)
---
> {% match status %}{% else %}fallback{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "else-only should be valid: {errors:?}");
}

#[test]
fn else_arm_renders_correctly() {
    let tmpl = crate::Template::from_source(
        r"---
params:
  - status = enum(A, B, C)
---
> {% match status %}{% case A %}alpha{% else %}other{% /match %}",
    )
    .unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("status", "B");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "other");
    ctx.set("status", "A");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "alpha");
}

// -- For-loop on non-list --------------------------------------------

#[test]
fn for_loop_on_str_is_error() {
    let decls = vec![VarDecl {
        name: "name".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - name = str
---
> {% for c in name %}{{ c }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("expected list") && e.contains("str")),
        "expected for-loop type error: {errors:?}"
    );
}

#[test]
fn for_loop_on_enum_suggests_kinds() {
    let decls = vec![VarDecl {
        name: "Stage".to_string(),
        var_type: VarType::Enum(vec![unit_variant("A"), unit_variant("B")]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - Stage = enum(A, B)
---
> {% for s in Stage %}{{ s }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("use kinds(Stage) to iterate over variant names")),
        "expected kinds suggestion for enum loop: {errors:?}"
    );
}

#[test]
fn for_loop_over_kinds_ok() {
    let decls = vec![VarDecl {
        name: "Stage".to_string(),
        var_type: VarType::Enum(vec![unit_variant("A"), unit_variant("B")]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - Stage = enum(A, B)
---
> {% for s in kinds(Stage) %}{{ s }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "for loop over kinds(Stage) should pass type checking: {errors:?}"
    );
}

// -- Scalar field access ---------------------------------------------

#[test]
fn field_on_str_is_error() {
    let decls = vec![VarDecl {
        name: "name".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - name = str
---
{{ name.length }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot access field") && errors[0].contains("str"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn field_on_int_is_error() {
    let decls = vec![VarDecl {
        name: "count".to_string(),
        var_type: VarType::Int,
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - count = int
---
{{ count.abs }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot access field") && errors[0].contains("int"),
        "got: {}",
        errors[0]
    );
}

// -- Struct field validation -------------------------------------------

#[test]
fn dict_unknown_field_is_error() {
    let decls = vec![VarDecl {
        name: "config".to_string(),
        var_type: VarType::Struct(vec![VarDecl {
            name: "host".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - config = struct(host = str)
---
{{ config.port }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("port") && errors[0].contains("does not exist"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn dict_known_field_ok() {
    let decls = vec![VarDecl {
        name: "config".to_string(),
        var_type: VarType::Struct(vec![VarDecl {
            name: "host".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - config = struct(host = str)
---
{{ config.host }}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(errors.is_empty(), "declared field: {errors:?}");
}

// -- Include contract tests ------------------------------------------

fn make_include(
    path: &str,
    with_vars: Vec<(&str, &str)>,
    for_each: Option<(&str, &str)>,
    declarations: Vec<VarDecl>,
    segments: Vec<Segment>,
) -> CompiledInclude {
    use std::sync::Arc;
    CompiledInclude {
        path: std::borrow::Cow::Owned(path.to_string()),
        with_vars: with_vars
            .into_iter()
            .map(|(k, v)| {
                (
                    std::borrow::Cow::Owned(k.to_string()),
                    std::borrow::Cow::Owned(v.to_string()),
                )
            })
            .collect(),
        for_each: for_each.map(|(b, l)| {
            (
                std::borrow::Cow::Owned(b.to_string()),
                std::borrow::Cow::Owned(l.to_string()),
            )
        }),
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::from(segments),
            declarations: Arc::from(declarations),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    }
}

fn str_decl(name: &str) -> VarDecl {
    VarDecl {
        name: name.to_string(),
        var_type: VarType::Str,
        default_value: None,
    }
}

fn int_decl(name: &str) -> VarDecl {
    VarDecl {
        name: name.to_string(),
        var_type: VarType::Int,
        default_value: None,
    }
}

fn bool_decl(name: &str) -> VarDecl {
    VarDecl {
        name: name.to_string(),
        var_type: VarType::Bool,
        default_value: None,
    }
}

#[test]
fn include_missing_required_params_error() {
    let inc = make_include(
        "child.tmpl.md",
        vec![],
        None,
        vec![str_decl("msg"), int_decl("count")],
        vec![],
    );
    let parent_decls: Vec<VarDecl> = vec![];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.iter().any(|e| e.contains("missing required param")),
        "expected missing params error: {errors:?}"
    );
    assert!(
        errors
            .iter()
            .any(|e| e.contains("msg") && e.contains("count")),
        "should mention both missing params: {errors:?}"
    );
}

#[test]
fn include_all_params_provided_ok() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("msg", "my_msg"), ("count", "my_count")],
        None,
        vec![str_decl("msg"), int_decl("count")],
        vec![],
    );
    let parent_decls = vec![str_decl("my_msg"), int_decl("my_count")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "all params provided should be OK: {errors:?}"
    );
}

#[test]
fn include_for_binding_counts_as_provided() {
    let inc = make_include(
        "row.tmpl.md",
        vec![],
        Some(("item", "items")),
        vec![str_decl("item")],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "items".to_string(),
        var_type: VarType::List(vec![]),
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "for binding should satisfy param: {errors:?}"
    );
}

#[test]
fn include_no_declarations_always_ok() {
    let inc = make_include("static.tmpl.md", vec![], None, vec![], vec![]);
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.is_empty(),
        "no declarations should always be OK: {errors:?}"
    );
}

// -- Include type-check tests ----------------------------------------

#[test]
fn include_type_match_str_ok() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("name", "parent_name")],
        None,
        vec![str_decl("name")],
        vec![],
    );
    let parent_decls = vec![str_decl("parent_name")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(errors.is_empty(), "matching types should be OK: {errors:?}");
}

#[test]
fn include_type_mismatch_error() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("count", "name")],
        None,
        vec![int_decl("count")],
        vec![],
    );
    let parent_decls = vec![str_decl("name")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.iter().any(|e| e.contains("type mismatch")),
        "should report type mismatch: {errors:?}"
    );
}

#[test]
fn include_dotted_path_type_resolution() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("label", "config.host")],
        None,
        vec![str_decl("label")],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "config".to_string(),
        var_type: VarType::Struct(vec![str_decl("host")]),
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "dotted path type should resolve: {errors:?}"
    );
}

#[test]
fn include_dotted_path_type_mismatch() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("count", "config.host")],
        None,
        vec![int_decl("count")], // expects int
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "config".to_string(),
        var_type: VarType::Struct(vec![str_decl("host")]), // host is str
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.iter().any(|e| e.contains("type mismatch")),
        "dotted path type mismatch: {errors:?}"
    );
}

#[test]
fn include_literal_value_skips_type_check() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("msg", "\"hello\"")],
        None,
        vec![str_decl("msg")],
        vec![],
    );
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.is_empty(),
        "literals should skip type check: {errors:?}"
    );
}

#[test]
fn include_enum_type_forwarding() {
    let enum_variants = vec![
        variant("Active", vec![("label", VarType::Str)]),
        unit_variant("Stopped"),
    ];
    let enum_type = VarType::Enum(enum_variants.clone());
    let inc = make_include(
        "child.tmpl.md",
        vec![("status", "status")],
        None,
        vec![VarDecl {
            name: "status".to_string(),
            var_type: enum_type.clone(),
            default_value: None,
        }],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "status".to_string(),
        var_type: enum_type,
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "enum forwarding should be OK: {errors:?}"
    );
}

// -- Include body validation tests ------------------------------------

#[test]
fn include_body_undeclared_var_error() {
    let inc = make_include(
        "child.tmpl.md",
        vec![],
        None,
        vec![], // no declarations in child
        vec![Segment::Expr {
            expr: CompiledExpr::compile("ghost").unwrap(),
            filters: vec![],
        }],
    );
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "should catch undeclared var in included body: {errors:?}"
    );
}

#[test]
fn include_body_field_on_scalar_error() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("name", "parent_name")],
        None,
        vec![str_decl("name")],
        vec![Segment::Expr {
            expr: CompiledExpr::compile("name.length").unwrap(),
            filters: vec![],
        }],
    );
    let parent_decls = vec![str_decl("parent_name")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("cannot access field") && e.contains("str")),
        "should catch field access on scalar in included body: {errors:?}"
    );
}

#[test]
fn include_body_valid_references_ok() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("msg", "parent_msg")],
        None,
        vec![str_decl("msg")],
        vec![Segment::Expr {
            expr: CompiledExpr::compile("msg").unwrap(),
            filters: vec![],
        }],
    );
    let parent_decls = vec![str_decl("parent_msg")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "valid references in body should be OK: {errors:?}"
    );
}

// -- Cycle detection tests -------------------------------------------

#[test]
fn self_recursive_include_no_infinite_loop() {
    // A template that includes itself — should not infinite loop.
    // Boundary is checked, body is walked once.
    let inc = make_include(
        "self.tmpl.md",
        vec![],
        None,
        vec![],
        // Body includes itself again (with the same path).
        vec![Segment::Include(CompiledInclude {
            path: "self.tmpl.md".into(),
            with_vars: vec![],
            for_each: None,
            inline_compiled: Some(CompiledInlineTemplate {
                segments: std::sync::Arc::from(vec![Segment::Static("leaf".into())]),
                declarations: std::sync::Arc::from(vec![]),
                consts: std::sync::Arc::new(crate::compat::HashMap::new()),
                imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            }),
        })],
    );
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &[]);
    // Should complete without hanging. No errors expected (no params).
    assert!(
        errors.is_empty(),
        "self-recursive with no params should be OK: {errors:?}"
    );
}

#[test]
fn flip_flop_includes_no_infinite_loop() {
    // A→B→A cycle — should not infinite loop.
    let inc_b = CompiledInclude {
        path: "a.tmpl.md".into(),
        with_vars: vec![],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: std::sync::Arc::from(vec![Segment::Static("leaf".into())]),
            declarations: std::sync::Arc::from(vec![]),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };
    let inc_a = make_include(
        "b.tmpl.md",
        vec![],
        None,
        vec![],
        vec![Segment::Include(inc_b)],
    );
    let segments = vec![Segment::Include(inc_a)];
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.is_empty(),
        "flip-flop cycle with no params should be OK: {errors:?}"
    );
}

#[test]
fn self_recursive_include_with_type_mismatch_error() {
    // Self-recursive include with wrong type at boundary.
    let inc = make_include(
        "self.tmpl.md",
        vec![("name", "name")],
        None,
        vec![int_decl("name")], // child expects int
        vec![Segment::Include(CompiledInclude {
            path: "self.tmpl.md".into(),
            with_vars: vec![(
                std::borrow::Cow::Borrowed("name"),
                std::borrow::Cow::Borrowed("name"),
            )],
            for_each: None,
            inline_compiled: Some(CompiledInlineTemplate {
                segments: std::sync::Arc::from(vec![]),
                declarations: std::sync::Arc::from(vec![int_decl("name")]),
                consts: std::sync::Arc::new(crate::compat::HashMap::new()),
                imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            }),
        })],
    );
    let parent_decls = vec![str_decl("name")]; // parent has str
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.iter().any(|e| e.contains("type mismatch")),
        "should catch type mismatch at recursive boundary: {errors:?}"
    );
}

#[test]
fn self_recursive_include_contract_missing_params_error() {
    // Self-recursive include missing required params at boundary.
    let inc = make_include(
        "self.tmpl.md",
        vec![], // no with vars at outer call
        None,
        vec![str_decl("msg")], // child requires msg
        vec![Segment::Include(CompiledInclude {
            path: "self.tmpl.md".into(),
            with_vars: vec![],
            for_each: None,
            inline_compiled: Some(CompiledInlineTemplate {
                segments: std::sync::Arc::from(vec![]),
                declarations: std::sync::Arc::from(vec![str_decl("msg")]),
                consts: std::sync::Arc::new(crate::compat::HashMap::new()),
                imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            }),
        })],
    );
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &[]);
    assert!(
        errors.iter().any(|e| e.contains("missing required param")),
        "should catch missing params at recursive boundary: {errors:?}"
    );
}

// -- types_compatible tests ------------------------------------------

#[test]
fn types_compatible_scalars() {
    assert!(types_compatible(&VarType::Str, &VarType::Str));
    assert!(types_compatible(&VarType::Int, &VarType::Int));
    assert!(types_compatible(&VarType::Float, &VarType::Float));
    assert!(types_compatible(&VarType::Bool, &VarType::Bool));
    assert!(!types_compatible(&VarType::Str, &VarType::Int));
    assert!(!types_compatible(&VarType::Int, &VarType::Bool));
}

#[test]
fn types_compatible_untyped_containers() {
    // Untyped list is compatible with typed list.
    assert!(types_compatible(
        &VarType::List(vec![]),
        &VarType::List(vec![str_decl("x")])
    ));
    assert!(types_compatible(
        &VarType::List(vec![str_decl("x")]),
        &VarType::List(vec![])
    ));
    // Same typed lists are compatible.
    assert!(types_compatible(
        &VarType::List(vec![str_decl("x")]),
        &VarType::List(vec![str_decl("x")])
    ));
    // Different typed lists are not.
    assert!(!types_compatible(
        &VarType::List(vec![str_decl("x")]),
        &VarType::List(vec![int_decl("x")])
    ));
}

#[test]
fn types_compatible_cross_kind() {
    assert!(!types_compatible(&VarType::Str, &VarType::List(vec![])));
    assert!(!types_compatible(&VarType::Struct(vec![]), &VarType::Int));
}

#[test]
fn types_compatible_option_types() {
    // Same inner type: compatible.
    assert!(types_compatible(
        &VarType::Option(Box::new(VarType::Str)),
        &VarType::Option(Box::new(VarType::Str)),
    ));
    assert!(types_compatible(
        &VarType::Option(Box::new(VarType::Int)),
        &VarType::Option(Box::new(VarType::Int)),
    ));
    // Different inner types: not compatible.
    assert!(!types_compatible(
        &VarType::Option(Box::new(VarType::Str)),
        &VarType::Option(Box::new(VarType::Int)),
    ));
    // Option vs non-option: not compatible.
    assert!(!types_compatible(
        &VarType::Option(Box::new(VarType::Str)),
        &VarType::Str,
    ));
    assert!(!types_compatible(
        &VarType::Str,
        &VarType::Option(Box::new(VarType::Str)),
    ));
}

// -- Include inside control flow ------------------------------------

#[test]
fn include_inside_for_loop() {
    let inc = make_include(
        "row.tmpl.md",
        vec![("label", "item.label")],
        None,
        vec![str_decl("label")],
        vec![Segment::Expr {
            expr: CompiledExpr::compile("label").unwrap(),
            filters: vec![],
        }],
    );
    let parent_decls = vec![VarDecl {
        name: "items".to_string(),
        var_type: VarType::List(vec![str_decl("label")]),
        default_value: None,
    }];
    let segments = vec![Segment::ForLoop {
        binding: "item".into(),
        list_expr: CompiledExpr::compile("items").unwrap(),
        body: vec![Segment::Include(inc)],
        else_body: vec![],
    }];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "include inside for loop should type-check: {errors:?}"
    );
}

#[test]
fn include_inside_match_arm() {
    let enum_type = VarType::Enum(vec![
        variant("Confirmed", vec![("evidence", VarType::Str)]),
        unit_variant("NotConfirmed"),
    ]);
    let inc = make_include(
        "detail.tmpl.md",
        vec![("proof", "outcome.evidence")],
        None,
        vec![str_decl("proof")],
        vec![Segment::Expr {
            expr: CompiledExpr::compile("proof").unwrap(),
            filters: vec![],
        }],
    );
    let parent_decls = vec![VarDecl {
        name: "outcome".to_string(),
        var_type: enum_type,
        default_value: None,
    }];
    let segments = vec![Segment::Match {
        expr: CompiledPath::compile("outcome"),
        arms: vec![crate::compiled::MatchArm {
            variants: vec!["Confirmed".into()],
            guard: None,
            body: vec![Segment::Include(inc)],
        }],
        is_option: false,
    }];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "include inside match arm should type-check: {errors:?}"
    );
}

// -- Multiple includes of same template -----------------------------

#[test]
fn multiple_includes_same_template_ok() {
    let inc1 = make_include(
        "child.tmpl.md",
        vec![("msg", "a")],
        None,
        vec![str_decl("msg")],
        vec![],
    );
    let inc2 = make_include(
        "child.tmpl.md",
        vec![("msg", "b")],
        None,
        vec![str_decl("msg")],
        vec![],
    );
    let parent_decls = vec![str_decl("a"), str_decl("b")];
    let segments = vec![Segment::Include(inc1), Segment::Include(inc2)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "multiple includes of same template: {errors:?}"
    );
}

// -- Include with extra with vars -----------------------------------

#[test]
fn include_extra_with_vars_ok() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("msg", "msg"), ("extra", "extra")],
        None,
        vec![str_decl("msg")], // child only declares msg
        vec![],
    );
    let parent_decls = vec![str_decl("msg"), str_decl("extra")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "extra with vars should be OK: {errors:?}"
    );
}

// -- Same-named inline templates from different files -------------------
// These test the pointer-based identity fix: same name but different
// Arc<[Segment]> should be walked independently.

#[test]
fn same_name_different_content_both_type_checked() {
    use std::sync::Arc;
    // Two includes both named "helper" but with different bodies/declarations.
    // The second body references an undeclared var — both should be walked.
    let inc1 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("helper"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("a"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::from(vec![Segment::Expr {
                expr: CompiledExpr::compile("msg").unwrap(),
                filters: vec![],
            }]),
            declarations: Arc::from(vec![str_decl("msg")]),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };
    let inc2 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("helper"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("b"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            // This body references "ghost" which is NOT declared.
            segments: Arc::from(vec![
                Segment::Expr {
                    expr: CompiledExpr::compile("msg").unwrap(),
                    filters: vec![],
                },
                Segment::Expr {
                    expr: CompiledExpr::compile("ghost").unwrap(),
                    filters: vec![],
                },
            ]),
            declarations: Arc::from(vec![str_decl("msg")]),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };

    let parent_decls = vec![str_decl("a"), str_decl("b")];
    let segments = vec![Segment::Include(inc1), Segment::Include(inc2)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert_eq!(
        errors.len(),
        1,
        "second helper's 'ghost' should be caught: {errors:?}"
    );
    assert!(
        errors[0].contains("ghost"),
        "should report undeclared 'ghost': {errors:?}"
    );
}

#[test]
fn same_arc_deduplicates_body_walk() {
    use std::sync::Arc;
    // Two includes using the SAME Arc (same file) should only walk once.
    let shared_segments: Arc<[Segment]> = Arc::from(vec![Segment::Expr {
        expr: CompiledExpr::compile("msg").unwrap(),
        filters: vec![],
    }]);
    let shared_decls: Arc<[VarDecl]> = Arc::from(vec![str_decl("msg")]);

    let inc1 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("shared.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("a"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::clone(&shared_segments),
            declarations: Arc::clone(&shared_decls),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };
    let inc2 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("shared.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("b"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::clone(&shared_segments),
            declarations: Arc::clone(&shared_decls),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };

    let parent_decls = vec![str_decl("a"), str_decl("b")];
    let segments = vec![Segment::Include(inc1), Segment::Include(inc2)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(errors.is_empty(), "shared arc dedup: {errors:?}");
}

// -- Include with inline_compiled = None (no cross-boundary checks) -----

#[test]
fn include_no_inline_compiled_validates_parent_paths() {
    // When inline_compiled is None, cross-boundary checks are skipped,
    // but parent-scope validation of `with` expressions should still happen.
    let inc = CompiledInclude {
        path: std::borrow::Cow::Borrowed("unknown.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("ghost"),
        )],
        for_each: None,
        inline_compiled: None, // Not resolved
    };
    let parent_decls = vec![str_decl("a")]; // 'ghost' is NOT declared
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert_eq!(
        errors.len(),
        1,
        "should catch undeclared 'ghost': {errors:?}"
    );
    assert!(
        errors[0].contains("ghost"),
        "should mention 'ghost': {errors:?}"
    );
}

#[test]
fn include_no_inline_compiled_skips_contract() {
    // When inline_compiled is None, contract checking is impossible
    // (we don't know what the included template declares).
    let inc = CompiledInclude {
        path: std::borrow::Cow::Borrowed("unknown.tmpl.md"),
        with_vars: vec![],
        for_each: None,
        inline_compiled: None,
    };
    let parent_decls = vec![str_decl("a")];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        errors.is_empty(),
        "no inline_compiled = no contract check: {errors:?}"
    );
}

// -- Include inside {% if %} (always type-checked, even false branch) ---

#[test]
fn include_inside_if_false_branch_still_checked() {
    // An include with a missing param inside an if branch should still
    // produce an error — type checking is exhaustive, not conditional.
    let inc = make_include(
        "child.tmpl.md",
        vec![], // missing required param
        None,
        vec![str_decl("msg")],
        vec![],
    );
    let parent_decls = vec![bool_decl("flag")];
    let segments = vec![Segment::If {
        branches: vec![(
            crate::compiled::Condition::Truthy(
                crate::scope::ConditionOperand::compile("flag").unwrap(),
            ),
            vec![Segment::Include(inc)],
        )],
        else_body: vec![],
    }];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        !errors.is_empty(),
        "include inside if-branch should still be checked"
    );
    assert!(
        errors[0].contains("msg"),
        "should mention missing 'msg': {errors:?}"
    );
}

// -- Include with both for_each AND with_vars --------------------------

#[test]
fn include_for_each_plus_with_type_mismatch() {
    let inc = make_include(
        "row.tmpl.md",
        vec![("extra", "my_int")],
        Some(("item", "items")),
        vec![str_decl("item"), str_decl("extra")], // extra expects str
        vec![],
    );
    let parent_decls = vec![
        VarDecl {
            name: "items".to_string(),
            var_type: VarType::List(vec![]),
            default_value: None,
        },
        int_decl("my_int"), // int, but child expects str
    ];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        !errors.is_empty(),
        "int→str mismatch should be caught: {errors:?}"
    );
    assert!(
        errors[0].contains("type mismatch"),
        "should mention type mismatch: {errors:?}"
    );
}

// -- With var referencing undeclared parent variable --------------------

#[test]
fn include_with_var_references_undeclared_parent() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("msg", "nonexistent")],
        None,
        vec![str_decl("msg")],
        vec![],
    );
    let parent_decls = vec![str_decl("other")]; // 'nonexistent' not declared
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        !errors.is_empty(),
        "undeclared parent var should error: {errors:?}"
    );
    assert!(
        errors[0].contains("nonexistent"),
        "should mention 'nonexistent': {errors:?}"
    );
}

// -- Same template, different types at different sites ------------------

#[test]
fn same_template_different_sites() {
    use std::sync::Arc;
    let child_decls: Arc<[VarDecl]> = Arc::from(vec![str_decl("msg")]);
    let child_segments: Arc<[Segment]> = Arc::from(vec![Segment::Expr {
        expr: CompiledExpr::compile("msg").unwrap(),
        filters: vec![],
    }]);

    // Site 1: msg=my_str (str→str, OK)
    let inc1 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("child.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("my_str"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::clone(&child_segments),
            declarations: Arc::clone(&child_decls),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };
    // Site 2: msg=my_int (int→str, ERROR)
    let inc2 = CompiledInclude {
        path: std::borrow::Cow::Borrowed("child.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("my_int"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: Arc::clone(&child_segments),
            declarations: Arc::clone(&child_decls),
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };

    let parent_decls = vec![str_decl("my_str"), int_decl("my_int")];
    let segments = vec![Segment::Include(inc1), Segment::Include(inc2)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert_eq!(
        errors.len(),
        1,
        "exactly one type mismatch (second site): {errors:?}"
    );
    assert!(
        errors[0].contains("type mismatch"),
        "should report type mismatch: {errors:?}"
    );
}

// -- Container type mismatches (list→dict, dict→list) -------------------

#[test]
fn include_list_dict_cross_kind_mismatch() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("data", "my_list")],
        None,
        vec![VarDecl {
            name: "data".to_string(),
            var_type: VarType::Struct(vec![str_decl("key")]),
            default_value: None,
        }],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "my_list".to_string(),
        var_type: VarType::List(vec![str_decl("key")]),
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        !errors.is_empty(),
        "list→dict mismatch should error: {errors:?}"
    );
}

// -- Float and bool include type checking ------------------------------

#[test]
fn include_float_type_match_ok() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("val", "score")],
        None,
        vec![VarDecl {
            name: "val".to_string(),
            var_type: VarType::Float,
            default_value: None,
        }],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "score".to_string(),
        var_type: VarType::Float,
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(errors.is_empty(), "float→float should be OK: {errors:?}");
}

#[test]
fn include_bool_type_mismatch() {
    let inc = make_include(
        "child.tmpl.md",
        vec![("flag", "name")],
        None,
        vec![VarDecl {
            name: "flag".to_string(),
            var_type: VarType::Bool,
            default_value: None,
        }],
        vec![],
    );
    let parent_decls = vec![str_decl("name")]; // str != bool
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert!(
        !errors.is_empty(),
        "str→bool mismatch should error: {errors:?}"
    );
}

// -- for_each binding name collides with a with var --------------------

#[test]
fn include_for_each_binding_collides_with_var() {
    // Both `for item in items` and `with item="override"` provide "item".
    // The contract should be satisfied (item IS provided).
    let inc = make_include(
        "child.tmpl.md",
        vec![("item", "\"override\"")],
        Some(("item", "items")),
        vec![str_decl("item")],
        vec![],
    );
    let parent_decls = vec![VarDecl {
        name: "items".to_string(),
        var_type: VarType::List(vec![]),
        default_value: None,
    }];
    let segments = vec![Segment::Include(inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    // Contract satisfied — "item" is provided by both for_each and with.
    assert!(
        errors.is_empty(),
        "binding + with for same name should be OK: {errors:?}"
    );
}

// -- Grandchild include type mismatch ----------------------------------

#[test]
fn nested_include_grandchild_type_error() {
    use std::sync::Arc;
    // Parent → child → grandchild. Grandchild has an undeclared var.
    let grandchild_segments: Arc<[Segment]> = Arc::from(vec![Segment::Expr {
        expr: CompiledExpr::compile("undefined_in_grandchild").unwrap(),
        filters: vec![],
    }]);
    let grandchild_decls: Arc<[VarDecl]> = Arc::from(vec![str_decl("msg")]);

    let child_inc = CompiledInclude {
        path: std::borrow::Cow::Borrowed("grandchild.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("msg"),
            std::borrow::Cow::Borrowed("child_msg"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: grandchild_segments,
            declarations: grandchild_decls,
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };

    let child_segments: Arc<[Segment]> = Arc::from(vec![
        Segment::Expr {
            expr: CompiledExpr::compile("child_msg").unwrap(),
            filters: vec![],
        },
        Segment::Include(child_inc),
    ]);
    let child_decls: Arc<[VarDecl]> = Arc::from(vec![str_decl("child_msg")]);

    let parent_inc = CompiledInclude {
        path: std::borrow::Cow::Borrowed("child.tmpl.md"),
        with_vars: vec![(
            std::borrow::Cow::Borrowed("child_msg"),
            std::borrow::Cow::Borrowed("parent_msg"),
        )],
        for_each: None,
        inline_compiled: Some(CompiledInlineTemplate {
            segments: child_segments,
            declarations: child_decls,
            consts: std::sync::Arc::new(crate::compat::HashMap::new()),
            imported_consts: std::sync::Arc::new(crate::compat::HashMap::new()),
        }),
    };

    let parent_decls = vec![str_decl("parent_msg")];
    let segments = vec![Segment::Include(parent_inc)];
    let errors = validate_field_accesses(&segments, &parent_decls);
    assert_eq!(errors.len(), 1, "grandchild's undeclared var: {errors:?}");
    assert!(
        errors[0].contains("undefined_in_grandchild"),
        "should report grandchild error: {errors:?}"
    );
}

// -- Complex type aliases in types: block ----------------------------------

/// Like `compile_and_check`, but uses the frontmatter's own declarations
/// (including type-alias-resolved params) instead of externally passed decls.
fn compile_and_check_self(template: &str) -> Vec<String> {
    let (fm, body) = crate::parse_frontmatter(template).expect("parse");
    let (segments, _) = crate::compiled::compile(body, &fm.type_aliases).expect("compile");
    validate_field_accesses(&segments, &fm.declarations)
}

#[test]
fn list_type_alias_in_types_block() {
    let tmpl = r"---
name: t
types:
  - TaskList = list(title = str, score = int)

params:
  - tasks = TaskList
---
> {% for b in tasks %}{{ b.title }}: {{ b.score }}
> {% /for %}";
    let errors = compile_and_check_self(tmpl);
    assert!(errors.is_empty(), "list type alias should work: {errors:?}");
}

#[test]
fn chained_type_alias_enum_in_list() {
    let tmpl = r"---
name: t
types:
  - Severity = enum(High, Medium, Low)
  - TaskReport = list(title = str, severity = Severity)

params:
  - tasks = TaskReport
---
> {% for b in tasks %}{{ b.title }} {% match b.severity %}{% case High %}🔴{% case Medium %}🟡{% case Low %}🟢{% /match %}
> {% /for %}";
    let errors = compile_and_check_self(tmpl);
    assert!(
        errors.is_empty(),
        "chained type alias should work: {errors:?}"
    );
}

// -- Opaque roots (import stems / consts) --------------------------------

fn compile_and_check_with_opaque(
    template: &str,
    decls: &[VarDecl],
    opaque: &[&str],
) -> Vec<String> {
    let (_fm, body) = crate::parse_frontmatter(template).expect("parse");
    let empty_aliases = crate::compat::HashMap::new();
    let (segments, _) = crate::compiled::compile(body, &empty_aliases).expect("compile");
    let opaque_set: HashSet<String> = opaque.iter().copied().map(String::from).collect();
    validate_field_accesses_with_opaque(&segments, decls, &opaque_set)
}

#[test]
fn opaque_root_skips_undeclared_error() {
    // `imported.NOTEBOOK_FILENAME` should not error when `imported` is opaque.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ imported.NOTEBOOK_FILENAME }}",
        &[],
        &["imported"],
    );
    assert!(
        errors.is_empty(),
        "opaque root should skip validation: {errors:?}"
    );
}

#[test]
fn opaque_root_dotted_path_deep() {
    // Deep dotted path on opaque root should also be skipped.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ config.STAGES.DESIGN }}",
        &[],
        &["config"],
    );
    assert!(
        errors.is_empty(),
        "deep opaque path should skip: {errors:?}"
    );
}

#[test]
fn opaque_root_bare_reference() {
    // Bare reference to opaque root (no dotted path) should also be valid.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ MAX_RETRIES }}",
        &[],
        &["MAX_RETRIES"],
    );
    assert!(
        errors.is_empty(),
        "bare opaque reference should work: {errors:?}"
    );
}

#[test]
fn non_opaque_unknown_variable_still_errors() {
    // Unknown variable that is NOT opaque should still error.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ unknown_var }}",
        &[],
        &["imported"],
    );
    assert_eq!(errors.len(), 1, "non-opaque unknown should error");
    assert!(errors[0].contains("undeclared variable"));
}

#[test]
fn opaque_root_in_conditional() {
    // Opaque roots used in if conditions should not error.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
> {% if imported.ENABLED %}yes> {% /if %}",
        &[],
        &["imported"],
    );
    assert!(errors.is_empty(), "opaque root in conditional: {errors:?}");
}

#[test]
fn opaque_root_coexists_with_typed_params() {
    // Opaque roots and typed params should coexist.
    let decls = vec![VarDecl {
        name: "name".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let errors = compile_and_check_with_opaque(
        r"---
params:
  - name = str
---
{{ name }} {{ imported.CONST }}",
        &decls,
        &["imported"],
    );
    assert!(
        errors.is_empty(),
        "mixed opaque and typed should work: {errors:?}"
    );
}

#[test]
fn multiple_opaque_roots() {
    // Multiple opaque roots should all be recognized.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ imported.X }} {{ config.Y }} {{ MAX }}",
        &[],
        &["imported", "config", "MAX"],
    );
    assert!(errors.is_empty(), "multiple opaque roots: {errors:?}");
}

#[test]
fn empty_opaque_set_behaves_like_normal() {
    // Empty opaque set = normal validation.
    let errors = compile_and_check_with_opaque(
        r"---
params: []
---
{{ unknown }}",
        &[],
        &[],
    );
    assert_eq!(errors.len(), 1, "empty opaque set should not help");
}

// -- tmpl() displayability rejection ---------------------------------

#[test]
fn display_tmpl_param_is_compile_error() {
    let decls = vec![VarDecl {
        name: "widget".to_string(),
        var_type: VarType::Tmpl(vec![]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - widget = tmpl()
---
{{ widget }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected displayability error: {errors:?}");
    assert!(
        errors[0].contains("cannot display") && errors[0].contains("tmpl"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn display_tmpl_param_with_signature_is_compile_error() {
    let decls = vec![VarDecl {
        name: "formatter".to_string(),
        var_type: VarType::Tmpl(vec![VarDecl {
            name: "name".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - formatter = tmpl(name = str)
---
{{ formatter }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected displayability error: {errors:?}");
    assert!(
        errors[0].contains("cannot display") && errors[0].contains("include"),
        "should suggest using include, got: {}",
        errors[0]
    );
}

// -- Option narrowing and inverse tests ------------------------------

#[test]
fn option_field_access_inside_has_guard_ok() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Struct(vec![str_decl("title")]))),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - opt = option(struct(title = str))
---
> {% if has(opt) %}{{ opt.title }}{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "field access inside has() guard should pass: {errors:?}"
    );
}

#[test]
fn direct_option_rendering_without_guard_is_error() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Str)),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - opt = option(str)
---
{{ opt }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot display value of type option"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn option_field_access_without_has_guard_is_error() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Struct(vec![str_decl("title")]))),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - opt = option(struct(title = str))
---
{{ opt.title }}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot access field") && errors[0].contains("option"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn option_field_access_in_else_arm_is_error() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Struct(vec![str_decl("title")]))),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - opt = option(struct(title = str))
---
> {% if has(opt) %}present{% else %}{{ opt.title }}{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected error in else arm: {errors:?}");
    assert!(
        errors[0].contains("cannot access field") && errors[0].contains("option"),
        "got: {}",
        errors[0]
    );
}

// -- Flow-sensitive option narrowing: field access in all branch positions --
//
// Lock in the contract that an option's inner value (here, its struct fields)
// is accessible ONLY in the branch where the option is proven present, and
// produces a compile-time "cannot access field" error anywhere it is absent.
//
// Note: bare display of a *scalar* option (e.g. `{{ o }}` where `o = option(str)`)
// is intentionally allowed — it renders "None" when absent — so field access on
// an `option(struct)` is used to observe the narrowing boundary.

/// Build a single `option(struct(title = str))` param named `o`.
fn option_struct_decls() -> Vec<VarDecl> {
    vec![VarDecl {
        name: "o".to_string(),
        var_type: VarType::Option(Box::new(VarType::Struct(vec![str_decl("title")]))),
        default_value: None,
    }]
}

const OPTION_STRUCT_HEADER: &str =
    "---\nname: t\nparams:\n  - o = option(struct(title = str))\n---\n";

fn assert_field_option_error(errors: &[String]) {
    assert_eq!(errors.len(), 1, "expected 1 error, got: {errors:?}");
    assert!(
        errors[0].contains("cannot access field") && errors[0].contains("option"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn narrow_if_true_field_usable() {
    // Position 1 (if-true): `o` is present → inner field accessible.
    let tmpl = format!("{OPTION_STRUCT_HEADER}> {{% if has(o) %}}{{{{ o.title }}}}{{% /if %}}");
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert!(
        errors.is_empty(),
        "has() branch should allow field: {errors:?}"
    );
}

#[test]
fn narrow_if_else_field_is_error() {
    // Position 2 (if-else): `o` is absent in the else → compile error.
    let tmpl = format!(
        "{OPTION_STRUCT_HEADER}> {{% if has(o) %}}x{{% else %}}{{{{ o.title }}}}{{% /if %}}"
    );
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert_field_option_error(&errors);
}

#[test]
fn narrow_negated_true_field_is_error() {
    // Position 3 (negated-true): inside `!has(o)` the option is absent → error.
    let tmpl = format!("{OPTION_STRUCT_HEADER}> {{% if !has(o) %}}{{{{ o.title }}}}{{% /if %}}");
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert_field_option_error(&errors);
}

#[test]
fn narrow_negated_else_field_usable() {
    // Position 4 (negated-else): once `!has(o)` is skipped, `o` is present in
    // the else → inner field accessible.
    let tmpl = format!(
        "{OPTION_STRUCT_HEADER}> {{% if !has(o) %}}x{{% else %}}{{{{ o.title }}}}{{% /if %}}"
    );
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert!(
        errors.is_empty(),
        "negated-has else branch should allow field: {errors:?}"
    );
}

#[test]
fn narrow_negated_else_carries_to_later_branch() {
    // A `!has(o)` guard also proves presence in a subsequent `elif` branch.
    let tmpl = format!(
        "{OPTION_STRUCT_HEADER}> {{% if !has(o) %}}x{{% elif true %}}{{{{ o.title }}}}{{% /if %}}"
    );
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert!(
        errors.is_empty(),
        "negated-has should carry presence to elif: {errors:?}"
    );
}

#[test]
fn narrow_match_some_arm_field_usable() {
    // Match Some arm: `o` present → inner field accessible.
    let tmpl = format!(
        "{OPTION_STRUCT_HEADER}> {{% match o %}}{{% case Some %}}{{{{ o.title }}}}{{% case None %}}x{{% /match %}}"
    );
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert!(errors.is_empty(), "Some arm should allow field: {errors:?}");
}

#[test]
fn narrow_match_none_arm_field_is_error() {
    // Match None arm: `o` absent → compile error.
    let tmpl = format!(
        "{OPTION_STRUCT_HEADER}> {{% match o %}}{{% case Some %}}x{{% case None %}}{{{{ o.title }}}}{{% /match %}}"
    );
    let errors = compile_and_check(&tmpl, &option_struct_decls());
    assert_field_option_error(&errors);
}

// -- for...else type checking -----------------------------------------

#[test]
fn for_else_body_type_checked() {
    // Variables in the else body should be type-checked.
    let decls = vec![
        VarDecl {
            name: "items".to_string(),
            var_type: VarType::List(vec![VarDecl {
                name: "title".to_string(),
                var_type: VarType::Str,
                default_value: None,
            }]),
            default_value: None,
        },
        VarDecl {
            name: "fallback".to_string(),
            var_type: VarType::Str,
            default_value: None,
        },
    ];
    let tmpl = r"---
name: t
params:
  - items = list(title = str)
  - fallback = str
---
> {% for item in items %}{{ item.title }}{% else %}{{ fallback }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "else body with valid var should pass: {errors:?}"
    );
}

#[test]
fn for_else_body_undeclared_variable_is_error() {
    // Undeclared variables in the else body should be caught.
    let decls = vec![VarDecl {
        name: "items".to_string(),
        var_type: VarType::List(vec![VarDecl {
            name: "title".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - items = list(title = str)
---
> {% for item in items %}{{ item.title }}{% else %}{{ ghost }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "should catch undeclared var in else body: {errors:?}"
    );
}

#[test]
fn for_else_loop_binding_not_in_else_body() {
    // The loop binding (item) should not be accessible in the else body,
    // since the else body only executes when the list is empty.
    // The type checker doesn't need to produce an error for this —
    // the loop binding is just not narrowed in the else body scope.
    // This test verifies the else body is walked without the binding.
    let decls = vec![VarDecl {
        name: "items".to_string(),
        var_type: VarType::List(vec![VarDecl {
            name: "title".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - items = list(title = str)
---
> {% for item in items %}{{ item.title }}{% else %}{{ item.title }}{% /for %}";
    let errors = compile_and_check(tmpl, &decls);
    // item is not declared as a root variable, so accessing it in else
    // should produce an undeclared error.
    assert!(
        errors.iter().any(|e| e.contains("undeclared")),
        "loop binding should not be accessible in else body: {errors:?}"
    );
}

// -- String match (quoted case labels) -----------------------------------

#[test]
fn string_match_on_str_param_ok() {
    let decls = vec![VarDecl {
        name: "status".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl = r#"---
name: t
params:
  - status = str
---
> {% match status %}{% case "Active" %}active{% case "Inactive" %}inactive{% /match %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "quoted string cases on str should work: {errors:?}"
    );
}

#[test]
fn match_on_str_with_quoted_cases_renders() {
    let tmpl = crate::Template::from_source(
        r#"---
params:
  - status = str
---
> {% match status %}{% case "Active" %}active{% case "Inactive" %}inactive{% /match %}"#,
    )
    .unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("status", "Active");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "active");
    ctx.set("status", "Inactive");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "inactive");
    ctx.set("status", "Unknown");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");
}

#[test]
fn match_on_enum_with_quoted_cases_is_error() {
    let decls = vec![enum_decl(
        "status",
        vec![unit_variant("Active"), unit_variant("Inactive")],
    )];
    let tmpl = r#"---
name: t
params:
  - status = enum(Active, Inactive)
---
> {% match status %}{% case "Active" %}active{% /match %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        !errors.is_empty(),
        "quoted cases on enum should error: {errors:?}"
    );
}

#[test]
fn inline_match_quoted_case_on_str_ok() {
    let decls = vec![VarDecl {
        name: "status".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl = r#"---
name: t
params:
  - status = str
---
> {% match status case "Active" %}yes{% /match %}"#;
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "inline quoted case on str should work: {errors:?}"
    );
}

#[test]
fn mixed_quoted_unquoted_cases_compiles_ok() {
    // Mixed quoted/unquoted labels on str params are allowed.
    // Quoted labels compare against the string value (quotes stripped),
    // while unquoted labels compare literally.
    let tmpl = crate::Template::from_source(
        r#"---
params:
  - status = str
---
> {% match status %}{% case "Active" %}a{% case Inactive %}b{% /match %}"#,
    )
    .expect("mixed quoted/unquoted should compile");
    let mut ctx = crate::Context::new();
    ctx.set("status", "Active");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "a");
    ctx.set("status", "Inactive");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "b");
}

#[test]
fn string_match_with_else_arm() {
    let tmpl = crate::Template::from_source(
        r#"---
params:
  - status = str
---
> {% match status %}{% case "Active" %}active{% else %}other{% /match %}"#,
    )
    .unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("status", "Active");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "active");
    ctx.set("status", "Inactive");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "other");
    ctx.set("status", "Whatever");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "other");
}

#[test]
fn inline_single_quoted_case_renders() {
    let tmpl = crate::Template::from_source(
        r#"---
params:
  - status = str
---
> {% match status case "Active" %}yes{% /match %}"#,
    )
    .unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("status", "Active");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "yes");
    ctx.set("status", "Inactive");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");
}

// -- Param-reference matching (unquoted labels on str params) --------

#[test]
fn param_ref_match_compiles_when_label_is_declared_param() {
    let decls = vec![
        VarDecl {
            name: "status".to_string(),
            var_type: VarType::Str,
            default_value: None,
        },
        VarDecl {
            name: "expected".to_string(),
            var_type: VarType::Str,
            default_value: None,
        },
    ];
    let tmpl = r"---
name: t
params:
  - status = str
  - expected = str
---
> {% match status %}{% case expected %}matched{% /match %}";
    let errors = compile_and_check(tmpl, &decls);
    assert!(
        errors.is_empty(),
        "param-ref match with declared param should compile: {errors:?}"
    );
}

#[test]
fn str_match_unquoted_label_compiles_and_matches_literally() {
    // Unquoted labels on str params are compared literally at runtime.
    let tmpl = crate::Template::from_source(
        r"---
params:
  - status = str
---
> {% match status %}{% case Unknown %}nope{% else %}ok{% /match %}",
    )
    .expect("unquoted label on str should compile");
    let mut ctx = crate::Context::new();
    ctx.set("status", "Unknown");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "nope");
    ctx.set("status", "Other");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "ok");
}

#[test]
fn scalar_and_collection_types_in_if_condition_are_allowed() {
    let tmpl_str = "---\n---\n> {% if name %}hello{% /if %}";
    let errors = compile_and_check(tmpl_str, &[str_decl("name")]);
    assert!(
        errors.is_empty(),
        "str in if condition should succeed: {errors:?}"
    );

    let tmpl_int = "---\n---\n> {% if count %}hello{% /if %}";
    let errors = compile_and_check(tmpl_int, &[int_decl("count")]);
    assert!(
        errors.is_empty(),
        "int in if condition should succeed: {errors:?}"
    );

    let tmpl_list = "---\n---\n> {% if items %}hello{% /if %}";
    let errors = compile_and_check(
        tmpl_list,
        &[VarDecl {
            name: "items".to_string(),
            var_type: VarType::List(vec![VarDecl {
                name: String::new(),
                var_type: VarType::Str,
                default_value: None,
            }]),
            default_value: None,
        }],
    );
    assert!(
        errors.is_empty(),
        "list in bare if condition should succeed: {errors:?}"
    );
}

#[test]
fn has_on_str_and_list_rejected() {
    // has() is strictly for option(T) presence/unwrapping. String and list
    // presence is expressed with bare truthiness (`{% if title %}`), not has().
    let tmpl_str = r"---
---
> {% if has(title) %}x{% /if %}";
    let errors = compile_and_check(tmpl_str, &[str_decl("title")]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(str) should be rejected: {errors:?}"
    );

    let tmpl_list = r"---
---
> {% if has(items) %}x{% /if %}";
    let errors = compile_and_check(
        tmpl_list,
        &[VarDecl {
            name: "items".to_string(),
            var_type: VarType::List(vec![VarDecl {
                name: String::new(),
                var_type: VarType::Str,
                default_value: None,
            }]),
            default_value: None,
        }],
    );
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(list) should be rejected: {errors:?}"
    );
}

#[test]
fn bare_truthiness_on_str_and_list_renders() {
    // The replacement for has(str)/has(list): bare truthiness.
    let tmpl = crate::Template::from_source(
        r"---
params:
  - title = str
  - items = list(str)
---
> {% if title %}title: {{ title }}{% /if %}
> {% if items %}items count: {{ len(items) }}{% /if %}",
    )
    .expect("bare truthiness on str/list should compile");

    let mut ctx = crate::Context::new();
    ctx.set("title", "");
    ctx.set("items", crate::Value::list(Vec::<crate::Value>::new()));
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");

    ctx.set("title", "Hello");
    ctx.set(
        "items",
        crate::Value::list(vec![
            crate::Value::Str("a".to_string()),
            crate::Value::Str("b".to_string()),
        ]),
    );
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "title: Helloitems count: 2");
}

#[test]
fn bare_struct_enum_and_tmpl_in_condition_rejected() {
    let tmpl_struct = r"---
---
> {% if s %}hi{% /if %}";
    let struct_decl_val = VarDecl {
        name: "s".to_string(),
        var_type: VarType::Struct(vec![VarDecl {
            name: "id".to_string(),
            var_type: VarType::Int,
            default_value: None,
        }]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_struct, &[struct_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("cannot evaluate truthiness of struct")),
        "bare struct in if condition should fail: {errors:?}"
    );

    let tmpl_enum = r"---
types:
  - Status = enum(Active, Paused)
---
> {% if st %}hi{% /if %}";
    let enum_decl_val = VarDecl {
        name: "st".to_string(),
        var_type: VarType::Enum(vec![
            crate::types::VariantDecl {
                name: "Active".into(),
                fields: vec![],
            },
            crate::types::VariantDecl {
                name: "Paused".into(),
                fields: vec![],
            },
        ]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_enum, &[enum_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("cannot evaluate truthiness of enum")),
        "bare enum in if condition should fail: {errors:?}"
    );

    let tmpl_handle = r"---
---
> {% if t %}hi{% /if %}";
    let tmpl_decl_val = VarDecl {
        name: "t".to_string(),
        var_type: VarType::Tmpl(vec![]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_handle, &[tmpl_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("cannot evaluate truthiness of template handle")),
        "bare tmpl in if condition should fail: {errors:?}"
    );
}

#[test]
fn option_type_in_if_condition_succeeds_and_narrows() {
    let tmpl = crate::Template::from_source(
        r"---
params:
  - opt = option(str) := None
---
> {% if has(opt) %} · {{ opt }}{% /if %}",
    )
    .expect("option in has() condition should compile and narrow");

    let mut ctx = crate::Context::new();
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");

    ctx.set("opt", "High");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), " · High");
}

#[test]
fn has_on_invalid_types_rejected() {
    let tmpl_int = r"---
---
> {% if has(n) %}hi{% /if %}";
    let errors = compile_and_check(tmpl_int, &[int_decl("n")]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(int) should fail: {errors:?}"
    );

    let tmpl_float = r"---
---
> {% if has(x) %}hi{% /if %}";
    let float_decl_val = VarDecl {
        name: "x".to_string(),
        var_type: VarType::Float,
        default_value: None,
    };
    let errors = compile_and_check(tmpl_float, &[float_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(float) should fail: {errors:?}"
    );

    let tmpl_enum = r"---
types:
  - Status = enum(Active, Paused)
---
> {% if has(st) %}hi{% /if %}";
    let enum_decl_val = VarDecl {
        name: "st".to_string(),
        var_type: VarType::Enum(vec![
            crate::types::VariantDecl {
                name: "Active".into(),
                fields: vec![],
            },
            crate::types::VariantDecl {
                name: "Paused".into(),
                fields: vec![],
            },
        ]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_enum, &[enum_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(enum) should fail: {errors:?}"
    );

    let tmpl_struct = r"---
---
> {% if has(s) %}hi{% /if %}";
    let struct_decl_val = VarDecl {
        name: "s".to_string(),
        var_type: VarType::Struct(vec![VarDecl {
            name: "id".to_string(),
            var_type: VarType::Int,
            default_value: None,
        }]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_struct, &[struct_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(struct) should fail: {errors:?}"
    );

    let tmpl_handle = r"---
---
> {% if has(t) %}hi{% /if %}";
    let tmpl_decl_val = VarDecl {
        name: "t".to_string(),
        var_type: VarType::Tmpl(vec![]),
        default_value: None,
    };
    let errors = compile_and_check(tmpl_handle, &[tmpl_decl_val]);
    assert!(
        errors
            .iter()
            .any(|e| e.contains("'has()' requires an option type")),
        "has(tmpl) should fail: {errors:?}"
    );
}

#[test]
fn not_has_negative_narrowing_carry_in_rust() {
    let tmpl = crate::Template::from_source(
        r"---
params:
  - label = option(str) := None
---
> {% if !has(label) %}default{% else %}label: {{ label }}{% /if %}",
    )
    .expect("!has(label) should narrow label to inner str in else branch");

    let mut ctx = crate::Context::new();
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "default");

    ctx.set("label", "custom");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "label: custom");
}

#[test]
fn has_on_option_enum_reports_present_for_struct_variant() {
    // Regression: a Some(enum struct-variant) carries a `__kind__` tag in its
    // transparent representation. Presence must be decided by Value::None only
    // (not by inspecting the tag), so has() reports such a value present.
    let tmpl = crate::Template::from_source(
        r"---
params:
  - status = option(enum(Active(score = int), Idle)) := None
---
> {% if has(status) %}present{% else %}absent{% /if %}",
    )
    .expect("option(enum) should compile");

    let mut ctx = crate::Context::new();
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "absent");

    // Some(Active { score: 9 }) — transparent enum struct-variant payload.
    ctx.set(
        "status",
        crate::Value::new_struct([
            (
                crate::consts::ENUM_TAG_KEY,
                crate::Value::Str("Active".into()),
            ),
            ("score", crate::Value::Int(9)),
        ]),
    );
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "present");
}

#[test]
fn bare_option_condition_rejected_at_compile_time() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Str)),
        default_value: None,
    }];
    let tmpl = r"---
name: t
params:
  - opt = option(str)
---
> {% if opt %}yes{% /if %}";
    let errors = compile_and_check(tmpl, &decls);
    assert_eq!(errors.len(), 1, "expected bare option error: {errors:?}");
    assert!(
        errors[0].contains("cannot evaluate truthiness of option"),
        "got: {}",
        errors[0]
    );
}

#[test]
fn has_and_unwrapped_operand_in_same_condition() {
    let tmpl = crate::Template::from_source(
        r"---
params:
  - test = option(str) := None
---
> {% if has(test) && test %}val: {{ test }}{% /if %}",
    )
    .expect("has(test) && test should compile cleanly due to left-to-right narrowing");

    let mut ctx = crate::Context::new();
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");

    ctx.set("test", "");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "");

    ctx.set("test", "hello");
    assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "val: hello");
}

#[test]
fn kind_on_plain_str_is_compile_error() {
    let decls = vec![VarDecl {
        name: "msg".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl_str = r"---
params:
  - msg = str
---
{{ kind(msg) }}";
    let errors = compile_and_check(tmpl_str, &decls);
    assert_eq!(errors.len(), 1, "expected compile error: {errors:?}");
    assert!(
        errors[0].contains("'kind()' requires an enum or option type, got str"),
        "unexpected error: {}",
        errors[0]
    );

    // Also verify runtime Scope rejects kind(plain_str_param)
    let tmpl = crate::Template::from_source(tmpl_str).unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("msg", "hello");
    let render_err = tmpl.render_ctx(&ctx).unwrap_err();
    assert!(
        render_err
            .to_string()
            .contains("kind() requires an enum or option value, got str on 'msg'"),
        "unexpected render error: {render_err}"
    );
}

#[test]
fn len_on_int_is_compile_error() {
    let decls = vec![VarDecl {
        name: "count".to_string(),
        var_type: VarType::Int,
        default_value: None,
    }];
    let tmpl_str = r"---
params:
  - count = int
---
{{ len(count) }}";
    let errors = compile_and_check(tmpl_str, &decls);
    assert_eq!(errors.len(), 1, "expected compile error: {errors:?}");
    assert!(
        errors[0].contains("'len()' requires a list or str type, got int"),
        "unexpected error: {}",
        errors[0]
    );
}

#[test]
fn has_in_expr_on_plain_str_is_compile_error() {
    let decls = vec![VarDecl {
        name: "label".to_string(),
        var_type: VarType::Str,
        default_value: None,
    }];
    let tmpl_str = r"---
params:
  - label = str
---
{{ has(label) }}";
    let errors = compile_and_check(tmpl_str, &decls);
    assert_eq!(errors.len(), 1, "expected compile error: {errors:?}");
    assert!(
        errors[0].contains("'has()' requires an option type, got str"),
        "unexpected error: {}",
        errors[0]
    );

    // Also verify runtime Scope rejects has(plain_str_param)
    let tmpl = crate::Template::from_source(tmpl_str).unwrap();
    let mut ctx = crate::Context::new();
    ctx.set("label", "hello");
    let render_err = tmpl.render_ctx(&ctx).unwrap_err();
    assert!(
        render_err
            .to_string()
            .contains("has() requires an option value, got str on 'label'"),
        "unexpected render error: {render_err}"
    );
}

#[test]
fn option_match_non_exhaustive_missing_none_is_compile_error() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Str)),
        default_value: None,
    }];
    let tmpl_str = r#"---
params:
  - opt = option(str)
---

> {% match opt %}
> {% case Some && opt == "special" %}

special: {{ opt }}

> {% case Some %}

has: {{ opt }}

> {% /match %}"#;
    let errors = compile_and_check(tmpl_str, &decls);
    assert_eq!(errors.len(), 1, "expected non-exhaustive error: {errors:?}");
    assert!(
        errors[0].contains("non-exhaustive") && errors[0].contains("None"),
        "unexpected error message: {}",
        errors[0]
    );
}

#[test]
fn option_match_some_or_none_does_not_unsoundly_narrow() {
    let decls = vec![VarDecl {
        name: "opt".to_string(),
        var_type: VarType::Option(Box::new(VarType::Struct(vec![VarDecl {
            name: "title".to_string(),
            var_type: VarType::Str,
            default_value: None,
        }]))),
        default_value: None,
    }];
    let tmpl_str = r"---
params:
  - opt = option(struct(title = str))
---

> {% match opt %}
> {% case Some | None %}

{{ opt.title }}

> {% /match %}";
    let errors = compile_and_check(tmpl_str, &decls);
    assert_eq!(errors.len(), 1, "expected error: {errors:?}");
    assert!(
        errors[0].contains("cannot access field 'title' on option"),
        "unexpected error message: {}",
        errors[0]
    );
}

#[test]
fn case_wildcard_is_rejected_in_match() {
    let tmpl = r"---
params:
  - outcome = enum(Confirmed, NotConfirmed, Pending)
---
> {% match outcome %}
> {% case Confirmed %}

confirmed

> {% case _ %}

fallback

> {% /match %}";
    let err = crate::Template::from_source(tmpl).unwrap_err();
    assert!(
        err.to_string()
            .contains("wildcard '_' in {% case %} is not supported"),
        "unexpected error: {err}"
    );
}

#[test]
fn match_without_else_arm_rejected_when_non_exhaustive() {
    let tmpl = r"---
params:
  - outcome = enum(Confirmed, NotConfirmed, Pending)
---
> {% match outcome %}
> {% case Confirmed %}

confirmed

> {% case NotConfirmed %}

not confirmed

> {% /match %}";
    let err = crate::Template::from_source(tmpl).unwrap_err();
    assert!(
        err.to_string().contains("non-exhaustive"),
        "unexpected error: {err}"
    );
}

#[test]
fn match_with_else_arm_accepted() {
    let tmpl = r"---
params:
  - outcome = enum(Confirmed, NotConfirmed, Pending)
---
> {% match outcome %}
> {% case Confirmed %}

confirmed

> {% else %}

fallback

> {% /match %}";
    assert!(crate::Template::from_source(tmpl).is_ok());
}
