# md-tmpl

Strongly-typed prompt templates for LLMs — markdown files with YAML frontmatter,
validated at **build time** via proc macros, with a full runtime API for dynamic loading.

```rust
use md_tmpl::include_template;

// Parses and validates the template at build time, generates typed structs + enums.
include_template!("prompts/task_report.tmpl.md");

// Generated types:
//   task_report::Params                  — typed struct
//   task_report::ParamsPriority          — enum(Critical, High, Medium, Low)
//   task_report::ParamsTasksItem         — struct { name, urgency }
//   task_report::ParamsTasksItemUrgency  — enum(Critical, High, Medium, Low)

let params = task_report::Params::builder()
    .title("Deploy v2.0")
    .priority(task_report::ParamsPriority::Critical)
    .tasks([
        task_report::ParamsTasksItem::builder()
            .name("run migrations")
            .urgency(task_report::ParamsTasksItemUrgency::High)
            .build(),
        task_report::ParamsTasksItem::builder()
            .name("update load balancer")
            .urgency(task_report::ParamsTasksItemUrgency::Medium)
            .build(),
    ])
    .build();

let output = params.render().unwrap();
assert!(output.contains("# Task Report: Deploy v2.0"));
assert!(output.contains("Priority: Critical"));
assert!(output.contains("run migrations (High)"));
```

The template behind it — a plain `.tmpl.md` markdown file:

```markdown
---
name: task_report
description: A task report template with types
types:
  - Priority = enum(Critical, High, Medium, Low)

params:
  - title = str
  - priority = Priority
  - tasks = list(name = str, urgency = Priority)
---

# Task Report: {{ title }}

Priority: {{ kind(priority) }}

> {% for task in tasks %}

- {{ task.name }} ({{ kind(task.urgency) }})

> {% /for %}
```

Rename a variant, add a field, remove a param — the compiler catches it
immediately. No runtime surprises.

## Why?

- **Build-time validation** — proc macros parse and validate syntax, types, and variable references at `cargo build`. Typos, missing fields, and type mismatches are build errors. Templates can also be loaded and validated at runtime.
- **Markdown-native** — prompts live in `.tmpl.md` files, readable in any editor or on GitHub. Compound types use `()` (never `<>`), control-flow tags use `> {% %}` blockquote prefixes.
- **Agent-safe** — when an LLM edits prompts, the compiler catches drift immediately. `validate_template()` enables hot-reload with contract enforcement.

## Installation

Available on crates.io: <https://crates.io/crates/md-tmpl> (and <https://crates.io/crates/md-tmpl-macros>)

```bash
cargo add md-tmpl
# macros are included by default — no extra dependency needed!
# (md-tmpl re-exports include_template! and template! macros)
```

**MSRV:** 1.85 (Rust 2024 edition) · **`no_std`** compatible (disable default `std` feature)

## Template Syntax & Features

| Feature                    | Syntax / Example                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| **Typed parameters**       | `str`, `int`, `float`, `bool`, `list(…)`, `struct(…)`, `enum(…)`, `option(…)`, `tmpl(…)` |
| **Type aliases**           | `types:` block defines reusable named types (`Priority = enum(High, Low)`)               |
| **Cross-template imports** | `imports:` pulls types via dotted paths (`stem.TypeName`)                                |
| **Constants**              | `consts:` block for file-scoped immutable values                                         |
| **Environment variables**  | `env:` block for compile-time injection from the build environment                       |
| **String interpolation**   | `{{ expr }}` inside all quoted strings — conditions, includes, panic messages            |
| **For loops & else**       | `> {% for task in tasks %} … > {% else %} empty > {% /for %}`                            |
| **Conditionals**           | `> {% if count > 0 %} … > {% elif active %} … > {% else %} … > {% /if %}`                |
| **Enum dispatch**          | `> {% match status %} > {% case Approved %} … > {% case Rejected %} … > {% /match %}`    |
| **Includes as links**      | `> {% include [widget](widget.tmpl.md) with title = "Hello" %}`                          |
| **Inline templates**       | `> {% tmpl header %} … > {% /tmpl %}` (call with `{% include header %}`)                 |
| **Built-in functions**     | `idx(b)`, `len(x)`, `kind(x)`, `kinds(Type)`, `has(x)`                                   |
| **Filters**                | `upper`, `lower`, `trim`, `fixed(N)`, `join(sep)`, `limit(N)`, `add(N)`, `sub(N)`        |

## Build-Time Typed Structs

### `include_template!`

Reads a `.tmpl.md` file at build time, validates it, and generates a typed
module:

```rust
use md_tmpl::include_template;

// Generates: pub mod simple_greeting { pub struct Params { pub name: String } }
include_template!("prompts/simple_greeting.tmpl.md");

let output = simple_greeting::Params { name: "world".into() }.render().unwrap();
assert_eq!(output, "\nHello world!\n");
```

### `template!`

Inline template strings — same validation, no file needed:

```rust
md_tmpl::template!(r#"
---
params:
  - name = str
---
Hello {{ name }}!
"# => greeting);

let output = greeting::Params { name: "World".into() }
    .render()
    .unwrap();
assert_eq!(output, "Hello World!\n");
```

## `TypedBuilder` Integration

Every generated param struct derives `TypedBuilder` for ergonomic,
compile-time-checked construction. This is **always available** — no feature
flag to enable and no `typed-builder` dependency to add yourself (the derive is
re-exported by `md-tmpl`):

```rust
# md_tmpl::include_template!("prompts/greeting.tmpl.md");
let params = greeting::Params::builder()
    .name("Alice")       // setter(into): accepts &str or String
    .count(42)
    .build();            // `items` defaults to vec![]

let output = params.render().unwrap();
```

| Field type                     | Builder behaviour                                                     |
| ------------------------------ | --------------------------------------------------------------------- |
| `String`                       | `setter(into)` — accepts `&str`, `String`, or anything `Into<String>` |
| `Vec<…>`                       | `default` — omit the field to get an empty `Vec`                      |
| Scalars (`i64`, `f64`, `bool`) | Required                                                              |

Sub-structs also derive `TypedBuilder`:

```rust
# md_tmpl::include_template!("prompts/greeting.tmpl.md");
let item = greeting::ParamsItemsItem::builder()
    .label("write docs")
    .build();

let params = greeting::Params::builder()
    .name("Alice")
    .count(1)
    .items(vec![item])
    .build();
```

## serde Integration

Render directly from any `Serialize` struct:

```bash
cargo add md-tmpl --features serde
```

```rust
use md_tmpl::Template;
use serde::Serialize;

#[derive(Serialize)]
struct ReviewParams {
    file_path: String,
    severity: String,
    findings: Vec<Finding>,
}

#[derive(Serialize)]
struct Finding { line: i64, message: String }

let tmpl = Template::from_source("\
---
params:
  - file_path = str
  - severity = str
  - findings = list(line = int, message = str)
---

# Code Review: {{ file_path }}

Severity: {{ severity }}

> {% for finding in findings %}

- Line {{ finding.line }}: {{ finding.message }}

> {% /for %}"
).unwrap();

let output = tmpl.render(&ReviewParams {
    file_path: "main.rs".into(),
    severity: "high".into(),
    findings: vec![
        Finding { line: 42, message: "unused variable".into() },
    ],
}).unwrap();
```

## Binary Deserialization (CBOR & `FlexBuffers`)

Build a `Context` straight from a binary buffer — useful for language bindings
and zero-copy pipelines. Each format lives behind its own feature, so you only
compile the codecs you actually use (both are enabled by default):

- `cbor` — `Context::from_cbor` (works in `no_std`, via `ciborium`)
- `flexbuffers` — `Context::from_flexbuffers` and `Value::from_flexbuffers`
  (requires `std`)

Opt out of the defaults to trim dependencies down to exactly what you need:

```bash
# serde + CBOR only, no FlexBuffers (and its transitive deps)
cargo add md-tmpl --no-default-features --features std,serde,cbor
```

## Runtime API

For dynamic or scripting use cases, parse templates at runtime.

### `ctx!` Macro

Ergonomic context construction with nested structs and lists:

```rust
use md_tmpl::{ctx, Template};

let tmpl = Template::from_source("
---
params:
  - tasks = list(title = str, priority = str)
---

> {% for task in tasks %}

- **{{ task.title }}** ({{ task.priority }})

> {% /for %}"
).unwrap();

let output = tmpl.render_ctx(&ctx! {
    tasks: [
        { title: "Write documentation", priority: "High" },
        { title: "Add unit tests",      priority: "Medium" },
    ]
}).unwrap();

assert_eq!(output, "- **Write documentation** (High)\n- **Add unit tests** (Medium)\n");
```

### Runtime Loading

```rust
use md_tmpl::load_template;

let tmpl = load_template(std::path::Path::new("prompts"), "simple_greeting").unwrap();

let mut ctx = md_tmpl::Context::new();
ctx.set("name", "world");
let output = tmpl.render_ctx(&ctx).unwrap();
assert!(output.contains("Hello world!"));
```

### Environment Variables

Inject values at compile time from the build environment:

```rust
use md_tmpl::{ctx, Template, CompileOptions, Value};

let (tmpl, _fm) = Template::compile("\
---
params:
  - name = str

env:
  - MODEL = str
  - MAX_TOKENS = int := 4096
---
Hello {{ name }}! Using {{ MODEL }} (max {{ MAX_TOKENS }} tokens).",
    CompileOptions::default().env(&[("MODEL", Value::Str("gemini-2.0-flash".into()))]),
).unwrap();

let output = tmpl.render_ctx(&ctx! { name: "Alice" }).unwrap();
assert!(output.contains("gemini-2.0-flash"));
assert!(output.contains("4096")); // default used
```

## Hot-Reload

Load templates from disk at runtime while keeping type safety —
iterate on prompt wording without recompiling:

```rust
# md_tmpl::include_template!("prompts/greeting.tmpl.md");
let tmpl = md_tmpl::Template::from_file(
    std::path::Path::new("prompts/greeting.tmpl.md")
).unwrap();
greeting::Params::validate_template(&tmpl).unwrap();

let output = greeting::Params {
    name: "Bob".into(),
    count: 1,
    items: vec![],
}.render_reloaded(&tmpl).unwrap();
```

## Caching

`TemplateCache` hashes file contents — unchanged files return cached
compilations. `render_cached()` extends this to included templates:

```rust
use md_tmpl::TemplateCache;

let dir = tempfile::tempdir().unwrap();
let path = dir.path().join("greeting.tmpl.md");
std::fs::write(&path, "\
---
params:
  - name = str
---
Hello {{ name }}!"
).unwrap();

let cache = TemplateCache::new();
let tmpl = cache.load(&path).unwrap();

let mut ctx = md_tmpl::Context::new();
ctx.set("name", "world");
let output = tmpl.render_ctx_cached(&ctx, &cache).unwrap();
assert_eq!(output, "Hello world!");
```

## Defaults & Extra Params

### `render_allowing_extra()`

Extra context keys not declared in frontmatter are silently ignored:

```rust
use md_tmpl::{ctx, Template};

let tmpl = Template::from_source("\
---
params:
  - name = str
---
Hello {{ name }}!"
).unwrap();
let ctx = ctx! { name: "world", extra_key: "ignored" };
assert_eq!(tmpl.render_ctx_allowing_extra(&ctx).unwrap(), "Hello world!");
```

### `defaults_context()`

Returns a `Context` pre-filled with default values:

```rust
use md_tmpl::Template;

let tmpl = Template::from_source("\
---
params:
  - name = str
  - count = int := 5
---
{{ name }} ({{ count }})"
).unwrap();
let mut ctx = tmpl.defaults_context();
ctx.set("name", "Alice"); // count already has default 5
assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "Alice (5)");
```

## Performance

### vs Competitors

Criterion benchmarks, render only (pre-parsed template + data → output).
([source](../../benchmarks/benches/comparison.rs))

| Scenario        |        md-tmpl |           Tera | `MiniJinja` | Handlebars |
| --------------- | -------------: | -------------: | ----------: | ---------: |
| **simple**      |  **168 ns** 🏆 |         289 ns |      575 ns |     744 ns |
| **loop**        |  **583 ns** 🏆 |         648 ns |     2.30 µs |    4.09 µs |
| **conditional** |  **264 ns** 🏆 |         326 ns |      639 ns |    1.19 µs |
| **hero**        |        2.22 µs | **2.14 µs** 🏆 |     7.97 µs |   22.00 µs |
| **mega**        | **8.84 µs** 🏆 |       11.10 µs |    38.47 µs |  109.76 µs |

_Intel Xeon @ 2.60 GHz, 3 runs × 100 Criterion samples._

```bash
just bench-rust          # run Criterion benchmarks
just bench-update-rust   # run + update this table
```

## Full Reference

See **[SPEC.md](../../SPEC.md)** for the complete syntax — control-flow
tags, filters, built-in functions, whitespace control, and error
diagnostics.

## License

Apache-2.0 OR MIT
