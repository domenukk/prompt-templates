# md-tmpl for Go

Strongly-typed prompt templates for LLMs.

## Why?

- **Markdown-native** — prompts live in `.tmpl.md` files, readable in any editor or on GitHub.
- **Strict typing** — every parameter declares a type; mismatches are caught at render time with clear errors.
- **Agent-safe** — when an LLM edits prompts, the engine catches drift immediately.
- **Fast** — 3–6× faster than `text/template` on medium/large templates.

## Quick Example

The template — a plain `.tmpl.md` file:

<!-- prettier-ignore -->
```markdown
---
params:
  - model = str
  - steps = list(tool = str, status = enum(Search(reason = str), Done))
---

# Run: {{ model }}

> {% for step in steps %}

## Step {{ idx(step) }}: {{ step.tool }}

> {% match step.status %}
> {% case Search %}

Searching — {{ step.status.reason }}

> {% case Done %}

✅ Complete

> {% /match %}
> {% /for %}
```

Render it from Go:

```go
import pt "github.com/domenukk/md-tmpl/go/md_tmpl"

// Typed structs map directly to template parameters.
type AgentAction struct {
    pt.TaggedVariant
    Reason string `json:"reason"`
}

func Search(reason string) AgentAction {
    return AgentAction{TaggedVariant: pt.NewTaggedVariant("Search"), Reason: reason}
}

type Step struct {
    Tool   string `json:"tool"`
    Status any    `json:"status"` // Go lacks sum types — use any for enum slots
}

type RunParams struct {
    Model string `json:"model"`
    Steps []Step `json:"steps"`
}

tmpl, _ := pt.FromFile("prompts/run.tmpl.md")
defer tmpl.Close()

result, _ := tmpl.RenderStruct(RunParams{
    Model: "gemini-3.5-flash",
    Steps: []Step{
        {Tool: "web", Status: Search("latest Go release")},
        {Tool: "code", Status: pt.Variant{Kind: "Done"}},
    },
})
```

> **On `Status any`:** Go has no sum types or tagged unions, so enum-typed
> fields use `any`. The template engine validates the variant kind and fields
> at render time — you still get clear errors for mismatches. For static
> typing within Go, embed [`TaggedVariant`](#taggedvariant-static-typing) in
> custom structs.

## Prerequisites

You must compile the native library before running Go tests or builds:

```bash
# Option A: using just (recommended)
just build-go-ffi

# Option B: manual
cargo build -p md-tmpl-ffi --release
```

You will need a working [Rust toolchain](https://rustup.rs/) installed in your environment.

## Installation

Repository: <https://github.com/domenukk/md-tmpl>

```bash
go get github.com/domenukk/md-tmpl/go/md_tmpl
```

## Struct-Based Rendering

Define Go structs that match your template parameters. Fields are mapped
by `json` tag, falling back to lowercased field name:

```go
type ReviewParams struct {
    Reviewer string `json:"reviewer"`
    FilePath string `json:"file_path"`
    Severity string `json:"severity"`
}

tmpl, err := pt.FromFile("prompts/code_review.tmpl.md")
if err != nil {
    log.Fatal(err)
}
defer tmpl.Close()

result, err := tmpl.RenderStruct(ReviewParams{
    Reviewer: "Alice",
    FilePath: "main.go",
    Severity: "high",
})
```

### Type Mapping

| Frontmatter Type            | Go Type in Struct                                    |
| :-------------------------- | :--------------------------------------------------- |
| `str`                       | `string`                                             |
| `int`                       | `int`, `int64`                                       |
| `float`                     | `float64`                                            |
| `bool`                      | `bool`                                               |
| `list(field = type, ...)`   | `[]StructType`                                       |
| `list(type)`                | `[]GoType` (e.g. `[]string`)                         |
| `struct(field = type, ...)` | `StructType`                                         |
| `enum(Variant, ...)`        | `any` (or embedded `TaggedVariant` / `Variant`)      |
| `option(type)`              | `*GoType` (pointer, e.g. `*string`, `nil` if absent) |
| `tmpl(...)`                 | `*Template`                                          |

## Map-Based Rendering

For dynamic use cases, pass a `map[string]any`:

```go
result, err := tmpl.RenderMap(map[string]any{
    "reviewer":  "Alice",
    "file_path": "main.go",
    "severity":  "high",
})
```

## Enum Dispatch

Typed variants with exhaustiveness checking and field narrowing.

### TaggedVariant (static typing)

Embed `TaggedVariant` in Go structs for statically typed variants:

```go
type DoneVariant struct {
    pt.TaggedVariant
    Summary string `json:"summary"`
}

func NewDone(summary string) DoneVariant {
    return DoneVariant{
        TaggedVariant: pt.NewTaggedVariant("Done"),
        Summary:       summary,
    }
}

type StatusParams struct {
    Status any `json:"status"`
}

result, err := tmpl.RenderStruct(StatusParams{
    Status: NewDone("All tests pass"),
})
```

### Dynamic Variant

When the variant is determined at runtime:

```go
result, err := tmpl.RenderMap(map[string]any{
    "status": pt.Variant{
        Kind:   "Done",
        Fields: map[string]any{"summary": "All tests pass"},
    },
})

// Unit variants (no fields):
result, err = tmpl.RenderMap(map[string]any{
    "status": pt.Variant{Kind: "Blocked"},
})
```

## Code Generation

The `pt-gen-go` tool turns a `.tmpl.md` file into a typed Go source file, so a
template's parameters and enums become real Go types instead of `any` slots.

```bash
go install github.com/domenukk/md-tmpl/go/cmd/pt-gen-go@latest

pt-gen-go -input prompts/review.tmpl.md -output review_types.go -package review
```

Or drive it with `go:generate`:

```go
//go:generate pt-gen-go -input prompts/review.tmpl.md -output review_types.go -package review
```

Flags: `-input` and `-output` (required), `-package` (default `main`),
`-params` (params struct name, default derived from the filename), and
`-no-render` (omit the generated `Render` helper).

### Generated code

For `Status = enum(Approved, NeedsChanges(reason = str), Rejected)`, the tool
emits an idiomatic **sealed interface** sum type — one struct per variant, so
the compiler enforces exhaustiveness and you never touch `any`:

```go
// Status is a sum type (sealed interface).
type Status interface {
    isStatus()
    Kind() string                // discriminant name, e.g. "Approved"
    AsVariant() md_tmpl.Variant  // dynamic __kind__-tagged wire form
}

// StatusVariants lists every variant name, in declaration order.
var StatusVariants = []string{"Approved", "NeedsChanges", "Rejected"}

type StatusApproved struct{}
type StatusNeedsChanges struct {
    Reason string `json:"reason"`
}
type StatusRejected struct{}
```

Each variant also gets a `New…` constructor, a `MarshalJSON` that produces the
shared cross-language wire format (a bare string for unit variants, a
`{"__kind__": …}` object for data variants), and the enum gets an
`UnmarshalStatus([]byte) (Status, error)` dispatcher for the reverse direction.

The generated params struct carries a `Render` helper, so rendering is fully
typed end to end:

```go
import "github.com/domenukk/md-tmpl/go/md_tmpl"

tmpl, _ := md_tmpl.FromFile("prompts/review.tmpl.md")
defer tmpl.Close()

out, _ := review.StatusParams{
    Reviewer: "Alice",
    Status:   review.NewStatusNeedsChanges("missing tests"),
}.Render(tmpl)
fmt.Println(out)
```

## Features

### Typed Lists

Template:

<!-- prettier-ignore -->
```markdown
---
params:
  - tasks = list(title = str, priority = str)
---

> {% for task in tasks %}

- {{ task.title }}: {{ task.priority }}

> {% /for %}
```

Go:

```go
type Task struct {
    Title    string `json:"title"`
    Priority string `json:"priority"`
}

tmpl, _ := pt.FromFile("prompts/task_list.tmpl.md")
defer tmpl.Close()

result, _ := tmpl.RenderStruct(struct {
    Tasks []Task `json:"tasks"`
}{
    Tasks: []Task{
        {Title: "Write docs", Priority: "High"},
        {Title: "Add tests", Priority: "Medium"},
    },
})
```

### Default Values

```markdown
---
params:
  - name = str
  - greeting = str := "Hello"
---

{{ greeting }}, {{ name }}!
```

```go
tmpl, _ := pt.FromFile("prompts/greeting.tmpl.md")

result, _ := tmpl.RenderMap(map[string]any{"name": "Alice"})
// → "Hello, Alice!"
```

### Filters

```
{{ name | upper }}        → ALICE
{{ name | lower }}        → alice
{{ name | trim }}         → (strips whitespace)
{{ score | fixed(2) }}    → 3.14
{{ items | join(", ") }}  → a, b, c
{{ items | limit(2) }}    → first 2 elements
{{ count | add(1) }}      → 43
{{ count | sub(1) }}      → 41
{{ name | trim | upper }} → chains work
```

### Built-in Functions

```
{{ idx(item) }}           → 0, 1, 2, … (loop index)
{{ len(items) }}          → 3 (list length)
{{ len(name) }}           → 5 (string length)
{{ kind(status) }}        → "Done" (variant name)
{{ kinds(Status) }}       → ["Search", "Done"] (enum variant names)
{{ has(field) }}          → true if option(T) is present
```

`idx(binding)` tracks each loop variable independently in nested loops.

### Includes

```markdown
> {% include [header](header.tmpl.md) with title=title %}
```

### Constants

```markdown
---
consts:
  - MAX_RETRIES = int := 3

params: []
---

Max retries: {{ MAX_RETRIES }}
```

### Environment Variables

Inject values at compile time from the build environment using `env:`
declarations. Env vars are resolved once when the template is compiled and
behave like constants at render time.

```go
source := `---
params:
  - name = str
env:
  - MODEL = str
  - MAX_TOKENS = int := 4096
---
Hello {{ name }}! Using {{ MODEL }} (max {{ MAX_TOKENS }} tokens).`

tmpl, err := pt.FromSourceWithEnv(source, map[string]any{
    "MODEL": "gemini-2.0-flash",
})
if err != nil {
    log.Fatal(err)
}
defer tmpl.Close()

result, err := tmpl.RenderMap(map[string]any{"name": "Alice"})
// → "Hello Alice! Using gemini-2.0-flash (max 4096 tokens)."
```

### Caching

```go
cache := pt.NewCache()
defer cache.Close()

tmpl, err := cache.Load("prompts/greeting.tmpl.md")
defer tmpl.Close()
cache.TemplateCount()
cache.Clear()
```

## API Reference

### Template

```go
// Constructors — combine settings via functional options:
//   WithBaseDir(dir), WithEnv(map[string]any), WithAllowUnused()
pt.FromSource(source string, opts ...Option) (*Template, error)
pt.FromFile(path string, opts ...Option) (*Template, error)
pt.FromSourceWithBaseDir(source, baseDir string) (*Template, error)
pt.FromSourceWithEnv(source string, env map[string]any) (*Template, error)
pt.FromSourceWithFrontmatter(source string) (*Template, *Frontmatter, error)

// Rendering — pass AllowExtra() to permit undeclared parameters
tmpl.Render(ctx *Context, opts ...RenderOption) (string, error)
tmpl.RenderMap(params map[string]any, opts ...RenderOption) (string, error)
tmpl.RenderStruct(v any, opts ...RenderOption) (string, error)
tmpl.RenderJSON(jsonStr string, opts ...RenderOption) (string, error)
tmpl.RenderEmpty() (string, error)              // all params must have defaults
tmpl.RenderUnchecked(ctx *Context) (string, error) // skip param validation
tmpl.RenderCached(ctx *Context, cache *Cache) (string, error) // reuse includes

// Metadata
tmpl.Name() (string, bool)        // frontmatter name (ok=false if absent)
tmpl.Description() (string, bool) // frontmatter description
tmpl.Declarations() []Declaration
tmpl.Defaults() map[string]any
tmpl.Constants() map[string]any
tmpl.ImportedConstants() map[string]any
tmpl.DefaultsContext() *Context
tmpl.SourceHash() uint64
tmpl.Body() string
tmpl.ValidateDeclarations([]Declaration) error
tmpl.SetMaxIncludeDepth(depth int)
tmpl.Close()
```

### Context

```go
ctx := pt.NewContext()
defer ctx.Close()

ctx.SetStr("name", "Alice")
ctx.SetInt("count", 42)
ctx.SetFloat("score", 9.5)
ctx.SetBool("enabled", true)
ctx.SetJSON("items", `[{"label":"alpha"}]`)
ctx.SetTmpl("card", cardTemplate)
ctx.Set("key", value) // auto-detect type
ctx.MergeStruct(myStruct) // merge struct fields into context
```

### Errors

```go
var pt.ErrClosed     // operating on a closed resource
var pt.ErrNilContext // rendering with nil context

// Typed engine errors carry a machine-readable Kind. Match them with
// errors.Is against the per-kind sentinels, or inspect *TemplateError.Kind:
var pt.ErrSyntax, pt.ErrMissingParams, pt.ErrTypeMismatch, pt.ErrExtraParams
var pt.ErrUndefinedVariable, pt.ErrUnknownFilter, pt.ErrIncludeNotFound
var pt.ErrDeclarationsMutated, pt.ErrPanic, pt.ErrIO

// Example:
_, err := tmpl.RenderMap(map[string]any{"extra": 1})
if errors.Is(err, pt.ErrExtraParams) { /* handle undeclared params */ }
```

## Performance

vs Go's `text/template`, median of 3 runs
([source](md_tmpl_vs_go_test.go)).

**Render** (pre-parsed template + data → output):

| Scenario   |          md-tmpl | Go `text/template` | speedup |
| ---------- | ---------------: | -----------------: | ------: |
| **small**  |    **514 ns** 🏆 |             547 ns |   1.06× |
| **medium** |  **1,531 ns** 🏆 |           6,174 ns |    4.0× |
| **large**  | **27,160 ns** 🏆 |         143,053 ns |    5.3× |

**Round-trip** (parse + render):

| Scenario   |          md-tmpl | Go `text/template` | speedup |
| ---------- | ---------------: | -----------------: | ------: |
| **small**  |         6,774 ns |           5,540 ns |   ~1.0× |
| **medium** |        22,309 ns |          20,103 ns |   ~1.0× |
| **large**  | **66,692 ns** 🏆 |         167,501 ns |    2.5× |

**Filters:**

| Filter     |       md-tmpl | Go `text/template` | Speedup |
| ---------- | ------------: | -----------------: | ------: |
| upper      | **489 ns** 🏆 |             907 ns |    1.9× |
| trim+upper | **441 ns** 🏆 |           1,312 ns |    3.0× |

Allocations: 2 per render (small/medium/large) vs 3–517 for `text/template`.

```bash
just test-go     # 257 tests
just bench-go    # 24 benchmarks
```

## Full Reference

See **[SPEC.md](../../SPEC.md)** for the complete syntax reference.

## License

Apache-2.0 OR MIT
