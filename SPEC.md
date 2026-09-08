# md-tmpl — Language Specification

Complete reference for `.tmpl.md` template syntax and the frontmatter type
system. See the [README](README.md) for API documentation, motivation,
and quick-start examples.

## Table of Contents

- [File Format](#file-format)
- [Frontmatter & Type System](#frontmatter--type-system)
- [Markdown Blockquotes, Statement Tags, and Comments](#markdown-blockquotes-statement-tags-and-comments)
- [Type Aliases](#type-aliases)
- [Cross-Template Imports](#cross-template-imports)
- [Constants](#constants)
- [Compile-Time Environment Variables](#compile-time-environment-variables)
- [Enum Literal Expressions](#enum-literal-expressions)
- [Naming Conventions & Collision Rules](#naming-conventions--collision-rules)
- [Expression Syntax](#expression-syntax)
- [Filters](#filters)
- [Built-in Functions](#built-in-functions)
- [String Interpolation](#string-interpolation)
- [Control Flow](#control-flow)
- [Option Types](#option-types)
- [Panic Statements](#panic-statements)
- [Includes](#includes)
- [Inline Templates](#inline-templates)
- [Raw Blocks](#raw-blocks)
- [Comments](#comments)
- [Whitespace Control](#whitespace-control)
- [Error Diagnostics](#error-diagnostics)

---

## File Format

By default, template files use the `.tmpl.md` extension for md-tmpl parsable files.
They are valid markdown files with a required YAML frontmatter block followed by a body:

```markdown
---
<frontmatter>
---

<body>
```

**Markdown safety** is a core design goal. Template files must render
readably in any standard markdown viewer (GitHub, VS Code, etc.) even
without a `.tmpl.md`-aware parser. This constrains the syntax:

- Compound types use **parentheses** — `list(…)`, `struct(…)`, `enum(…)`,
  `option(…)`, `tmpl(…)` — never angle brackets `<…>` (which markdown
  renderers strip as HTML tags).
- Default values use `"quoted"` strings, `[…]` lists, `{…}` structs, and
  `Variant(…)` enum literals — all markdown-safe.
- Control-flow tags use `> {% %}` blockquote prefixes so they render as
  visible blockquotes rather than invisible HTML.

**YAML validity** is a hard requirement. The frontmatter block between
`---` delimiters must be parseable by any standard YAML parser (e.g.
`serde_yaml`, `PyYAML`, `js-yaml`). The engine uses a lightweight custom
parser for `no_std` and cross-platform portability, but YAML conformance
is enforced via `serde_yaml` cross-validation tests. In practice:

- Each `params:`, `env:`, `consts:`, and `types:` list item is a YAML plain
  scalar string (e.g. `- name = str := "World"`). YAML preserves the
  string verbatim; the engine then parses the type/default syntax.
- YAML's built-in multiline folding handles continuation lines correctly —
  indented lines following a list item are joined to the preceding scalar.
- **Inline params** (`params: [x = str, y = int]`) are only safe for
  simple scalar types. Any param containing commas — compound types like
  `enum(A, B)`, `list(name = str, score = int)`, or defaults with `[…]` —
  will break because YAML splits on `,` inside flow sequences `[…]`.
  Use the block list format for anything beyond simple scalars.

**Standalone control-flow tags** (`{% %}`) and comments (`{# #}`) at
line start must carry a `> ` blockquote prefix — see
[Markdown Blockquotes, Statement Tags, and Comments](#markdown-blockquotes-statement-tags-and-comments)
for the full rules. **Inline tags** on a single line work without any prefix:

```markdown
{% if x %}yes{% else %}no{% /if %}
```

**Line endings:** All backends normalize `\r\n` (CRLF) to `\n` (LF) at the
earliest compilation entry point. Template files checked out with Windows
line endings produce byte-identical output to their Unix counterparts.

---

## Frontmatter & Type System

All frontmatter keys are **optional** — only the `---` delimiters are
mandatory. Omitted keys default to empty / absent.

- **`name:`** / **`description:`** — template metadata, queryable via
  the API (e.g. `.name()`, `.description()` in Rust) but **not** injected
  into the body scope. They do not collide with `params:` names.
- **`allow_unused:`** — set to `true` to suppress errors for unused
  parameters and type aliases (default: `false`).

### Frontmatter Binding Summary

| Section   | When bound     | Who provides     | Available in imports | Available in body |
| --------- | -------------- | ---------------- | -------------------- | ----------------- |
| `consts:` | Compile time ¹ | Template author  | ✅                   | ✅                |
| `env:`    | Compile time ² | Caller (Options) | ✅                   | ✅                |
| `params:` | Render time    | Caller (Context) | ❌                   | ✅                |

¹ Values are literal in the source — resolved during `from_source()` or `compile()`.
² Values are provided externally via `CompileOptions` — resolved during `compile()`.
`from_source()` is equivalent to `compile()` with empty options; both
parse frontmatter and compile the body in a single step.

```yaml
---
name: my_template
description: A summary
types:
  - Labelled = enum(Known(label = str), Unknown)
  - Priority = enum(High, Medium, Low)

imports:
  - "[shared_types](./shared_types.tmpl.md)"

env:
  - PROMPTS_DIR = str
  - MAX_RETRIES = int := 3

consts:
  - NOTEBOOK_FILENAME = str := "thought_process.md"

params:
  - name = str
  - count = int
  - score = float := 0.95
  - active = bool := true
  - items = list(label = str, score = int)
  - config = struct(timeout = int, retries = int)
  - status = enum(Active, Paused, Stopped)
  - outcome = enum(Confirmed(evidence = str), Rejected)
  - label = option(str) := None
  - category = Labelled
  - ext_type = shared_types.SomeType

allow_unused: false
---
```

### Type Reference

| Annotation                  | Rust equivalent (generated by `include_template!`)  | Notes                                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `str`                       | `String`                                            |                                                                                                                                                                                                                         |
| `bool`                      | `bool`                                              |                                                                                                                                                                                                                         |
| `int`                       | `i64`                                               |                                                                                                                                                                                                                         |
| `float`                     | `f64`                                               |                                                                                                                                                                                                                         |
| `list(field = type, ...)`   | `Vec<StructName>`                                   | Each field is a typed struct field                                                                                                                                                                                      |
| `list(type)`                | `Vec<RustType>`                                     | Scalar list (e.g. `list(str)`, `list(int)`)                                                                                                                                                                             |
| `struct(field = type, ...)` | Nested generated struct                             |                                                                                                                                                                                                                         |
| `enum(Variant1, Variant2)`  | Generated enum                                      | No payload variants                                                                                                                                                                                                     |
| `enum(V(field = type), V2)` | Generated enum with struct variants                 | Fields accessible inside `{% match %}` arms                                                                                                                                                                             |
| `option(type)`              | Generated enum: `Some(val)` / `None`                | Sugar for `enum(Some(val = T), None)`. See [Option Types](#option-types)                                                                                                                                                |
| `tmpl(field = type, ...)`   | Validated `Template` reference                      | Template must match declared param signature                                                                                                                                                                            |
| `tmpl()`                    | Validated `Template` reference (no required params) | Any template with no required params (may have defaulted params)                                                                                                                                                        |
| `AliasName`                 | Resolved type from `types:` block                   | See [Type Aliases](#type-aliases)                                                                                                                                                                                       |
| `stem.TypeName`             | Resolved type from imported template                | See [Cross-Template Imports](#cross-template-imports). For **enums**, the generated field type can be aliased to the imported template's type — see [Reusing Imported Types](#reusing-imported-types-in-generated-code) |

All parameters (and `consts:` entries) **must** have explicit types:

- A bare `- name` with no type is a hard error (`missing a type annotation`).
- An implicit-typed default such as `- name := "value"` is also rejected —
  write `- name = str := "value"` instead. The engine cannot infer the type
  from the default value.

#### Template Parameter Signature Matching

When a value of type `tmpl(...)` is provided, its parameter declarations
are validated against the declared signature. This enables **higher-order
template composition** — passing templates as values and including them
by variable name.

**Providing `tmpl(...)` values:**

- **Rust**: Use `Value::Tmpl(Arc<Template>)` — wrap a compiled `Template`
  in an `Arc` and pass it via the context.
- **TypeScript**: Pass a `Template` instance directly in the render params.
  The engine detects it automatically via `fromJs()`, or use
  `template.toValue()` for explicit conversion.

**Signature validation rules:**

1. **All signature params must exist** — the template must declare every
   parameter listed in the `tmpl(...)` signature, with matching types.
2. **Extra params allowed if defaulted** — the template may declare
   additional parameters beyond the signature, but only if they have
   default values. Extra required params (no default) cause a type error.
3. **`tmpl()` (empty)** — accepts any template that has no required
   parameters. The template may still have defaulted params.

```yaml
# Example: signature matching

params:
  - widget = tmpl(name = str)
```

A template with `params: [name = str]` matches ✅.
A template with `params: [name = str, color = str := "gray"]` matches ✅
(extra `color` has a default).
A template with `params: [name = str, color = str]` does NOT match ❌
(extra `color` has no default).
A template with `params: [age = int]` does NOT match ❌
(`name` is missing, `age` is not in the signature).

**TypeScript example:**

```typescript
import { Template } from "md-tmpl";

// Define a reusable widget template
const widget = Template.fromSource(`---
params:
  - name = str
---
Hello {{ name }}!`);

// Define a layout that accepts a widget
const layout = Template.fromSource(`---
params:
  - greeting = tmpl(name = str)
---
> {% include greeting with name="World" %}`);

// Pass the widget template as a parameter
layout.render({ greeting: widget });
// → "Hello World!"
```

**Rust example:**

```rust
use std::sync::Arc;
use md_tmpl::{Template, Value};

let widget = Template::from_source("---\nparams:\n  - name = str\n---\nHello {{ name }}!").unwrap();
let layout = Template::from_source("---\nparams:\n  - greeting = tmpl(name = str)\n---\n> {% include greeting with name=\"World\" %}").unwrap();

let mut ctx = md_tmpl::Context::new();
ctx.set("greeting", Value::Tmpl(Arc::new(widget)));
assert_eq!(layout.render_ctx(&ctx).unwrap().trim(), "Hello World!");
```

#### Nested Template Parameters (`tmpl` inside `tmpl`)

Template parameters can themselves accept template-typed fields, enabling
multi-level template composition — templates that accept templates as
parameters:

```yaml
# A layout that accepts a widget, which itself accepts a sub-widget
params:
  - widget = tmpl(target = tmpl(x = str))
```

This declares that `widget` must be a template with a parameter named
`target` whose type is `tmpl(x = str)`. At render time, the caller
provides a template for `widget`, and that template in turn receives
a template for `target`:

```typescript
import { Template } from "md-tmpl";

// Inner template: accepts a simple str param
const inner = Template.fromSource(`---
params: [x = str]
---
inner={{ x }}`);

// Outer template: accepts a tmpl-typed param and includes it
const outer = Template.fromSource(`---
params: [target = tmpl(x = str)]
---
> {% include target with x="hello" %}`);

// Layout: accepts a widget that itself takes a tmpl param
const layout = Template.fromSource(`---
params: [widget = tmpl(target = tmpl(x = str))]
---
> {% include widget with target=inner %}`);

// Render: pass templates as values at each level
outer.render({ target: inner });
// → "inner=hello"

layout.render({ widget: outer });
// widget receives `outer`, which in turn receives `inner` via `with`
```

**Nesting rules:**

- `tmpl(...)` fields inside `tmpl(...)` signatures are validated
  recursively — each level must match the declared signature.
- `option(tmpl(...))` — optional template parameters are supported.
  Pass `null` (TypeScript) or `None` (Rust) to omit, or a `Template`
  to provide.
- Deeply nested patterns like `tmpl(a = tmpl(b = tmpl(c = str)))` work
  to arbitrary depth.
- Signature mismatches at any nesting level produce clear compile errors.

### Compound Type Delimiters & Quoting

For all compound types (`list`, `struct`, `enum`, `option`, `tmpl`), enclosing delimiters **must** be parentheses `(...)` (e.g., `list(str)`, `option(int)`, `struct(name = str)`).

In YAML frontmatter declarations, outer quotes around type expressions (or entire parameter/type declarations) are automatically stripped before parsing (e.g., `items = "list(str)"`).

### Type Nesting Rules

Compound types can be nested, with one restriction:

```markdown
# ✅ Valid nesting

- items = list(name = str, score = int) # list of structs (the correct way)
- grid = list(list(str)) # nested list (matrix/grid)
- tags = list(enum(High, Medium, Low)) # list of enum values
- config = struct(pos = struct(x = int, y = int), label = str) # nested struct
- entries = struct(status = enum(Active, Done), items = list(str))
- label = option(str) # required (caller must provide string or null)
- scores = list(option(int)) # list of optional ints
- meta = option(struct(key = str, value = str)) # optional struct
- widget = tmpl(name = str) # template parameter (higher-order)
- layout = tmpl(body = tmpl(x = str)) # nested tmpl (tmpl inside tmpl)
- panel = option(tmpl(title = str)) # optional template parameter

# ❌ Forbidden — redundant raw struct wrapper

- items = list(struct(name = str, score = int)) # ERROR: use list(name = str, score = int) or list(MyAlias)
```

**Raw `list(struct(...))` is forbidden** because `list(name = str, score = int)`
already creates a list of structs, making the explicit `struct()` wrapper redundant.
However, referencing a strong struct type alias inside a list (e.g., `list(MyStructAlias)`)
**is allowed** and unwraps the struct fields directly into the list elements.

### Structural (Duck) Typing

`struct`, `list`, and `enum` type checks validate that all **declared fields**
are present with correct types. Extra undeclared fields are silently ignored.
This applies recursively at every nesting depth, including through type aliases.

Top-level context parameters are subject to a separate extra-key check (see
[Error Diagnostics](#error-diagnostics)). The structural typing rule applies
only to values **inside** compound types.

### Default Values

Append `:= {literal}` after the type:

```markdown
# Scalar defaults

- name = str := "World"
- count = int := 42
- verbose = bool := false
- threshold = float := 0.95

# Enum defaults — unit variants

- status = enum(Active, Paused) := Active

# Enum defaults — struct variants (inline fields)

- outcome = enum(Confirmed(evidence = str), Rejected) := Confirmed(evidence = "found it")

# Option defaults

- label = option(str) := None # absent value (parameter becomes optional)
- label = option(str) := "hello" # present value (auto-wraps to Some)

# Struct defaults

- config = struct(timeout = int, label = str) := {timeout = 10, label = "fast"}

# List defaults

- tags = list(str) := ["rust", "go", "python"]
- items = list(name = str, score = int) := [{name = "a", score = 10}]

# Const-reference defaults — use a const name instead of a literal

- retries = int := MAX_RETRIES
- output_file = str := config.DEFAULT_PATH
```

**Rules:**

- String defaults must be quoted (`"World"` or `'World'` — both single and
  double quotes are valid for string literals).
- Enum unit variant defaults are unquoted (`Active`, not `"Active"`).
- Struct variant defaults use `VariantName(field = value)` syntax (parentheses).
- Bare struct variant names without fields are rejected (e.g., `:= Confirmed`
  fails when `Confirmed` has required fields).
- Unknown variant names are rejected at compile time.
- Enum variant defaults use the **bare** variant name — identical to `{% case %}`
  arm syntax. A qualified `Type.Variant` in default position (e.g.
  `s = Stage := Stage.Build`) is a **compile error**; write `:= Build` instead.
  Namespacing (`Type.Variant`) is only valid in expression position, such as
  `kind(Stage.Build)` (see [Enum Literal Expressions](#enum-literal-expressions)).
- Enum defaults **nest** inside compound types using the same bare-variant
  syntax: `struct(st = Stage) := {st = Build}`, `list(Stage) := [Build, Deploy]`,
  `option(Stage) := Build` (or `:= None`), and enum-typed fields of a struct
  variant, e.g. `enum(Wrap(s = Stage), Empty) := Wrap(s = Build)`.
- Struct defaults use `{key = value}` syntax (curly braces with `=`).
- List defaults use `[value, ...]` syntax.
- **Const-reference defaults**: a default value can reference a local
  constant (`consts:` entry) or an imported constant (`stem.NAME`) by name.
  The referenced constant's type must match the parameter's declared type.
  Local consts are parsed before params, so order within frontmatter does
  not matter. Imported constants are resolved after import resolution.
- **YAML constraint**: see [YAML validity](#file-format) — use block
  list format for compound types and defaults containing commas.

#### Embedded Delimiters and Quoting in String Defaults

Inside a **quoted** string default, the structural delimiters — commas and
the bracket family `()`, `[]`, `{}`, `<>` — are treated as literal
characters. List and struct/record defaults are only split on delimiters
that appear at the **top level**, i.e. outside any quoted string. This makes
prose defaults with punctuation safe:

```markdown
# Commas inside quoted strings do not split list items / struct fields

- tags = list(str) := ["red, green", "blue"] # 2 items, not 3
- cfg = struct(msg = str, n = int) := {msg = "a, b", n = 1} # msg = "a, b"
- rows = list(name = str, note = str) := [{name = "x", note = "p, q, r"}]

# Bracket characters inside quoted strings are literal too

- samples = list(str) := ["arr[0]", "set{1}", "f(x)"] # 3 items, intact
```

String defaults support the same backslash escapes as statement string
literals — `\\` → `\`, `\"` → `"`, `\'` → `'` — while any other `\X` sequence
is preserved verbatim (see [String Literal Syntax](#string-literal-syntax)).
Both `"` and `'` are valid quotes, so a quote character can be embedded either
by escaping it or by switching to the other quote style:

```markdown
- a = str := 'He said "hi", then left' # other-quote style
- b = str := "He said \"hi\", then left" # escaped quote — same value
- c = str := "it's, fine" # single quote inside double quotes
```

> **Note:** the [YAML constraint](#file-format) still applies — any default
> containing commas must use the block-list frontmatter form, never the
> inline `params: [ ... ]` flow form.

Defaults are type-checked at compile time. If a param with a default is
omitted from the render context, the default is injected automatically.

Query defaults programmatically:

```rust
use md_tmpl::Template;

let tmpl = Template::from_source(
"---
params:
  - name = str := \"World\"
---
Hello {{ name }}!").unwrap();
let defaults = tmpl.defaults();
assert_eq!(defaults.len(), 1);

let ctx = md_tmpl::Context::new();
assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "Hello World!");
```

### Unused Parameters and Type Aliases

Declared params that are never referenced in the body (not even in a
`{# comment #}`) are a hard error by default. A parameter is considered
"referenced" if it appears in an expression (`{{ param }}`), a condition
(`{% if param %}`), a match target (`{% match param %}`), **or as an
unquoted case label** (`{% case param_name %}`), since the runtime reads
its value for comparison.

Similarly, type aliases declared in `types:` but never referenced by any
parameter, constant declaration, **or another type alias** (chained aliases
like `Name = Base`) are also rejected. **Enum types are exempt** — they
are implicitly used as namespace constants (see
[Enum Literal Expressions](#enum-literal-expressions)).

Disable both checks with `allow_unused: true` in frontmatter, or call
`Template::from_source_allowing_unused()`.

> **Note:** Undeclared params (referenced in the body but absent from
> `params:`) are always rejected, even with `allow_unused: true`.

#### Best Practice: `allow_unused` vs Comment Suppression

**Prefer comment-based suppression** (`{# unused: {{ param_name }} #}`) over
`allow_unused: true` in most cases. Comments are explicit, self-documenting,
and preserve the compiler's ability to catch genuinely unused declarations:

```markdown
> {# unused: {{ extra_param }} #}
```

**Import tracking is root-level.** The unused-variable check tracks
imports by their **stem** (root name), not individual sub-fields. Using
_any_ sub-field — `{{ lib.TypeA }}`, `{{ lib.CONST_X }}`, or even
`{{ kinds(lib.ForumTag) }}` — marks the entire import as used.
There is **no need** to claim individual sub-fields in comments:

```markdown
---
imports:
  - "[lib](./lib.tmpl.md)"

params: []
---

> {# ✅ Using lib.TypeA is enough — lib.TypeC and lib.CONST_Y
> do NOT need separate {# unused #} claims #}
> Type: {{ lib.TypeA }}
```

**Note:** Unused imports are silently allowed — the unused-variable
check only applies to `params:` and `types:` declarations, not imports.
An import that is never referenced simply has no effect. Removing
unnecessary imports is still good practice for readability.

**Reserve `allow_unused: true`** for **type library templates** — files
whose sole purpose is defining shared types/constants for other templates
to import. These files typically have no body content and exist purely as
a type namespace. Since every importing template uses a different subset,
suppressing unused checks in the library itself is appropriate:

```yaml
---
name: shared_types
description: Shared type definitions
allow_unused: true
types:
  - Severity = enum(Low, Medium, High, Critical)
  - Status = enum(Open, Closed)
  - ItemList = list(name = str)
---

> {# Type library — no body content #}
```

---

## Markdown Blockquotes, Statement Tags, and Comments

Statement tags (`{% ... %}`) and comments (`{# ... #}`) that start a line **must** be prefixed with a markdown blockquote `> `. This is enforced at compile time — bare tags or comments at line start are syntax errors.

- **Tags and Comments at line start**: If `{%` or `{#` is at the beginning of a line, it **must** start with `> ` (e.g., `> {% ... %}` or `> {# ... #}`). For comments, spaces are required around the content (`{# comment #}`).
- **Mandatory Blank Lines**: If `{%` or `{#` is at the beginning of a line, the line before and after **must** be blank unless the adjacent line is frontmatter (`---`) or also starts with a blockquote tag/comment (`> {%` or `> {#`).
- **Whitespace Preservation**: Standalone tags consume surrounding blank lines so they produce no spurious whitespace in the output:
  - **Tag ↔ content**: The mandatory blank line between a standalone tag and adjacent content is consumed. Extra blank lines beyond the mandatory one are preserved as intentional whitespace: N blank lines → N−1 extra newlines in the output.
  - **Tag ↔ tag**: Between consecutive standalone tags (e.g., `> {% if %}` followed by `> {% for %}`), **all** blank lines are consumed — they are purely structural and never produce output whitespace.
- **Multiple Comments and Mixed Tags on a Line**: `{%` and `{#` in the same line work seamlessly (no matter how many follow). Text on the line is treated normally, and any `{# ... #}` comments are omitted from output while preserving the rest of the line.
- **Content lines inside blocks are normal text.** The lines between `> {% for ... %}` and `> {% /for %}` (or any other block) are just regular template content. The `> ` prefix stripping applies **exclusively** to lines where the first non-whitespace content after `> ` is `{% ` or `{# `. If a content line starts with `> ` (for example, a standard Markdown blockquote), it is **not** stripped and is kept verbatim in the rendered output.

Example — only the `{% %}` tag lines carry the `> ` prefix; the prose
lines inside the block do not:

<!-- prettier-ignore -->
```markdown

> {% for task in tasks %}

- **{{ task.title }}** ({{ task.priority }})

> {% /for %}
```

## Type Aliases

The optional `types:` block defines named type aliases that can be
referenced by name in `params:` declarations. This avoids repeating
complex type definitions and enables type sharing across parameters
and templates.

Any type expression (`enum(…)`, `list(…)`, `struct(…)`, `tmpl(…)`, or even scalar
types) can be aliased.

### Syntax

Type aliases are declared as YAML mappings in the `types:` block:

```yaml
---
types:
  - Category = enum(Labelled(label = str), Unlabelled)
  - Priority = enum(High, Medium, Low)
  - TaskList = list(title = str, category = Category, priority = Priority)
  - Config = struct(timeout = int, retries = int)

params:
  - tasks = TaskList
  - components = list(name = str, category = Category)
  - cfg = Config
---
```

Each entry maps an alias name to a type expression. The alias name can
then be used anywhere a type is expected in `params:`.

### Resolution Order

When a type name appears in `params:`, it is resolved in this order:

1. **Built-in types** — `str`, `bool`, `int`, `float`, `list(…)`, `struct(…)`, `enum(…)`, `tmpl(…)`
2. **Local `types:` entries** — exact name match from the same template's `types:` block
3. **Imported types via dotted path** — `stem.TypeName` from `imports:` (see [Cross-Template Imports](#cross-template-imports))

If a type name is not found in any of these, it is an "unknown type" error.

### Chained Aliases

Type aliases can reference previously defined aliases (defined earlier
in the same `types:` block):

```yaml
types:
  - Severity = enum(Critical, High, Medium, Low)
  - TaskInfo = struct(title = str, severity = Severity)
```

Forward references (referencing an alias defined later in the block)
are not supported.

### Implicit Param Types

Every param or constant with a compound type (`list`, `struct`, or `enum`)
implicitly creates a named type entry using the declaration's name in
`PascalCase`. This implicit type is importable from other templates via
dotted path, alongside explicit `types:` entries.

For example, given:

```yaml
params:
  - tasks = list(title = str, priority = str)

consts:
  - DEFAULT_ITEMS = list(label = str) := [{label = "init"}]
```

The param `tasks` implicitly creates a type named `Tasks`, and the
constant `DEFAULT_ITEMS` implicitly creates a type named `DefaultItems`.
Other templates can reference these as `template_stem.Tasks` or
`template_stem.DefaultItems` via an import.

If an explicit `types:` entry with the same `PascalCase` name already
exists, the implicit entry is **not** generated — explicit aliases take
precedence.

---

## Cross-Template Imports

The optional `imports:` block declares dependencies on other templates,
allowing you to reference their type aliases and implicit param types
via dotted paths.

### Syntax

Each import entry uses quoted markdown link syntax:

```yaml
---
imports:
  - "[task_list_item](./task_list_item.tmpl.md)"

params:
  - tasks = task_list_item.tasks
  - label = task_list_item.Category
---
```

The `[stem]` part is the namespace prefix used in dotted paths.
The `(path.tmpl.md)` is the file path, resolved relative to the
importing template's directory (same as `{% include %}`).

**Strict Path Requirement**: All relative file import paths **must** begin explicitly with `./` or `../`. Bare relative filenames (e.g., `[my_types](my_types.tmpl.md)`) are rejected with syntax errors. Absolute paths beginning with `/` are also permitted.

### Dynamic Import Path Interpolation

Import paths in `imports:` declarations support constant interpolation (e.g., `"[my_types]({{ PROMPTS_DIR }}/types.tmpl.md)"`). Any `{{ expression }}` within the path is evaluated **prior** to file system lookup or stem validation. Because imports are declared in the YAML frontmatter, only `env:` values, `consts:` from the local template, and constants from previously resolved imports are available during import path evaluation; parameters and loop variables cannot be used in frontmatter import paths.

#### Sequential (Chained) Resolution

Imports are resolved **sequentially, top-to-bottom**. Each resolved import's exported constants are accumulated and become available for interpolation in subsequent import paths. This enables a powerful chaining pattern:

```yaml
---
imports:
  - "[env](./env.tmpl.md)"
  - "[session_layout]({{ env.PROMPTS_DIR }}/session_layout.tmpl.md)"
  - "[artist]({{ env.PROMPTS_DIR }}/artist.tmpl.md)"

params:
  - name = str
---
```

In this example:

1. `env` is imported first (literal path `./env.tmpl.md`).
2. `env.tmpl.md` exports `PROMPTS_DIR` as a const.
3. The second import uses `{{ env.PROMPTS_DIR }}` — this works because `env` was already resolved.
4. The third import can also use `{{ env.PROMPTS_DIR }}`.

This is the recommended pattern for **dynamic import path resolution** — create a small
"environment" template that exports path constants, import it first, then use its constants
in all subsequent import paths.

**Important**: The order matters. An import **cannot** reference constants from an import
declared below it. If `env` were listed after `session_layout`, the `{{ env.PROMPTS_DIR }}`
expression would fail with an unresolvable error.

#### Combining with `env:` Frontmatter

The `env:` frontmatter section provides an alternative to the chained import pattern.
`env:` values are resolved **before** any imports, so they can always be used in import paths:

```yaml
---
env:
  - PROMPTS_DIR = str

imports:
  - "[session_layout]({{ PROMPTS_DIR }}/session_layout.tmpl.md)"
  - "[artist]({{ PROMPTS_DIR }}/artist.tmpl.md)"

params:
  - name = str
---
```

The `env:` approach eliminates the need for a separate `env.tmpl.md` file but requires
the caller to provide the value at compile time.

Both patterns can coexist — `env:` values and previously-resolved import consts are
both available during import path interpolation.

**Error Behavior:**

- **Unclosed expression**: If a `{{` is not closed by a matching `}}`, a syntax error is raised (e.g., `unclosed '{{' in import path '...'`).
- **Empty expression**: An empty expression `{{}}` or `{{ }}` raises a syntax error (e.g., `empty expression '{{}}' in import path '...'`).
- **Unresolvable expression**: If the referenced constant is undefined or cannot be evaluated, a syntax error is raised (e.g., `unresolvable expression '{{consts.UNKNOWN}}' in import path '...'`).
- **Invalid resulting path**: After interpolation, the resulting path must still satisfy the [strict path requirement](#cross-template-imports) (`./`, `../`, or `/` prefix). Otherwise, a syntax error is raised.

### Stem Validation

The link text (stem) **must** match the filename without `.tmpl.md`.
For example, `"[my_types](./my_types.tmpl.md)"` is valid, but
`"[alias](./my_types.tmpl.md)"` is an error because `alias` ≠ `my_types`.

### Importable Names

Both explicit `types:` entries and implicit param types (compound params)
from the imported template are available via `stem.Name`:

- `task_list_item.Category` — references a `types:` entry named `Category`
- `task_list_item.tasks` — references the implicit type from a compound param named `tasks`

### Circular Import Detection

Circular imports are detected and produce an error. If template A
imports template B and template B imports template A, compilation fails
with a clear error message.

### Transitive Imports

Imported templates that themselves have imports are resolved
transitively. However, transitive types are **not** re-exported — each
template must directly import the templates whose types it uses:

```yaml
# base.tmpl.md
---
types:
  - Priority = enum(High, Medium, Low)
---
```

```yaml
# middle.tmpl.md — imports base, uses Priority
---
imports:
  - "[base](./base.tmpl.md)"

params:
  - prio = base.Priority
---
```

```yaml
# top.tmpl.md — must import base directly to use Priority
---
imports:
  - "[base](./base.tmpl.md)"
  - "[middle](./middle.tmpl.md)"

params:
  - prio = base.Priority
---
```

`top.tmpl.md` cannot access `base.Priority` via `middle.base.Priority` —
nested dotted paths through transitive imports are not supported.

### Reusing Imported Types in Generated Code

By default, when a param references an imported **enum** type via
`stem.TypeName`, `include_template!` emits a _fresh copy_ of that enum into the
generated module. This keeps each template self-contained but means the copy is
a **distinct Rust type** from the imported template's enum, forcing callers to
convert between them.

To instead reference the imported enum **directly** — so the two are the same
Rust type — pass the optional `imports = { ... }` argument to the macro. It maps
each import _stem_ (as declared in the template's `imports:` block) to the Rust
module path where that imported template's generated types live:

```rust
// Generates `mod roles_lib` with `roles_lib::WorkRole`.
md_tmpl::include_template!("prompts/roles_lib.tmpl.md");

// `role_consumer`'s `role` param is `role = roles_lib.WorkRole`. Mapping the
// `roles_lib` stem makes the generated field type an alias of the imported
// enum instead of a duplicate.
md_tmpl::include_template!(
    "prompts/role_consumer.tmpl.md",
    imports = { roles_lib = crate::roles_lib }
);

fn main() {
    // `role_consumer::ParamsRole` is a `pub type` alias for `roles_lib::WorkRole`,
    // so the same nominal type crosses the boundary with no conversion.
    let params = role_consumer::Params {
        role: roles_lib::WorkRole::Judge,
    };
    assert_eq!(params.render().unwrap(), "\nRole: Judge\n");
}
```

With the mapping, the generated `role` field has type
`role_consumer::ParamsRole`, which is a `pub type` **alias** for
`crate::roles_lib::WorkRole`. Because they are the same nominal type, no
conversion is needed at the boundary.

Rules and notes:

- **Enums only.** Only params whose _top-level_ type is a bare `stem.TypeName`
  reference to an enum are aliased. Nested positions (e.g. `list(stem.T)`,
  `option(stem.T)`, struct fields) still emit copies.
- **Absolute paths.** The mapped path is emitted verbatim inside the generated
  module, so it must resolve from _within_ that module. Use an absolute path
  (`crate::...` or `::other_crate::...`), not a bare sibling name.
- **Variant contract.** The imported template's `types:` declaration remains the
  compile-time contract md-tmpl validates against. The mapped Rust type must
  have the same variants (this holds automatically when both are generated from
  the same template).
- **Fallback.** Stems that are not mapped fall back to the default behavior
  (a fresh per-template enum copy), so `imports = { ... }` is fully optional and
  backward compatible.

---

## Constants

The optional `consts:` block in frontmatter declares file-scoped constant
values. Constants are available everywhere in the template body without
being passed via `with`.

### Syntax

Each entry follows `- NAME = type := value`:

```markdown
---
consts:
  - NOTEBOOK_FILENAME = str := "thought_process.md"
  - MAX_RETRIES = int := 3
  - STAGES = struct(DESIGN = str, BUILD = str) := {DESIGN = "Design", BUILD = "Build"}
---

Notebook: {{ NOTEBOOK_FILENAME }}
Max retries: {{ MAX_RETRIES }}
Stage: {{ STAGES.DESIGN }}
```

Constants are type-checked at compile time. The value is mandatory — a
`consts:` entry without `:= value` is a hard error.

### Scoping

- **File-scoped**: constants are visible throughout the template body,
  including inside `{% for %}`, `{% if %}`, and `{% match %}` blocks.
- **Inherited by inline templates**: `{% tmpl %}` blocks inherit the
  parent template's constants automatically (see
  [Inline Templates — Scoping Rules](#scoping-rules)).
- **Not passed via `with`**: constants are injected automatically into
  the template's scope. They do not appear in `params:` and cannot be
  overridden at render time.

### Imported Constants

When a template is imported via `imports:`, its constants become
accessible via dotted path `stem.CONST_NAME`:

```markdown
---
imports:
  - "[config](./config.tmpl.md)"
---

Notebook: {{ config.NOTEBOOK_FILENAME }}
```

Imported constants follow the same resolution rules as imported types.
They do not need to be passed via `with`.

---

## Compile-Time Environment Variables

The optional `env:` block in frontmatter declares compile-time variables
that are provided externally by the caller via `CompileOptions`. Unlike
`params:` (bound at render time) and `consts:` (defined statically in
the template), `env:` variables are bound at compile time and baked into
the compiled template.

### Syntax

Each entry uses the same syntax as `params:` — `- NAME = type` for
required env vars, and `- NAME = type := default` for optional ones:

```markdown
---
env:
  - PROMPTS_DIR = str
  - MAX_RETRIES = int := 3
  - DEBUG = bool := false

imports:
  - "[session_layout]({{ PROMPTS_DIR }}/session_layout.tmpl.md)"

params:
  - name = str
---

Max retries: {{ MAX_RETRIES }}
Debug: {{ DEBUG }}
```

Env declarations support **all type annotations** — `str`, `int`, `bool`,
`float`, `list(...)`, `struct(...)`, `enum(...)`, etc. — and follow the
same type-checking rules as `params:`.

### Providing Env Values

Env values are provided at compile time via `CompileOptions`:

```rust
# fn main() -> Result<(), Box<dyn std::error::Error>> {
use md_tmpl::{CompileOptions, Template, Value};

let source = "---\nenv:\n  - PROMPTS_DIR = str\n  - MAX_RETRIES = int := 3\n---\nRetries: {{ MAX_RETRIES }}";
let env_vars = [
    ("PROMPTS_DIR", Value::Str("/path/to/prompts".into())),
    ("MAX_RETRIES", Value::Int(5)),
];
let (tmpl, fm) = Template::compile(
    source,
    CompileOptions::default().env(&env_vars),
)?;
# Ok(())
# }
```

In TypeScript:

```typescript
const tmpl = Template.compile(source, {
  env: { PROMPTS_DIR: "/path/to/prompts", MAX_RETRIES: 5 },
});
```

### Defaults

Env vars with defaults (`:=`) are optional in `CompileOptions`:

```yaml
env:
  - MAX_RETRIES = int := 3
```

If `MAX_RETRIES` is not provided via `CompileOptions`, the default `3`
is used. If provided, the caller's value overrides the default.

Env vars **without** defaults are required — omitting them from
`CompileOptions` produces a compile-time error:

```text
compile error: env variable 'PROMPTS_DIR' is required but not provided
```

### Type Checking

Env values are type-checked at compile time:

- Values are provided as typed `Value` variants (e.g., `Value::Int(42)`
  for `int`, `Value::Bool(true)` for `bool`). The provided type must
  match the declared type.
- Type mismatches produce a compile-time error.
- Defaults are type-checked at compile time, same as `consts:` defaults.

### Scoping

- **Available in import paths**: env values are resolved before imports,
  so they can be used in `{{ EXPR }}` interpolation within import paths.
- **Available in template body**: env values behave like `consts:` in
  the body — they are injected into the template scope automatically
  and do not need to be passed via `with`.
- **Not available at render time**: env values cannot be overridden at
  render time. They are baked into the compiled template.

### Import Path Interpolation

Env values are the primary mechanism for dynamic import path resolution —
see [Dynamic Import Path Interpolation](#dynamic-import-path-interpolation)
for full details, examples, and the chained resolution pattern.

See [Frontmatter Binding Summary](#frontmatter-binding-summary) for a
comparison of `consts:`, `env:`, and `params:` binding semantics.

### Collision Rules

Env names follow the same [collision rules](#naming-conventions--collision-rules)
as `params:` and `consts:` — no duplicates, cross-namespace uniqueness,
and PascalCase type binding all apply.

---

## Enum Literal Expressions

When an enum type is declared in `types:` (or as an inline param type),
its variants are automatically available as **namespace constants** using
`TypeName.VariantName` dotted-path syntax. No manual `consts:` entry is
needed — the type declaration itself populates the template scope.

Enum literal expressions **must** be wrapped in the `kind()` built-in
function, which returns the variant name as a string. Bare access
(e.g., `{{ Stage.Design }}`) is a compile error.

### Basic Usage

```markdown
---
types:
  - Stage = enum(Design, Build, Deploy)
  - Status = enum(Active, Paused(reason = str))
---

{{ kind(Stage.Design) }} {# renders: Design #}
{{ kind(Stage.Build) }} {# renders: Build #}
{{ kind(Status.Paused) }} {# renders: Paused #}
```

Both **unit variants** (no fields) and **struct variants** (with fields)
work the same way — `kind()` extracts the variant name as a string
(e.g., `kind(Stage.Design)` → `"Design"`,
`kind(Status.Paused)` → `"Paused"`).

### Iterating over Variant Names with `kinds()`

To get a list of all variant names of an enum type (in declaration order), use the `kinds()` built-in function:

```markdown
---
types:
  - Stage = enum(Design, Build, Deploy)
---

All stages: {{ kinds(Stage) | join(", ") }}

> {% for stage in kinds(Stage) %}

- Stage: {{ stage }}

> {% /for %}
```

Attempting to iterate over an enum type directly without `kinds()` (e.g., `{% for s in Stage %}`) is rejected at compile time with an error suggesting `kinds(Stage)`.

**Rationale:** requiring `kind()` prevents confusion between enum type
namespace access and regular variable dot-access (e.g., `struct.field`).
The explicit `kind()` call makes the intent unambiguous.

### Imported Enum Literals

Enum types from imported templates are accessible via the import
stem, following the same dotted-path convention as imported types
and constants:

```markdown
---
imports:
  - "[lib](./lib.tmpl.md)"
---

{{ kind(lib.Stage.Design) }} {# renders: Design #}
{{ kind(lib.Status.Paused) }} {# renders: Paused #}
```

The path follows the pattern `stem.TypeName.VariantName`.

### Precedence

If a user-defined constant in `consts:` has the same name as a `types:`
entry, the constant takes precedence in the template scope. However,
this situation is normally prevented by the
[collision rules](#naming-conventions--collision-rules) — a `consts:`
name that collides with a `types:` name is a compile error.

### Compile-Time Guarantees

- **Bare access** — `{{ Stage.Design }}` without `kind()` is a
  compile error.
- **Unknown variant** — `kind(Stage.Nonexistent)` is a compile error.
- **Unknown type** — `kind(Nonexistent.Design)` is a compile error.
- **Non-enum type** — accessing variants on a `struct` or scalar type
  is a compile error.

---

## Naming Conventions & Collision Rules

### PascalCase Naming

Generated Rust and Python types use `PascalCase` for type names:

- Param `tasks` → type `Tasks`
- Param `category` → type `Category`
- Param `code_review` → type `CodeReview`

Type alias names in `types:` are used as-is (they should already be
`PascalCase` by convention).

### Collision Rules

All naming checks run at compile time and produce syntax errors.

**Reserved names** — the following cannot be used as parameter, constant,
or type alias names:

- **Built-in type names**: `str`, `bool`, `int`, `float`, `list`, `struct`,
  `enum`, `tmpl`, `option`, `params`.
- **Pattern-syntax keywords**: `true`, `false`, `Some`, `None`, `_` — these
  have special meaning in `{% case %}` arms and boolean/option contexts.
- **Internal keys**: `__kind__`, `__variants__` — reserved for internal enum
  variant tagging and variant enumeration.
- **Codegen collision guards**: `__self`, `__Self`, `__super`, `__crate` —
  Rust codegen renames `self` → `__self` etc. because these cannot be raw
  identifiers; the mangled names are reserved to prevent collisions.

Using any of these as a name produces a compile-time error.

**Reserved internal key** — the key `__kind__` is reserved for internal
enum variant tagging. Accessing it via dot-path (e.g., `{{ item.__kind__ }}`)
is a **compile-time error**. Setting it directly in `Context` causes a
runtime panic. Use `kind(expr)` to extract variant names instead.

**No duplicate names** — within each block (`params:`, `consts:`,
`types:`), names must be unique.

**Cross-namespace uniqueness** — the following names must all be
distinct from each other: param names, const names, type alias names,
import stems, and inline template names. Additionally, the `PascalCase`
form of a param/const name must not collide with a type alias or
import stem.

**PascalCase type binding** — if a `types:` entry exists whose name
equals the `PascalCase` of a param or const (e.g., type `Tasks` and
param `tasks`), the declaration's type **must** be that alias.

**Unused type aliases** — a `types:` entry never referenced by any
param or const is rejected (unless `allow_unused: true`). Enum types
are exempt — their variants are injected as namespace constants.

**For-loop binding shadowing** — a `{% for %}` binding must not shadow
a declared param, const, import stem, or inline template name.
Sequential loops may reuse the same binding name.

**Target-language keywords** — keywords from host languages (Rust's
`type`, `match`, `loop`, `fn`; TypeScript's `class`, `delete`, `typeof`;
Python's `def`, `class`, `del`, etc.) are **not** reserved by md-tmpl.
They are valid as parameter, constant, and field names.

Each backend is responsible for emitting valid code when these names
appear in generated types:

- **Rust proc-macro** (`template!`, `include_template!`): The codegen
  automatically uses raw identifiers (`r#type`, `r#match`, etc.) for
  any name that is a Rust keyword. Users access these fields in Rust code
  via the `r#` prefix (e.g., `params.r#type`). For the four keywords that
  cannot be raw identifiers (`self`, `Self`, `super`, `crate`), the codegen
  prefixes with `__` (e.g., `self` → `__self`) and emits
  `#[serde(rename = "self")]` for serialization compatibility. Users access
  these fields as `params.__self`.
- **TypeScript**: Interface properties and object keys accept all
  keywords without escaping (`{ type: string }` is valid TypeScript).
  No special handling is needed.
- **Runtime API**: Both `Context::set("type", ...)` (Rust) and
  `{ type: "value" }` (TypeScript/JavaScript) work with any name.

---

## Expression Syntax

Variable substitution: `{{ expr }}`

```markdown
{{ name }}
{{ task.title }}
{{ task.component.label }}
```

Dotted paths resolve nested struct and enum fields. Accessing a field that does
not exist on the resolved type is a compile-time error.

### Optional Namespace Prefixes

Variables in template expressions may optionally carry an explicit namespace prefix corresponding to their declaration source:

- `consts.NAME` — resolves a constant declared in `consts:`
- `params.name` — resolves a parameter declared in `params:`
- `opts.NAME` / `options.NAME` — resolves a compile-time environment variable declared in `env:`

These prefixes are optional syntactic sugar for readability and are stripped during identifier resolution (e.g. `{{ consts.MAX_RETRIES }}` is equivalent to `{{ MAX_RETRIES }}`).

### Renderable Types

Only **scalar types** can appear directly in `{{ }}` expressions:

| Type    | Rendered as                 |
| ------- | --------------------------- |
| `str`   | The string value            |
| `int`   | Decimal integer (e.g. `42`) |
| `float` | Decimal float (e.g. `3.14`) |
| `bool`  | `true` or `false`           |

Attempting to render a non-scalar type directly is a **compile-time error**.
Use the appropriate construct instead:

| Type     | Correct usage                                                       |
| -------- | ------------------------------------------------------------------- |
| `list`   | `{% for item in items %}{{ item.field }}{% /for %}`                 |
| `struct` | `{{ config.timeout }}` (access individual fields)                   |
| `enum`   | `{% match status %}` or `{{ kind(status) }}`                        |
| `tmpl`   | `{% include widget with field = value %}`                           |
| `option` | `{% if has(x) %}{{ x }}{% /if %}` (narrowing unwraps to inner type) |

Enum types declared in `types:` also support dotted-path access to their
variants via the `kind()` function — see
[Enum Literal Expressions](#enum-literal-expressions).

### Literal Expressions

Anywhere an expression is accepted — `{{ }}` output, filter input
(`{{ expr | filter }}`), [string interpolation](#string-interpolation),
`{% if %}` conditions, `==` comparisons, `{% case %}` labels, and
`{% panic(...) %}` — a **literal** and a **variable** are interchangeable:

| Literal kind | Example      | Renders as |
| ------------ | ------------ | ---------- |
| `str`        | `{{ "hi" }}` | `hi`       |
| `int`        | `{{ 42 }}`   | `42`       |
| `float`      | `{{ 3.14 }}` | `3.14`     |
| `bool`       | `{{ true }}` | `true`     |

A literal renders exactly as a variable of the same type would (see
[Renderable Types](#renderable-types)). This **auto-stringification applies
only to scalars at the display boundary** — non-scalar values
(`list`/`struct`/`enum`/`option`) still cannot be rendered directly and must be
unwrapped/iterated as shown above. There is no `str()` cast: display already
stringifies scalars, and filters that require a string value (e.g. `upper`) still
reject non-string values by type (`{{ 42 | upper }}` is an error).

**Numeric literal grammar:** `-?[0-9]+(\.[0-9]+)?` — an optional leading `-`,
one or more digits, and an optional single fractional part with digits on **both**
sides of the dot. Not accepted (each is an error, never a silent `NaN`):
scientific notation (`1e3`), hex (`0x10`), unary plus (`+5`), and bare `3.` / `.5`.
Leading zeros are normalized (`007` → `7`). Whole-valued floats drop the
fractional part (`3.0` → `3`), and negative zero renders `0` (`-0.0` → `0`).

String literals support the same escapes and `{{ }}` interpolation as
[string defaults](#string-literal-syntax).

> **Note:** built-in functions (`len`, `has`, `kind`, `kinds`, `idx`) take a
> variable or loop binding as their argument, not a literal.

---

## Filters

Pipe operator chains transforms left-to-right: `{{ expr | filter | filter }}`

Attempting to use an unrecognized filter name is rejected with a syntax error at compile time.

```markdown
{{ name | upper }}
{{ name | trim | lower }}
{{ score | fixed(2) }}
{{ items | join(", ") }}
```

| Filter        | Input  | Output | Description                       |
| ------------- | ------ | ------ | --------------------------------- |
| `upper`       | str    | str    | UPPERCASE                         |
| `lower`       | str    | str    | lowercase                         |
| `trim`        | str    | str    | Strip leading/trailing whitespace |
| `fixed(N)`    | number | str    | Format with N decimal places      |
| `join("sep")` | list   | str    | Join list items with separator    |
| `limit(N)`    | list   | list   | Take first N elements             |
| `add(N)`      | number | number | Add N to the value                |
| `sub(N)`      | number | number | Subtract N from the value         |

> **Note:** `join()` is designed for **scalar lists** (`list(str)`, `list(int)`,
> etc.). Applying `join()` to a struct-typed list (e.g., `list(name = str,
score = int)`) produces a render-time error — use `{% for %}` and render
> fields individually instead.

---

## Built-in Functions

| Function       | Returns | Description                                                                                                                                                                                                                              |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idx(binding)` | int     | 0-based loop index of a `for` binding                                                                                                                                                                                                    |
| `len(expr)`    | int     | Length of a list (element count) or string (byte length). Structs, enums, and other types are rejected.                                                                                                                                  |
| `kind(expr)`   | str     | Variant name of an enum value or option value (returns `"Some"` or `"None"` for options). Also works with [enum literal expressions](#enum-literal-expressions), e.g. `kind(Status.Paused)`                                              |
| `kinds(type)`  | list    | List of strings representing all variant names of an enum type (in declaration order), e.g. `kinds(Status)`. Errors on non-enum                                                                                                          |
| `has(expr)`    | bool    | `true` if an `option(T)` is `Some`, and narrows `expr` to `T` in the guarded branch. Requires an `option(T)` — other types are a compile error (use bare truthiness `{% if expr %}` for `str`/`list`). See [Option Types](#option-types) |

`idx()` tracks each loop variable independently in nested loops:

```rust
use md_tmpl::{ctx, Template};

let tmpl = Template::from_source("---
params:
  - outer = list(label = str)
  - inner = list(label = str)
---
> {% for a in outer %}{% for b in inner %}{{ idx(a) }}.{{ idx(b) }} {% /for %}{% /for %}").unwrap();

let output = tmpl.render_ctx(&ctx! {
    outer: [{ label: "x" }, { label: "y" }],
    inner: [{ label: "p" }, { label: "q" }],
}).unwrap();
assert_eq!(output, "0.0 0.1 1.0 1.1 ");
```

---

## String Interpolation

Quoted string literals inside **statements** support `{{ expr }}` interpolation.
The embedded expressions are evaluated at render time, just like top-level
`{{ }}` tags in the template body.

This applies uniformly wherever a quoted string appears in a statement:

| Context                          | Example                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| **Condition comparisons** (`if`) | `{% if role == "admin_{{ env }}" %}`                       |
| **`in` operator**                | `{% if "item_{{ key }}" in items %}`                       |
| **Panic messages**               | `{% panic("unsupported: {{ kind(status) }}") %}`           |
| **Include `with` values**        | `{% include widget with title = "{{ name }}'s profile" %}` |

Expressions inside interpolations follow the same rules as body expressions:
dotted paths, function calls (`len()`, `kind()`, etc.), and filters
(`| upper`, `| trim`, etc.) are all supported.

### Examples

```markdown
---
params:
  - role = str
  - env = str
---

> {% if role == "admin_{{ env }}" %}

You are an admin on {{ env }}.

> {% else %}

Access denied.

> {% /if %}
```

```markdown
---
params:
  - name = str
---

> {% panic("unknown user: {{ name | upper }}") %}
```

Plain strings without `{{ }}` are treated as literal values with no
interpolation overhead.

### String Literal Syntax

String literals are delimited by double quotes (`"`) or single quotes (`'`).
The following backslash escape sequences are interpreted:

| Escape | Result        |
| ------ | ------------- |
| `\\`   | a literal `\` |
| `\"`   | a literal `"` |
| `\'`   | a literal `'` |

Any other `\X` sequence is preserved **verbatim** — both the backslash and the
following character are kept — so content such as Windows paths (`"C:\path"`) or
regex snippets is unaffected. C-style whitespace escapes like `\n` and `\t` are
**not** interpreted.

Escapes are honored everywhere a string literal appears: statement conditions,
`{% case %}` / `{% match %}` labels, `include … with` arguments, and frontmatter
`:= …` defaults (including inside `list`, `struct`, and enum-variant literals).
Because `\"` does not close a string, a quoted element like `["a\", b", "c"]`
parses as two items rather than a parse error.

Escapes compose with `{{ }}` interpolation: escapes are decoded first, then
interpolation runs, so `"he said \"{{ name }}\""` with `name = "Alice"` renders
`he said "Alice"`.

### Error Behavior

| Condition                          | Error                                   |
| ---------------------------------- | --------------------------------------- |
| Unclosed `{{` (no matching `}}`)   | Syntax error: `unclosed '{{'`           |
| Empty expression `{{ }}`           | Syntax error: `empty expression '{{}}'` |
| Undeclared variable inside `{{ }}` | Compile error: `undeclared variable`    |

---

## Control Flow

### For Loops

```markdown
> {% for task in tasks %}

- **{{ task.title }}**: {{ task.description }}

> {% /for %}
```

`{% for x in y %}` requires `y` to be a `list` type — enforced at compile time.
The iterable `y` may be a param, a local `consts:` list, or an imported constant
list (e.g., `{% for row in lib.ITEMS %}`); element fields are type-checked in all
cases. Iterating over an `option(list(...))` is a type error; use
`{% if has(y) %}{% for x in y %}...{% /for %}{% /if %}` instead.

#### `for...else`

An optional `{% else %}` block renders when the list is **empty**:

```markdown
> {% for agent in agents %}

- {{ agent.name }}

> {% else %}

No agents available.

> {% /for %}
```

- When `agents` has items → only the loop body is rendered.
- When `agents` is empty → only the else body is rendered.
- `{% else %}` inside nested `{% if %}` or `{% for %}` blocks is
  correctly scoped — it does **not** interfere with the for-else.
- The loop binding (e.g. `agent`) is **not** in scope inside the else body.

### Conditionals

<!-- prettier-ignore -->
```markdown

> {% if severity == "critical" %}

🔴 Immediate action required.

> {% elif severity == "high" %}

🟠 High priority.

> {% else %}

🟢 Normal.

> {% /if %}
```

Comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `in`.

Boolean operators: `&&` (logical AND), `||` (logical OR), `!` (unary NOT), `()` (grouping).

Plain identifiers are evaluated for truthiness. String literal operands
support `{{ }}` interpolation (see [String Interpolation](#string-interpolation)).

#### Operator Precedence

From highest to lowest:

| Precedence  | Operator(s)                            | Description    |
| ----------- | -------------------------------------- | -------------- |
| 1 (highest) | `!`                                    | Unary negation |
| 2           | `==`, `!=`, `<`, `>`, `<=`, `>=`, `in` | Comparisons    |
| 3           | `&&`                                   | Logical AND    |
| 4 (lowest)  | `\|\|`                                 | Logical OR     |

#### Boolean Expression Examples

```markdown
{# AND: both conditions must be true #}

> {% if a > 0 && b > 0 %}both positive{% /if %}

{# OR: at least one condition must be true #}

> {% if a > 0 || b > 0 %}at least one positive{% /if %}

{# NOT: negate a function call #}

> {% if !has(x) %}x is missing{% /if %}

{# NOT with grouping: negate a comparison #}

> {% if !(a > 0) %}a is not positive{% /if %}

{# Combined: grouping controls evaluation order #}

> {% if (a || b) && c %}complex condition met{% /if %}
```

The `in` operator checks for substring or element membership, or static enum variant validity:

- **String / List membership**: `{% if "admin" in roles %}` or `{% if !("err" in status_str) %}`.
- **Enum variant checking with `kinds()`**: You can statically check whether a string literal matches an enum variant using `{% if "Superuser" in kinds(Role) %}`. When the right-hand side is `kinds(EnumType)` and the left-hand side is a static string literal, the engine validates at compile time that the string literal is indeed a valid variant of that enum type!

> **Note:** Use `!` for negation (e.g. `!flag`, `!(x in y)`).
> The `not` keyword is not supported.

#### Truthiness

Conditions in `{% if %}` / `{% elif %}` / inline guards are evaluated for **truthiness**. `bool`, `str`, `int`, `float`, and `list` have truthiness; `option(T)`, `struct`, `enum`, and `tmpl` do not and are a compile-time type error as a bare condition (use `has(x)` to check option presence, field access, `{% match %}`, or `{% include %}` instead).

| Type in `{% if expr %}` | Allowed? | Truthiness & narrowing behavior                                                                            |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `bool`                  | ✅       | The boolean value itself (`true` / `false`).                                                               |
| `str`                   | ✅       | Non-empty is `true`; `""` is `false`.                                                                      |
| `int` / `float`         | ✅       | Non-zero is `true`; `0` / `0.0` is `false`.                                                                |
| `list(...)`             | ✅       | Non-empty is `true`; `[]` is `false`.                                                                      |
| `option(T)`             | ❌       | Compile-time type error — option has no bare truthiness. Use `has(x)` to check presence and unwrap to `T`. |
| `struct(...)`           | ❌       | Compile-time type error — a struct has no truthiness. Test a specific field (e.g. `{% if s.enabled %}`).   |
| `enum(...)`             | ❌       | Compile-time type error — an enum has no truthiness. Use `{% match %}` (or `{{ kind(e) }}`) for dispatch.  |
| `tmpl(...)`             | ❌       | Compile-time type error — a template handle has no truthiness. Use `{% include %}` to render it.           |

> **Tip:** For explicit intent, prefer `has(expr)` (option presence) or an explicit comparison (`count > 0`, `name != ""`, `len(items) > 0`) over relying on bare truthiness.

> **Note:** Enum values cannot be compared with `==`/`!=`. Use `{% match %}` for
> enum dispatch — it provides exhaustiveness checking and struct variant support.

### Match / Case (Enums)

Dispatch on enum variants with compile-time exhaustiveness checking:

**Multi-arm** (must cover all variants):

<!-- prettier-ignore -->
```markdown

> {% match outcome %}
> {% case Confirmed %}

Confirmed with evidence.

> {% case NotConfirmed %}

Not confirmed.

> {% /match %}
```

**Catch-all arm** (fallback for unmatched variants):

<!-- prettier-ignore -->
```markdown

> {% match outcome %}
> {% case Confirmed %}

Confirmed with evidence: {{ outcome.evidence }}

> {% case NotConfirmed %}

Not confirmed.

> {% else %}

Outcome pending.

> {% /match %}
```

The `{% else %}` arm matches any variant not covered by preceding `{% case %}` arms.
It must be the last arm — placing `{% case %}` after `{% else %}` is a compile error.

**Multi-variant arm** (shared body for several variants):

<!-- prettier-ignore -->
```markdown

> {% case Confirmed | ConfirmedWithCaveats %}

Evidence found.
```

**Inline guard** (renders only if variant matches):

```markdown
> {% match category case Labelled %}({{ category.label }}){% /match %}
```

Inside a `{% match %}` arm, the variant's fields are accessible via `expr.field`
after type narrowing:

- `{% case A | B %}` — only fields present on **both** A and B are accessible.
- `{{ outcome.evidence }}` outside a `{% case Confirmed %}` is a compile error
  if `evidence` is not shared by all variants.

### Match / Case (All Types)

`{% match %}` supports matching on **any scalar type** — not only enums and
options but also `str`, `int`, `bool`, and `float`:

<!-- prettier-ignore -->
```markdown

> {% match status %}
> {% case "Active" %}

Currently active.

> {% case "Paused" %}

On hold.

> {% else %}

Unknown status.

> {% /match %}
```

**Inline guard** (renders only if the value matches):

```markdown
> {% match role case "Admin" %}⚙️ admin panel{% /match %}
```

**Multi-value arm** (shared body for several values):

```markdown
> {% case "Active" | "Pending" %}
```

**Scalar matching** (`int`, `bool`, `float`):

```markdown
> {% match count %}
> {% case 0 %}

No items.

> {% case 1 %}

One item.

> {% else %}

Multiple items.

> {% /match %}
```

> **Best practice:** Prefer `enum` types and unquoted variant names for
> dispatch whenever possible. Enum matching provides exhaustiveness checking
> and compile-time variant validation that scalar matching cannot.

#### Case Label Semantics

| Syntax                    | Meaning                   | Valid on       | Example                                                             |
| ------------------------- | ------------------------- | -------------- | ------------------------------------------------------------------- |
| `{% case Active %}`       | Enum variant name         | `enum` types   | `{% match status case Active %}`                                    |
| `{% case "Active" %}`     | String literal value      | `str` only     | `{% match name case "Alice" %}`                                     |
| `{% case "{{ expr }}" %}` | Interpolated string label | `str` only     | `{% match status case "{{ expected }}" %}`                          |
| `{% case Some %}`         | Option discriminant       | `option` types | `{% match label case Some %}`                                       |
| `{% case other %}`        | Param-reference match     | any type       | `{% match status case expected %}` (resolves `expected` at runtime) |
| `{% case 42 %}`           | Numeric literal           | `int`, `float` | `{% match count case 0 %}`                                          |
| `{% case true %}`         | Boolean literal           | `bool`         | `{% match enabled case true %}`                                     |

- **Unquoted** case labels on **enum** or **option** params are **type
  identifiers** — enum variant names or option discriminants (`Some`, `None`).
  They are validated against the declared type at compile time.
- **Unquoted** case labels on **non-enum** params are compared literally
  against the stringified value at runtime. They can also act as param-reference
  matches: if the label resolves as a declared parameter, its runtime value
  is used for comparison and the parameter is counted as referenced (it will
  not trigger an unused-parameter error).
- **Quoted** case labels (including interpolated strings — see below) are
  **string literal comparisons**. They are only valid on `str` parameters;
  using them on `int`, `bool`, or `float` is a compile error.
  Both `"double"` and `'single'` quotes are valid.
- **Quoted case labels on enum params are a compile error** — use unquoted
  variant names instead. The error message directs you to remove the quotes.
- Unquoted case labels on **enum** params that are not declared variant
  names are a **compile error** (typo protection).

#### Interpolation in Quoted Case Labels

Quoted case labels support `{{ expr }}` interpolation, just like quoted
strings in condition expressions:

```markdown
> {% match status %}{% case "{{ expected }}" %}matched{% else %}no match{% /match %}
```

The `{{ expr }}` inside the quoted label is evaluated at render time. This
enables dynamic matching — the label value is computed from the current scope.

**Concatenation** is supported:

```markdown
> {% match status %}{% case "{{ prefix }}_done" %}done{% else %}pending{% /match %}
```

**`kind()` in labels** — combine with enum type constants for type-safe
dynamic matching:

```markdown
> {% match status %}{% case "{{ kind(TaskState.Active) }}" %}on{% else %}off{% /match %}
```

> **Tip:** To compare a `str` parameter against a known enum variant name,
> use `{% if status == kind(Status.Active) %}` instead of `{% match %}`.
> The `kind()` function returns the variant name as a string, enabling
> type-safe string comparisons against enum variant names.

#### Differences from enum matching

Non-enum matching differs from enum matching in several ways:

- **No exhaustiveness** — scalar values are unbounded, so exhaustiveness
  checking does not apply. Use `{% else %}` for unmatched values.
- **No field narrowing** — scalars have no fields; the matched expression
  type remains unchanged inside each arm.

#### Compile-time guarantees for `match`

1. **Variant validation** — unknown variant names → compile error (enum only).
2. **Field narrowing** — field access outside a matching arm → compile error (enum only).
3. **Multi-variant intersection** — only shared fields are accessible (enum only).
4. **Exhaustiveness** — multi-arm matches must cover **all** variants (enum only). Adding a
   new variant to the enum and forgetting to handle it is a compile error.
   Use `{% else %}` as a catch-all if you don't need per-variant handling.
5. **No `==` on enums** — comparing an enum with `==` or `!=` is a compile error.
   Do not use `kind()` to work around this — string comparisons defeat
   exhaustiveness checking and break silently when variants are renamed.
   Always use `{% match %}` for enum dispatch.
6. **Syntax validity** — a `match` block without an expression, without any
   case arms, or with empty variant names in `{% case %}` is a syntax error.
7. **Quoted labels on enums** — quoted string literals on an `enum` param are
   compile errors (with a helpful message directing you to use unquoted variant
   names instead).
8. **Case label type consistency** — case labels must match the expression type.
   Numeric literals on `str`, quoted strings on `int`/`bool`/`float`, bool
   literals on `int`, etc. are compile errors with suggestions for the correct
   syntax.
9. **No `kind()` in match expression** — `{% match kind(x) %}` is a compile
   error. Matching on `kind()` converts the enum to a string, defeating
   exhaustiveness checking. Use `{% match x %}` with unquoted variant names
   instead.

### Match as Boolean Condition

A `match X case Y` expression can be used inside `{% if %}` as a boolean
sub-expression. It evaluates to `true` if the variant matches, `false`
otherwise:

```markdown
> {% if match status case Active %}status is active{% /if %}

> {% if match status case Active | Pending %}actionable{% /if %}
```

**Multi-variant**: `match X case A | B` matches if the value is variant
A or variant B.

**Combining with boolean operators**: `match ... case ...` can be combined
with `&&`, `||`, and `!` like any other boolean expression:

```markdown
> {% if match status case Approved | Pending && count > 0 %}
> process items
> {% /if %}
```

> **Note:** No field narrowing occurs in the `{% if %}` body when using
> `match` as a boolean condition. Use `{% match %}` blocks for field access.

### Match Guards

Inline `{% match %}` blocks support an optional guard expression using
`&&`. The guard is evaluated after the variant matches; the body is
rendered only if both the variant matches **and** the guard is truthy:

```markdown
> {% match status case Approved && status.score > 80 %}
> high-scoring approval: {{ status.score }}
> {% /match %}
```

**Multi-variant with guard**: the guard applies to all listed variants:

```markdown
> {% match status case Approved | Pending && count > 0 %}
> actionable item
> {% /match %}
```

Inside the match body, field narrowing still applies — the matched
variant's fields are accessible via `expr.field` as usual.

---

## Option Types

`option(T)` is a first-class way to express optional/nullable values.

### Declaration

```yaml
params:
  - name = option(str) # required — caller MUST provide a value or null
  - score = option(int) := None # optional — defaults to absent (no automatic None default!)
  - label = option(str) := "hello" # optional — defaults to "hello" (auto-wrapped to Some)
```

> [!IMPORTANT]
> **`option(T)` does NOT default to `None`.** A bare `option(str)` param
> is _required_ — the caller must explicitly provide a value or `null`.
> To make it truly optional, add `:= None` as a default.

### Representation

Option values are **transparent** — the inner value is used directly:

| Host input (`null`/value) | Template `Value`    | `{{ x }}` output | JS repr   |
| ------------------------- | ------------------- | ---------------- | --------- |
| `null` / `None`           | `NoneValue`         | `""` (empty)     | `null`    |
| `42`                      | `IntValue(42)`      | `42`             | `42`      |
| `"hello"`                 | `StrValue("hello")` | `hello`          | `"hello"` |

> **Note:** Only the bare `None` keyword (or a host `null` / `None`) is the
> absent sentinel. A **quoted** string `"None"` is an ordinary present value:
> `option(str) := "None"` yields `Some("None")`, so `has(x)` is `true` and
> `{{ x }}` renders `None`. The string never masquerades as the sentinel — this
> holds for both parsed defaults and runtime-supplied values.

### Condition Truthiness & Presence

Expressions evaluated inside `{% if expr %}` or `{% elif expr %}` evaluate truthiness naturally according to their value:

- **`bool`**: `true` evaluates to `true`, `false` evaluates to `false`.
- **`str`**: Non-empty string (`s != ""`) evaluates to `true`, empty string (`""`) evaluates to `false`.
- **`list(...)`**: Non-empty collection (`len > 0`) evaluates to `true`, empty list (`[]`) evaluates to `false`.
- **`int` / `float`**: Non-zero evaluates to `true`, zero (`0` / `0.0`) evaluates to `false`.
- **`option(T)`**, **`struct`**, **`enum`**, **`tmpl`**: Have **no bare truthiness**. Evaluating them directly in `{% if %}` is a compile-time type error.

### Checking Option presence with `has()`

`has(x)` is `true` when an `option(T)` is `Some`, and `false` when `None`. It requires an `option(T)`. `has(x)` **narrows** `x` to `T` in the guarded branch body and in subsequent `&&` condition operands (e.g. `{% if has(test) && test %}`):

```markdown
> {% if has(maybe_name) %}

Hello {{ maybe_name }}!

> {% else %}

Hello stranger!

> {% /if %}
```

Presence narrowing is **branch-local**: evaluating an `option(T)` as `true` makes the inner value usable
only in the branch that proves presence. In the `{% else %}` of
`{% if x %}`, the body of `{% if !has(x) %}`, and the `{% case None %}`
arm, `x` remains an absent option — accessing its inner value there is an
error, so a `None` value can never leak into an absent branch. (Implementations
may report this at compile time or at render time.)

### Inspecting variant name with `kind()`

`kind(opt)` returns `"Some"` or `"None"` as a string:

```markdown
Option status: {{ kind(name) }} {# renders "Some" or "None" #}
```

### Matching with `{% match %}`

```markdown
> {% match name %}
> {% case Some %}

Name: {{ name }}

> {% case None %}

_(no name provided)_

> {% /match %}
```

Inside `{% case Some %}`, `{{ name }}` renders the inner value directly.
Outside the match, `{{ name }}` on a `None` value renders as empty string.

### Nesting

Options can be nested with any type:

```yaml
params:
  - items = list(option(str)) # list of optional strings
  - meta = option(struct(k = str)) # optional struct
  - nested = option(option(int)) # double-optional (unusual but valid)
```

---

## Panic Statements

The `{% panic(...) %}` statement tag halts rendering with a fatal error.

```markdown
> {% if count < 0 %}
> {% panic("count must not be negative") %}
> {% /if %}

> {% if !has(config.host) %}
> {% panic(config.error_message) %}
> {% /if %}
```

- **Literal strings**: `{% panic("error message") %}` — fails with
  `template panic: error message`. String content supports `{{ }}`
  interpolation (see [String Interpolation](#string-interpolation)):
  `{% panic("unsupported role: {{ role }}") %}`.
- **Variable reference**: `{% panic(err_msg) %}` — evaluates the
  expression and uses its value as the error message.

---

## Includes

```markdown
> {% include [name](./path.tmpl.md) %}
> {% include [child](./child.tmpl.md) with msg=greeting %}
> {% include [row](./row.tmpl.md) for item in items %}
> {% include [row](./row.tmpl.md) for item in items with extra=val %}
```

- The `[name]` part is a standard markdown link — clickable in editors.
- The `(path.tmpl.md)` is the file path, resolved **relative to the including
  template's directory**. The same [strict path requirement](#cross-template-imports)
  applies — relative paths must begin with `./` or `../`.
  Named template references (`{% include my_tmpl %}`) and absolute paths
  starting with `/` do not require relative prefixes.
- **Dynamic include path interpolation**: file paths support `{{ expr }}`
  interpolation (e.g., `{% include [foo]({{ SOME_DIR }}/foo.tmpl.md) %}`).
  Expressions are evaluated against the active scope **prior** to file
  system lookup or template caching. The same error and path validation
  rules as [import path interpolation](#dynamic-import-path-interpolation)
  apply.
- **Explicit parameter passing** via `with` is required; no implicit scope
  leaking. String literal values support `{{ }}` interpolation
  (see [String Interpolation](#string-interpolation)).
- **Iterated includes** via `for binding in list` unroll the list: for
  each element, the included template is rendered with `binding` set to the
  current item. The binding name satisfies the included template's
  parameter declaration of the same name. `idx(binding)` provides the
  0-based loop index inside the included template. Combined `for + with`
  syntax is also supported, passing additional explicit overrides alongside
  the iteration binding.
- **Bare name includes**: if the include name refers to an inline template
  defined via `{% tmpl name %}` (or a variable of type `tmpl(...)`), use
  `{% include name with ... %}` without the markdown link syntax.
- **Resolution order** for bare name includes:
  1. **Inline templates** — `{% tmpl name %}...{% /tmpl %}` definitions in
     the current file.
  2. **`tmpl(...)` parameter variables** — if the name resolves to a
     variable of type `tmpl(...)`, the engine renders the referenced
     template with the `with` values. This enables higher-order template
     composition (passing templates as callback-like parameters).
  3. **Filesystem** — falls through to file-based lookup.
- Parameters are type-checked against the included template's frontmatter.

**Higher-order template include example:**

```markdown
---
params:
  - widget = tmpl(name = str)
---

> {% include widget with name="World" %}
```

When `widget` is a `tmpl(name = str)` typed parameter, the engine resolves
it as a template reference and renders it with `name="World"`. The included
template's parameter declarations are validated against the `tmpl(...)`
signature at the point the value is provided.

### Depth Limits

- **Runtime**: Default max nesting depth is 16, configurable via
  `.with_max_include_depth(n)`.
- **Compile-time** (`include_template!`): Default 64. Override with
  `MD_TMPL_MAX_INCLUDE_DEPTH` env var.
- **Circular `{% include %}`** hits the depth limit at runtime.
  At compile time, cycles are not fatal — declarations are loaded for
  type checking but the body is not recursed into.

### Import Resolution

`imports:` reads the target file's frontmatter (types, consts) but does
**not** recursively chase the target's own `imports:`. See
[Transitive Imports](#transitive-imports) for details on how multi-level
import chains work.

- **Mutual imports work**: A imports B, B imports A — no problem.
- **Duplicate imports** (same canonical path twice) are rejected.
- **No transitive access**: A importing B does not give A access to
  B's imports. Import explicitly.

### Include Path Interpolation Scope

| Available in `{% include %}` paths    | Available in `imports:` paths               |
| ------------------------------------- | ------------------------------------------- |
| ✅ `env:`, `consts:`, imported consts | ✅ `env:`, `consts:`, prior imported consts |
| ✅ `params`, loop variables           | ❌ `params`, loop variables                 |

Param-based include paths work but skip compile-time type checking
(path unknown until render time).

### Static vs. Dynamic Includes (Async / Browser Implications)

There are two classes of file include, and the distinction matters for any
environment without **synchronous** file I/O (browsers, Deno, edge runtimes):

- **Static include path** — the path is a literal, e.g.
  `{% include [x](./sections/intro.tmpl.md) %}`. The target file is known
  from the source alone, before any render.
- **Dynamic include path** — the path embeds `{{ expr }}` interpolation, e.g.
  `{% include [x](./sections/{{ section }}.tmpl.md) %}`. Two sub-cases:
  - If the interpolated expressions reference only `env:`/`consts:`/imported
    consts, the path is still **param-independent** and resolvable at load time
    (like `imports:` paths).
  - If they reference `params` or loop variables, the target file depends on
    the values passed to `render()` and is only known at **render time**, per
    render.

Implications:

- The **transitive set of files a template needs is not statically knowable**
  in the presence of dynamic include paths. You cannot, in general, compute
  the full closure by walking the AST — a dynamic segment can resolve to any
  file for a given parameter set.
- In **Node** this is a non-issue: include resolution reads files
  synchronously (`readFileSync`) on demand during rendering, so dynamic paths
  "just work".
- In **browsers / async-only runtimes**, file bytes can only be fetched
  asynchronously (`fetch`), but rendering is synchronous. Two consequences:
  1. **Static** closures _can_ be pre-fetched: parse the entry file, collect
     literal `{% include %}` paths and `imports:` targets, fetch them, recurse
     to a fixpoint, then render synchronously against the in-memory set.
  2. **Dynamic** includes cannot be fully pre-fetched from source alone. They
     must be resolved for a specific parameter set. A robust strategy is a
     render-and-retry loop: attempt a synchronous render, catch the
     `IncludeNotFoundError` (which carries the fully-resolved path), fetch that
     one file, and retry until the render succeeds. Because rendering is pure,
     re-rendering is safe; the number of retries is bounded by the number of
     distinct files reached for those params.
- `imports:` paths never interpolate `params` or loop variables (see the scope
  table above), so import closures are **param-independent** — resolvable at
  load time from the compile-time `env:` alone, without any render. However,
  they are **not** a single parallel batch: an import path may interpolate a
  const imported by an **earlier** import (imports resolve sequentially, and
  each import's `stem.NAME` consts become available to subsequent import
  paths). A pre-fetcher must therefore resolve imports **in declared order**,
  potentially fetching import _N_ before it can compute import _N+1_'s path.

### Self-Recursive Includes

A template can include **itself** to render recursive data structures
(trees, nested comments, etc.). The depth limit prevents infinite loops.

> **Note:** The type system does not support self-referential type
> definitions. For recursive data, model the tree as a flat list
> with explicit depth fields, or use an enum to capture node kinds.

### Heterogeneous Lists and Structs

Untyped `list()` and `struct()` are **not allowed** — all containers must
have explicit types. For collections with mixed element types, define
an enum and use it as the element or field type:

<!-- prettier-ignore -->
```markdown
---
types:
  - TreeNode = enum(Leaf(label = str), Branch(label = str, depth = int))

params:
  - nodes = list(TreeNode)
---

> {% for node in nodes %}

> {% match node %}
> {% case Leaf %}

- 🍃 {{ node.label }}

> {% case Branch %}

- 🌿 {{ node.label }} (depth {{ node.depth }})

> {% /match %}
> {% /for %}
```

The same pattern works for structs with heterogeneous value types:

```yaml
types:
  - ConfigVal = enum(Text(val = str), Num(val = int), Flag(val = bool))

params:
  - settings = struct(timeout = ConfigVal, label = ConfigVal)
```

This replaces untyped containers with **exhaustive, type-checked
dispatch** via `{% match %}` — the compiler verifies all variants
are handled.

### Path Resolution

- Include paths are resolved relative to the directory of the file
  containing the `{% include %}` directive.
- At compile time, paths are canonicalized (`realpath`) for cycle detection
  and deduplication. `../common/header.tmpl.md` and `./header.tmpl.md` from
  different directories correctly resolve to the same file.
- The same file included from multiple places is compiled once and its body
  is type-checked once (deduplication by canonical path / `Arc` identity).

### Imports in Included Files

Included templates can declare their own `imports:` block in frontmatter.
These imports are resolved **relative to the included file's directory**
when the file is loaded — just like top-level template imports. This
enables included templates to use strongly typed parameters from imported
enum types, access imported constants, and perform `{% match %}`/`{% case %}`
dispatch on imported enums.

```yaml
# types.tmpl.md — shared type definitions
---
name: types
types: [Role = enum(admin, editor, viewer)]
---
```

```yaml
# child.tmpl.md — included by a parent template
---
imports:
  - "[types](./types.tmpl.md)"

params: [role = types.Role]
---
> {% match role %}
> {% case admin %}
Admin panel
> {% case editor %}
Editor view
> {% case viewer %}
Read-only
> {% /match %}
```

```yaml
# parent.tmpl.md — includes child.tmpl.md
---
params: [role = str]
---
> {% include [child](./child.tmpl.md) with role=role %}
```

Key rules:

- **Relative resolution**: The included file's `imports:` paths are resolved
  relative to the included file's own directory, not the parent's directory.
  An included file in `sub/child.tmpl.md` can import `../types.tmpl.md` to
  reach a file one level above itself.
- **Full type support**: Imported types (`types.Role`), constants
  (`config.APP_NAME`), and enum functions (`kinds(types.Role)`) are all
  available within the included file's body.
- **Type checking at load time**: Type validation on `with` parameters
  happens after the included file's imports are resolved. Passing an
  invalid enum variant to an imported-type param produces a type mismatch
  error.
- **Independent namespaces**: Each included file resolves its own imports
  independently. Two included files can import different type-definition
  files without conflict.
- **Env propagation**: The parent template's compile-time `env:` values
  **are** automatically propagated to included files. An included file
  that declares `env: [PROMPTS_DIR = str]` receives the value from the
  parent's `CompileOptions::env()`. This enables included files to use
  env-based paths for imports or constants.

---

## Inline Templates

Define reusable fragments inline, without separate files:

```markdown
> {% tmpl task_row %}

---

params:

- title = str
- priority = str

---

- **{{ title }}** ({{ priority }})

> {% /tmpl %}

> {% for task in tasks %}
> {% include task_row with title=task.title, priority=task.priority %}
> {% /for %}
```

Inline templates use standard `---` delimited frontmatter inside the
`{% tmpl %}` block — the same syntax as file-based templates. They are
parsed through the same `parse_frontmatter()` path, so all frontmatter
features work identically.

Inline templates support: typed frontmatter (including `types:` and
`imports:` blocks), `with` parameter passing, `for` iteration, and full
type checking. They are compiled once and reused at every include site.

### Scoping Rules

Inline template names (`{% tmpl name %}`) are **scoped to their defining
file**. Each `.tmpl.md` file has its own namespace:

- **No leaking upward**: an included file's `{% tmpl %}` definitions are
  not visible to the parent template.
- **No leaking downward**: a parent's `{% tmpl %}` definitions are not
  visible inside included files.
- **Same name, different files**: two files can both define `{% tmpl row %}`
  with different content. Each file's `{% include row %}` resolves to its
  own definition.
- **Duplicate names in the same file**: rejected at compile time.

This scoping applies identically at compile time (proc macros) and runtime
(dynamic include resolution).

### Type Resolution in Inline Templates

Inline templates can define their own `types:` and `imports:` blocks,
and they also inherit the parent template's `types:` and `imports:`
via lexical scoping. Own definitions shadow parent definitions on name
conflict.

Resolution order for type names in an inline template:

1. Built-in types
2. Own `types:` entries
3. Parent `types:` entries
4. Own `imports:` (dotted path)
5. Parent `imports:` (dotted path)

**Constants** (both local `consts:` and imported constants from the
parent) are inherited by inline templates automatically.

**Params** are _not_ inherited — they must be explicitly passed via
`with` at the include site.

This is by design: constants are file-scoped values (analogous to
`#define`), while params are function arguments that flow through
explicit call sites.

---

## Raw Blocks

Output literal template syntax without processing:

```rust
use md_tmpl::{Context, Template};

let tmpl = Template::from_source("---
params: []
---

> {% raw %}

{{ not_processed }}

> {% /raw %}").unwrap();

let ctx = Context::new();
assert_eq!(tmpl.render_ctx(&ctx).unwrap(), "{{ not_processed }}\n");
```

Custom delimiter to escape `{% /raw %}` itself:

```markdown
> {% raw=# %}
> This outputs {% raw %}...{% /raw %} literally.
> {% /# %}
```

Any string works as the delimiter — `#` is a common choice:

```markdown
> {% raw=# %}{{ not_a_variable }}{% /# %}
```

---

## Comments

Template comments are stripped from output. Parameters referenced inside
`{{ }}` delimiters within comments count as "used" for unused-parameter analysis.
Bare variable names (without `{{ }}`) do **not** count:

```markdown
{# This comment won't appear in output #}
{# {{ reserved_var }} — suppresses unused-parameter error #}
{# reserved_var — bare name, does NOT suppress the error #}
Hello {{ name }}!
```

Use the `{# unused: ... #}` pattern to document intentionally unused parameters:

```markdown
{# unused: {{ role_type }}, {{ agent_name }} #}
```

Multiple `{{ }}` references in a single comment are all tracked. Dotted paths
like `{{ item.label }}` track the root variable (`item`).

---

## Whitespace Control

Add `-` inside any delimiter to strip adjacent whitespace:

| Delimiter | Effect                                                        |
| --------- | ------------------------------------------------------------- |
| `{%-`     | Strips whitespace _before_ the tag (back to previous newline) |
| `-%}`     | Strips whitespace _after_ the tag (through next newline)      |
| `{{-`     | Strips whitespace _before_ the expression                     |
| `-}}`     | Strips whitespace _after_ the expression                      |
| `{#-`     | Strips whitespace _before_ the comment                        |
| `-#}`     | Strips whitespace _after_ the comment                         |

Trim modifiers are designed for **inline** tags where fine-grained whitespace
control is needed. On **standalone blockquote tags** (`> {% ... %}`), trim
modifiers have no additional effect — the blockquote preprocessing layer
already consumes all surrounding blank lines.

```rust
use md_tmpl::{ctx, Template};

let tmpl = Template::from_source("---
params:
  - name = str
---
hello  {{- name -}}
bye").unwrap();

let output = tmpl.render_ctx(&ctx! { name: "world" }).unwrap();
assert_eq!(output, "helloworldbye");
```

---

## Error Diagnostics

All errors include structured context for debugging:

- **Syntax errors** — line number, column, source snippet, and descriptive
  message (e.g. unknown filter, unclosed tag, undeclared variable).
- **Type mismatches** — the full dotted field path to the failing value
  (e.g. `items[1].score`), expected type, and actual type.
- **Missing/extra parameters** — lists of param names that were required
  but absent, or provided but undeclared.
- **Panic** — the rendered panic message from `{% panic("...") %}`.

For language-specific error APIs and host-language integration
(value coercion, caching, code generation, typed builders), see the
[README](README.md).
