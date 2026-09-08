# md-tmpl: Strongly typed markdown templates

Fast and powerful templates. Valid markdown. Strongly typed and great for agents.

## The Template

<!-- prettier-ignore -->
```markdown
---
consts:
  - MODEL = str := "gemini-3.5-flash"
  - MAX_FINDINGS = int := 20

types:
  - Severity = enum(Critical, High, Medium, Low)
  - Verdict = enum(Approved, NeedsChanges(reason = str), Rejected(reason = str))

params:
  - reviewer = str
  - file_path = str
  - severity = Severity
  - findings = list(line = int, message = str, severity = Severity)
  - verdict = Verdict
---

# Code Review: {{ file_path }}

Reviewer: {{ reviewer }} · Model: {{ MODEL }}
Severity: {{ kind(severity) }} · Findings: {{ len(findings) }}/{{ MAX_FINDINGS }}

> {% for finding in findings %}

- **L{{ finding.line }}** ({{ kind(finding.severity) }}): {{ finding.message }}

> {% /for %}

> {% match verdict %}
> {% case Approved %}

✅ **Approved** — ship it.

> {% case NeedsChanges %}

🔄 **Needs changes:** {{ verdict.reason }}

> {% case Rejected %}

❌ **Rejected:** {{ verdict.reason }}

> {% /match %}
```

Types and fields are validated at build time — rendering happens at runtime:

```rust
use md_tmpl::include_template;

include_template!("prompts/code_review.tmpl.md");

let output = code_review::Params::builder()
    .reviewer("Alice")
    .file_path("src/main.rs")
    .severity(code_review::Severity::High)
    .findings([
        code_review::FindingsItem::builder()
            .line(42)
            .message("unused import")
            .severity(code_review::Severity::Low)
            .build(),
    ])
    .verdict(code_review::Verdict::NeedsChanges {
        reason: "remove dead imports".into(),
    })
    .build().render().unwrap();
```

Wrong types, missing fields, non-exhaustive matches — all caught at **build time**.
Templates can also be loaded and validated at runtime for dynamic or hot-reload use cases.

## Why?

| Problem                       | Solution                                                                 |
| ----------------------------- | ------------------------------------------------------------------------ |
| Prompts buried in code        | **Markdown-native** — `.tmpl.md` files render in any editor or on GitHub |
| Errors found in production    | **Strict typing** — caught at build time (Rust) or render time           |
| LLMs drift templates silently | **Agent-safe** — the engine catches drift immediately                    |
| Syntax breaks in previews     | **Markdown-safe** — renders cleanly in any viewer, even unrendered       |

## Features

| Feature                    | Description                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| **Typed parameters**       | `str`, `int`, `float`, `bool`, `list(…)`, `struct(…)`, `enum(…)`, `option(…)`, `tmpl(…)`            |
| **Type aliases**           | `types:` defines reusable named types                                                               |
| **Cross-template imports** | `imports:` pulls types via dotted paths (`stem.TypeName`)                                           |
| **Typed lists**            | `list(title = str, score = int)` — iterate with `{% for %}`, fields validated                       |
| **Enum dispatch**          | `match`/`case` with exhaustiveness checking and field narrowing                                     |
| **Includes as links**      | `{% include [name](path.tmpl.md) with … %}` — clickable, type-checked                               |
| **Inline templates**       | `{% tmpl name %}` — reusable fragments without separate files                                       |
| **Constants**              | `consts:` for file-scoped immutable values                                                          |
| **Environment variables**  | `env:` for compile-time injection from the build environment                                        |
| **String interpolation**   | `{{ expr }}` inside all quoted strings — conditions, includes, panic messages                       |
| **Built-in functions**     | `idx(b)`, `len(x)`, `kind(x)`, `kinds(t)`, `has(x)` + filters (`upper`, `lower`, `trim`, `join`, …) |
| **Readable as markdown**   | `> {% %}` blockquote prefix keeps control flow visually separated from prose                        |
| **Markdown-safe syntax**   | Valid YAML frontmatter, clean `()` type syntax — looks good even unrendered                         |

> **Note:** The `> ` prefix is required only on `{% %}` tag lines — it is
> stripped before compilation. Content lines between tags are normal text
> and should not use `> `. A content line starting with `> ` is kept
> verbatim as a literal markdown blockquote in the output.

## Quick Start

```rust
use md_tmpl::include_template;

// Parsed + validated at build time — generates typed structs from frontmatter
include_template!("prompts/task_report.tmpl.md");

let output = task_report::Params::builder()
    .title("Sprint 42")
    .priority(task_report::Priority::Critical)
    .tasks([
        task_report::TasksItem::builder()
            .name("Fix auth bypass")
            .urgency(task_report::Priority::Critical)
            .build(),
        task_report::TasksItem::builder()
            .name("Update dependencies")
            .urgency(task_report::Priority::Low)
            .build(),
    ])
    .build().render().unwrap();
```

## Performance

Built for speed — the Rust core renders into a single pre-sized output buffer (reuse it across renders with the `render_*_into` variants to avoid per-render output allocation), backed by a native FFI engine in every binding.

### Rust (render-only, pre-parsed)

| Scenario        |        md-tmpl |           Tera | `MiniJinja` | Handlebars |
| --------------- | -------------: | -------------: | ----------: | ---------: |
| **simple**      |  **168 ns** 🏆 |         289 ns |      575 ns |     744 ns |
| **loop**        |  **583 ns** 🏆 |         648 ns |     2.30 µs |    4.09 µs |
| **conditional** |  **264 ns** 🏆 |         326 ns |      639 ns |    1.19 µs |
| **hero**        |        2.22 µs | **2.14 µs** 🏆 |     7.97 µs |   22.00 µs |
| **mega**        | **8.84 µs** 🏆 |       11.10 µs |    38.47 µs |  109.76 µs |

See the language-specific READMEs or the [benchmarks suite](benchmarks/README.md) for full details and methodology.

## Language Bindings

First-class native packages across all major ecosystems — with tailored ergonomics and high-performance engines:

- **[Rust](crates/md-tmpl/README.md)** — Reusable-buffer rendering (`render_into` writes into your own `String`), build-time validation via proc macros (`include_template!`), ergonomic `TypedBuilder` & `serde` integration, `ctx!` macro, caching, and hot-reload.
- **[Python](crates/md-tmpl-python/README.md)** — 4–8× faster than Jinja2. Auto-generated dataclasses, mypy/pyright static typing stubs, native Python 3.10+ structural pattern matching (`match`/`case`), and direct import hooks (`from prompts.review import CodeReview`).
- **[Go](go/md_tmpl/README.md)** — 3–6× faster than standard `text/template`. Native Rust FFI engine, idiomatic struct tag mapping (`json:"field"`), map rendering, and static enum typing via `TaggedVariant`.
- **[TypeScript](crates/md-tmpl-typescript/README.md)** — Build-time TypeScript type generation (`generateTypesFromFile`), generic `TypedTemplate<P>` contracts, type-safe enum constructors (`defineVariants`), and exhaustive pattern matching (`match`).
- **[WASM](crates/md-tmpl-wasm/README.md)** — Exact Rust-engine feature parity in Node.js and browsers (~200 KB `.wasm`). Supports zero-copy binary throughput (`renderFlexbuffers`) and implements the exact same `ITemplate` interface as pure TypeScript.

## Full Reference

See **[SPEC.md](SPEC.md)** for the complete syntax — all control-flow
tags, filters, built-in functions, whitespace control, and error
diagnostics.

## Packages

- **Rust**: <https://crates.io/crates/md-tmpl> (and <https://crates.io/crates/md-tmpl-macros>)
- **Python**: <https://pypi.org/project/md-tmpl/>
- **Go**: <https://github.com/domenukk/md-tmpl>
- **TypeScript**: <https://www.npmjs.com/package/md-tmpl>

## License

Apache-2.0 OR MIT
