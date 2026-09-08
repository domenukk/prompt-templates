/**
 * Tests for the md-tmpl TypeScript bindings.
 *
 * Uses Node.js built-in test runner (`node:test`).
 *
 * Covers:
 * - Basic template loading and rendering (fromSource, fromFile)
 * - Type validation (str, int, float, bool, list, struct, enum)
 * - Strict validation: extra params rejected by default
 * - allow_extra flag
 * - renderDict API
 * - Default values
 * - TemplateCache
 * - Template metadata (declarations, source_hash, defaults)
 * - Filters: upper, lower, trim, fixed, join, limit, add, sub
 * - Built-in functions: idx, len, kind
 * - Variant helpers (unitVariant, variant, defineVariants)
 * - Value module (fromJs, display, isTruthy)
 * - Frontmatter parsing
 * - Edge cases (empty params, unicode, validate_declarations_against)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  Template,
  TypedTemplate,
  TemplateCache,
  Context,
  defineVariants,
  unitVariant,
  variant,
  match,
  isVariant,
  TemplateError,
  TemplateSyntaxError,
  MissingParamsError,
  TypeMismatchError,
  ExtraParamsError,
  UndefinedVariableError,
  UnknownFilterError,
  TemplatePanicError,
  IncludeNotFoundError,
  DeclarationsMutatedError,
  structVal,
  StructValue,
  dict,
  DictValue,
  str,
  int,
} from "../index.js";
import { fromJs, display, isTruthy, TYPE_NONE, type Value } from "../value.js";
import {
  parseFrontmatter,
  parseVarType,
  varTypeToString,
  stripFrontmatter,
  TYPE_LIST,
} from "../frontmatter.js";
import { joinContinuationLines } from "../frontmatter/yaml.js";
import { generateTypes, inferTypes } from "../codegen.js";
import { toPascalCase } from "../validation.js";
import { splitTopLevel } from "../frontmatter/var_type.js";
import {
  parseLiteral,
  parseListLiteral,
  parseStructLiteral,
} from "../frontmatter/literals.js";
import { TYPE_STR, TYPE_INT, TYPE_STRUCT } from "../consts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that an indexed or optional lookup produced a value and return it.
 *
 * Replaces non-null assertions (`x!`) in tests: it narrows away `undefined`
 * at runtime via `assert`, yielding a clear failure message instead of a
 * downstream `TypeError`.
 */
function defined<T>(
  value: T | undefined,
  message = "expected a defined value",
): T {
  assert.ok(value !== undefined, message);
  return value;
}

function withTempFile(content: string, fn: (filepath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-test-"));
  const filepath = path.join(dir, "test.tmpl.md");
  fs.writeFileSync(filepath, content);
  try {
    fn(filepath);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Template.fromSource — basic rendering
// ---------------------------------------------------------------------------

describe("Template.fromSource", () => {
  it("renders a basic string param", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
  });

  it("renders an int param", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - count = int
---
Count: {{ count }}`,
    );
    assert.strictEqual(tmpl.render({ count: 42 }), "Count: 42");
  });

  it("renders a bool param in an if block", () => {
    const tmpl = Template.fromSource(
      `---
params: [flag = bool]
---
> {% if flag %}

yes

> {% /if %}`,
    );
    const output = tmpl.render({ flag: true });
    assert.ok(output.includes("yes"));
  });

  it("renders a float param", () => {
    const tmpl = Template.fromSource(
      `---
params: [score = float]
---
{{ score }}`,
    );
    assert.strictEqual(tmpl.render({ score: 3.14 }), "3.14");
  });

  it("throws on missing frontmatter", () => {
    assert.throws(
      () => Template.fromSource("no frontmatter at all"),
      (err: Error) => err.message.includes("frontmatter"),
    );
  });

  it("throws on missing param", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, age = int]
---
{{ name }} {{ age }}`,
    );
    assert.throws(
      () => tmpl.render({ name: "Alice" }),
      (err: Error) => err.message.includes("missing"),
    );
  });

  it("throws on type mismatch", () => {
    const tmpl = Template.fromSource(
      `---
params: [flag = bool]
---
{{ flag }}`,
    );
    assert.throws(
      () => tmpl.render({ flag: "not a bool" }),
      (err: Error) => err.message.includes("type mismatch"),
    );
  });
});

// ---------------------------------------------------------------------------
// Template.fromFile
// ---------------------------------------------------------------------------

describe("Template.fromFile", () => {
  it("loads and renders a file", () => {
    withTempFile(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
      (filepath) => {
        const tmpl = Template.fromFile(filepath);
        assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
      },
    );
  });

  it("throws on missing file", () => {
    assert.throws(
      () => Template.fromFile("/nonexistent/path.tmpl.md"),
      (err: Error) => err.message.includes("failed to load"),
    );
  });
});

// ---------------------------------------------------------------------------
// Template.fromSourceAllowingUnused
// ---------------------------------------------------------------------------

describe("Template.fromSourceAllowingUnused", () => {
  it("accepts unused params", () => {
    const tmpl = Template.fromSourceAllowingUnused(
      `---
params: [name = str, unused = int]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(
      tmpl.render({ name: "world", unused: 42 }),
      "Hello world!",
    );
  });

  it("strict mode rejects unused params", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params: [name = str, unused = int]
---
Hello {{ name }}!`,
        ),
      (err: Error) => err.message.includes("unused"),
    );
  });
});

// ---------------------------------------------------------------------------
// Strict validation — extra params
// ---------------------------------------------------------------------------

describe("Strict validation", () => {
  it("rejects extra params by default", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.throws(
      () => tmpl.render({ name: "world", bogus: "unexpected" }),
      (err: Error) =>
        err.message.includes("extra") || err.message.includes("undeclared"),
    );
  });

  it("allows extra with allowExtra", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    const result = tmpl.render(
      { name: "world", bogus: "ignored" },
      { allowExtra: true },
    );
    assert.strictEqual(result, "Hello world!");
  });

  it("renderDict rejects extra params", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.throws(
      () => tmpl.renderDict({ name: "world", bogus: "unexpected" }),
      (err: Error) =>
        err.message.includes("extra") || err.message.includes("undeclared"),
    );
  });

  it("renderDict allows extra with allowExtra", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    const result = tmpl.renderDict(
      { name: "world", bogus: "ignored" },
      { allowExtra: true },
    );
    assert.strictEqual(result, "Hello world!");
  });
});

// ---------------------------------------------------------------------------
// renderDict
// ---------------------------------------------------------------------------

describe("renderDict", () => {
  it("renders from a plain object", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.renderDict({ name: "dict" }), "Hello dict!");
  });

  it("validates types", () => {
    const tmpl = Template.fromSource(
      `---
params: [count = int]
---
{{ count }}`,
    );
    assert.throws(
      () => tmpl.renderDict({ count: "not an int" }),
      (err: Error) => err.message.includes("type mismatch"),
    );
  });
});

// ---------------------------------------------------------------------------
// renderEmpty
// ---------------------------------------------------------------------------

describe("renderEmpty", () => {
  it("renders no-param template", () => {
    const tmpl = Template.fromSource(`---
---
Hello world!`);
    assert.strictEqual(tmpl.renderEmpty(), "Hello world!");
  });

  it("renders with all-default params", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - greeting = str := "Hi"
  - count = int := 5
---
{{ greeting }} {{ count }}`,
    );
    assert.strictEqual(tmpl.renderEmpty(), "Hi 5");
  });

  it("renders with consts only", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - VERSION = str := "1.0"

params: []
---
v{{ VERSION }}`,
    );
    assert.strictEqual(tmpl.renderEmpty(), "v1.0");
  });

  it("throws for required params", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
    );
    assert.throws(
      () => tmpl.renderEmpty(),
      (err: Error) => err.message.includes("name"),
    );
  });

  it("throws for mixed defaults and required", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - greeting = str := "Hi"
  - name = str
---
{{ greeting }} {{ name }}!`,
    );
    assert.throws(
      () => tmpl.renderEmpty(),
      (err: Error) => err.message.includes("name"),
    );
  });
});

// ---------------------------------------------------------------------------
// Typed lists
// ---------------------------------------------------------------------------

describe("Typed lists", () => {
  const SRC = `---
params:
  - tasks = list(title = str, priority = str)
---
> {% for task in tasks %}

- **{{ task.title }}** ({{ task.priority }})

> {% /for %}`;

  it("renders a list of structs", () => {
    const tmpl = Template.fromSource(SRC);
    const output = tmpl.render({
      tasks: [
        { title: "Write documentation", priority: "High" },
        { title: "Add unit tests", priority: "Medium" },
      ],
    });
    assert.ok(output.includes("Write documentation"));
    assert.ok(output.includes("Add unit tests"));
  });

  it("renders an empty list", () => {
    const tmpl = Template.fromSource(SRC);
    const output = tmpl.render({ tasks: [] });
    assert.strictEqual(output.trim(), "");
  });

  it("throws on wrong item type", () => {
    const tmpl = Template.fromSource(SRC);
    assert.throws(() => tmpl.render({ tasks: ["not a struct"] }));
  });
});

// ---------------------------------------------------------------------------
// Struct parameters
// ---------------------------------------------------------------------------

describe("Struct parameters", () => {
  const SRC = `---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}:{{ config.port }}`;

  it("renders a struct param", () => {
    const tmpl = Template.fromSource(SRC);
    const output = tmpl.render({
      config: { host: "localhost", port: 8080 },
    });
    assert.strictEqual(output, "localhost:8080");
  });

  it("throws on missing field", () => {
    const tmpl = Template.fromSource(SRC);
    assert.throws(
      () => tmpl.render({ config: { host: "localhost" } }),
      (err: Error) => err.message.includes("missing"),
    );
  });
});

// ---------------------------------------------------------------------------
// Enum dispatch
// ---------------------------------------------------------------------------

describe("Enum dispatch", () => {
  const SRC = [
    `---`,
    "params:",
    "  - outcome = enum(Confirmed(evidence = str), Rejected, NeedsWork)",
    `---`,
    "> {% match outcome %}",
    "> {% case Confirmed %}",
    "",
    "YES: {{ outcome.evidence }}",

    "",
    "> {% case Rejected %}",
    "",
    "NO",

    "",
    "> {% case NeedsWork %}",
    "",
    "MAYBE",

    "",
    "> {% /match %}",
  ].join("\n");

  it("renders a unit variant", () => {
    const tmpl = Template.fromSource(SRC);
    const output = tmpl.render({ outcome: "Rejected" });
    assert.strictEqual(output.trim(), "NO");
  });

  it("renders a struct variant as dict", () => {
    const tmpl = Template.fromSource(SRC);
    const output = tmpl.render({
      outcome: { __kind__: "Confirmed", evidence: "found it" },
    });
    assert.strictEqual(output.trim(), "YES: found it");
  });

  it("throws on invalid variant", () => {
    const tmpl = Template.fromSource(SRC);
    assert.throws(
      () => tmpl.render({ outcome: "Unknown" }),
      (err: Error) =>
        err.message.includes("type mismatch") || err.message.includes("enum"),
    );
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe("Default values", () => {
  const SRC = `---
params:
  - name = str := "World"
  - count = int := 1
---
Hello {{ name }}, count={{ count }}!`;

  it("uses defaults when params omitted", () => {
    const tmpl = Template.fromSource(SRC);
    assert.strictEqual(tmpl.render(), "Hello World, count=1!");
  });

  it("overrides defaults", () => {
    const tmpl = Template.fromSource(SRC);
    assert.strictEqual(
      tmpl.render({ name: "Alice", count: 99 }),
      "Hello Alice, count=99!",
    );
  });

  it("returns defaults dict", () => {
    const tmpl = Template.fromSource(SRC);
    const defs = tmpl.defaults();
    assert.ok("name" in defs);
    assert.ok("count" in defs);
  });

  it("supports list default values", () => {
    const tmpl = Template.fromSource(`---
params:
  - tags = list(str) := ["rust", "go"]
---
{{ tags | join(", ") }}`);
    assert.strictEqual(tmpl.render(), "rust, go");
  });

  it("supports empty list default values", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(int) := []
---
{{ len(items) }}`);
    assert.strictEqual(tmpl.render(), "0");
  });

  it("supports struct list default values", () => {
    const tmpl = Template.fromSource(`---
params:
  - users = list(name = str, active = bool) := [{name = "Alice", active = true}]
---
> {% for u in users %}{{ u.name }}:{{ u.active }}{% /for %}`);
    assert.strictEqual(tmpl.render().trim(), "Alice:true");
  });
});

// ---------------------------------------------------------------------------
// TemplateCache
// ---------------------------------------------------------------------------

describe("TemplateCache", () => {
  it("loads and caches a template", () => {
    withTempFile(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
      (filepath) => {
        const cache = new TemplateCache();
        const t1 = cache.load(filepath);
        assert.strictEqual(t1.render({ name: "cached" }), "Hello cached!");
      },
    );
  });

  it("returns same hash on repeated loads", () => {
    withTempFile(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
      (filepath) => {
        const cache = new TemplateCache();
        const t1 = cache.load(filepath);
        const t2 = cache.load(filepath);
        assert.strictEqual(t1.sourceHash(), t2.sourceHash());
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

describe("Template metadata", () => {
  it("returns declarations", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    const decls = tmpl.declarations();
    const names = decls.map((d) => d[0]);
    assert.ok(names.includes("name"));
    assert.ok(names.includes("count"));
  });

  it("returns correct types in declarations", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    const decls = tmpl.declarations();
    const typeMap = Object.fromEntries(decls);
    assert.strictEqual(typeMap.name, "str");
    assert.strictEqual(typeMap.count, "int");
  });

  it("sourceHash is stable", () => {
    const source = `---
params: [x = str]
---
{{ x }}`;
    const t1 = Template.fromSource(source);
    const t2 = Template.fromSource(source);
    assert.strictEqual(t1.sourceHash(), t2.sourceHash());
  });

  it("sourceHash changes with content", () => {
    const t1 = Template.fromSource(
      `---
params: [x = str]
---
Hello {{ x }}`,
    );
    const t2 = Template.fromSource(
      `---
params: [x = str]
---
Goodbye {{ x }}`,
    );
    assert.notStrictEqual(t1.sourceHash(), t2.sourceHash());
  });

  it("toString includes Template", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
{{ name }}`,
    );
    assert.ok(tmpl.toString().includes("Template"));
    assert.ok(tmpl.toString().includes("name"));
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("Filters", () => {
  it("upper filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg | upper }}`,
    );
    assert.strictEqual(tmpl.render({ msg: "hello" }), "HELLO");
  });

  it("lower filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg | lower }}`,
    );
    assert.strictEqual(tmpl.render({ msg: "HELLO" }), "hello");
  });

  it("trim filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg | trim }}`,
    );
    assert.strictEqual(tmpl.render({ msg: "  hello  " }), "hello");
  });

  it("fixed filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = float]
---
{{ val | fixed(2) }}`,
    );
    assert.strictEqual(tmpl.render({ val: 3.14159 }), "3.14");
  });

  it("join filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(str)]
---
{{ items | join(", ") }}`,
    );
    assert.strictEqual(tmpl.render({ items: ["a", "b", "c"] }), "a, b, c");
  });

  it("limit filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(str)]
---
{{ items | limit(2) | join(", ") }}`,
    );
    assert.strictEqual(tmpl.render({ items: ["a", "b", "c"] }), "a, b");
  });

  it("add filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [n = int]
---
{{ n | add(1) }}`,
    );
    assert.strictEqual(tmpl.render({ n: 9 }), "10");
  });

  it("sub filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [n = int]
---
{{ n | sub(1) }}`,
    );
    assert.strictEqual(tmpl.render({ n: 10 }), "9");
  });
});

// ---------------------------------------------------------------------------
// Built-in functions
// ---------------------------------------------------------------------------

describe("Built-in functions", () => {
  it("len() for list", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(x = str)]
---
{{ len(items) }}`,
    );
    assert.strictEqual(tmpl.render({ items: [{ x: "a" }, { x: "b" }] }), "2");
  });

  it("len() for string", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ len(msg) }}`,
    );
    assert.strictEqual(tmpl.render({ msg: "hello" }), "5");
  });

  it("idx() in for loop", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(label = str)
---
> {% for item in items %}

{{ idx(item) | add(1) }}. {{ item.label }}

> {% /for %}`,
    );
    const output = tmpl.render({
      items: [{ label: "first" }, { label: "second" }],
    });
    assert.ok(output.includes("1. first"));
    assert.ok(output.includes("2. second"));
  });

  it("kind() extracts variant name", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected)
---
{{ kind(outcome) }}`,
    );
    const output = tmpl.render({
      outcome: { __kind__: "Confirmed", evidence: "proof" },
    });
    assert.strictEqual(output.trim(), "Confirmed");
  });
});

// ---------------------------------------------------------------------------
// Variant helpers
// ---------------------------------------------------------------------------

describe("Variant helpers", () => {
  it("unitVariant creates sentinel", () => {
    const v = unitVariant("Rejected");
    assert.strictEqual(v.__kind__, "Rejected");
    assert.deepStrictEqual({ ...v }, { __kind__: "Rejected" });
  });

  it("variant() creates constructor with fields", () => {
    const NeedsChanges = variant("NeedsChanges", ["reason"] as const);
    const v = NeedsChanges({ reason: "fix tests" });
    assert.strictEqual(v.__kind__, "NeedsChanges");
    assert.strictEqual(v.reason, "fix tests");
  });

  it("variant() throws on missing field", () => {
    const Required = variant("Required", ["value"] as const);
    assert.throws(
      () => Required({} as Record<"value", unknown>),
      (err: Error) => err.message.includes("missing"),
    );
  });

  it("variant() throws on unexpected field", () => {
    const Simple = variant("Simple", ["x"] as const);
    assert.throws(
      () =>
        (Simple as (f: Record<string, unknown>) => unknown)({
          x: 1,
          y: 2,
        }),
      (err: Error) => err.message.includes("unexpected"),
    );
  });

  it("defineVariants creates mixed enum", () => {
    const Status = defineVariants({
      Approved: null,
      Rejected: null,
      NeedsChanges: ["reason"],
    });
    assert.strictEqual(Status.Approved.__kind__, "Approved");
    const nc = Status.NeedsChanges({ reason: "fix" });
    assert.strictEqual(nc.__kind__, "NeedsChanges");
    assert.strictEqual(nc.reason, "fix");
  });

  it("variant objects render correctly", () => {
    const Status = defineVariants({
      Confirmed: ["evidence"],
      Rejected: null,
    });

    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - outcome = enum(Confirmed(evidence = str), Rejected)",
        `---`,
        "> {% match outcome %}",
        "> {% case Confirmed %}",
        "",
        "YES: {{ outcome.evidence }}",

        "",
        "> {% case Rejected %}",
        "",
        "NO",

        "",
        "> {% /match %}",
      ].join("\n"),
    );

    assert.strictEqual(tmpl.render({ outcome: Status.Rejected }).trim(), "NO");
    assert.strictEqual(
      tmpl.render({ outcome: Status.Confirmed({ evidence: "proof" }) }).trim(),
      "YES: proof",
    );
  });
});

// ---------------------------------------------------------------------------
// Value module
// ---------------------------------------------------------------------------

describe("Value module", () => {
  it("fromJs converts string", () => {
    const v = fromJs("hello");
    assert.strictEqual(v.type, "str");
    assert.strictEqual(display(v), "hello");
  });

  it("fromJs converts integer", () => {
    const v = fromJs(42);
    assert.strictEqual(v.type, "int");
    assert.strictEqual(display(v), "42");
  });

  it("fromJs converts float", () => {
    const v = fromJs(3.14);
    assert.strictEqual(v.type, "float");
    assert.strictEqual(display(v), "3.14");
  });

  it("fromJs converts boolean", () => {
    const v = fromJs(true);
    assert.strictEqual(v.type, "bool");
    assert.strictEqual(display(v), "true");
  });

  it("fromJs converts array", () => {
    const v = fromJs(["a", "b"]);
    assert.strictEqual(v.type, "list");
  });

  it("fromJs converts object", () => {
    const v = fromJs({ key: "val" });
    assert.strictEqual(v.type, "struct");
  });

  it("isTruthy works correctly", () => {
    assert.strictEqual(isTruthy(fromJs(true)), true);
    assert.strictEqual(isTruthy(fromJs(false)), false);
    assert.strictEqual(isTruthy(fromJs("")), false);
    assert.strictEqual(isTruthy(fromJs("hello")), true);
    assert.strictEqual(isTruthy(fromJs(0)), false);
    assert.strictEqual(isTruthy(fromJs(1)), true);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe("Frontmatter parsing", () => {
  it("parses params and body", () => {
    const [fm, body] = parseFrontmatter(
      `---
params:
  - name = str
---
Hello {{ name }}!`,
    );
    assert.strictEqual(fm.params.length, 1);
    assert.strictEqual(defined(fm.params[0]).name, "name");
    assert.ok(body.includes("Hello"));
  });

  it("parseVarType round-trips", () => {
    for (const t of ["str", "bool", "int", "float"]) {
      const vt = parseVarType(t);
      assert.strictEqual(varTypeToString(vt), t);
    }
  });

  it("parses inline list syntax", () => {
    const [fm] = parseFrontmatter(
      `---
params: [x = str, y = int]
---
{{ x }} {{ y }}`,
    );
    assert.strictEqual(fm.params.length, 2);
    assert.strictEqual(defined(fm.params[0]).name, "x");
    assert.strictEqual(defined(fm.params[1]).name, "y");
  });

  it("joins a multi-line := default value (list) onto one declaration", () => {
    // Regression: a `:=` value whose list literal spans several physical
    // lines must be captured in full, not truncated to an empty default.
    const [fm] = parseFrontmatter(
      `---
consts:
  - LADDER = list(tier = str, note = str) :=
    [{tier = "L0", note = "analysis"},
    {tier = "L1", note = "trigger"},
    {tier = "L2", note = "control"}]

params: []
---
body`,
    );
    assert.strictEqual(fm.consts.length, 1);
    const ladder = defined(fm.consts[0]);
    assert.strictEqual(ladder.name, "LADDER");
    assert.ok(ladder.defaultValue !== undefined, "default must be parsed");
    assert.strictEqual(ladder.defaultValue.type, TYPE_LIST);
    assert.strictEqual(
      (ladder.defaultValue as { items: readonly unknown[] }).items.length,
      3,
    );
  });

  it("does not let comments/blank lines break a continuation", () => {
    // Mirrors the ARTIST template layout: a documented const whose multi-line
    // value follows `:=` on subsequent indented lines.
    const [fm] = parseFrontmatter(
      `---
consts:
  - FIRST = str := "one"

  # A documented, canonical list.
  # Spanning several comment lines.
  - SECOND = list(k = str) :=
    [{k = "a"},
    {k = "b"}]

params: []
---
body`,
    );
    assert.strictEqual(fm.consts.length, 2);
    assert.strictEqual(defined(fm.consts[0]).name, "FIRST");
    const second = defined(fm.consts[1]);
    assert.strictEqual(second.name, "SECOND");
    assert.strictEqual(defined(second.defaultValue).type, TYPE_LIST);
    assert.strictEqual(
      (second.defaultValue as { items: readonly unknown[] }).items.length,
      2,
    );
  });

  it("joins a multi-line compound type declaration", () => {
    const [fm] = parseFrontmatter(
      `---
params:
  - rows = list(tier = str,
    short = str,
    note = str)
---
body`,
    );
    assert.strictEqual(fm.params.length, 1);
    assert.strictEqual(defined(fm.params[0]).name, "rows");
    const ty = varTypeToString(defined(fm.params[0]).varType);
    assert.ok(ty.startsWith("list("), `expected a list type, got: ${ty}`);
    assert.ok(ty.includes("tier = str"));
    assert.ok(ty.includes("short = str"));
    assert.ok(ty.includes("note = str"));
  });

  it("joinContinuationLines merges only non-item, non-section lines", () => {
    const joined = joinContinuationLines([
      "consts:",
      '  - A = str := "x"',
      "  - B = list(k = str) :=",
      '    [{k = "a"},',
      '    {k = "b"}]',
    ]);
    assert.deepStrictEqual(joined, [
      "consts:",
      '  - A = str := "x"',
      '  - B = list(k = str) := [{k = "a"}, {k = "b"}]',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Regression: delimiters inside quoted strings in frontmatter defaults
//
// In frontmatter default values (`:= ...`), delimiters — commas and the
// bracket family `()[]{}<>` — that appear INSIDE quoted string literals must
// be treated as literal characters, NOT as field/element separators. This
// holds for both double (`"..."`) and single (`'...'`) quotes.
//
// The quote-aware root parser is `splitTopLevel` (var_type.ts), consumed by
// `parseLiteral` / `parseListLiteral` / `parseStructLiteral` (literals.ts).
// These tests LOCK IN that behavior at the unit and end-to-end levels; they
// mirror the canonical cross-language matrix (cases T1–T8) so the TypeScript
// backend stays byte-for-byte aligned with the Rust core.
// ---------------------------------------------------------------------------

describe("Frontmatter: delimiters inside quoted strings (regression)", () => {
  // Narrowing helpers: assert the Value shape and return the inner data so the
  // individual assertions read clearly.
  const asStr = (v: Value | undefined): string => {
    const val = defined(v);
    if (val.type !== TYPE_STR) {
      assert.fail(`expected str, got '${val.type}'`);
    }
    return val.value;
  };
  const asInt = (v: Value | undefined): number => {
    const val = defined(v);
    if (val.type !== TYPE_INT) {
      assert.fail(`expected int, got '${val.type}'`);
    }
    return val.value;
  };
  const asList = (v: Value | undefined): readonly Value[] => {
    const val = defined(v);
    if (val.type !== TYPE_LIST) {
      assert.fail(`expected list, got '${val.type}'`);
    }
    return val.items;
  };
  const asStruct = (v: Value | undefined): ReadonlyMap<string, Value> => {
    const val = defined(v);
    if (val.type !== TYPE_STRUCT) {
      assert.fail(`expected struct, got '${val.type}'`);
    }
    return val.fields;
  };

  // Parse a single-param frontmatter and return that param's parsed default.
  const paramDefault = (decl: string): Value => {
    const [fm] = parseFrontmatter(`---\nparams:\n  - ${decl}\n---\nbody`);
    assert.strictEqual(fm.params.length, 1, "expected exactly one param");
    return defined(
      defined(fm.params[0]).defaultValue,
      "param default must be parsed",
    );
  };

  // -------------------------------------------------------------------------
  // Low-level split unit tests (mirror the Rust `split_at_depth_zero` cases)
  // -------------------------------------------------------------------------
  describe("splitTopLevel ignores delimiters inside quoted strings", () => {
    it("does not split on a comma inside a double-quoted string", () => {
      assert.deepStrictEqual(splitTopLevel('a = "x, y", b = 1', ","), [
        'a = "x, y"',
        " b = 1",
      ]);
    });

    it("does not split on a comma inside a single-quoted string", () => {
      assert.deepStrictEqual(splitTopLevel("a = 'x, y', b = 2", ","), [
        "a = 'x, y'",
        " b = 2",
      ]);
    });

    it("treats brackets inside a string as literal (no depth change)", () => {
      // The `[` `]` `1` inside the quotes must not open bracket depth, so the
      // following top-level comma still splits into exactly two parts.
      assert.deepStrictEqual(splitTopLevel('a = "x[1],y", b = 3', ","), [
        'a = "x[1],y"',
        " b = 3",
      ]);
    });

    it("never splits mid-quote even for many embedded delimiters", () => {
      assert.deepStrictEqual(splitTopLevel('"a, b, c, d"', ","), [
        '"a, b, c, d"',
      ]);
    });

    it("keeps unbalanced brackets inside strings from corrupting depth", () => {
      // A lone `[` in one string and a lone `]` in another are literal; the
      // top-level comma between them still separates the two fields.
      assert.deepStrictEqual(splitTopLevel('x = "[", y = "]"', ","), [
        'x = "["',
        ' y = "]"',
      ]);
    });

    it("respects escaped quotes when scanning string literals", () => {
      // The escaped `\"` does not close the string, so the enclosed comma is
      // still literal and no top-level split happens inside it.
      assert.deepStrictEqual(splitTopLevel('a = "x \\", y", b = 4', ","), [
        'a = "x \\", y"',
        " b = 4",
      ]);
    });

    it("splits every brace family delimiter only at depth zero", () => {
      // Commas inside the nested struct/list literals stay grouped; only the
      // top-level comma separates the two outer fields.
      assert.deepStrictEqual(
        splitTopLevel('a = {p = "1, 2", q = 3}, b = [4, 5]', ","),
        ['a = {p = "1, 2", q = 3}', " b = [4, 5]"],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Literal parsers: parseLiteral / parseListLiteral / parseStructLiteral
  // -------------------------------------------------------------------------
  describe("parseLiteral keeps embedded delimiters intact", () => {
    it("parses a scalar string containing commas verbatim", () => {
      assert.strictEqual(
        asStr(parseLiteral('"a, b, c"', parseVarType("str"))),
        "a, b, c",
      );
    });

    it("parseListLiteral splits elements, not commas inside strings (T1)", () => {
      const items = asList(
        parseListLiteral('["a, b", "c, d"]', parseVarType("list(str)")),
      );
      assert.strictEqual(items.length, 2);
      assert.strictEqual(asStr(items[0]), "a, b");
      assert.strictEqual(asStr(items[1]), "c, d");
    });

    it("parseListLiteral keeps bracket-family chars inside strings (T4)", () => {
      const items = asList(
        parseListLiteral(
          '["a[b]c", "d{e}f", "g(h)i"]',
          parseVarType("list(str)"),
        ),
      );
      assert.deepStrictEqual(
        items.map((i) => asStr(i)),
        ["a[b]c", "d{e}f", "g(h)i"],
      );
    });

    it("parseListLiteral handles single-quoted elements (T5)", () => {
      const items = asList(
        parseListLiteral("['a, b', 'c']", parseVarType("list(str)")),
      );
      assert.strictEqual(items.length, 2);
      assert.strictEqual(asStr(items[0]), "a, b");
      assert.strictEqual(asStr(items[1]), "c");
    });

    it("parseStructLiteral keeps commas inside a field's string (T2)", () => {
      const structType = parseVarType("struct(msg = str, n = int)");
      if (structType.kind !== TYPE_STRUCT) {
        throw new Error(`expected a struct type, got '${structType.kind}'`);
      }
      const fields = asStruct(
        parseStructLiteral('{msg = "a, b", n = 1}', structType),
      );
      assert.strictEqual(asStr(fields.get("msg")), "a, b");
      assert.strictEqual(asInt(fields.get("n")), 1);
    });

    it("parseLiteral dispatches struct literals with embedded commas", () => {
      const fields = asStruct(
        parseLiteral(
          '{msg = "hello, world", n = 7}',
          parseVarType("struct(msg = str, n = int)"),
        ),
      );
      assert.strictEqual(asStr(fields.get("msg")), "hello, world");
      assert.strictEqual(asInt(fields.get("n")), 7);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end frontmatter defaults (canonical matrix T1–T8)
  // -------------------------------------------------------------------------
  describe("end-to-end parseFrontmatter defaults (T1–T8)", () => {
    it("T1: list(str) with comma-bearing string elements", () => {
      const items = asList(paramDefault('x = list(str) := ["a, b", "c, d"]'));
      assert.deepStrictEqual(
        items.map((i) => asStr(i)),
        ["a, b", "c, d"],
      );
    });

    it("T2: struct with a comma-bearing string field", () => {
      const fields = asStruct(
        paramDefault('x = struct(msg = str, n = int) := {msg = "a, b", n = 1}'),
      );
      assert.strictEqual(asStr(fields.get("msg")), "a, b");
      assert.strictEqual(asInt(fields.get("n")), 1);
    });

    it("T3: list of records; record note keeps its commas", () => {
      const items = asList(
        paramDefault(
          "x = list(name = str, note = str) := " +
            '[{name = "x", note = "p, q, r"}, {name = "y", note = "s"}]',
        ),
      );
      assert.strictEqual(items.length, 2);
      const rec0 = asStruct(items[0]);
      assert.strictEqual(asStr(rec0.get("name")), "x");
      assert.strictEqual(asStr(rec0.get("note")), "p, q, r");
      const rec1 = asStruct(items[1]);
      assert.strictEqual(asStr(rec1.get("name")), "y");
      assert.strictEqual(asStr(rec1.get("note")), "s");
    });

    it("T4: list(str) with bracket-family chars inside strings", () => {
      const items = asList(
        paramDefault('x = list(str) := ["a[b]c", "d{e}f", "g(h)i"]'),
      );
      assert.deepStrictEqual(
        items.map((i) => asStr(i)),
        ["a[b]c", "d{e}f", "g(h)i"],
      );
    });

    it("T5: list(str) with single-quoted, comma-bearing elements", () => {
      const items = asList(paramDefault("x = list(str) := ['a, b', 'c']"));
      assert.deepStrictEqual(
        items.map((i) => asStr(i)),
        ["a, b", "c"],
      );
    });

    it("T6: list(str) preserves unicode (em-dash, emoji) and commas", () => {
      const items = asList(
        paramDefault(
          'x = list(str) := ["Theory — not a finding", "✅ done, ok"]',
        ),
      );
      assert.deepStrictEqual(
        items.map((i) => asStr(i)),
        ["Theory — not a finding", "✅ done, ok"],
      );
    });

    it("T7: list of records tolerates empty strings and comma-bearing notes", () => {
      const items = asList(
        paramDefault(
          "x = list(name = str, note = str) := " +
            '[{name = "", note = ""}, {name = "a", note = "y, z"}]',
        ),
      );
      assert.strictEqual(items.length, 2);
      const rec0 = asStruct(items[0]);
      assert.strictEqual(asStr(rec0.get("name")), "");
      assert.strictEqual(asStr(rec0.get("note")), "");
      const rec1 = asStruct(items[1]);
      assert.strictEqual(asStr(rec1.get("name")), "a");
      assert.strictEqual(asStr(rec1.get("note")), "y, z");
    });

    it("T8: real-world SEVERITY_LADDER shape with prose fields", () => {
      // A list of records whose prose fields contain commas, an em-dash, and
      // an emoji — the exact shape that originally exposed the bug.
      const items = asList(
        paramDefault(
          "x = list(tier = str, short = str, proves = str) := " +
            '[{tier = "L0", short = "static, dynamic", ' +
            'proves = "Reachable — but not exploitable, yet ⚠️"}, ' +
            '{tier = "L1", short = "trigger", ' +
            'proves = "Crashes, reliably"}]',
        ),
      );
      assert.strictEqual(items.length, 2);
      const rec0 = asStruct(items[0]);
      assert.strictEqual(asStr(rec0.get("tier")), "L0");
      assert.strictEqual(asStr(rec0.get("short")), "static, dynamic");
      assert.strictEqual(
        asStr(rec0.get("proves")),
        "Reachable — but not exploitable, yet ⚠️",
      );
      const rec1 = asStruct(items[1]);
      assert.strictEqual(asStr(rec1.get("tier")), "L1");
      assert.strictEqual(asStr(rec1.get("proves")), "Crashes, reliably");
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("empty params", () => {
    const tmpl = Template.fromSource(`---
params: []
---
Static content`);
    assert.strictEqual(tmpl.render(), "Static content");
  });

  it("unicode params", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg }}`,
    );
    assert.strictEqual(
      tmpl.render({ msg: "🎉 Hello 世界!" }),
      "🎉 Hello 世界!",
    );
  });

  it("multiple vars same template", () => {
    const tmpl = Template.fromSource(
      `---
params: [a = str, b = str]
---
{{ a }} and {{ b }}`,
    );
    assert.strictEqual(tmpl.render({ a: "X", b: "Y" }), "X and Y");
  });

  it("validateDeclarationsAgainst matches", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
{{ name }}`,
    );
    const decls = tmpl.declarations();
    // Should not throw
    tmpl.validateDeclarationsAgainst(decls);
  });

  it("validateDeclarationsAgainst rejects mismatch", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
{{ name }}`,
    );
    assert.throws(
      () => {
        tmpl.validateDeclarationsAgainst([["different", "int"]]);
      },
      (err: Error) =>
        err instanceof DeclarationsMutatedError &&
        err.message.includes("declarations were modified"),
    );
  });

  it("multiline template", () => {
    const tmpl = Template.fromSource(
      `---
params: [title = str]
---
# {{ title }}

Body text.`,
    );
    const output = tmpl.render({ title: "Test" });
    assert.strictEqual(output, "# Test\n\nBody text.");
  });

  it("comments are stripped", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {# this is a comment #}{{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
  });
});

// ---------------------------------------------------------------------------
// Multiple param types
// ---------------------------------------------------------------------------

describe("Multiple param types", () => {
  it("all primitive types together", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
  - count = int
  - score = float
  - enabled = bool
---
{{ name }}: count={{ count }}, score={{ score }}, enabled={{ enabled }}`,
    );
    const output = tmpl.render({
      name: "Alice",
      count: 42,
      score: 9.5,
      enabled: true,
    });
    assert.strictEqual(output, "Alice: count=42, score=9.5, enabled=true");
  });
});

// ---------------------------------------------------------------------------
// If / elif / else
// ---------------------------------------------------------------------------

describe("If/elif/else", () => {
  const SRC = [
    `---`,
    "params:",
    "  - level = int",
    "  - name = str",
    `---`,
    "> {% if level == 1 %}",
    "",
    "Beginner: {{ name }}",

    "",
    "> {% elif level == 2 %}",
    "",
    "Intermediate: {{ name }}",

    "",
    "> {% else %}",
    "",
    "Expert: {{ name }}",

    "",
    "> {% /if %}",
  ].join("\n");

  it("renders first branch", () => {
    const tmpl = Template.fromSource(SRC);
    assert.strictEqual(
      tmpl.render({ level: 1, name: "Alice" }).trim(),
      "Beginner: Alice",
    );
  });

  it("renders elif branch", () => {
    const tmpl = Template.fromSource(SRC);
    assert.strictEqual(
      tmpl.render({ level: 2, name: "Bob" }).trim(),
      "Intermediate: Bob",
    );
  });

  it("renders else branch", () => {
    const tmpl = Template.fromSource(SRC);
    assert.strictEqual(
      tmpl.render({ level: 99, name: "Carol" }).trim(),
      "Expert: Carol",
    );
  });
});

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

describe("Code generation", () => {
  const CODEGEN_SRC = [
    `---`,
    "params:",
    "  - name = str",
    "  - count = int",
    "  - tasks = list(title = str, priority = str)",
    "  - outcome = enum(Confirmed(evidence = str), Rejected)",
    `---`,
    "Hello {{ name }}!",
  ].join("\n");

  it("generateTypes produces valid TypeScript", () => {
    const code = generateTypes(CODEGEN_SRC);
    assert.ok(code.includes("interface Params"));
    assert.ok(code.includes("readonly name: string"));
    assert.ok(code.includes("readonly count: number"));
  });

  it("generates list item interfaces", () => {
    const code = generateTypes(CODEGEN_SRC);
    assert.ok(code.includes("interface TasksItem"));
    assert.ok(code.includes("readonly title: string"));
    assert.ok(code.includes("readonly priority: string"));
  });

  it("generates enum types", () => {
    const code = generateTypes(CODEGEN_SRC);
    assert.ok(code.includes("type Outcome"));
    assert.ok(code.includes('"Rejected"'));
    assert.ok(code.includes("Outcome_Confirmed"));
    assert.ok(code.includes('readonly __kind__: "Confirmed"'));
  });

  it("emits a companion namespace with a data-variant constructor", () => {
    const code = generateTypes(CODEGEN_SRC);
    // The enum's companion object is a single `const Outcome = { ... }`.
    assert.ok(
      code.includes("export const Outcome = {"),
      `expected companion namespace 'Outcome' in:\n${code}`,
    );
    // Data variant → factory taking a typed `fields` object.
    assert.ok(
      code.includes(
        "Confirmed: (fields: { evidence: string }): Outcome_Confirmed =>",
      ),
      `expected typed 'Confirmed' constructor in:\n${code}`,
    );
    // The constructor body attaches the reserved discriminant tag + spread.
    assert.ok(
      code.includes('{ __kind__: "Confirmed", ...fields }'),
      `expected __kind__-tagged body in:\n${code}`,
    );
  });

  it("emits unit variants as bare string constants in the namespace", () => {
    const code = generateTypes(CODEGEN_SRC);
    // Unit variant → a `V: "V" as const` entry (matches the bare-string wire form).
    assert.ok(
      code.includes('Rejected: "Rejected" as const,'),
      `expected unit constant 'Rejected' in:\n${code}`,
    );
  });

  it("emits kinds tuple, kindOf, is, and an exhaustive match", () => {
    const code = generateTypes(CODEGEN_SRC);
    assert.ok(
      code.includes('kinds: ["Confirmed", "Rejected"] as const,'),
      `expected 'kinds' tuple in:\n${code}`,
    );
    assert.ok(
      code.includes("kindOf: (v: Outcome): OutcomeKind =>"),
      `expected 'kindOf' helper in:\n${code}`,
    );
    assert.ok(
      code.includes("is: (v: Outcome, k: OutcomeKind): boolean =>"),
      `expected 'is' helper in:\n${code}`,
    );
    assert.ok(
      code.includes("match: <R>(v: Outcome, arms: {"),
      `expected generic 'match' helper in:\n${code}`,
    );
    // Both arms must be present and typed to their precise variant shapes.
    assert.ok(
      code.includes("Confirmed: (v: Outcome_Confirmed) => R"),
      `expected typed 'Confirmed' match arm in:\n${code}`,
    );
    assert.ok(
      code.includes('Rejected: (v: "Rejected") => R'),
      `expected typed 'Rejected' match arm in:\n${code}`,
    );
  });

  it("handles an enum with multiple data + unit variants", () => {
    const code = generateTypes(
      `---
params:
  - result = enum(Success(value = str), Failure(error = str, code = int), Unknown)
---
{{ result }}`,
    );
    // Both data-variant constructors, each typed to its own field object.
    assert.ok(
      code.includes("Success: (fields: { value: string }): Result_Success =>"),
      `expected Success constructor in:\n${code}`,
    );
    assert.ok(
      code.includes(
        "Failure: (fields: { error: string; code: number }): Result_Failure =>",
      ),
      `expected Failure constructor with both fields in:\n${code}`,
    );
    // Unit variant const.
    assert.ok(
      code.includes('Unknown: "Unknown" as const,'),
      `expected 'Unknown' unit constant in:\n${code}`,
    );
    // kinds enumerates every tag in declaration order.
    assert.ok(
      code.includes('kinds: ["Success", "Failure", "Unknown"] as const,'),
      `expected ordered 'kinds' tuple in:\n${code}`,
    );
  });

  it("companion namespace respects exportTypes: false", () => {
    const code = generateTypes(CODEGEN_SRC, { exportTypes: false });
    // No `export` on any generated declaration.
    assert.ok(
      !code.includes("export const Outcome"),
      `expected no export on Outcome namespace:\n${code}`,
    );
    assert.ok(
      !code.includes("export type Outcome"),
      `expected no export on Outcome type:\n${code}`,
    );
    assert.ok(!/\bexport\b/.test(code), `expected zero exports in:\n${code}`);
    // But the namespace itself is still emitted.
    assert.ok(
      code.includes("const Outcome = {"),
      `expected Outcome namespace:\n${code}`,
    );
  });

  it("generates render helper", () => {
    const code = generateTypes(CODEGEN_SRC);
    assert.ok(code.includes("function render"));
  });

  it("respects options", () => {
    const code = generateTypes(CODEGEN_SRC, {
      paramsName: "MyParams",
      exportTypes: false,
      includeRenderHelper: false,
    });
    assert.ok(code.includes("interface MyParams"));
    assert.ok(!code.includes("export "));
    assert.ok(!code.includes("function render"));
  });

  it("marks optional params with defaults", () => {
    const code = generateTypes(
      `---
params:
  - name = str := "World"
---
{{ name }}`,
    );
    assert.ok(code.includes("readonly name?: string"));
  });

  it("inferTypes returns structured result", () => {
    const result = inferTypes(CODEGEN_SRC);
    assert.strictEqual(result.fields.length, 4);
    assert.strictEqual(defined(result.fields[0]).name, "name");
    assert.strictEqual(defined(result.fields[0]).tsType, "string");
    assert.strictEqual(defined(result.fields[1]).name, "count");
    assert.strictEqual(defined(result.fields[1]).tsType, "number");
  });

  it("inferTypes returns correct enum type", () => {
    const result = inferTypes(CODEGEN_SRC);
    const outcomeField = result.fields.find((f) => f.name === "outcome");
    assert.ok(outcomeField);
    assert.ok(outcomeField.tsType.includes('"Rejected"'));
    assert.ok(outcomeField.tsType.includes('__kind__: "Confirmed"'));
  });

  it("handles struct params", () => {
    const code = generateTypes(
      `---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}`,
    );
    assert.ok(code.includes("interface Config"));
    assert.ok(code.includes("readonly host: string"));
    assert.ok(code.includes("readonly port: number"));
  });

  it("emits type aliases from types: block", () => {
    const src = [
      `---`,
      "types:",
      "  - Status = enum(Active, Inactive, Pending)",
      "",
      "params:",
      "  - status = Status",
      `---`,
      "{{ status }}",
    ].join("\n");
    const code = generateTypes(src);
    // Should define the Status type
    assert.ok(
      code.includes("type Status"),
      `expected 'type Status' in:\n${code}`,
    );
    assert.ok(code.includes('"Active"'));
    assert.ok(code.includes('"Inactive"'));
    assert.ok(code.includes('"Pending"'));
    // Params should reference Status by name
    assert.ok(code.includes("readonly status: Status"));
  });

  it("emits struct type aliases", () => {
    const src = [
      `---`,
      "types:",
      "  - Config = struct(host = str, port = int)",
      "",
      "params:",
      "  - cfg = Config",
      `---`,
      "{{ cfg.host }}",
    ].join("\n");
    const code = generateTypes(src);
    assert.ok(
      code.includes("interface Config") || code.includes("type Config"),
    );
    assert.ok(code.includes("readonly cfg: Config"));
  });

  it("inferTypes resolves type aliases", () => {
    const src = [
      `---`,
      "types:",
      "  - Priority = enum(High, Medium, Low)",
      "",
      "params:",
      "  - p = Priority",
      `---`,
      "{{ p }}",
    ].join("\n");
    const result = inferTypes(src);
    assert.strictEqual(result.fields.length, 1);
    // inferTypes should resolve the alias inline
    assert.ok(defined(result.fields[0]).tsType.includes('"High"'));
    assert.ok(defined(result.fields[0]).tsType.includes('"Low"'));
    // typeAliases should also be returned
    assert.strictEqual(result.typeAliases.length, 1);
    assert.strictEqual(defined(result.typeAliases[0]).name, "Priority");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Constants", () => {
  it("renders constant values", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - MAX = int := 100

params: []
---
Max: {{ MAX }}`,
    );
    assert.strictEqual(tmpl.render({}), "Max: 100");
  });

  it("renders string constant", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - GREETING = str := "hello"

params: []
---
{{ GREETING }}`,
    );
    assert.strictEqual(tmpl.render({}), "hello");
  });

  it("constants coexist with params", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - PREFIX = str := "Hello"

params:
  - name = str
---
{{ PREFIX }} {{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "World" }), "Hello World!");
  });

  it("consts() accessor returns constant values", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - MAX = int := 100
  - LABEL = str := "test"

params: []
---
{{ MAX }} {{ LABEL }}`,
    );
    const c = tmpl.consts();
    assert.strictEqual(c.MAX, 100);
    assert.strictEqual(c.LABEL, "test");
  });

  it("generateTypes emits CONSTANTS object", () => {
    const src = [
      `---`,
      "consts:",
      "  - MAX = int := 100",
      '  - PREFIX = str := "hello"',
      "",
      "params: [name = str]",
      `---`,
      "{{ PREFIX }} {{ name }} {{ MAX }}",
    ].join("\n");
    const code = generateTypes(src);
    // Should have a CONSTANTS block
    assert.ok(code.includes("CONSTANTS"), `expected CONSTANTS in:\n${code}`);
    assert.ok(code.includes("MAX: 100"));
    assert.ok(code.includes('PREFIX: "hello"'));
    assert.ok(code.includes("as const"));
  });

  it("generateTypes emits DEFAULTS object", () => {
    const src = [
      `---`,
      "params:",
      '  - greeting = str := "Hello"',
      "  - name = str",
      `---`,
      "{{ greeting }} {{ name }}",
    ].join("\n");
    const code = generateTypes(src);
    // greeting should be optional
    assert.ok(
      code.includes("greeting?:"),
      `expected 'greeting?:' in:\n${code}`,
    );
    // name should NOT be optional
    assert.ok(code.includes("readonly name:"));
    assert.ok(!code.includes("name?:"));
    // DEFAULTS block
    assert.ok(code.includes("DEFAULTS"), `expected DEFAULTS in:\n${code}`);
    assert.ok(code.includes('"Hello"'));
  });

  it("inferTypes returns consts", () => {
    const src = [
      `---`,
      "consts:",
      "  - VERSION = int := 42",
      "",
      "params: [x = str]",
      `---`,
      "v{{ VERSION }}: {{ x }}",
    ].join("\n");
    const result = inferTypes(src);
    assert.strictEqual(result.consts.length, 1);
    assert.strictEqual(defined(result.consts[0]).name, "VERSION");
    assert.strictEqual(defined(result.consts[0]).value, 42);
    assert.strictEqual(defined(result.consts[0]).tsType, "number");
  });

  it("inferTypes returns defaults", () => {
    const src = [
      `---`,
      "params:",
      '  - name = str := "World"',
      "  - count = int",
      `---`,
      "{{ name }} {{ count }}",
    ].join("\n");
    const result = inferTypes(src);
    assert.strictEqual(result.fields.length, 2);
    const nameField = defined(result.fields.find((f) => f.name === "name"));
    assert.ok(nameField.optional);
    assert.strictEqual(nameField.defaultValue, "World");
    const countField = defined(result.fields.find((f) => f.name === "count"));
    assert.ok(!countField.optional);
    assert.strictEqual(countField.defaultValue, undefined);
  });

  it("TypedTemplate.consts() delegates correctly", () => {
    const tmpl = TypedTemplate.fromSource<{ name: string }>(
      `---
consts:
  - VER = int := 3

params: [name = str]
---
{{ name }} v{{ VER }}`,
    );
    const c = tmpl.consts();
    assert.strictEqual(c.VER, 3);
    assert.strictEqual(tmpl.render({ name: "test" }), "test v3");
  });

  it("constants work with renderUnchecked", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - TAG = str := "v1"

params: [name = str]
---
{{ name }}@{{ TAG }}`,
    );
    assert.strictEqual(tmpl.renderUnchecked({ name: "app" }), "app@v1");
  });
});

// ---------------------------------------------------------------------------
// Filter chains
// ---------------------------------------------------------------------------

describe("Filter chains", () => {
  it("chains trim and upper", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = str]
---
{{ val | trim | upper }}`,
    );
    assert.strictEqual(tmpl.render({ val: "  hello world  " }), "HELLO WORLD");
  });

  it("chains trim and lower", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = str]
---
{{ val | trim | lower }}`,
    );
    assert.strictEqual(tmpl.render({ val: "  HELLO  " }), "hello");
  });
});

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

describe("Type aliases", () => {
  it("resolves type aliases in params", () => {
    const src = [
      `---`,
      "types:",
      "  - Status = enum(Active, Inactive)",
      "",
      "params:",
      "  - user_status = Status",
      `---`,
      "> {% match user_status %}",
      "> {% case Active %}",
      "",
      "ACTIVE",

      "",
      "> {% case Inactive %}",
      "",
      "INACTIVE",

      "",
      "> {% /match %}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ user_status: "Active" }).trim(), "ACTIVE");
  });

  it("resolves type aliases for type checking", () => {
    const src = [
      `---`,
      "types:",
      "  - Status = enum(Active, Inactive)",
      "",
      "params:",
      "  - status = Status",
      `---`,
      "> {% match status %}",
      "> {% case Active %}",
      "",
      "ok",

      "",
      "> {% case Inactive %}",
      "",
      "no",

      "",
      "> {% /match %}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    // Invalid variant should fail
    assert.throws(() => tmpl.render({ status: "Unknown" }));
  });

  it("type aliases appear in declarations", () => {
    const src = [
      `---`,
      "types:",
      "  - Priority = enum(High, Low)",
      "",
      "params:",
      "  - p = Priority",
      `---`,
      "{{ kind(p) }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    const decls = tmpl.declarations();
    assert.strictEqual(decls.length, 1);
    assert.strictEqual(defined(decls[0])[0], "p");
    assert.strictEqual(defined(decls[0])[1], "Priority");
  });
});

// ---------------------------------------------------------------------------
// Includes (stub behavior)
// ---------------------------------------------------------------------------

describe("Includes", () => {
  it("parses include syntax without error", () => {
    // Include is parsed but rendering is a no-op in pure TS
    const src = [
      `---`,
      "params:",
      "  - title = str",
      `---`,
      "> {% include [header](./header.tmpl.md) with title=title %}",
      "",
      "Body: {{ title }}",
    ].join("\n");
    const tmpl = Template.fromSourceAllowingUnused(src);
    assert.ok(tmpl);
  });
});

// ---------------------------------------------------------------------------
// Nested types
// ---------------------------------------------------------------------------

describe("Nested types", () => {
  it("renders nested list of structs with inner fields", () => {
    const src = [
      `---`,
      "params:",
      "  - sections = list(heading = str, items = list(label = str))",
      `---`,
      "> {% for section in sections %}",
      "",
      "## {{ section.heading }}",

      "",
      "> {% for item in section.items %}",
      "",
      "- {{ item.label }}",

      "",
      "> {% /for %}",
      "> {% /for %}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    const result = tmpl.render({
      sections: [
        { heading: "A", items: [{ label: "one" }, { label: "two" }] },
        { heading: "B", items: [{ label: "three" }] },
      ],
    });
    assert.ok(result.includes("## A"));
    assert.ok(result.includes("- one"));
    assert.ok(result.includes("- two"));
    assert.ok(result.includes("## B"));
    assert.ok(result.includes("- three"));
  });

  it("renders struct with nested struct", () => {
    const src = [
      `---`,
      "params:",
      "  - config = struct(db = struct(host = str, port = int))",
      `---`,
      "{{ config.db.host }}:{{ config.db.port }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    const result = tmpl.render({
      config: { db: { host: "localhost", port: 5432 } },
    });
    assert.strictEqual(result, "localhost:5432");
  });
});

// ---------------------------------------------------------------------------
// TypedTemplate
// ---------------------------------------------------------------------------

describe("TypedTemplate", () => {
  it("renders with typed params", () => {
    interface MyParams {
      readonly name: string;
      readonly count: number;
    }
    const tmpl = TypedTemplate.fromSource<MyParams>(
      `---
params:
  - name = str
  - count = int
---
{{ name }}: {{ count }}`,
    );
    const result = tmpl.render({ name: "Alice", count: 42 });
    assert.strictEqual(result, "Alice: 42");
  });

  it("wraps an existing Template", () => {
    interface P {
      readonly x: string;
    }
    const inner = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    const typed = TypedTemplate.wrap<P>(inner);
    assert.strictEqual(typed.render({ x: "hello" }), "hello");
  });

  it("exposes metadata via inner template", () => {
    interface P {
      readonly x: string;
    }
    const tmpl = TypedTemplate.fromSource<P>(
      `---
params: [x = str]
---
{{ x }}`,
    );
    assert.strictEqual(tmpl.declarations().length, 1);
    assert.ok(tmpl.sourceHash() > 0);
    assert.ok(tmpl.body().includes("{{ x }}"));
    assert.ok(tmpl.toString().includes("Template"));
  });

  it("defaults returns partial of P", () => {
    interface P {
      readonly name: string;
      readonly count: number;
    }
    const tmpl = TypedTemplate.fromSource<P>(
      `---
params:
  - name = str := "World"
  - count = int
---
{{ name }} {{ count }}`,
    );
    const defs = tmpl.defaults();
    assert.strictEqual(defs.name, "World");
    assert.strictEqual(defs.count, undefined);
  });

  it("renderUnchecked produces correct output", () => {
    interface P {
      readonly x: string;
    }
    const tmpl = TypedTemplate.fromSource<P>(
      `---
params: [x = str]
---
{{ x }}`,
    );
    assert.strictEqual(tmpl.renderUnchecked({ x: "fast" }), "fast");
  });

  it("renderTrusted validates on first call", () => {
    interface P {
      readonly x: string;
    }
    const tmpl = TypedTemplate.fromSource<P>(
      `---
params: [x = str]
---
{{ x }}`,
    );
    // First call: validated
    assert.strictEqual(tmpl.renderTrusted({ x: "first" }), "first");
    // Subsequent calls: unchecked (but still correct)
    assert.strictEqual(tmpl.renderTrusted({ x: "second" }), "second");
    assert.strictEqual(tmpl.renderTrusted({ x: "third" }), "third");
  });

  it("renderTrusted rejects bad types on first call", () => {
    interface P {
      readonly x: string;
    }
    const tmpl = TypedTemplate.fromSource<P>(
      `---
params: [x = bool]
---
{{ x }}`,
    );
    // First call with wrong type should throw
    assert.throws(() => tmpl.renderTrusted({ x: "not a bool" }));
  });
});

// ---------------------------------------------------------------------------
// Template.renderUnchecked
// ---------------------------------------------------------------------------

describe("Template.renderUnchecked", () => {
  it("renders without type checking", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }}: {{ count }}`,
    );
    assert.strictEqual(
      tmpl.renderUnchecked({ name: "Bob", count: 7 }),
      "Bob: 7",
    );
  });

  it("renders with defaults when params omitted", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str := "World"
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.renderUnchecked({}), "Hello World!");
  });

  it("is faster than render for list templates", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str, score = int)
---
> {% for item in items %}

{{ item.name }}: {{ item.score }}

> {% /for %}`,
    );
    const data = {
      items: Array.from({ length: 10 }, (_, i) => ({
        name: `item${String(i)}`,
        score: i * 10,
      })),
    };

    // Warmup JIT and inline caches
    for (let i = 0; i < 100; i++) {
      tmpl.render(data);
      tmpl.renderUnchecked(data);
    }

    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      tmpl.renderUnchecked(data);
    }
    const uncheckedMs = performance.now() - start;

    const start2 = performance.now();
    for (let i = 0; i < 500; i++) {
      tmpl.render(data);
    }
    const checkedMs = performance.now() - start2;

    // renderUnchecked should be faster for list templates
    assert.ok(
      uncheckedMs < checkedMs,
      `renderUnchecked (${uncheckedMs.toFixed(2)}ms) should be faster than render (${checkedMs.toFixed(2)}ms) for list templates`,
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrent / reuse
// ---------------------------------------------------------------------------

describe("Template reuse", () => {
  it("renders same template many times with different params", () => {
    const tmpl = Template.fromSource(`---
params: [n = int]
---
{{ n }}`);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(tmpl.render({ n: i }), String(i));
    }
  });

  it("multiple templates can coexist", () => {
    const t1 = Template.fromSource(`---
params: [x = str]
---
a={{ x }}`);
    const t2 = Template.fromSource(`---
params: [y = int]
---
b={{ y }}`);
    assert.strictEqual(t1.render({ x: "hi" }), "a=hi");
    assert.strictEqual(t2.render({ y: 42 }), "b=42");
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe("Comments", () => {
  it("strips inline comments", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = str]
---
Before{# this is a comment #}After {{ x }}`,
    );
    const result = tmpl.render({ x: "!" });
    assert.ok(result.includes("BeforeAfter"));
    assert.ok(!result.includes("this is a comment"));
  });

  it("strips multi-word comments", () => {
    const tmpl = Template.fromSource(`---
params: []
---
A{# remove me #}B`);
    assert.strictEqual(tmpl.render({}), "AB");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: generate types → use with TypedTemplate
// ---------------------------------------------------------------------------

describe("End-to-end type workflow", () => {
  const TEMPLATE_SRC = [
    `---`,
    "params:",
    "  - title = str",
    "  - count = int",
    "  - items = list(label = str, done = bool)",
    "  - outcome = enum(Success(msg = str), Failure)",
    `---`,
    "# {{ title }} ({{ count }})",

    "",
    "> {% for item in items %}",
    "",
    "- {{ item.label }}: {{ item.done }}",

    "",
    "> {% /for %}",
    "> {% match outcome %}",
    "> {% case Success %}",
    "",
    "OK: {{ outcome.msg }}",

    "",
    "> {% case Failure %}",
    "",
    "FAIL",

    "",
    "> {% /match %}",
  ].join("\n");

  it("generateTypes produces valid code for complex template", () => {
    const code = generateTypes(TEMPLATE_SRC);
    // Check all types are generated
    assert.ok(code.includes("interface Params"));
    assert.ok(code.includes("readonly title: string"));
    assert.ok(code.includes("readonly count: number"));
    assert.ok(code.includes("interface ItemsItem"));
    assert.ok(code.includes("readonly label: string"));
    assert.ok(code.includes("readonly done: boolean"));
    assert.ok(code.includes("type Outcome"));
    assert.ok(code.includes('"Failure"'));
    assert.ok(code.includes("Outcome_Success"));
    assert.ok(code.includes('readonly __kind__: "Success"'));
    assert.ok(code.includes("readonly msg: string"));
  });

  it("inferTypes matches template structure", () => {
    const result = inferTypes(TEMPLATE_SRC);
    assert.strictEqual(result.fields.length, 4);
    assert.strictEqual(defined(result.fields[0]).name, "title");
    assert.strictEqual(defined(result.fields[0]).tsType, "string");
    assert.strictEqual(defined(result.fields[1]).name, "count");
    assert.strictEqual(defined(result.fields[1]).tsType, "number");
    // items should be an array type
    assert.ok(defined(result.fields[2]).tsType.includes("label: string"));
    assert.ok(defined(result.fields[2]).tsType.includes("done: boolean"));
    // outcome should be a union type
    assert.ok(defined(result.fields[3]).tsType.includes('"Failure"'));
    assert.ok(defined(result.fields[3]).tsType.includes('__kind__: "Success"'));
  });

  it("TypedTemplate works with inferred type structure", () => {
    // Simulate what a user would do after running generateTypes
    interface ItemsItem {
      readonly label: string;
      readonly done: boolean;
    }
    interface Outcome_Success {
      readonly __kind__: "Success";
      readonly msg: string;
    }
    type Outcome = Outcome_Success | "Failure";
    interface Params {
      readonly title: string;
      readonly count: number;
      readonly items: readonly ItemsItem[];
      readonly outcome: Outcome;
    }

    const tmpl = TypedTemplate.fromSource<Params>(TEMPLATE_SRC);

    const result = tmpl.render({
      title: "Report",
      count: 2,
      items: [
        { label: "Task A", done: true },
        { label: "Task B", done: false },
      ],
      outcome: { __kind__: "Success", msg: "all good" },
    });

    assert.ok(result.includes("# Report (2)"));
    assert.ok(result.includes("- Task A: true"));
    assert.ok(result.includes("- Task B: false"));
    assert.ok(result.includes("OK: all good"));
  });

  it("TypedTemplate rejects wrong params at runtime", () => {
    interface Params {
      readonly title: string;
      readonly count: number;
      readonly items: readonly {
        readonly label: string;
        readonly done: boolean;
      }[];
      readonly outcome:
        { readonly __kind__: "Success"; readonly msg: string } | "Failure";
    }

    const tmpl = TypedTemplate.fromSource<Params>(TEMPLATE_SRC);

    // Missing required param
    assert.throws(() =>
      tmpl.render({
        title: "X",
        count: 1,
        items: [],
      } as unknown as Params),
    );
  });

  it("frontmatter accessor exposes parsed type info", () => {
    const tmpl = Template.fromSource(TEMPLATE_SRC);
    const fm = tmpl.frontmatter;
    assert.strictEqual(fm.params.length, 4);
    const titleParam = defined(fm.params[0]);
    assert.strictEqual(titleParam.name, "title");
    assert.strictEqual(titleParam.varType.kind, "str");
    const itemsParam = defined(fm.params[2]);
    assert.strictEqual(itemsParam.name, "items");
    assert.strictEqual(itemsParam.varType.kind, "list");
    const outcomeParam = defined(fm.params[3]);
    assert.strictEqual(outcomeParam.name, "outcome");
    // strictEqual narrows the discriminant, so `.variants` is accessible.
    assert.strictEqual(outcomeParam.varType.kind, "enum");
    assert.strictEqual(outcomeParam.varType.variants.length, 2);
    assert.strictEqual(
      defined(outcomeParam.varType.variants[0]).name,
      "Success",
    );
    assert.strictEqual(
      defined(outcomeParam.varType.variants[1]).name,
      "Failure",
    );
  });
});

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

describe("Error messages", () => {
  it("MissingParamsError lists missing param names", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - a = str
  - b = int
---
{{ a }} {{ b }}`,
    );
    try {
      tmpl.render({});
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("a"));
      assert.ok(err.message.includes("b"));
    }
  });

  it("TypeMismatchError includes path and types", () => {
    const tmpl = Template.fromSource(
      `---
params: [flag = bool]
---
{{ flag }}`,
    );
    try {
      tmpl.render({ flag: "not a bool" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("flag"));
      assert.ok(err.message.includes("bool"));
    }
  });

  it("ExtraParamsError lists extra param names", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    try {
      tmpl.render({ x: "hi", bogus: "extra" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("bogus"));
    }
  });
});

// ---------------------------------------------------------------------------
// match() and isVariant()
// ---------------------------------------------------------------------------

describe("match()", () => {
  const Status = defineVariants({
    Done: ["summary"],
    InProgress: null,
    Blocked: ["reason"],
  });

  it("matches unit variant", () => {
    const result = match(Status.InProgress, {
      Done: () => "done",
      InProgress: () => "working",
      Blocked: () => "blocked",
    });
    assert.strictEqual(result, "working");
  });

  it("matches struct variant with fields", () => {
    const v = Status.Done({ summary: "All tests pass" });
    const result = match(v, {
      Done: (f) => `✅ ${String(f.summary)}`,
      InProgress: () => "working",
      Blocked: () => "blocked",
    });
    assert.strictEqual(result, "✅ All tests pass");
  });

  it("uses wildcard fallback", () => {
    const result = match(Status.InProgress, {
      Done: () => "done",
      _: () => "other",
    });
    assert.strictEqual(result, "other");
  });

  it("throws without handler or wildcard", () => {
    assert.throws(
      () => match(Status.InProgress, { Done: () => "done" }),
      /no handler for variant 'InProgress'/,
    );
  });

  it("works with __kind__ tagged objects", () => {
    const v = { __kind__: "Confirmed", evidence: "proof" };
    const result = match(v, {
      Confirmed: (f) => `yes: ${String(f.evidence)}`,
      _: () => "no",
    });
    assert.strictEqual(result, "yes: proof");
  });

  it("works with string unit variants", () => {
    const result = match("Rejected", {
      Confirmed: () => "yes",
      Rejected: () => "no",
    });
    assert.strictEqual(result, "no");
  });
});

describe("isVariant()", () => {
  const Status = defineVariants({
    Done: ["summary"],
    InProgress: null,
  });

  it("detects unit variant", () => {
    assert.ok(isVariant(Status.InProgress, "InProgress"));
    assert.ok(!isVariant(Status.InProgress, "Done"));
  });

  it("detects struct variant", () => {
    const v = Status.Done({ summary: "ok" });
    assert.ok(isVariant(v, "Done"));
    assert.ok(!isVariant(v, "InProgress"));
  });

  it("detects __kind__ objects", () => {
    assert.ok(isVariant({ __kind__: "Confirmed" }, "Confirmed"));
    assert.ok(!isVariant({ __kind__: "Confirmed" }, "Rejected"));
  });

  it("detects string variants", () => {
    assert.ok(isVariant("Rejected", "Rejected"));
    assert.ok(!isVariant("Rejected", "Confirmed"));
  });
});

// ---------------------------------------------------------------------------
// Edge cases & consistency
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("empty template (no params, no body)", () => {
    const tmpl = Template.fromSource(`---
params: []
---
`);
    assert.strictEqual(tmpl.render(), "");
    assert.strictEqual(tmpl.renderUnchecked(), "");
    assert.deepStrictEqual(tmpl.defaults(), {});
    assert.deepStrictEqual(tmpl.consts(), {});
  });

  it("consts-only template (no params)", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - NAME = str := "test"

params: []
---
Hello {{ NAME }}!`,
    );
    assert.strictEqual(tmpl.render(), "Hello test!");
    assert.strictEqual(tmpl.renderUnchecked(), "Hello test!");
    assert.deepStrictEqual(tmpl.consts(), { NAME: "test" });
  });

  it("TypedTemplate.consts() with multiple consts", () => {
    const tmpl = TypedTemplate.fromSource<{ x: string }>(
      `---
consts:
  - A = int := 1
  - B = str := "two"
  - C = bool := true

params: [x = str]
---
{{ A }} {{ B }} {{ C }} {{ x }}`,
    );
    const c = tmpl.consts();
    assert.strictEqual(c.A, 1);
    assert.strictEqual(c.B, "two");
    assert.strictEqual(c.C, true);
    assert.strictEqual(tmpl.render({ x: "done" }), "1 two true done");
  });

  it("{{ list }} is a compile error", () => {
    // Bare {{ items }} should fail to compile when items is a list type.
    assert.throws(
      () =>
        Template.fromSourceAllowingUnused(
          `---
params:
  - items = list(name = str)
---
{{ items }}`,
        ),
      /cannot display.*list/,
    );
  });

  it("defaults are injected in renderUnchecked", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - greeting = str := "Hi"
  - name = str
---
{{ greeting }} {{ name }}`,
    );
    assert.strictEqual(tmpl.renderUnchecked({ name: "Bob" }), "Hi Bob");
  });

  it("render and renderUnchecked produce same output for simple templates", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - x = str
  - n = int
---
{{ x }} has {{ n }} items`,
    );
    const params = { x: "Alice", n: 42 };
    assert.strictEqual(tmpl.render(params), tmpl.renderUnchecked(params));
  });
});

// ---------------------------------------------------------------------------
// fromSourceWithBaseDir
// ---------------------------------------------------------------------------

describe("Template.fromSourceWithBaseDir", () => {
  it("parses and renders a basic template", () => {
    const tmpl = Template.fromSourceWithBaseDir(
      `---
params: [x = str]
---
{{ x }}`,
      "/tmp",
    );
    assert.strictEqual(tmpl.render({ x: "works" }), "works");
  });

  it("sets basePath for include resolution", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-basedir-"));
    try {
      const tmpl = Template.fromSourceWithBaseDir(
        `---
params: [x = str]
---
{{ x }}`,
        dir,
      );
      assert.strictEqual(tmpl.basePath, dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("resolves and renders file-based includes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-include-"));
    try {
      // Create the included template file
      fs.writeFileSync(
        path.join(dir, "header.tmpl.md"),
        `---
params: [title = str]
---
# {{ title }}`,
      );
      const src = [
        `---`,
        "params: [title = str]",
        `---`,
        "> {% include [header](./header.tmpl.md) with title=title %}",
        "",
        "Body: {{ title }}",
      ].join("\n");
      const tmpl = Template.fromSourceWithBaseDir(src, dir);
      const result = tmpl.render({ title: "Hello" });
      assert.ok(
        result.includes("# Hello"),
        `expected included header in: ${result}`,
      );
      assert.ok(result.includes("Body: Hello"), `expected body in: ${result}`);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("throws on missing include file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-include-"));
    try {
      const src = [
        `---`,
        "params: [title = str]",
        `---`,
        "> {% include [missing](./does_not_exist.tmpl.md) with title=title %}",
        "",
        "Body: {{ title }}",
      ].join("\n");
      const tmpl = Template.fromSourceWithBaseDir(src, dir);
      assert.throws(
        () => tmpl.render({ title: "Hello" }),
        (err: Error) =>
          err instanceof IncludeNotFoundError &&
          err.include.includes("does_not_exist.tmpl.md") &&
          err.message.includes("include not found"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TemplateCache — file-based tests
// ---------------------------------------------------------------------------

describe("TemplateCache (file operations)", () => {
  it("loads and renders a template from file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cache-"));
    try {
      const fp = path.join(dir, "greet.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: [name = str]
---
Hello {{ name }}!`,
      );
      const cache = new TemplateCache();
      const tmpl = cache.load(fp);
      assert.strictEqual(tmpl.render({ name: "cached" }), "Hello cached!");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("returns cached template on repeated loads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cache2-"));
    try {
      const fp = path.join(dir, "test.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: [x = str]
---
{{ x }}`,
      );
      const cache = new TemplateCache();
      const t1 = cache.load(fp);
      const t2 = cache.load(fp);
      assert.strictEqual(t1.sourceHash(), t2.sourceHash());
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("templateCount tracks loaded templates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-count-"));
    try {
      const cache = new TemplateCache();
      assert.strictEqual(cache.templateCount(), 0);

      for (let i = 0; i < 3; i++) {
        const fp = path.join(dir, `t${String(i)}.tmpl.md`);
        fs.writeFileSync(
          fp,
          `---
params: []
---
Hi`,
        );
        cache.load(fp);
      }
      assert.strictEqual(cache.templateCount(), 3);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("clear removes all cached templates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-clear-"));
    try {
      const fp = path.join(dir, "test.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: []
---
Hi`,
      );
      const cache = new TemplateCache();
      cache.load(fp);
      assert.strictEqual(cache.templateCount(), 1);
      cache.clear();
      assert.strictEqual(cache.templateCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("throws on non-existent file", () => {
    const cache = new TemplateCache();
    assert.throws(() => cache.load("/nonexistent/path.tmpl.md"));
  });

  it("reloads when file content changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-reload-"));
    try {
      const fp = path.join(dir, "test.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: []
---
Version 1`,
      );
      const cache = new TemplateCache();
      const t1 = cache.load(fp);
      const hash1 = t1.sourceHash();

      fs.writeFileSync(
        fp,
        `---
params: []
---
Version 2`,
      );
      const t2 = cache.load(fp);
      const hash2 = t2.sourceHash();

      assert.notStrictEqual(hash1, hash2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("deduplicates include ASTs across multiple references", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-dedup-"));
    try {
      const headerPath = path.join(dir, "header.tmpl.md");
      fs.writeFileSync(
        headerPath,
        `---
params: [title = str]
---
# {{ title }}`,
      );
      const mainPath = path.join(dir, "main.tmpl.md");
      fs.writeFileSync(
        mainPath,
        `---
params: [title = str]
---
> {% include [header](./header.tmpl.md) with title=title %}

Body content

> {% include [header](./header.tmpl.md) with title=title %}`,
      );
      const cache = new TemplateCache();
      const tmpl = cache.load(mainPath);
      assert.strictEqual(cache.templateCount(), 1);
      assert.strictEqual(cache.includeCount(), 0);

      const result = tmpl.render({ title: "Welcome" });
      assert.ok(result.includes("# Welcome"));
      assert.strictEqual(cache.templateCount(), 1);
      assert.strictEqual(cache.includeCount(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("compiles include exactly once inside a loop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-loop-"));
    try {
      const itemPath = path.join(dir, "item.tmpl.md");
      fs.writeFileSync(
        itemPath,
        `---
params: [name = str]
---
Item: {{ name }}
`,
      );
      const listPath = path.join(dir, "list.tmpl.md");
      fs.writeFileSync(
        listPath,
        `---
params: [items = list(name = str)]
---
> {% for item in items %}
> {% include [item](./item.tmpl.md) with name=item.name %}
> {% /for %}`,
      );
      const cache = new TemplateCache();
      const tmpl = cache.load(listPath);

      const items = Array.from({ length: 50 }, (_, i) => ({
        name: `Item ${String(i)}`,
      }));
      const result = tmpl.render({ items });
      assert.ok(result.includes("Item: Item 0"));
      assert.ok(result.includes("Item: Item 49"));
      assert.strictEqual(cache.includeCount(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("recompiles include when mtime changes on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-mtime-"));
    try {
      const subPath = path.join(dir, "sub.tmpl.md");
      fs.writeFileSync(
        subPath,
        `---
params: []
---
Original Include`,
      );
      const mainPath = path.join(dir, "main.tmpl.md");
      fs.writeFileSync(
        mainPath,
        `---
params: []
---
> {% include [sub](./sub.tmpl.md) %}`,
      );
      const cache = new TemplateCache();
      const tmpl = cache.load(mainPath);

      const res1 = tmpl.render();
      assert.ok(res1.includes("Original Include"));
      assert.strictEqual(cache.includeCount(), 1);

      const stat1 = fs.statSync(subPath);
      const newTime = new Date(stat1.mtimeMs + 2000);
      fs.writeFileSync(
        subPath,
        `---
params: []
---
Modified Include`,
      );
      fs.utimesSync(subPath, newTime, newTime);

      const res2 = tmpl.render();
      assert.ok(res2.includes("Modified Include"));
      assert.strictEqual(cache.includeCount(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("resolves include env: vars through the shared cache", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-env-"));
    try {
      // Child declares an env var with NO default — it can only resolve if
      // the parent's compile env is threaded through the cached resolver.
      fs.writeFileSync(
        path.join(dir, "child.tmpl.md"),
        `---
env: [PROMPTS_DIR = str]
params: []
---
dir={{ PROMPTS_DIR }}`,
      );
      const mainSrc = `---
params: []
---
> {% include [child](./child.tmpl.md) %}`;
      fs.writeFileSync(path.join(dir, "main.tmpl.md"), mainSrc);

      const cache = new TemplateCache();
      const tmpl = Template.fromSourceWithOptions(mainSrc, {
        baseDir: dir,
        env: { PROMPTS_DIR: "/prompts" },
      });
      tmpl._cache = cache;

      // First render — compiles the include from disk with env threaded in.
      const out1 = tmpl.render();
      assert.ok(out1.includes("dir=/prompts"), out1);
      assert.strictEqual(cache.includeCount(), 1);

      // Second render — served from cache; env-injected const must persist.
      const out2 = tmpl.render();
      assert.strictEqual(out1, out2);
      assert.strictEqual(cache.includeCount(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("invalidates cached include when compile env changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-env-inval-"));
    try {
      fs.writeFileSync(
        path.join(dir, "child.tmpl.md"),
        `---
env: [PROMPTS_DIR = str]
params: []
---
dir={{ PROMPTS_DIR }}`,
      );
      const mainSrc = `---
params: []
---
> {% include [child](./child.tmpl.md) %}`;
      fs.writeFileSync(path.join(dir, "main.tmpl.md"), mainSrc);

      const cache = new TemplateCache();
      const compileWith = (value: string): Template => {
        const t = Template.fromSourceWithOptions(mainSrc, {
          baseDir: dir,
          env: { PROMPTS_DIR: value },
        });
        t._cache = cache;
        return t;
      };

      // Render with env A → caches "dir=/alpha".
      const outA = compileWith("/alpha").render();
      assert.ok(outA.includes("dir=/alpha"), outA);

      // Render with env B against the SAME cache. The file is untouched, so
      // without env-aware invalidation the mtime fast path would return the
      // stale "/alpha" entry. It must instead recompute to "/beta".
      const outB = compileWith("/beta").render();
      assert.ok(outB.includes("dir=/beta"), outB);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("clear() resets both templateCount and includeCount", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cleardup-"));
    try {
      const subPath = path.join(dir, "sub.tmpl.md");
      fs.writeFileSync(
        subPath,
        `---
params: []
---
Sub content`,
      );
      const mainPath = path.join(dir, "main.tmpl.md");
      fs.writeFileSync(
        mainPath,
        `---
params: []
---
> {% include [sub](./sub.tmpl.md) %}`,
      );
      const cache = new TemplateCache();
      const tmpl = cache.load(mainPath);
      tmpl.render();

      assert.strictEqual(cache.templateCount(), 1);
      assert.strictEqual(cache.includeCount(), 1);

      cache.clear();
      assert.strictEqual(cache.templateCount(), 0);
      assert.strictEqual(cache.includeCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("resolves nested relative includes across directories in cache", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-nested-"));
    try {
      const dir1 = path.join(dir, "dir1");
      const dir2 = path.join(dir, "dir2");
      fs.mkdirSync(dir1);
      fs.mkdirSync(dir2);

      fs.writeFileSync(
        path.join(dir2, "nested.tmpl.md"),
        `---
params: []
---
Nested content`,
      );
      fs.writeFileSync(
        path.join(dir2, "sub.tmpl.md"),
        `---
params: []
---
Sub before {% include [nested](./nested.tmpl.md) %} Sub after`,
      );
      const mainPath = path.join(dir1, "main.tmpl.md");
      fs.writeFileSync(
        mainPath,
        `---
params: []
---
Main before {% include [sub](../dir2/sub.tmpl.md) %} Main after`,
      );

      const cache = new TemplateCache();
      const tmpl = cache.load(mainPath);
      const result = tmpl.render();
      assert.ok(result.includes("Main before"));
      assert.ok(result.includes("Sub before"));
      assert.ok(result.includes("Nested content"));
      assert.ok(result.includes("Sub after"));
      assert.ok(result.includes("Main after"));
      assert.strictEqual(cache.templateCount(), 1);
      assert.strictEqual(cache.includeCount(), 2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateDeclarationsAgainst — thorough coverage
// ---------------------------------------------------------------------------

describe("validateDeclarationsAgainst (thorough)", () => {
  it("accepts matching declarations", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    tmpl.validateDeclarationsAgainst([
      ["name", "str"],
      ["count", "int"],
    ]);
  });

  it("rejects when count differs (added)", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    assert.throws(() => {
      tmpl.validateDeclarationsAgainst([["name", "str"]]);
    }, TemplateError);
  });

  it("rejects when count differs (removed)", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
{{ name }}`,
    );
    assert.throws(() => {
      tmpl.validateDeclarationsAgainst([
        ["name", "str"],
        ["count", "int"],
      ]);
    }, TemplateError);
  });

  it("rejects retyped parameter", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    assert.throws(() => {
      tmpl.validateDeclarationsAgainst([
        ["name", "str"],
        ["count", "float"],
      ]);
    }, TemplateError);
  });

  it("rejects renamed parameter", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
{{ name }}`,
    );
    assert.throws(() => {
      tmpl.validateDeclarationsAgainst([["different", "str"]]);
    }, TemplateError);
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

describe("stripFrontmatter", () => {
  it("returns body without frontmatter", () => {
    const body = stripFrontmatter(
      `---
params: [x = str]
---
Hello {{ x }}!`,
    );
    assert.ok(body.includes("Hello {{ x }}!"));
    assert.ok(!body.includes("params"));
  });

  it("handles template with no body", () => {
    const body = stripFrontmatter(`---
params: []
---
`);
    assert.strictEqual(body.trim(), "");
  });

  it("preserves multi-line body", () => {
    const body = stripFrontmatter(
      `---
params: []
---
Line 1
Line 2
Line 3`,
    );
    assert.ok(body.includes("Line 1"));
    assert.ok(body.includes("Line 2"));
    assert.ok(body.includes("Line 3"));
  });
});

// ---------------------------------------------------------------------------
// Context class
// ---------------------------------------------------------------------------

describe("Context", () => {
  it("set and get string value", () => {
    const ctx = new Context();
    ctx.set("name", "Alice");
    const val = ctx.get("name");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "str");
    assert.strictEqual(val.value, "Alice");
  });

  it("set and get int value", () => {
    const ctx = new Context();
    ctx.set("count", 42);
    const val = ctx.get("count");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "int");
  });

  it("set and get bool value", () => {
    const ctx = new Context();
    ctx.set("flag", true);
    const val = ctx.get("flag");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "bool");
  });

  it("set and get float value", () => {
    const ctx = new Context();
    ctx.set("score", 3.14);
    const val = ctx.get("score");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "float");
  });

  it("returns undefined for missing key", () => {
    const ctx = new Context();
    assert.strictEqual(ctx.get("nonexistent"), undefined);
  });

  it("overwrites existing value", () => {
    const ctx = new Context();
    ctx.set("x", "first");
    ctx.set("x", "second");
    const val = ctx.get("x");
    assert.ok(val !== undefined);
    if (val.type === "str") assert.strictEqual(val.value, "second");
  });

  it("set and get list value", () => {
    const ctx = new Context();
    ctx.set("items", [{ label: "a" }, { label: "b" }]);
    const val = ctx.get("items");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "list");
  });

  it("set and get dict value", () => {
    const ctx = new Context();
    ctx.set("config", { host: "localhost", port: 8080 });
    const val = ctx.get("config");
    assert.ok(val !== undefined);
    assert.strictEqual(val.type, "struct");
  });

  it("values property returns the internal map", () => {
    const ctx = new Context();
    ctx.set("a", "hello");
    ctx.set("b", 42);
    assert.ok(ctx.values instanceof Map);
    assert.ok(ctx.values.has("a"));
    assert.ok(ctx.values.has("b"));
  });
});

// ---------------------------------------------------------------------------
// Error type properties
// ---------------------------------------------------------------------------

describe("Error type properties", () => {
  it("MissingParamsError exposes missing names", () => {
    const err = new MissingParamsError(["a", "b"]);
    assert.deepStrictEqual(err.missing, ["a", "b"]);
    assert.ok(err instanceof TemplateError);
    assert.ok(err.message.includes("a"));
    assert.ok(err.message.includes("b"));
    assert.strictEqual(err.name, "MissingParamsError");
  });

  it("TypeMismatchError exposes path, expected, actual", () => {
    const err = new TypeMismatchError("flag", "bool", "str");
    assert.strictEqual(err.path, "flag");
    assert.strictEqual(err.expected, "bool");
    assert.strictEqual(err.actual, "str");
    assert.ok(err instanceof TemplateError);
    assert.ok(err.message.includes("flag"));
    assert.ok(err.message.includes("bool"));
    assert.strictEqual(err.name, "TypeMismatchError");
  });

  it("ExtraParamsError exposes extra names", () => {
    const err = new ExtraParamsError(["bogus", "unknown"]);
    assert.deepStrictEqual(err.extra, ["bogus", "unknown"]);
    assert.ok(err instanceof TemplateError);
    assert.ok(err.message.includes("bogus"));
    assert.strictEqual(err.name, "ExtraParamsError");
  });

  it("UndefinedVariableError exposes variable name", () => {
    const err = new UndefinedVariableError("myVar");
    assert.strictEqual(err.variable, "myVar");
    assert.ok(err instanceof TemplateError);
    assert.ok(err.message.includes("myVar"));
    assert.strictEqual(err.name, "UndefinedVariableError");
  });

  it("UnknownFilterError exposes filter name", () => {
    const err = new UnknownFilterError("bogusFilter");
    assert.strictEqual(err.filter, "bogusFilter");
    assert.ok(err instanceof TemplateError);
    assert.ok(err.message.includes("bogusFilter"));
    assert.strictEqual(err.name, "UnknownFilterError");
  });

  it("TemplateSyntaxError has line, column and snippet", () => {
    const err = new TemplateSyntaxError("bad syntax", 5, 3, "{{ unclosed");
    assert.strictEqual(err.line, 5);
    assert.strictEqual(err.column, 3);
    assert.strictEqual(err.snippet, "{{ unclosed");
    assert.ok(err instanceof TemplateError);
    assert.strictEqual(err.name, "TemplateSyntaxError");
  });

  it("TemplateError is the base class", () => {
    const err = new TemplateError("generic error");
    assert.strictEqual(err.name, "TemplateError");
    assert.ok(err instanceof Error);
    assert.strictEqual(err.message, "generic error");
  });
});

// ---------------------------------------------------------------------------
// TemplateSyntaxError cases
// ---------------------------------------------------------------------------

describe("TemplateSyntaxError on invalid source", () => {
  it("rejects source without frontmatter", () => {
    assert.throws(
      () => Template.fromSource("no frontmatter at all"),
      (err: unknown) => err instanceof TemplateSyntaxError,
    );
  });

  it("rejects unused params in strict mode", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params: [name = str, unused = int]
---
Hello {{ name }}!`,
        ),
      (err: unknown) => err instanceof TemplateSyntaxError,
    );
  });

  it("fromSourceAllowingUnused permits unused params", () => {
    const tmpl = Template.fromSourceAllowingUnused(
      `---
params: [name = str, unused = int]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(
      tmpl.render({ name: "world", unused: 42 }),
      "Hello world!",
    );
  });
});

// ---------------------------------------------------------------------------
// Template.render with allowExtra option
// ---------------------------------------------------------------------------

describe("Template.render allowExtra option", () => {
  it("render rejects extra params by default", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    assert.throws(() => tmpl.render({ x: "ok", extra: "bad" }));
  });

  it("render accepts extra params with allowExtra", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    const result = tmpl.render(
      { x: "ok", extra: "ignored" },
      { allowExtra: true },
    );
    assert.strictEqual(result, "ok");
  });
});

// ---------------------------------------------------------------------------
// renderDict with Map
// ---------------------------------------------------------------------------

describe("renderDict with Map", () => {
  it("accepts Map<string, unknown>", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }}: {{ count }}`,
    );
    const params = new Map<string, unknown>([
      ["name", "Alice"],
      ["count", 42],
    ]);
    assert.strictEqual(tmpl.renderDict(params), "Alice: 42");
  });

  it("accepts Map with allowExtra", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    const params = new Map<string, unknown>([
      ["name", "World"],
      ["extra", "ignored"],
    ]);
    assert.strictEqual(
      tmpl.renderDict(params, { allowExtra: true }),
      "Hello World!",
    );
  });
});

// ---------------------------------------------------------------------------
// setMaxIncludeDepth
// ---------------------------------------------------------------------------

describe("setMaxIncludeDepth", () => {
  it("does not break rendering", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    tmpl.setMaxIncludeDepth(5);
    assert.strictEqual(tmpl.render({ x: "works" }), "works");
  });

  it("maxIncludeDepth accessor returns value", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    assert.strictEqual(tmpl.maxIncludeDepth, 16);
    tmpl.setMaxIncludeDepth(3);
    assert.strictEqual(tmpl.maxIncludeDepth, 3);
  });
});

// ---------------------------------------------------------------------------
// basePath accessor
// ---------------------------------------------------------------------------

describe("basePath accessor", () => {
  it("returns undefined for fromSource", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    assert.strictEqual(tmpl.basePath, undefined);
  });

  it("returns the dir for fromFile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-bp-"));
    try {
      const fp = path.join(dir, "test.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: [x = str]
---
{{ x }}`,
      );
      const tmpl = Template.fromFile(fp);
      assert.ok(tmpl.basePath !== undefined);
      assert.ok(tmpl.basePath.includes(dir));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Frontmatter metadata fields
// ---------------------------------------------------------------------------

describe("Frontmatter metadata", () => {
  it("exposes name and description", () => {
    const tmpl = Template.fromSourceAllowingUnused(
      `---
name: greeting
description: A greeting template
params: [name = str]
---
{{ name }}`,
    );
    const fm = tmpl.frontmatter;
    assert.strictEqual(fm.name, "greeting");
    assert.strictEqual(fm.description, "A greeting template");
  });

  it("exposes allowUnused flag", () => {
    const src = `---
allow_unused: true
params: [x = str, y = int]
---
{{ x }}`;
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.frontmatter.allowUnused, true);
  });

  it("name and description are undefined when not set", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    const fm = tmpl.frontmatter;
    assert.strictEqual(fm.name, undefined);
    assert.strictEqual(fm.description, undefined);
  });

  it("params list exposes correct types", () => {
    const src = [
      `---`,
      "params:",
      "  - name = str",
      "  - count = int",
      "  - score = float",
      "  - flag = bool",
      `---`,
      "{{ name }} {{ count }} {{ score }} {{ flag }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    const fm = tmpl.frontmatter;
    assert.strictEqual(fm.params.length, 4);
    assert.strictEqual(defined(fm.params[0]).name, "name");
    assert.strictEqual(defined(fm.params[0]).varType.kind, "str");
    assert.strictEqual(defined(fm.params[1]).name, "count");
    assert.strictEqual(defined(fm.params[1]).varType.kind, "int");
    assert.strictEqual(defined(fm.params[2]).name, "score");
    assert.strictEqual(defined(fm.params[2]).varType.kind, "float");
    assert.strictEqual(defined(fm.params[3]).name, "flag");
    assert.strictEqual(defined(fm.params[3]).varType.kind, "bool");
  });

  it("consts are accessible via frontmatter", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - MAX = int := 100
  - TAG = str := "v1"

params: []
---
{{ MAX }} {{ TAG }}`,
    );
    const fm = tmpl.frontmatter;
    assert.strictEqual(fm.consts.length, 2);
    assert.strictEqual(defined(fm.consts[0]).name, "MAX");
    assert.strictEqual(defined(fm.consts[1]).name, "TAG");
  });

  it("imports are empty for simple template", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    assert.strictEqual(tmpl.frontmatter.imports.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Float parameters
// ---------------------------------------------------------------------------

describe("Float parameters", () => {
  it("renders float value", () => {
    const tmpl = Template.fromSource(
      `---
params: [score = float]
---
{{ score }}`,
    );
    assert.strictEqual(tmpl.render({ score: 3.14 }), "3.14");
  });

  it("float accepts integer value", () => {
    const tmpl = Template.fromSource(
      `---
params: [score = float]
---
{{ score }}`,
    );
    // An int value should be accepted where float is expected
    assert.strictEqual(tmpl.render({ score: 42 }), "42");
  });

  it("float with fixed filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = float]
---
{{ val | fixed(2) }}`,
    );
    assert.strictEqual(tmpl.render({ val: 3.14159 }), "3.14");
  });

  it("negative float", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = float]
---
{{ val }}`,
    );
    assert.strictEqual(tmpl.render({ val: -2.5 }), "-2.5");
  });
});

// ---------------------------------------------------------------------------
// Unicode content
// ---------------------------------------------------------------------------

describe("Unicode content", () => {
  it("renders unicode in params", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg }}`,
    );
    const unicode = "Hello 🌍 こんにちは 世界 🦀";
    assert.strictEqual(tmpl.render({ msg: unicode }), unicode);
  });

  it("renders unicode in template body", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
🎉 Hello {{ name }}! 🎉`,
    );
    assert.strictEqual(tmpl.render({ name: "世界" }), "🎉 Hello 世界! 🎉");
  });

  it("renderUnchecked handles unicode", () => {
    const tmpl = Template.fromSource(
      `---
params: [msg = str]
---
{{ msg }}`,
    );
    const unicode = "日本語テスト 🏆";
    assert.strictEqual(tmpl.renderUnchecked({ msg: unicode }), unicode);
  });
});

// ---------------------------------------------------------------------------
// Boundary numbers
// ---------------------------------------------------------------------------

describe("Boundary numbers", () => {
  it("zero int", () => {
    const tmpl = Template.fromSource(`---
params: [n = int]
---
{{ n }}`);
    assert.strictEqual(tmpl.render({ n: 0 }), "0");
  });

  it("negative int", () => {
    const tmpl = Template.fromSource(`---
params: [n = int]
---
{{ n }}`);
    assert.strictEqual(tmpl.render({ n: -42 }), "-42");
  });

  it("large positive int", () => {
    const tmpl = Template.fromSource(`---
params: [n = int]
---
{{ n }}`);
    assert.strictEqual(
      tmpl.render({ n: 9007199254740991 }),
      "9007199254740991",
    );
  });

  it("empty string param", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
[{{ x }}]`);
    assert.strictEqual(tmpl.render({ x: "" }), "[]");
  });

  it("false bool in if condition", () => {
    const tmpl = Template.fromSource(
      `---
params: [flag = bool]
---
> {% if flag %}

yes

> {% else %}

no

> {% /if %}`,
    );
    assert.strictEqual(tmpl.render({ flag: false }).trim(), "no");
  });
});

// ---------------------------------------------------------------------------
// fromFile tests
// ---------------------------------------------------------------------------

describe("Template.fromFile", () => {
  it("loads and renders from file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-file-"));
    try {
      const fp = path.join(dir, "greeting.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: [name = str]
---
Hello {{ name }}!`,
      );
      const tmpl = Template.fromFile(fp);
      assert.strictEqual(tmpl.render({ name: "file" }), "Hello file!");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("throws for missing file", () => {
    assert.throws(
      () => Template.fromFile("/nonexistent/path.tmpl.md"),
      TemplateError,
    );
  });

  it("fromFile resolves includes relative to file directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-file-inc-"));
    try {
      // Create included template
      fs.writeFileSync(
        path.join(dir, "header.tmpl.md"),
        `---
params: [title = str]
---
# {{ title }}`,
      );
      // Create main template that includes it
      fs.writeFileSync(
        path.join(dir, "main.tmpl.md"),
        `---
params: [title = str]
---
> {% include [header](./header.tmpl.md) with title=title %}

Body: {{ title }}`,
      );
      const tmpl = Template.fromFile(path.join(dir, "main.tmpl.md"));
      assert.ok(tmpl.basePath !== undefined);
      const result = tmpl.render({ title: "Test" });
      assert.ok(
        result.includes("# Test"),
        `expected included header in: ${result}`,
      );
      assert.ok(result.includes("Body: Test"), `expected body in: ${result}`);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TypedTemplate.fromFile
// ---------------------------------------------------------------------------

describe("TypedTemplate.fromFile", () => {
  it("loads a typed template from file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-typed-"));
    try {
      const fp = path.join(dir, "typed.tmpl.md");
      fs.writeFileSync(
        fp,
        `---
params: [x = str]
---
{{ x }}`,
      );
      const tmpl = TypedTemplate.fromFile<{ x: string }>(fp);
      assert.strictEqual(tmpl.render({ x: "typed" }), "typed");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Error paths from rendering
// ---------------------------------------------------------------------------

describe("Error paths in rendering", () => {
  it("MissingParamsError thrown by render", () => {
    const tmpl = Template.fromSource(
      `---
params: [a = str, b = int]
---
{{ a }} {{ b }}`,
    );
    try {
      tmpl.render({});
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof MissingParamsError);
      assert.ok(err.missing.includes("a"));
      assert.ok(err.missing.includes("b"));
    }
  });

  it("TypeMismatchError thrown by render", () => {
    const tmpl = Template.fromSource(
      `---
params: [flag = bool]
---
{{ flag }}`,
    );
    try {
      tmpl.render({ flag: "not a bool" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof TypeMismatchError);
      assert.strictEqual(err.path, "flag");
      assert.strictEqual(err.expected, "bool");
    }
  });

  it("ExtraParamsError thrown by render", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    try {
      tmpl.render({ x: "hi", bogus: "extra" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ExtraParamsError);
      assert.ok(err.extra.includes("bogus"));
    }
  });

  it("list item missing field produces MissingParamsError", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str, score = int)
---
> {% for item in items %}

{{ item.name }}

> {% /for %}`,
    );
    assert.throws(
      () => tmpl.render({ items: [{ name: "ok" }] }),
      MissingParamsError,
    );
  });

  it("struct missing field produces MissingParamsError", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}`,
    );
    assert.throws(
      () => tmpl.render({ config: { host: "localhost" } }),
      MissingParamsError,
    );
  });

  it("invalid enum variant produces TypeMismatchError", () => {
    const src = [
      `---`,
      "params:",
      "  - outcome = enum(Confirmed(evidence = str), Rejected)",
      `---`,
      "> {% match outcome %}",
      "> {% case Confirmed %}",
      "",
      "YES",

      "",
      "> {% case Rejected %}",
      "",
      "NO",

      "",
      "> {% /match %}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    assert.throws(() => tmpl.render({ outcome: "Unknown" }), TypeMismatchError);
  });
});

// ---------------------------------------------------------------------------
// fromJs edge cases
// ---------------------------------------------------------------------------

describe("fromJs edge cases", () => {
  it("converts nested objects correctly", () => {
    const val = fromJs({ host: "localhost", port: 8080 });
    assert.strictEqual(val.type, "struct");
    assert.ok(val.fields.has("host"));
    assert.ok(val.fields.has("port"));
  });

  it("converts arrays of objects", () => {
    const val = fromJs([{ name: "a" }, { name: "b" }]);
    assert.strictEqual(val.type, "list");
    assert.strictEqual(val.items.length, 2);
  });

  it("converts null to str empty", () => {
    const val = fromJs(null);
    // null and undefined convert to the NONE sentinel.
    assert.strictEqual(val.type, TYPE_NONE);
  });

  it("converts undefined to str empty", () => {
    const val = fromJs(undefined);
    assert.strictEqual(val.type, TYPE_NONE);
  });
});

// ---------------------------------------------------------------------------
// Raw blocks
// ---------------------------------------------------------------------------

describe("Raw blocks", () => {
  it("preserves template syntax inside raw", () => {
    const tmpl = Template.fromSource(
      `---
params: []
---
> {% raw %}
{{ not_a_variable }}
> {% /raw %}`,
    );
    const result = tmpl.render({});
    assert.ok(
      result.includes("{{ not_a_variable }}"),
      `expected raw content preserved, got: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Multiple filter types
// ---------------------------------------------------------------------------

describe("All filter types", () => {
  it("upper filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = str]
---
{{ val | upper }}`,
    );
    assert.strictEqual(tmpl.render({ val: "hello" }), "HELLO");
  });

  it("lower filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = str]
---
{{ val | lower }}`,
    );
    assert.strictEqual(tmpl.render({ val: "HELLO" }), "hello");
  });

  it("trim filter", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = str]
---
{{ val | trim }}`,
    );
    assert.strictEqual(tmpl.render({ val: "  hello  " }), "hello");
  });

  it("fixed filter on float", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = float]
---
{{ val | fixed(2) }}`,
    );
    assert.strictEqual(tmpl.render({ val: 3.14159 }), "3.14");
  });

  it("join filter on list of strings", () => {
    const tmpl = Template.fromSourceAllowingUnused(
      `---
params:
  - items = list(str)
---
{{ items | join(", ") }}`,
    );
    const result = tmpl.render({ items: ["a", "b", "c"] });
    assert.strictEqual(result, "a, b, c");
  });

  it("join filter on list of structs throws at render", () => {
    // join() is valid at compile time (transforms list→str), but
    // at render time display() on each struct item throws.
    const tmpl = Template.fromSourceAllowingUnused(
      `---
params:
  - items = list(name = str)
---
{{ items | join(", ") }}`,
    );
    assert.throws(
      () =>
        tmpl.render({
          items: [{ name: "a" }, { name: "b" }],
        }),
      /cannot display struct/,
    );
  });

  it("limit filter on list throws at render", () => {
    // {{ items | limit(2) }} passes compile-time check (filtered expressions
    // are skipped). At render time, limit() returns a list, display() rejects.
    const tmpl = Template.fromSourceAllowingUnused(
      `---
params:
  - items = list(name = str)
---
{{ items | limit(2) }}`,
    );
    assert.throws(
      () =>
        tmpl.render({
          items: [{ name: "a" }, { name: "b" }, { name: "c" }],
        }),
      /cannot display list/,
    );
  });

  it("add filter on int", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = int]
---
{{ val | add(10) }}`,
    );
    assert.strictEqual(tmpl.render({ val: 5 }), "15");
  });

  it("sub filter on int", () => {
    const tmpl = Template.fromSource(
      `---
params: [val = int]
---
{{ val | sub(3) }}`,
    );
    assert.strictEqual(tmpl.render({ val: 10 }), "7");
  });

  it("unknown filter throws UnknownFilterError", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params: [val = str]
---
{{ val | nonexistent_filter }}`,
        ).render({ val: "test" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("nonexistent_filter"),
    );
  });
});

// ---------------------------------------------------------------------------
// Built-in functions: idx, len, kind
// ---------------------------------------------------------------------------

describe("Built-in functions (idx, len, kind)", () => {
  it("idx returns loop index", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ idx(item) }}: {{ item.name }}

> {% /for %}`,
    );
    const result = tmpl.render({
      items: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    assert.ok(result.includes("0: a"));
    assert.ok(result.includes("1: b"));
    assert.ok(result.includes("2: c"));
  });

  it("len returns list length", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
Count: {{ len(items) }}`,
    );
    assert.strictEqual(
      tmpl.render({
        items: [{ name: "a" }, { name: "b" }],
      }),
      "Count: 2",
    );
  });

  it("kind returns variant kind", () => {
    const src = [
      `---`,
      "params:",
      "  - outcome = enum(Confirmed(evidence = str), Rejected)",
      `---`,
      "Kind: {{ kind(outcome) }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ outcome: "Rejected" }), "Kind: Rejected");
  });
});

// ---------------------------------------------------------------------------
// Whitespace trimming
// ---------------------------------------------------------------------------

describe("Whitespace trimming", () => {
  it("trims with {{- -}} syntax", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = str]
---
  {{- x -}}  `,
    );
    const result = tmpl.render({ x: "hello" });
    assert.strictEqual(result.trim(), "hello");
  });
});

// ---------------------------------------------------------------------------
// Empty list edge case
// ---------------------------------------------------------------------------

describe("Empty list rendering", () => {
  it("for loop over empty list produces empty output", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ item.name }}

> {% /for %}`,
    );
    const result = tmpl.render({ items: [] });
    assert.strictEqual(result.trim(), "");
  });
});

// ---------------------------------------------------------------------------
// Defaults introspection
// ---------------------------------------------------------------------------

describe("Defaults introspection (additional)", () => {
  it("defaults() returns empty for no-default params", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = str, y = int]
---
{{ x }} {{ y }}`,
    );
    assert.deepStrictEqual(tmpl.defaults(), {});
  });

  it("defaults() returns correct values for multiple types", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str := "World"
  - count = int := 5
  - flag = bool := true
---
{{ name }} {{ count }} {{ flag }}`,
    );
    const defs = tmpl.defaults();
    assert.strictEqual(defs.name, "World");
    assert.strictEqual(defs.count, 5);
    assert.strictEqual(defs.flag, true);
  });

  it("renderUnchecked uses defaults", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - greeting = str := "Hi"
  - name = str
---
{{ greeting }} {{ name }}`,
    );
    assert.strictEqual(tmpl.renderUnchecked({ name: "Bob" }), "Hi Bob");
  });

  it("defaults can be overridden", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str := "World"
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "Alice" }), "Hello Alice!");
    assert.strictEqual(tmpl.render({}), "Hello World!");
  });
});

// ---------------------------------------------------------------------------
// Type alias rendering
// ---------------------------------------------------------------------------

describe("Type alias edge cases", () => {
  it("type alias with struct type", () => {
    const src = [
      `---`,
      "types:",
      "  - Config = struct(host = str, port = int)",
      "",
      "params:",
      "  - cfg = Config",
      `---`,
      "{{ cfg.host }}:{{ cfg.port }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    assert.strictEqual(
      tmpl.render({ cfg: { host: "localhost", port: 3000 } }),
      "localhost:3000",
    );
  });

  it("typeAliases map is populated", () => {
    const src = [
      `---`,
      "types:",
      "  - Priority = enum(High, Medium, Low)",
      "",
      "params:",
      "  - p = Priority",
      `---`,
      "{{ kind(p) }}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    assert.ok(tmpl.frontmatter.typeAliases.has("Priority"));
  });
});

// ---------------------------------------------------------------------------
// Inline match (guard syntax)
// ---------------------------------------------------------------------------

describe("Inline match guard", () => {
  it("renders inline match case Variant", () => {
    const src = [
      `---`,
      "params:",
      "  - status = enum(Active, Inactive)",
      `---`,
      "> {% match status case Active %}",
      "",
      "User is active",

      "",
      "> {% /match %}",
    ].join("\n");
    const tmpl = Template.fromSource(src);
    const result = tmpl.render({ status: "Active" });
    assert.ok(
      result.includes("User is active"),
      `expected 'User is active' in: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// toString representation
// ---------------------------------------------------------------------------

describe("Template toString", () => {
  it("includes param info", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str, count = int]
---
{{ name }} {{ count }}`,
    );
    const str = tmpl.toString();
    assert.ok(str.includes("Template"));
    assert.ok(str.includes("name"));
    assert.ok(str.includes("count"));
  });
});

// ---------------------------------------------------------------------------
// sourceHash stability and uniqueness
// ---------------------------------------------------------------------------

describe("sourceHash (additional)", () => {
  it("same source produces same hash", () => {
    const source = `---
params: [x = str]
---
{{ x }}`;
    const t1 = Template.fromSource(source);
    const t2 = Template.fromSource(source);
    assert.strictEqual(t1.sourceHash(), t2.sourceHash());
  });

  it("different source produces different hash", () => {
    const t1 = Template.fromSource(
      `---
params: [x = str]
---
Hello {{ x }}`,
    );
    const t2 = Template.fromSource(
      `---
params: [x = str]
---
Goodbye {{ x }}`,
    );
    assert.notStrictEqual(t1.sourceHash(), t2.sourceHash());
  });

  it("hash is a positive number", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    assert.ok(tmpl.sourceHash() > 0);
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — match else arm
// ---------------------------------------------------------------------------

describe("Match else arm", () => {
  const src = [
    `---`,
    "params:",
    "  - s = enum(A, B, C)",
    `---`,
    "> {% match s %}",
    "> {% case A %}",
    "",
    "alpha",

    "",
    "> {% else %}",
    "",
    "other",

    "",
    "> {% /match %}",
  ].join("\n");

  it("renders matching case", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "A" }), "alpha\n");
  });

  it("renders else for non-matching variant", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "B" }), "other\n");
  });

  it("renders else for another non-matching variant", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "C" }), "other\n");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — match multi-variant arm
// ---------------------------------------------------------------------------

describe("Match multi-variant arm", () => {
  const src = [
    `---`,
    "params:",
    "  - s = enum(A, B, C)",
    `---`,
    "> {% match s %}",
    "> {% case A | B %}",
    "",
    "ab",

    "",
    "> {% case C %}",
    "",
    "c",

    "",
    "> {% /match %}",
  ].join("\n");

  it("renders shared body for first variant", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "A" }), "ab\n");
  });

  it("renders shared body for second variant", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "B" }), "ab\n");
  });

  it("renders specific case", () => {
    assert.strictEqual(Template.fromSource(src).render({ s: "C" }), "c\n");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — nested idx()
// ---------------------------------------------------------------------------

describe("Nested idx()", () => {
  it("tracks each loop variable independently", () => {
    const src = [
      `---`,
      "params:",
      "  - outer = list(label = str)",
      "  - inner = list(label = str)",
      `---`,
      "> {% for a in outer %}{% for b in inner %}{{ idx(a) }}.{{ idx(b) }} {% /for %}{% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      outer: [{ label: "x" }, { label: "y" }],
      inner: [{ label: "p" }, { label: "q" }],
    });
    assert.strictEqual(result, "0.0 0.1 1.0 1.1 ");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — comparison operators
// ---------------------------------------------------------------------------

describe("Comparison operators", () => {
  const src = (op: string) =>
    [
      `---`,
      "params:",
      "  - x = int",
      `---`,
      `> {% if x ${op} 5 %}`,
      "",
      "yes",

      "",
      "> {% else %}",
      "",
      "no",

      "",
      "> {% /if %}",
    ].join("\n");

  it("!= operator", () => {
    assert.strictEqual(
      Template.fromSource(src("!=")).render({ x: 3 }),
      "yes\n",
    );
    assert.strictEqual(Template.fromSource(src("!=")).render({ x: 5 }), "no\n");
  });

  it("< operator", () => {
    assert.strictEqual(Template.fromSource(src("<")).render({ x: 3 }), "yes\n");
    assert.strictEqual(Template.fromSource(src("<")).render({ x: 5 }), "no\n");
  });

  it("> operator", () => {
    assert.strictEqual(Template.fromSource(src(">")).render({ x: 7 }), "yes\n");
    assert.strictEqual(Template.fromSource(src(">")).render({ x: 5 }), "no\n");
  });

  it("<= operator", () => {
    assert.strictEqual(
      Template.fromSource(src("<=")).render({ x: 5 }),
      "yes\n",
    );
    assert.strictEqual(Template.fromSource(src("<=")).render({ x: 6 }), "no\n");
  });

  it(">= operator", () => {
    assert.strictEqual(
      Template.fromSource(src(">=")).render({ x: 5 }),
      "yes\n",
    );
    assert.strictEqual(Template.fromSource(src(">=")).render({ x: 4 }), "no\n");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — whitespace control with {{- -}}
// ---------------------------------------------------------------------------

describe("Whitespace control", () => {
  it("trims whitespace with {{- -}}", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
hello  {{- name -}}
bye`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "helloworldbye");
  });

  it("trims only before with {{-", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
hello  {{- name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "helloworld!");
  });

  it("trims only after with -}}", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
hello {{ name -}}  !`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "hello world!");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — raw blocks
// ---------------------------------------------------------------------------

describe("Raw blocks", () => {
  it("preserves template syntax", () => {
    const tmpl = Template.fromSource(
      `---
params: []
---
> {% raw %}
{{ not_processed }}
> {% /raw %}`,
    );
    const result = tmpl.render({});
    assert.ok(result.includes("{{ not_processed }}"));
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — comments
// ---------------------------------------------------------------------------

describe("Comments", () => {
  it("strips {# #} from output", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
---
> {# This is a comment #}Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
  });

  it("comments suppress unused-param errors", () => {
    // The param 'unused' is only referenced in a comment, which should count
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
  - unused = str
---
> {# {{ unused }} #}Hello {{ name }}!`,
    );
    assert.strictEqual(
      tmpl.render({ name: "world", unused: "x" }),
      "Hello world!",
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — constants in scope
// ---------------------------------------------------------------------------

describe("Constants scoping", () => {
  it("consts are visible inside for loops", () => {
    const src = [
      `---`,
      "consts:",
      '  - PREFIX = str := ">>"',
      "",
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "{{ PREFIX }} {{ item.name }}",

      "",
      "> {% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      items: [{ name: "A" }, { name: "B" }],
    });
    assert.strictEqual(result, ">> A\n>> B\n");
  });

  it("consts are visible inside if blocks", () => {
    const src = [
      `---`,
      "consts:",
      "  - THRESHOLD = int := 10",
      "",
      "params:",
      "  - x = int",
      `---`,
      "> {% if x > 5 %}",
      "",
      "over (threshold={{ THRESHOLD }})",

      "",
      "> {% /if %}",
    ].join("\n");

    assert.strictEqual(
      Template.fromSource(src).render({ x: 7 }),
      "over (threshold=10)\n",
    );
  });

  it("consts are visible inside match blocks", () => {
    const src = [
      `---`,
      "consts:",
      '  - LABEL = str := "status"',
      "",
      "params:",
      "  - s = enum(A, B)",
      `---`,
      "> {% match s %}",
      "> {% case A %}",
      "",
      "{{ LABEL }}: alpha",

      "",
      "> {% case B %}",
      "",
      "{{ LABEL }}: beta",

      "",
      "> {% /match %}",
    ].join("\n");

    assert.strictEqual(
      Template.fromSource(src).render({ s: "A" }),
      "status: alpha\n",
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — for loop empty list
// ---------------------------------------------------------------------------

describe("For loop edge cases", () => {
  it("empty list produces empty output", () => {
    const src = [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "{{ item.name }}",

      "",
      "> {% /for %}",
    ].join("\n");

    assert.strictEqual(Template.fromSource(src).render({ items: [] }), "");
  });

  it("single item list has no trailing separator issues", () => {
    const src = [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "- {{ item.name }}",

      "",
      "> {% /for %}",
    ].join("\n");

    assert.strictEqual(
      Template.fromSource(src).render({ items: [{ name: "only" }] }),
      "- only\n",
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — inline templates ({% tmpl %})
// ---------------------------------------------------------------------------

describe("Inline templates", () => {
  it("defines and includes an inline template", () => {
    const src = [
      `---`,
      "params:",
      "  - tasks = list(title = str, priority = str)",
      `---`,
      "> {% tmpl task_row %}",
      "",
      `---`,
      "",
      "params:",
      "",
      "- title = str",
      "- priority = str",
      "",
      `---`,
      "",
      "- **{{ title }}** ({{ priority }})",

      "",
      "> {% /tmpl %}",
      "> {% for task in tasks %}",
      "> {% include task_row with title=task.title, priority=task.priority %}",
      "> {% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      tasks: [
        { title: "Write docs", priority: "high" },
        { title: "Add tests", priority: "medium" },
      ],
    });
    assert.ok(result.includes("Write docs"));
    assert.ok(result.includes("high"));
    assert.ok(result.includes("Add tests"));
    assert.ok(result.includes("medium"));
  });

  it("inline template renders with simple params", () => {
    const src = [
      `---`,
      "params:",
      "  - greeting = str",
      `---`,
      "> {% tmpl msg %}",
      "",
      `---`,
      "",
      "params:",
      "",
      "- text = str",
      "",
      `---`,
      "",
      "[{{ text }}]",

      "",
      "> {% /tmpl %}",
      "> {% include msg with text=greeting %}",
    ].join("\n");

    const result = Template.fromSource(src).render({ greeting: "hello" });
    assert.ok(result.includes("[hello]"));
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — include with params (file-based)
// ---------------------------------------------------------------------------

describe("Include with params (file-based)", () => {
  it("includes a file-based template with explicit params", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-include-"));
    const childPath = path.join(dir, "child.tmpl.md");
    fs.writeFileSync(
      childPath,
      `---
params:
  - msg = str
---
Child says: {{ msg }}`,
    );

    const parentPath = path.join(dir, "parent.tmpl.md");
    fs.writeFileSync(
      parentPath,
      `---
params:
  - greeting = str
---
> {% include [child](./child.tmpl.md) with msg=greeting %}`,
    );

    try {
      const tmpl = Template.fromFile(parentPath);
      const result = tmpl.render({ greeting: "hello" });
      assert.ok(
        result.includes("Child says: hello"),
        `expected 'Child says: hello' but got: ${result}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("include for iteration renders each item", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-incfor-"));
    const rowPath = path.join(dir, "row.tmpl.md");
    fs.writeFileSync(
      rowPath,
      `---
params:
  - item = struct(name = str)
---
- {{ item.name }}`,
    );

    const mainPath = path.join(dir, "main.tmpl.md");
    fs.writeFileSync(
      mainPath,
      `---
params:
  - items = list(name = str)
---
> {% include [row](./row.tmpl.md) for item in items %}`,
    );

    try {
      const tmpl = Template.fromFile(mainPath);
      const result = tmpl.render({
        items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      });
      assert.ok(result.includes("A"), `missing A in: ${result}`);
      assert.ok(result.includes("B"), `missing B in: ${result}`);
      assert.ok(result.includes("C"), `missing C in: ${result}`);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — raw custom delimiter
// ---------------------------------------------------------------------------

describe("Raw custom delimiter", () => {
  it("uses raw=DELIM to escape /raw itself", () => {
    const tmpl = Template.fromSource(
      `---
params: []
---
> {% raw=MYDELIM %}
> {% raw %}...{% /raw %}
> {% /MYDELIM %}`,
    );
    const result = tmpl.render({});
    assert.ok(
      result.includes("{% raw %}"),
      `expected raw syntax preserved, got: ${result}`,
    );
    assert.ok(
      result.includes("{% /raw %}"),
      `expected /raw preserved, got: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md coverage — include depth limit
// ---------------------------------------------------------------------------

describe("Include depth limit", () => {
  it("maxIncludeDepth prevents infinite recursion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-depth-"));
    const recPath = path.join(dir, "rec.tmpl.md");
    // Self-referencing template
    fs.writeFileSync(
      recPath,
      `---
params:
  - n = int
---
{{ n }}

> {% include [rec](./rec.tmpl.md) with n=n %}`,
    );

    try {
      const tmpl = Template.fromFile(recPath);
      assert.throws(() => tmpl.render({ n: 1 }), /depth/i);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Direct renderer parity — renderUnchecked must produce same output as render
// ---------------------------------------------------------------------------

describe("renderUnchecked parity", () => {
  const parityCheck = (
    label: string,
    src: string,
    params: Record<string, unknown>,
  ) => {
    it(label, () => {
      const tmpl = Template.fromSource(src);
      const checked = tmpl.render(params);
      const unchecked = tmpl.renderUnchecked(params);
      assert.strictEqual(
        unchecked,
        checked,
        `render vs renderUnchecked mismatch for: ${label}`,
      );
    });
  };

  parityCheck(
    "simple string",
    `---
params: [name = str]
---
Hello {{ name }}!`,
    { name: "world" },
  );

  parityCheck(
    "for loop",
    [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "- {{ item.name }}",

      "",
      "> {% /for %}",
    ].join("\n"),
    { items: [{ name: "A" }, { name: "B" }] },
  );

  parityCheck(
    "if/elif/else",
    [
      `---`,
      "params:",
      "  - x = int",
      `---`,
      "> {% if x > 10 %}",
      "",
      "big",

      "",
      "> {% elif x > 5 %}",
      "",
      "medium",

      "",
      "> {% else %}",
      "",
      "small",

      "",
      "> {% /if %}",
    ].join("\n"),
    { x: 7 },
  );

  parityCheck(
    "match/case with struct variant",
    [
      `---`,
      "params:",
      "  - status = enum(Ok(msg = str), Error(code = int))",
      `---`,
      "> {% match status %}",
      "> {% case Ok %}",
      "",
      "OK: {{ status.msg }}",

      "",
      "> {% case Error %}",
      "",
      "ERR: {{ status.code }}",

      "",
      "> {% /match %}",
    ].join("\n"),
    { status: { __kind__: "Ok", msg: "done" } },
  );

  parityCheck(
    "constants in scope",
    [
      `---`,
      "consts:",
      '  - PREFIX = str := ">>"',
      "",
      "params:",
      "  - name = str",
      `---`,
      "{{ PREFIX }} {{ name }}",
    ].join("\n"),
    { name: "test" },
  );

  parityCheck(
    "default values",
    [
      `---`,
      "params:",
      '  - name = str := "default"',
      "  - count = int := 0",
      `---`,
      "{{ name }} {{ count }}",
    ].join("\n"),
    {},
  );

  parityCheck(
    "empty list",
    [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "- {{ item.name }}",

      "",
      "> {% /for %}",
    ].join("\n"),
    { items: [] },
  );

  parityCheck(
    "whitespace control",
    `---
params:
  - name = str
---
hello  {{- name -}}
bye`,
    { name: "world" },
  );

  parityCheck(
    "match else arm",
    [
      `---`,
      "params:",
      "  - s = enum(A, B, C)",
      `---`,
      "> {% match s %}",
      "> {% case A %}",
      "",
      "alpha",

      "",
      "> {% else %}",
      "",
      "other",

      "",
      "> {% /match %}",
    ].join("\n"),
    { s: "B" },
  );

  parityCheck(
    "match multi-variant arm",
    [
      `---`,
      "params:",
      "  - s = enum(A, B, C)",
      `---`,
      "> {% match s %}",
      "> {% case A | B %}",
      "",
      "ab",

      "",
      "> {% case C %}",
      "",
      "c",

      "",
      "> {% /match %}",
    ].join("\n"),
    { s: "A" },
  );

  parityCheck(
    "filters chain",
    `---
params: [name = str]
---
{{ name | trim | upper }}`,
    { name: "  hello  " },
  );

  parityCheck(
    "comparison operators",
    [
      `---`,
      "params:",
      "  - x = int",
      `---`,
      "> {% if x >= 5 %}",
      "",
      "yes",

      "",
      "> {% else %}",
      "",
      "no",

      "",
      "> {% /if %}",
    ].join("\n"),
    { x: 5 },
  );

  parityCheck(
    "nested for loops",
    [
      `---`,
      "params:",
      "  - rows = list(cells = list(v = str))",
      `---`,
      "> {% for row in rows %}> {% for cell in row.cells %}{{ cell.v }} {% /for %}",
      "> {% /for %}",
    ].join("\n"),
    { rows: [{ cells: [{ v: "a" }, { v: "b" }] }, { cells: [{ v: "c" }] }] },
  );

  parityCheck(
    "idx and len built-ins",
    [
      `---`,
      "params:",
      "  - items = list(v = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "{{ idx(item) }}/{{ len(items) }}: {{ item.v }}",

      "",
      "> {% /for %}",
    ].join("\n"),
    { items: [{ v: "a" }, { v: "b" }, { v: "c" }] },
  );

  parityCheck(
    "comments stripped",
    `---
params: [name = str]
---
> {# comment #}Hello {{ name }}!`,
    { name: "world" },
  );

  parityCheck(
    "raw block",
    `---
params: []
---
> {% raw %}

{{ literal }}

> {% /raw %}`,
    {},
  );
});

// ---------------------------------------------------------------------------
// Filter edge cases
// ---------------------------------------------------------------------------

describe("Filter edge cases", () => {
  it("upper on empty string", () => {
    const tmpl = Template.fromSource(
      `---
params: [s = str]
---
{{ s | upper }}`,
    );
    assert.strictEqual(tmpl.render({ s: "" }), "");
  });

  it("lower on mixed case", () => {
    const tmpl = Template.fromSource(
      `---
params: [s = str]
---
{{ s | lower }}`,
    );
    assert.strictEqual(tmpl.render({ s: "HeLLo WoRLD" }), "hello world");
  });

  it("trim on string with only whitespace", () => {
    const tmpl = Template.fromSource(
      `---
params: [s = str]
---
[{{ s | trim }}]`,
    );
    assert.strictEqual(tmpl.render({ s: "   " }), "[]");
  });

  it("fixed(0) on float", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = float]
---
{{ x | fixed(0) }}`,
    );
    assert.strictEqual(tmpl.render({ x: 3.7 }), "4");
  });

  it("fixed(4) on integer", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = int]
---
{{ x | fixed(4) }}`,
    );
    assert.strictEqual(tmpl.render({ x: 42 }), "42.0000");
  });

  it("add(0) is identity", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = int]
---
{{ x | add(0) }}`,
    );
    assert.strictEqual(tmpl.render({ x: 42 }), "42");
  });

  it("sub with negative result", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = int]
---
{{ x | sub(100) }}`,
    );
    assert.strictEqual(tmpl.render({ x: 42 }), "-58");
  });

  it("add on float", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = float]
---
{{ x | add(0.5) | fixed(1) }}`,
    );
    assert.strictEqual(tmpl.render({ x: 1.5 }), "2.0");
  });

  it("limit on list shorter than N", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(str)]
---
{{ items | limit(10) | join(", ") }}`,
    );
    assert.strictEqual(tmpl.render({ items: ["a", "b"] }), "a, b");
  });

  it("join with empty separator", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(str)]
---
{{ items | join("") }}`,
    );
    assert.strictEqual(tmpl.render({ items: ["a", "b", "c"] }), "abc");
  });

  it("chained filters: limit then join", () => {
    const tmpl = Template.fromSource(
      `---
params: [items = list(str)]
---
{{ items | limit(2) | join(", ") }}`,
    );
    assert.strictEqual(tmpl.render({ items: ["a", "b", "c", "d"] }), "a, b");
  });

  it("unknown filter throws UnknownFilterError", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params: [x = str]
---
{{ x | nonexistent }}`,
        ).render({ x: "test" }),
      (err: unknown) => err instanceof UnknownFilterError,
    );
  });
});

// ---------------------------------------------------------------------------
// Context API tests
// ---------------------------------------------------------------------------

describe("Context API", () => {
  it("set and get string", () => {
    const ctx = new Context();
    ctx.set("name", "world");
    const val = ctx.get("name");
    assert.ok(val);
    assert.strictEqual(val.type, "str");
  });

  it("set and get int", () => {
    const ctx = new Context();
    ctx.set("count", 42);
    const val = ctx.get("count");
    assert.ok(val);
    assert.strictEqual(val.type, "int");
  });

  it("has returns true for existing key", () => {
    const ctx = new Context();
    ctx.set("key", "value");
    assert.ok(ctx.has("key"));
  });

  it("has returns false for missing key", () => {
    const ctx = new Context();
    assert.ok(!ctx.has("missing"));
  });

  it("size reflects number of entries", () => {
    const ctx = new Context();
    assert.strictEqual(ctx.size, 0);
    ctx.set("a", 1);
    ctx.set("b", 2);
    assert.strictEqual(ctx.size, 2);
  });

  it("keys returns all key names", () => {
    const ctx = new Context();
    ctx.set("alpha", 1);
    ctx.set("beta", 2);
    const keys = [...ctx.keys()];
    assert.deepStrictEqual(keys.sort(), ["alpha", "beta"]);
  });

  it("entries returns all entries", () => {
    const ctx = new Context();
    ctx.set("x", "hello");
    const entries = [...ctx.entries()];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(defined(entries[0])[0], "x");
  });

  it("Context.from creates from plain object", () => {
    const ctx = Context.from({ name: "world", count: 42 });
    assert.strictEqual(ctx.size, 2);
    assert.ok(ctx.has("name"));
    assert.ok(ctx.has("count"));
  });

  it("overwriting a key updates the value", () => {
    const ctx = new Context();
    ctx.set("x", "old");
    ctx.set("x", "new");
    assert.strictEqual(ctx.size, 1);
  });
});

// ---------------------------------------------------------------------------
// Value module tests
// ---------------------------------------------------------------------------

describe("Value module", () => {
  it("fromJs converts null to none", () => {
    const val = fromJs(null);
    assert.strictEqual(val.type, "none");
    assert.strictEqual(display(val), "");
  });

  it("fromJs converts undefined to none", () => {
    const val = fromJs(undefined);
    assert.strictEqual(val.type, "none");
    assert.strictEqual(display(val), "");
  });

  it("fromJs converts nested objects", () => {
    const val = fromJs({ a: { b: 42 } });
    assert.strictEqual(val.type, "struct");
  });

  it("display of int", () => {
    const val = fromJs(42);
    assert.strictEqual(display(val), "42");
  });

  it("display of float", () => {
    const val = fromJs(3.14);
    assert.strictEqual(display(val), "3.14");
  });

  it("display of bool true", () => {
    const val = fromJs(true);
    assert.strictEqual(display(val), "true");
  });

  it("display of bool false", () => {
    const val = fromJs(false);
    assert.strictEqual(display(val), "false");
  });

  it("display of list", () => {
    const val = fromJs(["a", "b"]);
    assert.strictEqual(val.type, "list");
    assert.ok(val.items.length === 2);
  });

  it("isTruthy for non-empty string", () => {
    assert.ok(isTruthy(fromJs("hello")));
  });

  it("isTruthy for empty string is false", () => {
    assert.ok(!isTruthy(fromJs("")));
  });

  it("isTruthy for non-zero int", () => {
    assert.ok(isTruthy(fromJs(42)));
  });

  it("isTruthy for zero is false", () => {
    assert.ok(!isTruthy(fromJs(0)));
  });

  it("isTruthy for true bool", () => {
    assert.ok(isTruthy(fromJs(true)));
  });

  it("isTruthy for false bool is false", () => {
    assert.ok(!isTruthy(fromJs(false)));
  });

  it("isTruthy for non-empty list", () => {
    assert.ok(isTruthy(fromJs([1])));
  });

  it("isTruthy for empty list is false", () => {
    assert.ok(!isTruthy(fromJs([])));
  });
});

// ---------------------------------------------------------------------------
// Frontmatter edge cases
// ---------------------------------------------------------------------------

describe("Frontmatter edge cases", () => {
  it("parses inline param list syntax", () => {
    const [fm] = parseFrontmatter(
      `---
params: [name = str, count = int]
---
`,
    );
    assert.strictEqual(fm.params.length, 2);
    assert.strictEqual(defined(fm.params[0]).name, "name");
    assert.strictEqual(defined(fm.params[1]).name, "count");
  });

  it("handles empty params list", () => {
    const [fm] = parseFrontmatter(`---
params: []
---
`);
    assert.strictEqual(fm.params.length, 0);
  });

  it("parses consts with default values", () => {
    const [fm] = parseFrontmatter(
      `---
consts:
  - GREETING = str := "Hello"
---
`,
    );
    assert.strictEqual(fm.consts.length, 1);
    assert.strictEqual(defined(fm.consts[0]).name, "GREETING");
    assert.ok(defined(fm.consts[0]).defaultValue !== undefined);
  });

  it("parses type aliases", () => {
    const [fm] = parseFrontmatter(
      `---
types:
  - Item = struct(name = str, score = int)

params:
  - items = list(Item)
---
`,
    );
    assert.ok(fm.typeAliases);
    assert.ok(fm.typeAliases.has("Item"));
  });

  it("stripFrontmatter returns body only", () => {
    const body = stripFrontmatter(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(body, "Hello {{ name }}!");
  });

  it("parseVarType and varTypeToString round-trip", () => {
    const types = ["str", "int", "float", "bool"];
    for (const t of types) {
      assert.strictEqual(varTypeToString(parseVarType(t)), t);
    }
  });

  it("parseVarType handles typed list", () => {
    const vt = parseVarType("list(name = str)");
    assert.strictEqual(vt.kind, "list");
  });

  it("parseVarType handles struct", () => {
    const vt = parseVarType("struct(name = str, score = int)");
    assert.strictEqual(vt.kind, "struct");
  });

  it("parseVarType handles enum", () => {
    const vt = parseVarType("enum(A, B(x = str))");
    assert.strictEqual(vt.kind, "enum");
  });

  it("frontmatter name and description", () => {
    const [fm] = parseFrontmatter(
      `---
name: "My Template"
description: "A greeting"
params: [name = str]
---
`,
    );
    assert.strictEqual(fm.name, "My Template");
    assert.strictEqual(fm.description, "A greeting");
  });

  it("allow_unused flag", () => {
    const [fm] = parseFrontmatter(
      `---
allow_unused: true
params: [name = str]
---
`,
    );
    assert.strictEqual(fm.allowUnused, true);
  });

  it("rejects missing blank line after block list in frontmatter", () => {
    assert.throws(
      () =>
        parseFrontmatter(`---
consts:
  - FOO = str := 'bar'
params:
  - x = int
---
body`),
      (err: Error) =>
        err.message.includes("A blank line is required after a block list"),
    );

    assert.throws(
      () =>
        parseFrontmatter(`---
types:
  - Priority = enum(High, Low)
consts:
  - FOO = str := 'bar'
---
body`),
      (err: Error) =>
        err.message.includes("A blank line is required after a block list"),
    );

    assert.throws(
      () =>
        parseFrontmatter(`---
consts:
  - FOO = str := 'bar'
allow_unused: true
---
body`),
      (err: Error) =>
        err.message.includes("A blank line is required after a block list"),
    );
  });
});

// ---------------------------------------------------------------------------
// Error hierarchy tests
// ---------------------------------------------------------------------------

describe("Error hierarchy", () => {
  it("all error types extend TemplateError", () => {
    const errors = [
      new TemplateSyntaxError("test"),
      new MissingParamsError(["x"]),
      new TypeMismatchError("x", "str", "int"),
      new ExtraParamsError(["y"]),
      new UndefinedVariableError("z"),
      new UnknownFilterError("bad"),
    ];
    for (const err of errors) {
      assert.ok(err instanceof TemplateError);
      assert.ok(err instanceof Error);
    }
  });

  it("MissingParamsError lists missing names", () => {
    const err = new MissingParamsError(["a", "b"]);
    assert.deepStrictEqual(err.missing, ["a", "b"]);
    assert.ok(err.message.includes("a"));
    assert.ok(err.message.includes("b"));
  });

  it("TypeMismatchError exposes path, expected, actual", () => {
    const err = new TypeMismatchError("items[0].score", "int", "str");
    assert.strictEqual(err.path, "items[0].score");
    assert.strictEqual(err.expected, "int");
    assert.strictEqual(err.actual, "str");
  });

  it("ExtraParamsError lists extra names", () => {
    const err = new ExtraParamsError(["extra1", "extra2"]);
    assert.deepStrictEqual(err.extra, ["extra1", "extra2"]);
  });

  it("UndefinedVariableError exposes variable name", () => {
    const err = new UndefinedVariableError("unknown_var");
    assert.strictEqual(err.variable, "unknown_var");
  });

  it("UnknownFilterError exposes filter name", () => {
    const err = new UnknownFilterError("badfilter");
    assert.strictEqual(err.filter, "badfilter");
  });
});

// ---------------------------------------------------------------------------
// Codegen tests
// ---------------------------------------------------------------------------

describe("Codegen", () => {
  it("generateTypes produces interface with correct fields", () => {
    const code = generateTypes(
      `---
params:
  - name = str
  - count = int
---
Hello {{ name }}!`,
    );
    assert.ok(code.includes("name: string"));
    assert.ok(code.includes("count: number"));
  });

  it("generateTypes handles list type", () => {
    const code = generateTypes(
      `---
params:
  - items = list(label = str)
---
{{ items }}`,
    );
    assert.ok(code.includes("items:"));
    assert.ok(code.includes("label: string"));
  });

  it("generateTypes handles enum type", () => {
    const code = generateTypes(
      `---
params:
  - status = enum(Ok, Error(msg = str))
---
{{ status }}`,
    );
    assert.ok(code.includes("Ok") || code.includes("ok"));
    assert.ok(code.includes("Error") || code.includes("error"));
  });

  it("inferTypes produces structured result", () => {
    const result = inferTypes(
      `---
params:
  - name = str
  - count = int
---
Hello {{ name }}!`,
    );
    assert.ok(result.fields.length === 2);
    assert.strictEqual(defined(result.fields[0]).name, "name");
    assert.ok(defined(result.fields[0]).tsType.includes("string"));
    assert.strictEqual(defined(result.fields[1]).name, "count");
    assert.ok(defined(result.fields[1]).tsType.includes("number"));
  });
});

// ---------------------------------------------------------------------------
// Variant edge cases
// ---------------------------------------------------------------------------

describe("Variant edge cases", () => {
  it("unitVariant has correct tag", () => {
    const v = unitVariant("Active");
    assert.strictEqual(v.__kind__, "Active");
  });

  it("variant with missing field throws", () => {
    const MyVariant = variant("MyVariant", ["field1"]);
    assert.throws(
      () => MyVariant({} as unknown as Record<"field1", unknown>),
      /missing/i,
    );
  });

  it("variant with extra fields logs warning", () => {
    const MyVariant = variant("MyVariant", ["field1"]);
    // Extra fields should be caught at runtime
    assert.throws(
      () =>
        (MyVariant as (v: Record<string, unknown>) => unknown)({
          field1: "ok",
          extraField: "bad",
        }),
      /unexpected/i,
    );
  });

  it("defineVariants creates all variants", () => {
    const { Active, Inactive } = defineVariants({
      Active: null,
      Inactive: null,
    });
    assert.strictEqual(
      (Active as unknown as { __kind__: string }).__kind__,
      "Active",
    );
    assert.strictEqual(
      (Inactive as unknown as { __kind__: string }).__kind__,
      "Inactive",
    );
  });

  it("isVariant checks correctly", () => {
    const v = unitVariant("MyType");
    assert.ok(isVariant(v, "MyType"));
    assert.ok(!isVariant(v, "Other"));
  });

  it("match function dispatches correctly", () => {
    const v = unitVariant("Success");
    const result = match(v, {
      Success: () => "ok",
      Error: () => "fail",
    });
    assert.strictEqual(result, "ok");
  });
});

// ---------------------------------------------------------------------------
// Enum variant construction & pattern matching (comprehensive)
// ---------------------------------------------------------------------------

describe("defineVariants — construction", () => {
  it("creates unit + struct variants in one call", () => {
    const Status = defineVariants({
      Approved: null,
      Rejected: null,
      NeedsChanges: ["reason"],
    });

    // Unit sentinels
    assert.strictEqual(Status.Approved.__kind__, "Approved");
    assert.strictEqual(Status.Rejected.__kind__, "Rejected");
    assert.deepStrictEqual({ ...Status.Approved }, { __kind__: "Approved" });

    // Struct constructor
    const nc = Status.NeedsChanges({ reason: "fix tests" });
    assert.strictEqual(nc.__kind__, "NeedsChanges");
    assert.strictEqual(nc.reason, "fix tests");
    assert.deepStrictEqual(
      { ...nc },
      { __kind__: "NeedsChanges", reason: "fix tests" },
    );
  });

  it("struct variant with multiple fields preserves all fields", () => {
    const Event = defineVariants({
      Click: ["x", "y"],
      Scroll: ["delta"],
    });
    const click = Event.Click({ x: 10, y: 20 });
    assert.strictEqual(click.x, 10);
    assert.strictEqual(click.y, 20);
    assert.deepStrictEqual({ ...click }, { __kind__: "Click", x: 10, y: 20 });
  });

  it("unit variant toString returns tag name", () => {
    const { Approved } = defineVariants({ Approved: null });
    // Variant instances define a non-enumerable custom `toString` not
    // surfaced by the type; assert through a `toString`-bearing view.
    assert.strictEqual(
      (Approved as { toString(): string }).toString(),
      "Approved",
    );
  });

  it("struct variant toString includes fields", () => {
    const { NeedsChanges } = defineVariants({
      NeedsChanges: ["reason"],
    });
    const v = NeedsChanges({ reason: "tests fail" });
    // Variant instances carry a non-enumerable custom `toString`.
    const rendered = (v as { toString(): string }).toString();
    assert.ok(rendered.includes("NeedsChanges"));
    assert.ok(rendered.includes("tests fail"));
  });
});

describe("variant() constructor validation", () => {
  it("throws on missing required field", () => {
    const { NeedsChanges } = defineVariants({
      NeedsChanges: ["reason"],
    });
    assert.throws(
      () => NeedsChanges({}),
      (err: Error) => err.message.includes("missing"),
    );
  });

  it("throws on extra unexpected field", () => {
    const { NeedsChanges } = defineVariants({
      NeedsChanges: ["reason"],
    });
    assert.throws(
      () =>
        (NeedsChanges as (f: Record<string, unknown>) => unknown)({
          reason: "ok",
          extra: "bad",
        }),
      (err: Error) => err.message.includes("unexpected"),
    );
  });

  it("variant instances are frozen (immutable)", () => {
    const { NeedsChanges } = defineVariants({
      NeedsChanges: ["reason"],
    });
    const v = NeedsChanges({ reason: "original" });
    assert.throws(() => {
      (v as Record<string, unknown>).reason = "modified";
    });
  });
});

describe("match() — pattern matching", () => {
  const Status = defineVariants({
    Approved: null,
    Rejected: null,
    NeedsChanges: ["reason"],
  });

  it("dispatches on unit variant", () => {
    const result = match(Status.Approved, {
      Approved: () => "Ship it!",
      NeedsChanges: () => "fix",
      Rejected: () => "no",
    });
    assert.strictEqual(result, "Ship it!");
  });

  it("dispatches on struct variant and passes fields", () => {
    const v = Status.NeedsChanges({ reason: "fix tests" });
    const result = match(v, {
      Approved: () => "ok",
      NeedsChanges: (f) => `Please fix: ${String(f.reason)}`,
      Rejected: () => "no",
    });
    assert.strictEqual(result, "Please fix: fix tests");
  });

  it("uses wildcard _ for unmatched variants", () => {
    const result = match(Status.Rejected, {
      Approved: () => "yes",
      _: () => "something else",
    });
    assert.strictEqual(result, "something else");
  });

  it("throws when no handler and no wildcard", () => {
    assert.throws(
      () =>
        match(Status.NeedsChanges({ reason: "x" }), {
          Approved: () => "ok",
        }),
      /no handler for variant 'NeedsChanges'/,
    );
  });

  it("works with __kind__ objects from generated types", () => {
    const result = match(
      { __kind__: "NeedsChanges", reason: "codegen" },
      {
        Approved: () => "yes",
        NeedsChanges: (f) => `fix: ${String(f.reason)}`,
        _: () => "default",
      },
    );
    assert.strictEqual(result, "fix: codegen");
  });

  it("returns typed result", () => {
    const count: number = match(Status.Approved, {
      Approved: () => 1,
      _: () => 0,
    });
    assert.strictEqual(count, 1);
  });
});

describe("isVariant() — type guard", () => {
  const Status = defineVariants({
    Approved: null,
    Rejected: null,
    NeedsChanges: ["reason"],
  });

  it("returns true for matching unit variant", () => {
    assert.ok(isVariant(Status.Approved, "Approved"));
  });

  it("returns false for non-matching unit variant", () => {
    assert.ok(!isVariant(Status.Approved, "Rejected"));
  });

  it("returns true for matching struct variant", () => {
    const v = Status.NeedsChanges({ reason: "fix" });
    assert.ok(isVariant(v, "NeedsChanges"));
  });

  it("returns false for non-matching struct variant", () => {
    const v = Status.NeedsChanges({ reason: "fix" });
    assert.ok(!isVariant(v, "Approved"));
  });

  it("works with __kind__ objects", () => {
    assert.ok(isVariant({ __kind__: "Approved" }, "Approved"));
    assert.ok(!isVariant({ __kind__: "Approved" }, "Rejected"));
  });

  it("works with plain string variants", () => {
    assert.ok(isVariant("Rejected", "Rejected"));
    assert.ok(!isVariant("Rejected", "Approved"));
  });

  it("returns false for null/undefined/non-variant", () => {
    assert.ok(!isVariant(null, "Anything"));
    assert.ok(!isVariant(undefined, "Anything"));
    assert.ok(!isVariant(42, "Anything"));
    assert.ok(!isVariant({ foo: "bar" }, "Anything"));
  });
});

// ---------------------------------------------------------------------------
// Template metadata edge cases
// ---------------------------------------------------------------------------

describe("Template metadata edge cases", () => {
  it("body() returns the raw body text", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.body(), "Hello {{ name }}!");
  });

  it("consts() returns constant values", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - GREETING = str := "Hi"

params: [name = str]
---
{{ GREETING }} {{ name }}!`,
    );
    const consts = tmpl.consts();
    assert.strictEqual(consts.GREETING, "Hi");
  });

  it("declarations() returns all param declarations", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - name = str
  - count = int
---
{{ name }} {{ count }}`,
    );
    const decls = tmpl.declarations();
    assert.strictEqual(decls.length, 2);
    assert.strictEqual(defined(decls[0])[0], "name");
    assert.strictEqual(defined(decls[1])[0], "count");
  });

  it("sourceHash is deterministic", () => {
    const src = `---
params: [x = str]
---
{{ x }}`;
    const t1 = Template.fromSource(src);
    const t2 = Template.fromSource(src);
    assert.strictEqual(t1.sourceHash(), t2.sourceHash());
  });

  it("maxIncludeDepth can be set", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    tmpl.setMaxIncludeDepth(8);
    assert.strictEqual(tmpl.maxIncludeDepth, 8);
  });

  it("frontmatter exposes full metadata", () => {
    const tmpl = Template.fromSource(
      `---
name: "Test"
description: "A test template"
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.frontmatter.name, "Test");
    assert.strictEqual(tmpl.frontmatter.description, "A test template");
  });
});

// ---------------------------------------------------------------------------
// TypedTemplate tests
// ---------------------------------------------------------------------------

describe("TypedTemplate", () => {
  it("renders with typed params", () => {
    const tmpl = TypedTemplate.fromSource<{ name: string }>(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
  });

  it("validates template structure", () => {
    const tmpl = TypedTemplate.fromSource<{ name: string }>(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    // First render triggers validation
    tmpl.render({ name: "test" });
    // Second render reuses validation
    assert.strictEqual(tmpl.render({ name: "world" }), "Hello world!");
  });

  it("fromFile creates typed template", () => {
    withTempFile(
      `---
params: [name = str]
---
Hello {{ name }}!`,
      (filepath) => {
        const tmpl = TypedTemplate.fromFile<{ name: string }>(filepath);
        assert.strictEqual(tmpl.render({ name: "file" }), "Hello file!");
      },
    );
  });

  it("exposes inner template methods", () => {
    const tmpl = TypedTemplate.fromSource<{ name: string }>(
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );
    assert.ok(tmpl.declarations().length > 0);
    assert.ok(tmpl.body().includes("{{ name }}"));
    assert.ok(tmpl.sourceHash() > 0);
  });
});

// ---------------------------------------------------------------------------
// TemplateCache edge cases
// ---------------------------------------------------------------------------

describe("TemplateCache edge cases", () => {
  it("returns same template for same file", () => {
    withTempFile(
      `---
params: [name = str]
---
Hello {{ name }}!`,
      (filepath) => {
        const cache = new TemplateCache();
        const t1 = cache.load(filepath);
        const t2 = cache.load(filepath);
        assert.strictEqual(t1.sourceHash(), t2.sourceHash());
      },
    );
  });

  it("detects changed file content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cache-"));
    const filepath = path.join(dir, "test.tmpl.md");
    fs.writeFileSync(
      filepath,
      `---
params: [name = str]
---
Hello {{ name }}!`,
    );

    try {
      const cache = new TemplateCache();
      const t1 = cache.load(filepath);
      // Modify the file
      fs.writeFileSync(
        filepath,
        `---
params: [name = str]
---
Goodbye {{ name }}!`,
      );
      const t2 = cache.load(filepath);
      // After file change, hash should differ
      assert.notStrictEqual(t1.sourceHash(), t2.sourceHash());
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Complex template scenarios
// ---------------------------------------------------------------------------

describe("Complex template scenarios", () => {
  it("deeply nested struct access", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - config = struct(server = struct(host = str, port = int))
---
{{ config.server.host }}:{{ config.server.port }}`,
    );
    assert.strictEqual(
      tmpl.render({
        config: { server: { host: "localhost", port: 8080 } },
      }),
      "localhost:8080",
    );
  });

  it("multiple for loops in sequence", () => {
    const src = [
      `---`,
      "params:",
      "  - fruits = list(name = str)",
      "  - vegs = list(name = str)",
      `---`,
      "Fruits:",

      "",
      "> {% for f in fruits %}",
      "",
      "- {{ f.name }}",

      "",
      "> {% /for %}",
      "",
      "Vegetables:",

      "",
      "> {% for v in vegs %}",
      "",
      "- {{ v.name }}",

      "",
      "> {% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      fruits: [{ name: "apple" }, { name: "banana" }],
      vegs: [{ name: "carrot" }],
    });
    assert.ok(result.includes("apple"));
    assert.ok(result.includes("banana"));
    assert.ok(result.includes("carrot"));
  });

  it("if inside for loop", () => {
    const src = [
      `---`,
      "params:",
      "  - items = list(name = str, active = bool)",
      `---`,
      "> {% for item in items %}> {% if item.active %}",
      "",
      "✓ {{ item.name }}",
      "",
      "> {% /if %}{% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      items: [
        { name: "A", active: true },
        { name: "B", active: false },
        { name: "C", active: true },
      ],
    });
    assert.ok(result.includes("✓ A"));
    assert.ok(!result.includes("B"));
    assert.ok(result.includes("✓ C"));
  });

  it("match inside for loop", () => {
    const src = [
      `---`,
      "params:",
      "  - items = list(status = enum(Ok, Error))",
      `---`,
      "> {% for item in items %}> {% match item.status %}> {% case Ok %}",
      "",
      "✓",

      "",
      "> {% case Error %}",
      "",
      "✗",
      "",
      "> {% /match %}{% /for %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      items: [{ status: "Ok" }, { status: "Error" }, { status: "Ok" }],
    });
    const lines = result.split("\n").filter((l) => l.trim());
    assert.ok(lines.some((l) => l.includes("✓")));
    assert.ok(lines.some((l) => l.includes("✗")));
  });

  it("enum struct variant with nested struct", () => {
    const src = [
      `---`,
      "params:",
      "  - event = enum(Click(x = int, y = int), Scroll(delta = float))",
      `---`,
      "> {% match event %}",
      "> {% case Click %}",
      "",
      "Click at {{ event.x }},{{ event.y }}",

      "",
      "> {% case Scroll %}",
      "",
      "Scroll by {{ event.delta }}",

      "",
      "> {% /match %}",
    ].join("\n");

    assert.strictEqual(
      Template.fromSource(src).render({
        event: { __kind__: "Click", x: 10, y: 20 },
      }),
      "Click at 10,20\n",
    );

    assert.strictEqual(
      Template.fromSource(src).render({
        event: { __kind__: "Scroll", delta: 3.5 },
      }),
      "Scroll by 3.5\n",
    );
  });

  it("template with all types combined", () => {
    const src = [
      `---`,
      "consts:",
      '  - VERSION = str := "1.0"',
      "",
      "params:",
      "  - name = str",
      "  - count = int",
      "  - score = float",
      "  - active = bool",
      "  - tags = list(str)",
      "  - meta = struct(key = str)",
      "  - status = enum(Ok, Error)",
      `---`,
      "v{{ VERSION }} {{ name }} #{{ count }} ({{ score | fixed(1) }})",

      "",
      "> {% if active %}",
      "",
      "Active",

      "",
      "> {% /if %}",
      "",
      'Tags: {{ tags | join(", ") }}',
      "Meta: {{ meta.key }}",

      "",
      "> {% match status %}",
      "> {% case Ok %}",
      "",
      "OK",

      "",
      "> {% case Error %}",
      "",
      "ERR",

      "",
      "> {% /match %}",
    ].join("\n");

    const result = Template.fromSource(src).render({
      name: "test",
      count: 42,
      score: 3.14,
      active: true,
      tags: ["a", "b"],
      meta: { key: "val" },
      status: "Ok",
    });
    assert.ok(result.includes("v1.0"));
    assert.ok(result.includes("test"));
    assert.ok(result.includes("#42"));
    assert.ok(result.includes("3.1"));
    assert.ok(result.includes("Active"));
    assert.ok(result.includes("a, b"));
    assert.ok(result.includes("val"));
    assert.ok(result.includes("OK"));
  });
});

// ---------------------------------------------------------------------------
// Statement-level whitespace control on standalone blockquote tags.
// Trim modifiers ({%-, -%}) are REDUNDANT on standalone blockquote tags —
// blockquote preprocessing already manages all surrounding whitespace.
// These tests verify that trim-modified versions produce identical output
// to non-trim versions, matching Rust's behaviour.
// ---------------------------------------------------------------------------
describe("Statement whitespace trimming (standalone blockquote — redundant)", () => {
  it("{%- for %} is redundant — same output as {% for %}", () => {
    const baseSrc = [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "start   ",
      "",
      "> {% for item in items %}",
      "",
      "{{ item.name }}",
      "",
      "> {% /for %}",
    ].join("\n");
    const trimSrc = baseSrc.replace("> {% for", "> {%- for");
    const baseResult = Template.fromSource(baseSrc).render({
      items: [{ name: "a" }],
    });
    const trimResult = Template.fromSource(trimSrc).render({
      items: [{ name: "a" }],
    });
    assert.strictEqual(
      trimResult,
      baseResult,
      `{%- on standalone blockquote should be redundant`,
    );
  });

  it("{% for -%} is redundant — same output as {% for %}", () => {
    const baseSrc = [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "   {{ item.name }}",
      "",
      "> {% /for %}",
    ].join("\n");
    const trimSrc = baseSrc.replace("items %}", "items -%}");
    const baseResult = Template.fromSource(baseSrc).renderUnchecked({
      items: [{ name: "hello" }],
    });
    const trimResult = Template.fromSource(trimSrc).renderUnchecked({
      items: [{ name: "hello" }],
    });
    assert.strictEqual(
      trimResult,
      baseResult,
      `-%} on standalone blockquote should be redundant`,
    );
  });

  it("{%- /for %} is redundant — same output as {% /for %}", () => {
    const baseSrc = [
      `---`,
      "params:",
      "  - items = list(name = str)",
      `---`,
      "> {% for item in items %}",
      "",
      "{{ item.name }}   ",
      "",
      "> {% /for %}",
    ].join("\n");
    const trimSrc = baseSrc.replace("> {% /for", "> {%- /for");
    const baseResult = Template.fromSource(baseSrc).render({
      items: [{ name: "x" }],
    });
    const trimResult = Template.fromSource(trimSrc).render({
      items: [{ name: "x" }],
    });
    assert.strictEqual(
      trimResult,
      baseResult,
      `{%- on standalone closing tag should be redundant`,
    );
  });

  it("{%- if %} is redundant — same output as {% if %}", () => {
    const baseSrc = [
      `---`,
      "params:",
      "  - flag = bool",
      `---`,
      "before   ",
      "",
      "> {% if flag %}",
      "",
      "yes",
      "",
      "> {% /if %}",
    ].join("\n");
    const trimSrc = baseSrc.replace("> {% if", "> {%- if");
    const baseResult = Template.fromSource(baseSrc).render({ flag: true });
    const trimResult = Template.fromSource(trimSrc).render({ flag: true });
    assert.strictEqual(
      trimResult,
      baseResult,
      `{%- on standalone blockquote if should be redundant`,
    );
  });

  it("{% /if -%} is redundant — same output as {% /if %}", () => {
    const baseSrc = [
      `---`,
      "params:",
      "  - flag = bool",
      `---`,
      "> {% if flag %}",
      "",
      "yes",
      "",
      "> {% /if %}",
      "",
      "   after",
    ].join("\n");
    const trimSrc = baseSrc.replace("/if %}", "/if -%}");
    const baseResult = Template.fromSource(baseSrc).render({ flag: true });
    const trimResult = Template.fromSource(trimSrc).render({ flag: true });
    assert.strictEqual(
      trimResult,
      baseResult,
      `-%} on standalone closing tag should be redundant`,
    );
  });
});

// ---------------------------------------------------------------------------
// tmpl() type parsing
// ---------------------------------------------------------------------------
describe("tmpl() type parsing", () => {
  it("tmpl(field = type) is parsed as struct-like type", () => {
    const src = [
      `---`,
      "params:",
      "  - sub = tmpl(title = str, count = int)",
      `---`,
      "{{ sub.title }}: {{ sub.count }}",
    ].join("\n");
    const result = Template.fromSource(src).render({
      sub: { title: "hello", count: 42 },
    });
    assert.strictEqual(result, "hello: 42");
  });

  it("tmpl() declarations are accessible", () => {
    const src = [
      `---`,
      "params:",
      "  - sub = tmpl(title = str)",
      `---`,
      "{{ sub.title }}",
    ].join("\n");
    const decls = Template.fromSource(src).declarations();
    assert.strictEqual(decls.length, 1);
    assert.strictEqual(defined(decls[0])[0], "sub");
  });
});

// ---------------------------------------------------------------------------
// Collision validation
// ---------------------------------------------------------------------------

describe("Collision validation", () => {
  // ── Rule 1: Reserved keywords ───────────────────────────────────────

  describe("Reserved keywords", () => {
    const reserved = [
      "str",
      "bool",
      "int",
      "float",
      "list",
      "struct",
      "enum",
      "tmpl",
      "params",
    ];

    for (const kw of reserved) {
      it(`rejects reserved keyword '${kw}' as param name`, () => {
        const src = `---
params:
  - ${kw} = str
---
{{ ${kw} }}`;
        assert.throws(
          () => Template.fromSource(src),
          (err: Error) => err.message.includes("reserved"),
        );
      });
    }

    it("rejects reserved keyword as const name", () => {
      const src = `---
consts:
  - str = int := 42
---
Hello`;
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("reserved"),
      );
    });

    it("allows non-reserved param names", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - my_str = str
---
{{ my_str }}`,
      );
      assert.strictEqual(tmpl.render({ my_str: "hello" }), "hello");
    });
  });

  // ── Rule 2: Duplicate names ─────────────────────────────────────────

  describe("Duplicate names", () => {
    it("rejects duplicate param names", () => {
      const src = `---
params:
  - name = str
  - name = int
---
{{ name }}`;
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("duplicate"),
      );
    });

    it("rejects duplicate const names", () => {
      const src = `---
consts:
  - VER = str := "1"
  - VER = int := 2
---
Hello`;
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("duplicate"),
      );
    });

    it("allows different param names", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - name = str
  - age = int
---
{{ name }} {{ age }}`,
      );
      assert.strictEqual(tmpl.render({ name: "Alice", age: 30 }), "Alice 30");
    });
  });

  // ── Rule 3: Param ↔ const conflict ──────────────────────────────────

  describe("Param vs const conflict", () => {
    it("rejects param and const with same name", () => {
      const src = `---
params:
  - level = str

consts:
  - level = int := 5
---
{{ level }}`;
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) =>
          err.message.includes("both a param and a constant") ||
          err.message.includes("conflicts with constant"),
      );
    });

    it("allows param and const with different names", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - name = str

consts:
  - VERSION = str := "1.0"
---
{{ name }} v{{ VERSION }}`,
      );
      assert.strictEqual(tmpl.render({ name: "test" }), "test v1.0");
    });
  });

  // ── Rule 4: Type alias vs PascalCase param collision ────────────────

  describe("Type/param PascalCase conflict", () => {
    it("rejects param whose PascalCase matches a type alias with different type", () => {
      const src = [
        `---`,
        "types:",
        "  - CodeReview = list(title = str)",
        "",
        "params:",
        "  - code_review = str",
        `---`,
        "{{ code_review }}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("conflicts with type alias"),
      );
    });

    it("allows param whose PascalCase matches type alias when types match", () => {
      const src = [
        `---`,
        "types:",
        "  - CodeReview = list(title = str)",
        "",
        "params:",
        "  - code_review = list(title = str)",
        `---`,
        "> {% for item in code_review %}",
        "",
        "{{ item.title }}",

        "",
        "> {% /for %}",
      ].join("\n");
      // Should NOT throw — the exception applies
      const tmpl = Template.fromSource(src);
      const output = tmpl.render({ code_review: [{ title: "review1" }] });
      assert.ok(output.includes("review1"));
    });

    it("rejects const whose PascalCase matches a type alias with different type", () => {
      const src = [
        `---`,
        "types:",
        "  - CodeReview = list(x = int)",
        "",
        "consts:",
        '  - code_review = str := "hello"',
        `---`,
        "{{ code_review }}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("conflicts with type alias"),
      );
    });
  });

  // ── Rule 5: Type alias ↔ import stem ────────────────────────────────

  describe("Type alias vs import stem", () => {
    it("rejects type alias with same name as import stem", () => {
      const src = [
        `---`,
        "imports:",
        '  - "[Utils](./Utils.tmpl.md)"',
        "",
        "types:",
        "  - Utils = list(x = str)",
        "",
        "params:",
        "  - data = Utils",
        `---`,
        "> {% for item in data %}",
        "",
        "{{ item.x }}",

        "",
        "> {% /for %}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("shadows"),
      );
    });
  });

  // ── Rule 6: Param PascalCase ↔ import stem ──────────────────────────

  describe("Param PascalCase vs import stem", () => {
    it("rejects param whose PascalCase matches import stem", () => {
      const src = [
        `---`,
        "imports:",
        '  - "[CodeReview](./CodeReview.tmpl.md)"',
        "",
        "params:",
        "  - code_review = str",
        `---`,
        "{{ code_review }}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("shadows import"),
      );
    });

    it("rejects const whose PascalCase matches import stem", () => {
      const src = [
        `---`,
        "imports:",
        '  - "[MyConst](./MyConst.tmpl.md)"',
        "",
        "consts:",
        '  - my_const = str := "val"',
        `---`,
        "{{ my_const }}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("shadows import"),
      );
    });

    it("allows param whose PascalCase does not match any import stem", () => {
      const src = [
        `---`,
        "imports:",
        '  - "[Utils](./Utils.tmpl.md)"',
        "",
        "params:",
        "  - user_name = str",
        `---`,
        "{{ user_name }}",
      ].join("\n");
      const tmpl = Template.fromSource(src);
      assert.strictEqual(tmpl.render({ user_name: "Alice" }), "Alice");
    });
  });

  // ── Rule 7: Built-in shadowing ──────────────────────────────────────

  describe("Built-in shadowing", () => {
    const builtins = [
      "str",
      "bool",
      "int",
      "float",
      "list",
      "struct",
      "enum",
      "tmpl",
    ];

    for (const name of builtins) {
      it(`rejects type alias that shadows built-in '${name}'`, () => {
        const src = [
          `---`,
          "types:",
          `  - ${name} = list(x = str)`,
          "",
          "params:",
          `  - data = ${name}`,
          `---`,
          "{{ data }}",
        ].join("\n");
        assert.throws(
          () => Template.fromSource(src),
          (err: Error) =>
            err.message.includes("shadow") ||
            err.message.includes("reserved") ||
            err.message.includes("built-in"),
        );
      });
    }

    it("allows type alias that does not shadow a built-in", () => {
      const src = [
        `---`,
        "types:",
        "  - Priority = list(label = str)",
        "",
        "params:",
        "  - items = Priority",
        `---`,
        "> {% for item in items %}",
        "",
        "{{ item.label }}",

        "",
        "> {% /for %}",
      ].join("\n");
      const tmpl = Template.fromSource(src);
      const output = tmpl.render({ items: [{ label: "high" }] });
      assert.ok(output.includes("high"));
    });
  });

  // ── Rule 8: Unused type aliases ─────────────────────────────────────

  describe("Unused type aliases", () => {
    it("rejects unused type alias when params exist", () => {
      const src = [
        `---`,
        "types:",
        "  - Unused = list(x = str)",
        "",
        "params:",
        "  - name = str",
        `---`,
        "{{ name }}",
      ].join("\n");
      assert.throws(
        () => Template.fromSource(src),
        (err: Error) => err.message.includes("unused type alias"),
      );
    });

    it("allows unused type alias with allow_unused: true", () => {
      const src = [
        `---`,
        "allow_unused: true",
        "types:",
        "  - Unused = list(x = str)",
        "",
        "params:",
        "  - name = str",
        `---`,
        "{{ name }}",
      ].join("\n");
      const tmpl = Template.fromSource(src);
      assert.strictEqual(tmpl.render({ name: "hello" }), "hello");
    });

    it("allows used type alias", () => {
      const src = [
        `---`,
        "types:",
        "  - Items = list(title = str)",
        "",
        "params:",
        "  - items = Items",
        `---`,
        "> {% for item in items %}",
        "",
        "{{ item.title }}",

        "",
        "> {% /for %}",
      ].join("\n");
      const tmpl = Template.fromSource(src);
      const output = tmpl.render({ items: [{ title: "test" }] });
      assert.ok(output.includes("test"));
    });

    it("skips unused check when no params and no consts (type-library)", () => {
      const src = [
        `---`,
        "types:",
        "  - SomeType = list(x = str)",
        `---`,
        "Static content",
      ].join("\n");
      // No params/consts → R4 should NOT fire
      const tmpl = Template.fromSource(src);
      assert.ok(tmpl.body().includes("Static content"));
    });
  });

  // ── Validation not in lenient mode ──────────────────────────────────

  describe("Validation scope", () => {
    it("fromSourceAllowingUnused does NOT run collision validation", () => {
      // This has a param↔const conflict which would fail in strict mode
      const src = `---
params:
  - level = str

consts:
  - level = int := 5
---
{{ level }}`;
      // Should NOT throw in lenient mode
      const tmpl = Template.fromSourceAllowingUnused(src);
      assert.ok(tmpl.declarations().length > 0);
    });

    it("renderUnchecked does NOT re-run validation", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - name = str
---
{{ name }}`,
      );
      // Should succeed without re-validation
      assert.strictEqual(tmpl.renderUnchecked({ name: "test" }), "test");
    });
  });

  // ── toPascalCase helper ─────────────────────────────────────────────

  describe("toPascalCase", () => {
    it("converts snake_case", () => {
      assert.strictEqual(toPascalCase("code_review"), "CodeReview");
      assert.strictEqual(toPascalCase("simple_greeting"), "SimpleGreeting");
    });

    it("converts kebab-case", () => {
      assert.strictEqual(toPascalCase("task-report"), "TaskReport");
    });

    it("converts single word", () => {
      assert.strictEqual(toPascalCase("single"), "Single");
    });

    it("handles empty string", () => {
      assert.strictEqual(toPascalCase(""), "");
    });

    it("handles leading/trailing separators", () => {
      assert.strictEqual(toPascalCase("_leading"), "Leading");
      assert.strictEqual(toPascalCase("trailing_"), "Trailing");
      assert.strictEqual(toPascalCase("__double__"), "Double");
    });

    it("preserves existing caps in segments", () => {
      assert.strictEqual(
        toPascalCase("already_PascalCase"),
        "AlreadyPascalCase",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe("Regression tests", () => {
  // ── 1. AST mutation bug (trimAfter) ─────────────────────────────────
  // Both `renderNodes()` and `renderDirectNodes()` previously mutated the
  // AST nodes array in-place when handling trimAfter. Calling render()
  // twice on the same template would produce different results.

  it("render() is idempotent with trimAfter whitespace control", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{- name -}} world`,
    );
    const first = tmpl.render({ name: "Alice" });
    const second = tmpl.render({ name: "Alice" });
    assert.strictEqual(first, second);
  });

  it("renderUnchecked() is idempotent with trimAfter whitespace control", () => {
    const tmpl = Template.fromSource(
      `---
params: [name = str]
---
Hello {{- name -}} world`,
    );
    const first = tmpl.renderUnchecked({ name: "Alice" });
    const second = tmpl.renderUnchecked({ name: "Alice" });
    assert.strictEqual(first, second);
  });

  it("render() and renderUnchecked() agree with trimAfter", () => {
    const tmpl = Template.fromSource(
      `---
params: [x = str]
---
A {{- x -}} B`,
    );
    const checked = tmpl.render({ x: "val" });
    const unchecked = tmpl.renderUnchecked({ x: "val" });
    assert.strictEqual(checked, unchecked);
  });

  // ── 2. node:fs lazy loading (browser compat) ────────────────────────
  // `import * as fs from "node:fs"` was replaced with lazy getFs()/getPath()
  // getters. fromSource() and render() must work without filesystem access.

  it("fromSource does not require filesystem", () => {
    // This test verifies that creating a template from source and rendering
    // it never triggers file system access — only fromFile/TemplateCache do.
    const tmpl = Template.fromSource(
      `---
params: [greeting = str]
---
{{ greeting }}, universe!`,
    );
    const result = tmpl.render({ greeting: "Hello" });
    assert.strictEqual(result, "Hello, universe!");
  });

  // ── 3. checkUnusedParams word-boundary matching ─────────────────────
  // The unused param check was using `body.includes(decl.name)` which
  // had false negatives: a param named "a" passed if the body contained
  // "variable" (which contains 'a' as a substring).

  it("rejects param whose name is a substring of body words", () => {
    // Param "a" is declared but only "variable" appears in body.
    // "variable" contains 'a' as a substring but not as a word.
    assert.throws(
      () =>
        Template.fromSource(`---
params: [a = str]
---
The variable is set`),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("unused"));
        return true;
      },
    );
  });

  // ── 4. Strict equality in direct renderer ───────────────────────────
  // The direct renderer was using `==` instead of `===` for comparisons,
  // which could cause `0 == ""` to be true due to JS loose coercion.

  it("direct renderer uses strict equality (empty string != 0)", () => {
    const tmpl = Template.fromSource(
      `---
params: [count = int]
---
> {% if count == 0 %}

zero

> {% else %}

nonzero

> {% /if %}`,
    );
    // With strict equality, "" !== 0, so this should NOT match the == 0 branch.
    // renderUnchecked uses the direct renderer which was the buggy path.
    const result = tmpl.renderUnchecked({ count: "" });
    assert.ok(
      result.includes("nonzero"),
      `expected "nonzero" but got: ${JSON.stringify(result)}`,
    );
  });

  // ── 5. importedConsts() method ──────────────────────────────────────
  // Verify importedConsts() returns an object (even if empty).

  it("importedConsts() returns an empty object for a simple template", () => {
    const tmpl = Template.fromSource(`---
params: [x = str]
---
{{ x }}`);
    const imported = tmpl.importedConsts();
    assert.deepStrictEqual(imported, {});
  });

  it("importedConsts() resolves constants from imported templates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-import-"));
    try {
      // Child template with consts
      const childContent = [
        `---`,
        "consts:",
        "  - MAX_RETRIES = int := 3",
        '  - MODEL_NAME = str := "gpt-4"',
        "",
        "params: [x = str]",
        `---`,
        "{{ x }}",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "child.tmpl.md"), childContent);

      // Parent template that imports the child
      const parentContent = [
        `---`,
        "imports:",
        '  - "[child](./child.tmpl.md)"',
        "",
        "params: [x = str]",
        `---`,
        "{{ x }}",
      ].join("\n");
      const parentPath = path.join(dir, "parent.tmpl.md");
      fs.writeFileSync(parentPath, parentContent);

      // Load parent from file (triggers import resolution)
      const tmpl = Template.fromFile(parentPath);
      const imported = tmpl.importedConsts();

      // Should have child's constants keyed as "child.NAME"
      assert.strictEqual(imported["child.MAX_RETRIES"], 3);
      assert.strictEqual(imported["child.MODEL_NAME"], "gpt-4");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  // ── 6. TemplateCache content hash ───────────────────────────────────
  // Verify that TemplateCache returns the same template for unchanged content.

  it("TemplateCache returns stable hashes for unchanged content", () => {
    withTempFile(
      `---
params: [v = str]
---
{{ v }}`,
      (filepath) => {
        const cache = new TemplateCache();
        const t1 = cache.load(filepath);
        const t2 = cache.load(filepath);
        assert.strictEqual(t1.sourceHash(), t2.sourceHash());
        // Both should render identically
        assert.strictEqual(
          t1.render({ v: "cached" }),
          t2.render({ v: "cached" }),
        );
      },
    );
  });

  it("TemplateCache evicts oldest entry when maxEntries exceeded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-lru-"));
    try {
      // Write 3 distinct template files
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(
          path.join(dir, `t${String(i)}.tmpl.md`),
          `---
params: [x = str]
---
Template ${String(i)}: {{ x }}`,
        );
      }

      const cache = new TemplateCache({ maxEntries: 2 });
      cache.load(path.join(dir, "t1.tmpl.md"));
      cache.load(path.join(dir, "t2.tmpl.md"));
      assert.strictEqual(cache.templateCount(), 2);

      // Loading a 3rd template should evict the oldest (t1)
      cache.load(path.join(dir, "t3.tmpl.md"));
      assert.strictEqual(cache.templateCount(), 2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("untyped list() fails", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [items = list()]
---
{{ len(items) }}`),
      (err: Error) => err.message.includes("untyped list() is not allowed"),
    );
  });

  it("untyped struct() fails", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [data = struct()]
---
{{ data.x }}`),
      (err: Error) => err.message.includes("untyped struct() is not allowed"),
    );
  });

  it("unnamed multiple fields list fails", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [items = list(str, int)]
---
{{ len(items) }}`),
      (err: Error) =>
        err.message.includes("list with multiple fields must use named fields"),
    );
  });

  it("unquoted string default fails", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [name = str := hello]
---
{{ name }}`),
      (err: Error) => err.message.includes("strings must be quoted"),
    );
  });

  // -- list(struct(...)) rejection ------------------------------------------

  it("list(str) parses OK (scalar list)", () => {
    const tmpl = Template.fromSource(`---
params: [items = list(str)]
---
{{ items | join(", ") }}`);
    assert.strictEqual(tmpl.render({ items: ["a", "b"] }), "a, b");
  });

  it("list(name = str, score = int) parses OK (named fields / struct items)", () => {
    const tmpl = Template.fromSource(`---
params: [items = list(name = str, score = int)]
---
> {% for item in items %}

{{ item.name }}: {{ item.score }}

> {% /for %}`);
    const output = tmpl.render({
      items: [{ name: "Alice", score: 100 }],
    });
    assert.ok(output.includes("Alice: 100"));
  });

  it("list(list(str)) parses OK (nested list)", () => {
    const tmpl = Template.fromSource(`---
params: [matrix = list(list(str))]
---
{{ len(matrix) }}`);
    assert.strictEqual(tmpl.render({ matrix: [["a", "b"], ["c"]] }), "2");
  });

  it("list(enum(A, B)) parses OK (list of enums)", () => {
    const tmpl = Template.fromSource(`---
params: [flags = list(enum(On, Off))]
---
{{ len(flags) }}`);
    assert.strictEqual(tmpl.render({ flags: ["On", "Off"] }), "2");
  });

  it("list(struct(name = str)) is rejected as redundant", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [items = list(struct(name = str))]
---
{{ len(items) }}`),
      (err: Error) =>
        err.message.includes(
          "list(struct(...)) is redundant; use named fields directly",
        ),
    );
  });

  it("list(struct(name = str, score = int)) is rejected as redundant", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [items = list(struct(name = str, score = int))]
---
{{ len(items) }}`),
      (err: Error) =>
        err.message.includes(
          "list(struct(...)) is redundant; use named fields directly",
        ),
    );
  });

  it("list of strong struct alias unwraps cleanly and renders", () => {
    const tmpl = Template.fromSource(`---
types: [MyItem = struct(name = str, score = int)]
params: [items = list(MyItem)]
---
> {% for item in items %}{{ item.name }}: {{ item.score }}{% /for %}`);
    assert.strictEqual(
      tmpl.render({ items: [{ name: "Alice", score: 10 }] }),
      "Alice: 10",
    );
  });

  it("list of named struct field allowed and renders", () => {
    const tmpl = Template.fromSource(`---
params: [items = list(item = struct(name = str, score = int))]
---
> {% for i in items %}{{ i.item.name }}: {{ i.item.score }}{% /for %}`);
    assert.strictEqual(
      tmpl.render({ items: [{ item: { name: "Bob", score: 20 } }] }),
      "Bob: 20",
    );
  });
});

// ---------------------------------------------------------------------------
// Enum default validation
// ---------------------------------------------------------------------------

describe("Enum default validation", () => {
  it("unit variant default works", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - status = enum(Active, Paused) := Active
---
{{ kind(status) }}`,
    );
    assert.strictEqual(tmpl.render(), "Active");
  });

  it("unit variant default on mixed enum", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected) := Rejected
---
{{ kind(outcome) }}`,
    );
    assert.strictEqual(tmpl.render(), "Rejected");
  });

  it("struct variant default with fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected) := Confirmed(evidence = "found it")
---
> {% match outcome %}

> {% case Confirmed %}

{{ outcome.evidence }}

> {% case Rejected %}

no

> {% /match %}`,
    );
    assert.strictEqual(tmpl.render().trim(), "found it");
  });

  it("multi-field struct variant default", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - result = enum(Success(msg = str, code = int), Failure) := Success(msg = "ok", code = 200)
---
> {% match result %}

> {% case Success %}

{{ result.msg }}:{{ result.code }}

> {% case Failure %}

fail

> {% /match %}`,
    );
    assert.strictEqual(tmpl.render().trim(), "ok:200");
  });

  it("struct variant default as a const renders correctly", () => {
    const tmpl = Template.fromSource(
      `---
consts:
  - DEFAULT = enum(Success(msg = str), Failure) := Success(msg = "done")
---
> {% match DEFAULT %}

> {% case Success %}

{{ DEFAULT.msg }}

> {% case Failure %}

fail

> {% /match %}`,
    );
    assert.strictEqual(tmpl.render().trim(), "done");
  });

  it("rejects bare struct variant without fields", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected) := Confirmed
---
{{ outcome }}`,
        ),
      (err: Error) =>
        err.message.includes("struct variant") &&
        err.message.includes("requires fields"),
    );
  });

  it("rejects unknown variant name", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params:
  - status = enum(Active, Paused) := Nonexistent
---
{{ status }}`,
        ),
      (err: Error) => err.message.includes("unknown enum variant"),
    );
  });

  it("rejects unit variant with fields", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params:
  - status = enum(Active, Paused) := Active(x = 1)
---
{{ status }}`,
        ),
      (err: Error) =>
        err.message.includes("unit variant") &&
        err.message.includes("cannot have fields"),
    );
  });
});

// ---------------------------------------------------------------------------
// Enum variant reserved keyword check
// ---------------------------------------------------------------------------

describe("Enum variant reserved keyword check", () => {
  it("rejects variant named 'struct'", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params:
  - x = enum(struct, ok)
---
{{ x }}`,
        ),
      (err: Error) => err.message.includes("shadows a builtin type keyword"),
    );
  });

  it("rejects variants named with reserved keywords", () => {
    for (const keyword of [
      "str",
      "bool",
      "int",
      "float",
      "list",
      "struct",
      "enum",
      "tmpl",
    ]) {
      assert.throws(
        () => parseVarType(`enum(${keyword}, Ok)`),
        (err: Error) => err.message.includes("shadows a builtin type keyword"),
        `expected variant '${keyword}' to be rejected`,
      );
    }
  });

  it("accepts valid variant names", () => {
    // Should not throw
    const vt = parseVarType("enum(Active, Paused, Done)");
    assert.strictEqual(vt.kind, "enum");
    assert.strictEqual(vt.variants.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Enum literal expressions
// ---------------------------------------------------------------------------

describe("Enum literal expressions", () => {
  it("{{ Stage.Design }} is rejected as bare enum literal", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
types:
  - Stage = enum(Design, Build, Test)

params: [name = str]
---
Stage: {{ Stage.Design }}, name: {{ name }}`,
        ),
      (err: Error) =>
        err.message.includes("bare enum literal") &&
        err.message.includes("Stage.Design") &&
        err.message.includes("kind(Stage.Design)"),
    );
  });

  it("{{ kind(Stage.Design) }} renders as Design", () => {
    const tmpl = Template.fromSource(
      `---
types:
  - Stage = enum(Design, Build, Test)

params: [name = str]
---
Kind: {{ kind(Stage.Design) }}, name: {{ name }}`,
    );
    assert.strictEqual(
      tmpl.render({ name: "hello" }),
      "Kind: Design, name: hello",
    );
  });

  it("struct variant: {{ kind(Status.Paused) }} renders as Paused", () => {
    const tmpl = Template.fromSource(
      `---
types:
  - Status = enum(Active, Paused(reason = str), Done)

params: [name = str]
---
Kind: {{ kind(Status.Paused) }}, name: {{ name }}`,
    );
    assert.strictEqual(
      tmpl.render({ name: "test" }),
      "Kind: Paused, name: test",
    );
  });

  it("all variants accessible via kind()", () => {
    const tmpl = Template.fromSource(
      `---
types:
  - Color = enum(Red, Green, Blue)

params: [x = str]
---
{{ kind(Color.Red) }}, {{ kind(Color.Green) }}, {{ kind(Color.Blue) }} ({{ x }})`,
    );
    assert.strictEqual(tmpl.render({ x: "ok" }), "Red, Green, Blue (ok)");
  });

  it("enum type constants do NOT overwrite user-defined constants", () => {
    const tmpl = Template.fromSource(
      `---
types:
  - Stage = enum(Design, Build)

consts:
  - Stage = str := "custom"

params: [x = str]
---
{{ Stage }}: {{ x }}`,
    );
    assert.strictEqual(tmpl.render({ x: "hi" }), "custom: hi");
  });

  it("kind(Stage.Design) works with renderUnchecked", () => {
    const tmpl = Template.fromSource(
      `---
types:
  - Stage = enum(Design, Build, Test)

params: [name = str]
---
{{ kind(Stage.Design) }}: {{ name }}`,
    );
    assert.strictEqual(tmpl.renderUnchecked({ name: "fast" }), "Design: fast");
  });

  it("bare enum with filter is also rejected", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
types:
  - Stage = enum(Design, Build)

params: [x = str]
---
{{ Stage.Design | upper }}: {{ x }}`,
        ),
      (err: Error) =>
        err.message.includes("bare enum literal") &&
        err.message.includes("Stage.Design"),
    );
  });
});

// ---------------------------------------------------------------------------
// option(T) type support
// ---------------------------------------------------------------------------

describe("option(T) parsing", () => {
  it("parses option(int) as dedicated option type", () => {
    const vt = parseVarType("option(int)");
    assert.strictEqual(vt.kind, "option");
    assert.deepStrictEqual(vt.innerType, { kind: "int" });
  });

  it("parses option(str)", () => {
    const vt = parseVarType("option(str)");
    assert.strictEqual(vt.kind, "option");
    assert.deepStrictEqual(vt.innerType, { kind: "str" });
  });

  it("formats option(int) back to string", () => {
    const vt = parseVarType("option(int)");
    assert.strictEqual(varTypeToString(vt), "option(int)");
  });

  it("formats option(str) back to string", () => {
    const vt = parseVarType("option(str)");
    assert.strictEqual(varTypeToString(vt), "option(str)");
  });

  it("declarations report option(T) correctly", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const decls = tmpl.declarations();
    assert.strictEqual(defined(decls[0])[1], "option(int)");
  });
});

describe("option(T) default values", () => {
  it("default None renders correctly", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
> {% if has(x) %}

present

> {% else %}

absent

> {% /if %}`);
    const output = tmpl.render();
    assert.ok(output.includes("absent"));
  });

  it("default auto-wrap integer", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := 42
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const output = tmpl.render();
    assert.ok(output.includes("42"));
  });

  it("default auto-wrap quoted string None", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := "None"
---
> {% if has(x) %}

{{ x }}

> {% else %}

absent

> {% /if %}`);
    const output = tmpl.render();
    assert.ok(output.includes("None"));
    assert.ok(!output.includes("absent"));
  });

  it("default auto-wrap quoted regular string", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := "hello"
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render().trim(), "hello");
  });

  it("defaults() returns null for None default", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const defs = tmpl.defaults();
    assert.strictEqual(defs.x, null);
  });

  it("defaults() returns unwrapped value for Some default", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := 42
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const defs = tmpl.defaults();
    assert.strictEqual(defs.x, 42);
  });
});

describe("option(T) required vs optional", () => {
  it("option without default is required — missing param throws", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.throws(
      () => tmpl.render({}),
      (err: Error) =>
        err.message.includes("missing") && err.message.includes("x"),
    );
  });

  it("option without default — providing value works", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.ok(tmpl.render({ x: 42 }).includes("42"));
  });

  it("option without default — providing null works", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

present

> {% else %}

absent

> {% /if %}`);
    assert.ok(tmpl.render({ x: null }).includes("absent"));
  });

  it("option with := None default — omitting param is OK", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
> {% if has(x) %}

present

> {% else %}

absent

> {% /if %}`);
    // No error: default None is applied
    assert.ok(tmpl.render().includes("absent"));
  });

  it("option with := None default — can override with value", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
> {% if has(x) %}

{{ x }}

> {% else %}

absent

> {% /if %}`);
    assert.ok(tmpl.render({ x: 99 }).includes("99"));
  });

  it("defaults() does not include option without default", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
  - y = option(str) := None
  - z = option(str) := "hi"
---
> {% if has(x) %}

{{ x }}

> {% /if %}

> {% if has(y) %}

{{ y }}

> {% /if %}

> {% if has(z) %}

{{ z }}

> {% /if %}`);
    const defs = tmpl.defaults();
    assert.ok(!("x" in defs), "x should not have a default");
    assert.strictEqual(defs.y, null, "y should default to null (None)");
    assert.strictEqual(defs.z, "hi", "z should default to 'hi'");
  });
});

describe("option(T) rendering with auto-unwrap", () => {
  it("auto-unwraps Some(val=42) to 42 in {{ x }}", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "42");
  });

  it("auto-unwraps Some(val=str) to str", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: "hello" }).trim(), "hello");
  });

  it("renders None as str(None) for kind()", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "None");
  });

  it("renders Some kind", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "Some");
  });
});

describe("option(T) has() builtin", () => {
  it("has() returns false for None", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.ok(tmpl.render({ x: null }).includes("no"));
  });

  it("has() returns true for Some", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.ok(tmpl.render({ x: 42 }).includes("yes"));
  });

  it("bare truthiness is true for non-empty string", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = str
---
> {% if x %}

yes

> {% /if %}`);
    assert.ok(tmpl.render({ x: "hello" }).includes("yes"));
  });
});

// ===========================================================================
// D1 — option has()/None handling and leak-safety (regression)
//
// Locks in the divergence-contract behavior shared with the Rust core:
//   * has() is false only for the None sentinel, true for any present value.
//   * The literal string "None" is a *present* value (has() == true), so it
//     never masquerades as the None sentinel — both as a parsed default and as
//     a runtime-supplied value.
//   * The inner value of an option must not "leak" into a branch where it is
//     statically known to be absent: reading it in the else-branch of
//     `if has(x)`, the body of `if !has(x)`, or a `case None` arm is rejected.
// ===========================================================================
describe("D1: option has()/None + leak-safety (regression)", () => {
  const renders = (src: string, ctx: Record<string, unknown>): string =>
    Template.fromSource(src).render(ctx);

  const ifHasElse = `---
params:
  - x = option(int)
---
> {% if has(x) %}

present

> {% else %}

absent

> {% /if %}`;

  it("has() is false for the None sentinel (absent)", () => {
    assert.ok(renders(ifHasElse, { x: null }).includes("absent"));
  });

  it("has() is true for a present Some value", () => {
    assert.ok(renders(ifHasElse, { x: 42 }).includes("present"));
  });

  it('the literal string "None" is present (has() == true) via default', () => {
    const src = `---
params:
  - x = option(str) := "None"
---
> {% if has(x) %}

present:{{ x }}

> {% else %}

absent

> {% /if %}`;
    assert.strictEqual(renders(src, {}).trim(), "present:None");
  });

  it('the literal string "None" is present (has() == true) at runtime', () => {
    const src = `---
params:
  - x = option(str)
---
> {% if has(x) %}

present:{{ x }}

> {% else %}

absent

> {% /if %}`;
    assert.strictEqual(renders(src, { x: "None" }).trim(), "present:None");
  });

  it("rejects reading the inner value in the else-branch of `if has(x)`", () => {
    const src = `---
params:
  - x = option(int)
---
> {% if has(x) %}

present

> {% else %}

val={{ x }}

> {% /if %}`;
    assert.throws(
      () => renders(src, { x: null }),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("cannot display value of type option"));
        return true;
      },
    );
  });

  it("rejects reading the inner value in the body of `if !has(x)`", () => {
    const src = `---
params:
  - x = option(int)
---
> {% if !has(x) %}

val={{ x }}

> {% /if %}`;
    assert.throws(
      () => renders(src, { x: null }),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("cannot display value of type option"));
        return true;
      },
    );
  });

  it("rejects reading the inner value in a `case None` arm", () => {
    const src = `---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

some

> {% case None %}

val={{ x }}

> {% /match %}`;
    assert.throws(
      () => renders(src, { x: null }),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("cannot display value of type option"));
        return true;
      },
    );
  });
});

// ===========================================================================
// D2 / D4 — declaration diagnostics (byte-for-byte parity with the Rust core)
//
// The exact wording of these diagnostics is part of the cross-backend
// divergence contract, so the assertions pin the full core message. The parser
// appends a " (line N, --> ...)" location suffix, which `includes` tolerates.
// ===========================================================================
describe("D2/D4: declaration diagnostics (byte-for-byte)", () => {
  const expectError = (fm: string, coreMessage: string): void => {
    assert.throws(
      () => parseFrontmatter(fm),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(
          err.message.includes(coreMessage),
          `expected message to include:\n  ${coreMessage}\ngot:\n  ${err.message}`,
        );
        return true;
      },
    );
  };

  // --- D2: qualified enum-variant defaults are rejected ---

  it("D2 rejects a qualified default on an inline enum type", () => {
    expectError(
      `---
params:
  - s = enum(Design, Build) := MyEnum.Build
---
body`,
      "declaration 's': invalid enum default 'MyEnum.Build': use the bare " +
        "variant name 'Build' (a qualified 'Type.Variant' is only valid in " +
        "expressions)",
    );
  });

  it("D2 rejects a qualified default on an enum type alias", () => {
    expectError(
      `---
types:
  - Stage = enum(Design, Build, Deploy)

params:
  - s = Stage := Stage.Build
---
body`,
      "declaration 's': invalid enum default 'Stage.Build': use the bare " +
        "variant name 'Build' (a qualified 'Type.Variant' is only valid in " +
        "expressions)",
    );
  });

  it("D2 rejects a qualified default on an option(enum) type", () => {
    expectError(
      `---
types:
  - Stage = enum(Design, Build, Deploy)

params:
  - o = option(Stage) := Stage.Deploy
---
body`,
      "declaration 'o': invalid enum default 'Stage.Deploy': use the bare " +
        "variant name 'Deploy' (a qualified 'Type.Variant' is only valid in " +
        "expressions)",
    );
  });

  // --- D4: implicit-typed declarations with a default are rejected ---

  it("D4 rejects an implicit-typed param (`x := ...`)", () => {
    expectError(
      `---
params:
  - x := "hello"
---
body`,
      "param 'x' must have an explicit type (expected 'name = type := value')",
    );
  });

  it("D4 rejects an implicit-typed param with no spaces (`x:=...`)", () => {
    expectError(
      `---
params:
  - x:="hello"
---
body`,
      "param 'x' must have an explicit type (expected 'name = type := value')",
    );
  });

  it("D4 rejects an implicit-typed const (`X := ...`)", () => {
    expectError(
      `---
consts:
  - X := "hello"
---
body`,
      "constant 'X' must have an explicit type (expected 'name = type := value')",
    );
  });

  it("D4 reports a missing type annotation for a bare name", () => {
    expectError(
      `---
params:
  - untyped_param
---
body`,
      "param 'untyped_param' is missing a type annotation " +
        "(expected 'name = type')",
    );
  });
});

describe("option(T) match/case", () => {
  it("matches Some case", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

found: {{ x }}

> {% case None %}

empty

> {% /match %}`);
    assert.ok(tmpl.render({ x: 42 }).includes("found: 42"));
  });

  it("matches None case", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

found

> {% case None %}

empty

> {% /match %}`);
    assert.ok(tmpl.render({ x: null }).includes("empty"));
  });
});

describe("option(T) JSON serde", () => {
  it("null input becomes None", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "None");
  });

  it("undefined input becomes None via default", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render().trim(), "None");
  });

  it("value input becomes Some", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "Some");
  });
});

describe("option(T) codegen", () => {
  it("generates T | null for option(int)", () => {
    const code = generateTypes(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.ok(code.includes("number | null"));
  });

  it("generates T | null for option(str)", () => {
    const code = generateTypes(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.ok(code.includes("string | null"));
  });

  it("inferTypes reports option correctly", () => {
    const result = inferTypes(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(defined(result.fields[0]).tsType, "number | null");
  });

  it("generates null for None default in codegen", () => {
    const code = generateTypes(`---
params:
  - x = option(int) := None
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.ok(code.includes("null"));
  });

  it("option label in JSDoc", () => {
    const code = generateTypes(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.ok(code.includes("option(int)"));
  });
});

describe("option(T) nested in structs and lists", () => {
  it("option inside struct", () => {
    const tmpl = Template.fromSource(`---
params:
  - config = struct(name = str, timeout = option(int))
---
> {% if has(config.timeout) %}

timeout: {{ config.timeout }}

> {% else %}

no timeout

> {% /if %}`);
    const output1 = tmpl.render({ config: { name: "test", timeout: 42 } });
    assert.ok(output1.includes("timeout: 42"));

    const output2 = tmpl.render({ config: { name: "test", timeout: null } });
    assert.ok(output2.includes("no timeout"));
  });

  it("option in list items", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(name = str, value = option(int))
---
> {% for item in items %}

> {% if has(item.value) %}

{{ item.name }}: {{ item.value }}

> {% else %}

{{ item.name }}: -

> {% /if %}

> {% /for %}`);
    const output = tmpl.render({
      items: [
        { name: "a", value: 1 },
        { name: "b", value: null },
      ],
    });
    assert.ok(output.includes("a: 1"));
    assert.ok(output.includes("b: -"));
  });
});

describe("option(T) renderUnchecked", () => {
  it("renders option value directly in unchecked mode", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const output = tmpl.renderUnchecked({ x: 42 });
    assert.strictEqual(output.trim(), "42");
  });

  it("has() works in unchecked mode", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.ok(tmpl.renderUnchecked({ x: null }).includes("no"));
    assert.ok(tmpl.renderUnchecked({ x: 42 }).includes("yes"));
  });
});

describe("option(T) error cases", () => {
  it("rejects wrong inner type in render", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.throws(
      () => tmpl.render({ x: "not a number" }),
      (err: Error) => err.message.includes("type mismatch"),
    );
  });

  it("option as reserved keyword prevents naming", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - option = str
---
{{ option }}`),
      (err: Error) => err.message.includes("reserved"),
    );
  });

  it("option variant name rejected in enum", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - x = enum(option, other)
---
{{ kind(x) }}`),
      (err: Error) => err.message.includes("shadows a builtin type keyword"),
    );
  });

  it("option type alias cannot shadow builtin", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
types:
  - Option = enum(A, B)

params:
  - x = Option
---
{{ kind(x) }}`),
      (err: Error) => err.message.includes("shadows built-in type name"),
    );
  });
});

describe("option(T) type alias support", () => {
  it("option type alias in types block", () => {
    const tmpl = Template.fromSource(`---
types:
  - MaybeInt = option(int)

params:
  - x = MaybeInt
---
> {% if has(x) %}

{{ x }}

> {% else %}

none

> {% /if %}`);
    assert.ok(tmpl.render({ x: 42 }).includes("42"));
    assert.ok(tmpl.render({ x: null }).includes("none"));
  });
});

// ---------------------------------------------------------------------------
// option(tmpl(...)) type support
// ---------------------------------------------------------------------------

describe("option(tmpl(...)) parsing", () => {
  // NOTE: tmpl() is a first-class VarType kind (not desugared to struct).
  // option(tmpl(x = str)) preserves the tmpl kind at the VarType level.
  it("parses option(tmpl(x = str)) — tmpl is first-class kind", () => {
    const vt = parseVarType("option(tmpl(x = str))");
    assert.strictEqual(vt.kind, "option");
    // tmpl is a first-class VarType kind
    assert.strictEqual(vt.innerType.kind, "tmpl");
  });

  it("parses option(tmpl()) — empty tmpl", () => {
    const vt = parseVarType("option(tmpl())");
    assert.strictEqual(vt.kind, "option");
    assert.strictEqual(vt.innerType.kind, "tmpl");
  });

  it("formats option(tmpl(x = str)) as option(tmpl(x = str))", () => {
    const vt = parseVarType("option(tmpl(x = str))");
    // tmpl is preserved as first-class kind
    assert.strictEqual(varTypeToString(vt), "option(tmpl(x = str))");
  });

  it("declarations report tmpl type", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% if has(cb) %}

present

> {% else %}

absent

> {% /if %}`);
    const decls = tmpl.declarations();
    // tmpl is preserved as first-class kind
    assert.strictEqual(defined(decls[0])[1], "option(tmpl(test = str))");
  });
});

describe("option(tmpl(...)) has() guard", () => {
  it("has() returns false for null option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% if has(cb) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.ok(tmpl.render({ cb: null }).includes("no"));
  });

  it("has() returns true for present option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% if has(cb) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.ok(tmpl.render({ cb: { test: "hello" } }).includes("yes"));
  });
});

describe("option(tmpl(...)) match/case", () => {
  it("matches Some case for option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% match cb %}

> {% case Some %}

present

> {% case None %}

absent

> {% /match %}`);
    assert.ok(tmpl.render({ cb: { test: "val" } }).includes("present"));
  });

  it("matches None case for option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% match cb %}

> {% case Some %}

present

> {% case None %}

absent

> {% /match %}`);
    assert.ok(tmpl.render({ cb: null }).includes("absent"));
  });
});

describe("option(tmpl(...)) default values", () => {
  it("defaults to None when := None", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str)) := None
---
> {% if has(cb) %}

present

> {% else %}

absent

> {% /if %}`);
    assert.ok(tmpl.render().includes("absent"));
  });

  it("option(tmpl) without default is required", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
---
> {% if has(cb) %}

yes

> {% /if %}`);
    assert.throws(
      () => tmpl.render({}),
      (err: Error) =>
        err.message.includes("missing") && err.message.includes("cb"),
    );
  });

  it("option(tmpl) with None default can be overridden", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str)) := None
---
> {% if has(cb) %}

{{ cb.test }}

> {% else %}

absent

> {% /if %}`);
    assert.ok(tmpl.render({ cb: { test: "override" } }).includes("override"));
  });
});

describe("option(tmpl(...)) field access inside has() guard", () => {
  it("accesses tmpl fields when option is present", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(name = str, count = int))
---
> {% if has(cb) %}

{{ cb.name }}: {{ cb.count }}

> {% /if %}`);
    assert.ok(
      tmpl.render({ cb: { name: "test", count: 42 } }).includes("test: 42"),
    );
  });

  it("skips field access block when None", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(name = str, count = int))
---
> {% if has(cb) %}

{{ cb.name }}: {{ cb.count }}

> {% else %}

no callback

> {% /if %}`);
    assert.ok(tmpl.render({ cb: null }).includes("no callback"));
  });
});

describe("option(tmpl(...)) kind() builtin", () => {
  it("kind() returns Some for present value", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(x = str))
---
{{ kind(cb) }}`);
    assert.strictEqual(tmpl.render({ cb: { x: "hi" } }).trim(), "Some");
  });

  it("kind() returns None for null value", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(x = str))
---
{{ kind(cb) }}`);
    assert.strictEqual(tmpl.render({ cb: null }).trim(), "None");
  });
});

describe("option(tmpl(...)) nested: option(tmpl(x = option(tmpl(...))))", () => {
  it("parses deeply nested option(tmpl(option(tmpl))) — first-class", () => {
    const vt = parseVarType("option(tmpl(sub = option(tmpl(test = str))))");
    assert.strictEqual(vt.kind, "option");
    // tmpl is a first-class VarType kind
    assert.strictEqual(vt.innerType.kind, "tmpl");
  });

  it("formats deeply nested type — tmpl preserved", () => {
    const vt = parseVarType("option(tmpl(sub = option(tmpl(test = str))))");
    assert.strictEqual(
      varTypeToString(vt),
      "option(tmpl(sub = option(tmpl(test = str))))",
    );
  });

  it("renders deeply nested option(tmpl) with all levels present", () => {
    const tmpl = Template.fromSource(`---
params:
  - outer = option(tmpl(inner = option(tmpl(val = str))))
---
> {% if has(outer) %}

> {% if has(outer.inner) %}

{{ outer.inner.val }}

> {% else %}

no inner

> {% /if %}

> {% else %}

no outer

> {% /if %}`);
    const output = tmpl.render({
      outer: { inner: { val: "deep" } },
    });
    assert.ok(output.includes("deep"), `output: ${output}`);
  });

  it("renders deeply nested option(tmpl) with inner None", () => {
    const tmpl = Template.fromSource(`---
params:
  - outer = option(tmpl(inner = option(tmpl(val = str))))
---
> {% if has(outer) %}

> {% if has(outer.inner) %}

{{ outer.inner.val }}

> {% else %}

no inner

> {% /if %}

> {% else %}

no outer

> {% /if %}`);
    const output = tmpl.render({ outer: { inner: null } });
    assert.ok(output.includes("no inner"), `output: ${output}`);
  });

  it("renders deeply nested option(tmpl) with outer None", () => {
    const tmpl = Template.fromSource(`---
params:
  - outer = option(tmpl(inner = option(tmpl(val = str))))
---
> {% if has(outer) %}

> {% if has(outer.inner) %}

deep

> {% else %}

no inner

> {% /if %}

> {% else %}

no outer

> {% /if %}`);
    const output = tmpl.render({ outer: null });
    assert.ok(output.includes("no outer"), `output: ${output}`);
  });
});

describe("option(tmpl(...)) codegen", () => {
  it("generates correct type for option(tmpl(x = str))", () => {
    const code = generateTypes(`---
params:
  - cb = option(tmpl(x = str))
---
> {% if has(cb) %}

{{ cb.x }}

> {% /if %}`);
    // Should contain null union and the field type
    assert.ok(code.includes("null"), `codegen should include null: ${code}`);
  });

  it("inferTypes reports option(tmpl) correctly", () => {
    const result = inferTypes(`---
params:
  - cb = option(tmpl(x = str))
---
> {% if has(cb) %}

{{ cb.x }}

> {% /if %}`);
    const field = result.fields.find((f) => f.name === "cb");
    assert.ok(field, "cb field should exist in inferred types");
    assert.ok(
      field.tsType.includes("null"),
      `type should include null: ${field.tsType}`,
    );
  });
});

describe("option(tmpl(...)) JSON serde", () => {
  it("null input becomes None for option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(x = str))
---
{{ kind(cb) }}`);
    assert.strictEqual(tmpl.render({ cb: null }).trim(), "None");
  });

  it("struct input becomes Some for option(tmpl)", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(x = str))
---
{{ kind(cb) }}`);
    assert.strictEqual(tmpl.render({ cb: { x: "hi" } }).trim(), "Some");
  });

  it("undefined input becomes None via default", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(x = str)) := None
---
{{ kind(cb) }}`);
    assert.strictEqual(tmpl.render().trim(), "None");
  });
});

describe("option(tmpl(...)) multiple params mix", () => {
  it("mix of option(tmpl), regular tmpl, and option scalars", () => {
    const tmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(test = str))
  - target = option(tmpl(test = str))
  - label = option(str) := None
---
> {% if has(cb) %}

cb: {{ cb.test }}

> {% /if %}

> {% if has(target) %}

target: {{ target.test }}

> {% /if %}

> {% if has(label) %}

label: {{ label }}

> {% /if %}`);
    const output = tmpl.render({
      cb: { test: "A" },
      target: null,
    });
    assert.ok(output.includes("cb: A"), `output: ${output}`);
    assert.ok(!output.includes("target:"), `output: ${output}`);
    assert.ok(!output.includes("label:"), `output: ${output}`);
  });
});

// ---------------------------------------------------------------------------
// for...else
// ---------------------------------------------------------------------------

describe("for...else", () => {
  it("renders else body when list is empty", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
> {% for item in items %}{{ item.name }}{% else %}No items{% /for %}`,
    );
    const output = tmpl.render({ items: [] });
    assert.strictEqual(output.trim(), "No items");
  });

  it("renders loop body when list is non-empty", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
> {% for item in items %}{{ item.name }}{% else %}No items{% /for %}`,
    );
    const output = tmpl.render({ items: [{ name: "Alice" }] });
    assert.ok(output.includes("Alice"));
    assert.ok(!output.includes("No items"));
  });

  it("nested for...else renders correctly", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - outer = list(name = str)
  - inner = list(name = str)
---
> {% for o in outer %}{% for i in inner %}{{ i.name }}{% else %}no inner{% /for %}{% else %}no outer{% /for %}`,
    );
    const output = tmpl.render({
      outer: [{ name: "A" }],
      inner: [],
    });
    assert.ok(output.includes("no inner"));
    assert.ok(!output.includes("no outer"));
  });

  it("for...else with if/else nesting", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
  - show = bool
---
> {% for item in items %}{% if show %}{{ item.name }}{% else %}hidden{% /if %}{% else %}No items{% /for %}`,
    );
    const output = tmpl.render({ items: [], show: true });
    assert.strictEqual(output.trim(), "No items");
  });

  it("for without else still works", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(name = str)
---
> {% for item in items %}{{ item.name }}{% /for %}`,
    );
    const output = tmpl.render({ items: [{ name: "Bob" }] });
    assert.strictEqual(output.trim(), "Bob");
  });
});

// ---------------------------------------------------------------------------
// Duplicate type alias detection
// ---------------------------------------------------------------------------

describe("Duplicate type alias detection", () => {
  it("throws on duplicate type alias", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
types:
  - Greeting = str
  - Greeting = int

params:
  - msg = Greeting
---
{{ msg }}`),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("duplicate type alias"));
        assert.ok(err.message.includes("Greeting"));
        return true;
      },
    );
  });

  it("accepts distinct type aliases", () => {
    const tmpl = Template.fromSource(`---
types:
  - Greeting = str
  - Count = int

params:
  - msg = Greeting
  - n = Count
---
{{ msg }} {{ n }}`);
    assert.strictEqual(tmpl.render({ msg: "hello", n: 5 }).trim(), "hello 5");
  });
});

// ---------------------------------------------------------------------------
// Enforcement — missing params, type mismatches, extra params
// ---------------------------------------------------------------------------

describe("Enforcement gaps", () => {
  it("rejects missing required param", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
  - age = int
---
{{ name }} {{ age }}`);
    assert.throws(
      () => tmpl.render({ name: "Alice" }),
      (err: Error) => {
        assert.ok(err instanceof MissingParamsError);
        return true;
      },
    );
  });

  it("rejects wrong type for int param", () => {
    const tmpl = Template.fromSource(`---
params:
  - count = int
---
{{ count }}`);
    assert.throws(
      () => tmpl.render({ count: "not a number" }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("rejects wrong type for bool param", () => {
    const tmpl = Template.fromSource(`---
params:
  - flag = bool
---
> {% if flag %}yes{% else %}no{% /if %}`);
    assert.throws(
      () => tmpl.render({ flag: "true" }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("rejects wrong type for list param", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
> {% for item in items %}{{ item }}{% /for %}`);
    assert.throws(
      () => tmpl.render({ items: "not a list" }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("rejects extra params by default", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
---
{{ name }}`);
    assert.throws(
      () => tmpl.render({ name: "Alice", extra: "bad" }),
      (err: Error) => {
        assert.ok(err instanceof ExtraParamsError);
        return true;
      },
    );
  });

  it("allows extra params with allowExtra option", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
---
{{ name }}`);
    const result = tmpl.render(
      { name: "Alice", extra: "ok" },
      { allowExtra: true },
    );
    assert.strictEqual(result.trim(), "Alice");
  });

  it("rejects wrong struct field type", () => {
    const tmpl = Template.fromSource(`---
params:
  - person = struct(name = str, age = int)
---
{{ person.name }} is {{ person.age }}`);
    assert.throws(
      () => tmpl.render({ person: { name: "Alice", age: "thirty" } }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("rejects missing struct field", () => {
    const tmpl = Template.fromSource(`---
params:
  - person = struct(name = str, age = int)
---
{{ person.name }} is {{ person.age }}`);
    assert.throws(
      () => tmpl.render({ person: { name: "Alice" } }),
      (err: Error) => {
        assert.ok(
          err instanceof MissingParamsError || err instanceof TypeMismatchError,
          `expected MissingParamsError or TypeMismatchError, got ${err.constructor.name}: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects wrong list element type", () => {
    const tmpl = Template.fromSource(`---
params:
  - nums = list(int)
---
> {% for n in nums %}{{ n }}{% /for %}`);
    assert.throws(
      () => tmpl.render({ nums: [1, "two", 3] }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("rejects unknown enum variant", () => {
    const tmpl = Template.fromSource(`---
params:
  - color = enum(Red, Green, Blue)
---
{{ kind(color) }}`);
    assert.throws(
      () => tmpl.render({ color: "Yellow" }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Filter comprehensive tests
// ---------------------------------------------------------------------------

describe("Filter comprehensive tests", () => {
  it("upper filter", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
---
{{ name | upper }}`);
    assert.strictEqual(tmpl.render({ name: "hello" }).trim(), "HELLO");
  });

  it("lower filter", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
---
{{ name | lower }}`);
    assert.strictEqual(tmpl.render({ name: "HELLO" }).trim(), "hello");
  });

  it("trim filter", () => {
    const tmpl = Template.fromSource(`---
params:
  - name = str
---
{{ name | trim }}`);
    assert.strictEqual(tmpl.render({ name: "  hello  " }).trim(), "hello");
  });

  it("join filter", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ items | join(", ") }}`);
    assert.strictEqual(
      tmpl.render({ items: ["a", "b", "c"] }).trim(),
      "a, b, c",
    );
  });

  it("join filter with empty list", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ items | join(", ") }}`);
    assert.strictEqual(tmpl.render({ items: [] }).trim(), "");
  });

  it("limit filter truncates long list", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ items | limit(2) | join(", ") }}`);
    assert.strictEqual(
      tmpl.render({ items: ["a", "b", "c", "d"] }).trim(),
      "a, b",
    );
  });

  it("limit filter keeps short list unchanged", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ items | limit(50) | join(", ") }}`);
    assert.strictEqual(tmpl.render({ items: ["a", "b"] }).trim(), "a, b");
  });

  it("add filter on int", () => {
    const tmpl = Template.fromSource(`---
params:
  - n = int
---
{{ n | add(5) }}`);
    assert.strictEqual(tmpl.render({ n: 10 }).trim(), "15");
  });

  it("sub filter on int", () => {
    const tmpl = Template.fromSource(`---
params:
  - n = int
---
{{ n | sub(3) }}`);
    assert.strictEqual(tmpl.render({ n: 10 }).trim(), "7");
  });

  it("fixed filter on float", () => {
    const tmpl = Template.fromSource(`---
params:
  - val = float
---
{{ val | fixed(2) }}`);
    assert.strictEqual(tmpl.render({ val: 3.14159 }).trim(), "3.14");
  });

  it("filter chain: upper then join", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ items | join(", ") | upper }}`);
    assert.strictEqual(
      tmpl.render({ items: ["hello", "world"] }).trim(),
      "HELLO, WORLD",
    );
  });

  it("filter chain: trim then lower", () => {
    const tmpl = Template.fromSource(`---
params:
  - text = str
---
{{ text | trim | lower }}`);
    assert.strictEqual(tmpl.render({ text: "  HELLO  " }).trim(), "hello");
  });

  it("unknown filter throws UnknownFilterError", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params:
  - text = str
---
{{ text | nonexistent }}`,
        ).render({ text: "hello" }),
      (err: Error) => {
        assert.ok(err instanceof UnknownFilterError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Comparison operators comprehensive tests
// ---------------------------------------------------------------------------

describe("Comparison operators comprehensive", () => {
  it("== with equal ints", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x == 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "yes");
  });

  it("== with unequal ints", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x == 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 3 }).trim(), "no");
  });

  it("!= with unequal ints", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x != 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 3 }).trim(), "yes");
  });

  it("!= with equal ints", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x != 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "no");
  });

  it("< comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x < 5 %}less{% else %}not{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 3 }).trim(), "less");
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "not");
  });

  it("> comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x > 5 %}more{% else %}not{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 7 }).trim(), "more");
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "not");
  });

  it("<= comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x <= 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "yes");
    assert.strictEqual(tmpl.render({ x: 6 }).trim(), "no");
  });

  it(">= comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x >= 5 %}yes{% else %}no{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "yes");
    assert.strictEqual(tmpl.render({ x: 4 }).trim(), "no");
  });

  it("string == comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - mode = str
---
> {% if mode == "debug" %}debugging{% else %}normal{% /if %}`);
    assert.strictEqual(tmpl.render({ mode: "debug" }).trim(), "debugging");
    assert.strictEqual(tmpl.render({ mode: "release" }).trim(), "normal");
  });

  it("bool == comparison", () => {
    const tmpl = Template.fromSource(`---
params:
  - flag = bool
---
> {% if flag == true %}on{% else %}off{% /if %}`);
    assert.strictEqual(tmpl.render({ flag: true }).trim(), "on");
    assert.strictEqual(tmpl.render({ flag: false }).trim(), "off");
  });
});

// ---------------------------------------------------------------------------
// Truthiness comprehensive tests
// ---------------------------------------------------------------------------

describe("Truthiness comprehensive", () => {
  it("empty string is falsy", () => {
    const tmpl = Template.fromSource(`---
params:
  - text = str
---
> {% if text %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ text: "" }).trim(), "falsy");
  });

  it("non-empty string is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - text = str
---
> {% if text %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ text: "hello" }).trim(), "truthy");
  });

  it("zero int is falsy", () => {
    const tmpl = Template.fromSource(`---
params:
  - n = int
---
> {% if n != 0 %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ n: 0 }).trim(), "falsy");
  });

  it("non-zero int is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - n = int
---
> {% if n != 0 %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ n: 42 }).trim(), "truthy");
  });

  it("negative int is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - n = int
---
> {% if n != 0 %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ n: -1 }).trim(), "truthy");
  });

  it("zero float is falsy", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = float
---
> {% if x != 0.0 %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 0.0 }).trim(), "falsy");
  });

  it("non-zero float is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = float
---
> {% if x != 0.0 %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 0.001 }).trim(), "truthy");
  });

  it("true bool is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - flag = bool
---
> {% if flag %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ flag: true }).trim(), "truthy");
  });

  it("false bool is falsy", () => {
    const tmpl = Template.fromSource(`---
params:
  - flag = bool
---
> {% if flag %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ flag: false }).trim(), "falsy");
  });

  it("empty list is falsy", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
> {% if items %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ items: [] }).trim(), "falsy");
  });

  it("non-empty list is truthy", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
> {% if items %}truthy{% else %}falsy{% /if %}`);
    assert.strictEqual(tmpl.render({ items: ["a"] }).trim(), "truthy");
  });
});

// ---------------------------------------------------------------------------
// Whitespace control comprehensive
// ---------------------------------------------------------------------------

describe("Whitespace control comprehensive", () => {
  it("for loop with compact output", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
[{% for item in items %}{{ item }}{% /for %}]`);
    const result = tmpl.render({ items: ["a", "b", "c"] });
    assert.strictEqual(result.trim(), "[abc]");
  });

  it("if/else with compact output", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
---
[{% if x %}yes{% else %}no{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: true }).trim(), "[yes]");
    assert.strictEqual(tmpl.render({ x: false }).trim(), "[no]");
  });
});

// ---------------------------------------------------------------------------
// Option handling with transparent access
// ---------------------------------------------------------------------------

describe("Option transparent access comprehensive", () => {
  it("accesses option value directly (transparent)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: "hello" }).trim(), "hello");
  });

  it("kind() returns Some for present option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "Some");
  });

  it("kind() returns None for absent option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "None");
  });

  it("has() returns true for present option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}present{% else %}absent{% /if %}`);
    assert.strictEqual(tmpl.render({ x: "hi" }).trim(), "present");
  });

  it("has() returns false for absent option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}present{% else %}absent{% /if %}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "absent");
  });

  it("match/case on option Some", () => {
    const tmpl = Template.fromSource(
      [
        "---",
        "params:",
        "  - x = option(int)",
        "---",
        "> {% match x %}",
        "",
        "> {% case Some %}",
        "",
        "got {{ x }}",
        "",
        "> {% case None %}",
        "",
        "nothing",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    const result = tmpl.render({ x: 42 });
    assert.ok(result.includes("got 42"));
  });

  it("match/case on option None", () => {
    const tmpl = Template.fromSource(
      [
        "---",
        "params:",
        "  - x = option(int)",
        "---",
        "> {% match x %}",
        "",
        "> {% case Some %}",
        "",
        "got {{ x }}",
        "",
        "> {% case None %}",
        "",
        "nothing",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    const result = tmpl.render({ x: null });
    assert.ok(result.includes("nothing"));
  });

  it("option with default None renders correctly", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := None
---
> {% if has(x) %}{{ x }}{% else %}default{% /if %}`);
    assert.strictEqual(tmpl.render({}).trim(), "default");
  });

  it("option with default Some value", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := "hello"
---
> {% if has(x) %}{{ x }}{% else %}default{% /if %}`);
    assert.strictEqual(tmpl.render({}).trim(), "hello");
  });
});

// ---------------------------------------------------------------------------
// Match/case with {% else %} keyword
// ---------------------------------------------------------------------------

describe("Match with {% else %} keyword", () => {
  it("else arm catches unmatched variant", () => {
    const tmpl = Template.fromSource(
      [
        "---",
        "params:",
        "  - status = enum(Ok, Err, Pending)",
        "---",
        "> {% match status %}",
        "",
        "> {% case Ok %}",
        "",
        "success",
        "",
        "> {% else %}",
        "",
        "other",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    assert.ok(tmpl.render({ status: "Ok" }).includes("success"));
    assert.ok(tmpl.render({ status: "Err" }).includes("other"));
    assert.ok(tmpl.render({ status: "Pending" }).includes("other"));
  });

  it("{% else %} works as catch-all in match", () => {
    const tmpl = Template.fromSource(
      [
        "---",
        "params:",
        "  - status = enum(Ok, Err, Pending)",
        "---",
        "> {% match status %}",
        "",
        "> {% case Ok %}",
        "",
        "success",
        "",
        "> {% else %}",
        "",
        "other",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    assert.ok(tmpl.render({ status: "Ok" }).includes("success"));
    assert.ok(tmpl.render({ status: "Err" }).includes("other"));
  });

  it("match with multiple cases and else", () => {
    const tmpl = Template.fromSource(
      [
        "---",
        "params:",
        "  - color = enum(Red, Green, Blue, Yellow)",
        "---",
        "> {% match color %}",
        "",
        "> {% case Red %}",
        "",
        "hot",
        "",
        "> {% case Blue %}",
        "",
        "cool",
        "",
        "> {% else %}",
        "",
        "neutral",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    assert.ok(tmpl.render({ color: "Red" }).includes("hot"));
    assert.ok(tmpl.render({ color: "Blue" }).includes("cool"));
    assert.ok(tmpl.render({ color: "Green" }).includes("neutral"));
    assert.ok(tmpl.render({ color: "Yellow" }).includes("neutral"));
  });
});

// ---------------------------------------------------------------------------
// Built-in functions edge cases
// ---------------------------------------------------------------------------

describe("Built-in function edge cases", () => {
  it("idx() starts at 0", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
> {% for item in items %}{{ idx(item) }}{% /for %}`);
    assert.strictEqual(tmpl.render({ items: ["a", "b", "c"] }).trim(), "012");
  });

  it("len() on string", () => {
    const tmpl = Template.fromSource(`---
params:
  - text = str
---
{{ len(text) }}`);
    assert.strictEqual(tmpl.render({ text: "hello" }).trim(), "5");
  });

  it("len() on empty string", () => {
    const tmpl = Template.fromSource(`---
params:
  - text = str
---
{{ len(text) }}`);
    assert.strictEqual(tmpl.render({ text: "" }).trim(), "0");
  });

  it("len() on list", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ len(items) }}`);
    assert.strictEqual(tmpl.render({ items: ["a", "b"] }).trim(), "2");
  });

  it("len() on empty list", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
{{ len(items) }}`);
    assert.strictEqual(tmpl.render({ items: [] }).trim(), "0");
  });

  it("len() on struct is rejected — only list and string are valid", () => {
    const tmpl = Template.fromSource(`---
params:
  - obj = struct(a = str, b = int)
---
{{ len(obj) }}`);
    assert.throws(
      () => tmpl.render({ obj: { a: "x", b: 1 } }),
      (err: Error) => err.message.includes("len()"),
    );
  });

  it("kind() on unit enum variant", () => {
    const tmpl = Template.fromSource(`---
params:
  - color = enum(Red, Green, Blue)
---
{{ kind(color) }}`);
    assert.strictEqual(tmpl.render({ color: "Red" }).trim(), "Red");
  });

  it("idx() throws on non-loop binding", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = str
---
{{ idx(x) }}`);
    assert.throws(() => tmpl.render({ x: "hi" }), TemplateSyntaxError);
  });
});

// ---------------------------------------------------------------------------
// for...else edge cases (additional)
// ---------------------------------------------------------------------------

describe("for...else edge cases (additional)", () => {
  it("for...else with single item list", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(str)
---
> {% for item in items %}{{ item }}{% else %}empty{% /for %}`);
    assert.strictEqual(tmpl.render({ items: ["only"] }).trim(), "only");
  });

  it("for...else with many items", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(int)
---
> {% for item in items %}{{ item }},{% else %}empty{% /for %}`);
    const result = tmpl.render({ items: [1, 2, 3, 4, 5] }).trim();
    assert.ok(result.includes("1,"));
    assert.ok(result.includes("5,"));
    assert.ok(!result.includes("empty"));
  });

  it("multiple for loops with independent else", () => {
    const tmpl = Template.fromSource(`---
params:
  - a = list(str)
  - b = list(str)
---
> {% for x in a %}{{ x }}{% else %}noA{% /for %}|{% for y in b %}{{ y }}{% else %}noB{% /for %}`);
    assert.strictEqual(tmpl.render({ a: [], b: ["hi"] }).trim(), "noA|hi");
    assert.strictEqual(tmpl.render({ a: ["hi"], b: [] }).trim(), "hi|noB");
  });
});

// ---------------------------------------------------------------------------
// Constants comprehensive
// ---------------------------------------------------------------------------

describe("Constants comprehensive (additional)", () => {
  it("const str parsed in frontmatter", () => {
    const tmpl = Template.fromSource(`---
consts:
  - GREETING = str := "Hello"

params:
  - name = str
---
{{ name }}`);
    assert.strictEqual(tmpl.consts().GREETING, "Hello");
  });

  it("const int parsed in frontmatter", () => {
    const tmpl = Template.fromSource(`---
consts:
  - MAX = int := 100

params:
  - n = int
---
{{ n }}`);
    assert.strictEqual(tmpl.consts().MAX, 100);
  });

  it("const bool parsed in frontmatter", () => {
    const tmpl = Template.fromSource(`---
consts:
  - ENABLED = bool := true

params:
  - name = str
---
{{ name }}`);
    assert.strictEqual(tmpl.consts().ENABLED, true);
  });

  it("multiple consts parsed", () => {
    const tmpl = Template.fromSource(`---
consts:
  - A = str := "alpha"
  - B = int := 42

params:
  - name = str
---
{{ name }}`);
    assert.strictEqual(tmpl.consts().A, "alpha");
    assert.strictEqual(tmpl.consts().B, 42);
  });
});

// ---------------------------------------------------------------------------
// If/elif/else comprehensive
// ---------------------------------------------------------------------------

describe("If/elif/else comprehensive (additional)", () => {
  it("simple if-true", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
---
> {% if x %}yes{% /if %}`);
    assert.strictEqual(tmpl.render({ x: true }).trim(), "yes");
  });

  it("simple if-false produces empty", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
---
> {% if x %}yes{% /if %}`);
    assert.strictEqual(tmpl.render({ x: false }).trim(), "");
  });

  it("if-elif-else selects correct branch", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x == 1 %}one{% elif x == 2 %}two{% else %}other{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 1 }).trim(), "one");
    assert.strictEqual(tmpl.render({ x: 2 }).trim(), "two");
    assert.strictEqual(tmpl.render({ x: 3 }).trim(), "other");
  });

  it("multiple elif chains", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = int
---
> {% if x == 1 %}one{% elif x == 2 %}two{% elif x == 3 %}three{% elif x == 4 %}four{% else %}other{% /if %}`);
    assert.strictEqual(tmpl.render({ x: 1 }).trim(), "one");
    assert.strictEqual(tmpl.render({ x: 4 }).trim(), "four");
    assert.strictEqual(tmpl.render({ x: 5 }).trim(), "other");
  });

  it("nested if blocks", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
  - y = bool
---
> {% if x %}{% if y %}both{% else %}x only{% /if %}{% else %}{% if y %}y only{% else %}neither{% /if %}{% /if %}`);
    assert.strictEqual(tmpl.render({ x: true, y: true }).trim(), "both");
    assert.strictEqual(tmpl.render({ x: true, y: false }).trim(), "x only");
    assert.strictEqual(tmpl.render({ x: false, y: true }).trim(), "y only");
    assert.strictEqual(tmpl.render({ x: false, y: false }).trim(), "neither");
  });

  it("not keyword is not supported — use else branch instead", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
---
> {% if not x %}negated{% else %}normal{% /if %}`);
    // "not x" is treated as a variable name, which doesn't exist
    assert.throws(() => tmpl.render({ x: true }));
  });

  it("negation via else branch works correctly", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = bool
---
> {% if x %}normal{% else %}negated{% /if %}`);
    assert.strictEqual(tmpl.render({ x: true }).trim(), "normal");
    assert.strictEqual(tmpl.render({ x: false }).trim(), "negated");
  });
});

// ---------------------------------------------------------------------------
// Undefined variable errors
// ---------------------------------------------------------------------------

describe("Undefined variable errors (additional)", () => {
  it("throws on undeclared variable in expression at compile time", () => {
    // A fully-undeclared top-level variable is a compile-time error in both
    // backends (Rust's `check_undeclared` / TS's `checkUndeclaredVariables`),
    // so construction — not render — is where it is rejected.
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - x = str
---
{{ x }} {{ y }}`),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(
          err.message.includes("undeclared variable(s) referenced in body: y"),
        );
        return true;
      },
    );
  });

  it("throws on undefined nested field", () => {
    const tmpl = Template.fromSource(`---
params:
  - obj = struct(name = str)
---
{{ obj.nonexistent }}`);
    assert.throws(
      () => tmpl.render({ obj: { name: "hi" } }),
      UndefinedVariableError,
    );
  });
});

// ---------------------------------------------------------------------------
// Raw blocks comprehensive
// ---------------------------------------------------------------------------

describe("Raw block comprehensive (additional)", () => {
  it("raw block preserves template syntax literally", () => {
    const tmpl = Template.fromSource(`---
params: []
---
> {% raw %}{{ x }}{% /raw %}`);
    assert.strictEqual(tmpl.render({}).trim(), "{{ x }}");
  });

  it("raw block preserves statements literally", () => {
    const tmpl = Template.fromSource(`---
params: []
---
> {% raw %}{% if x %}yes{% /if %}{% /raw %}`);
    assert.strictEqual(tmpl.render({}).trim(), "{% if x %}yes{% /if %}");
  });
});

// ---------------------------------------------------------------------------
// Comments comprehensive
// ---------------------------------------------------------------------------

describe("Comment comprehensive (additional)", () => {
  it("comment block is omitted from output", () => {
    const tmpl = Template.fromSource(`---
params:
---
before{# this is a comment #}after`);
    const result = tmpl.render({});
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
    assert.ok(!result.includes("this is a comment"));
  });

  it("comment blockquote rules enforced", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: []
---
{# line start #}`),
      /blockquote prefix/,
    );
    assert.throws(
      () =>
        Template.fromSource(`---
params: []
---
> {#nospace#}`),
      /spaces around the content/,
    );
  });

  it("statement tag spacing enforced", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [x = bool]
---
> {%if x%}hello{%/if%}`),
      /Statement tags must have spaces around the content/,
    );
  });

  it("comment mixed with statement tag on same line", () => {
    const tmpl = Template.fromSource(`---
params: [flag = bool]
---
> {# comment explaining complex if #}{% if flag %}hello{% /if %}`);
    assert.strictEqual(tmpl.render({ flag: true }), "hello");
  });

  it("multiple comments on same line", () => {
    const tmpl = Template.fromSource(`---
params: [a = str, b = str]
---
> {# first comment: {{ a }} #}text{# second comment: {{ b }} #}`);
    assert.strictEqual(tmpl.render({ a: "1", b: "2" }), "text");
  });
});

// ---------------------------------------------------------------------------
// Value module comprehensive
// ---------------------------------------------------------------------------

describe("Value module comprehensive (additional)", () => {
  it("fromJs converts null to none", () => {
    const val = fromJs(null);
    assert.strictEqual(val.type, "none");
    assert.strictEqual(display(val), "");
  });

  it("fromJs converts undefined to none", () => {
    const val = fromJs(undefined);
    assert.strictEqual(val.type, "none");
    assert.strictEqual(display(val), "");
  });

  it("fromJs converts string", () => {
    const val = fromJs("hello");
    assert.strictEqual(val.type, "str");
    assert.strictEqual(display(val), "hello");
  });

  it("fromJs converts integer", () => {
    const val = fromJs(42);
    assert.strictEqual(val.type, "int");
    assert.strictEqual(display(val), "42");
  });

  it("fromJs converts float", () => {
    const val = fromJs(3.14);
    assert.strictEqual(val.type, "float");
    assert.strictEqual(display(val), "3.14");
  });

  it("fromJs converts boolean true", () => {
    const val = fromJs(true);
    assert.strictEqual(val.type, "bool");
    assert.strictEqual(isTruthy(val), true);
  });

  it("fromJs converts boolean false", () => {
    const val = fromJs(false);
    assert.strictEqual(val.type, "bool");
    assert.strictEqual(isTruthy(val), false);
  });

  it("fromJs converts array to list", () => {
    const val = fromJs([1, 2, 3]);
    assert.strictEqual(val.type, "list");
    assert.strictEqual(val.items.length, 3);
  });

  it("fromJs converts object to dict", () => {
    const val = fromJs({ a: 1, b: "two" });
    assert.strictEqual(val.type, "struct");
    assert.strictEqual(val.fields.size, 2);
  });

  it("display of list throws", () => {
    const val = fromJs([1, 2, 3]);
    assert.throws(() => display(val), /cannot display list/);
  });

  it("display of dict throws", () => {
    const val = fromJs({ a: 1, b: 2 });
    assert.throws(() => display(val), /cannot display struct/);
  });

  it("isTruthy: empty dict is falsy", () => {
    const val = fromJs({});
    assert.strictEqual(isTruthy(val), false);
  });

  it("isTruthy: non-empty dict is truthy", () => {
    const val = fromJs({ a: 1 });
    assert.strictEqual(isTruthy(val), true);
  });
});

// ---------------------------------------------------------------------------
// Transparent option(T) comprehensive tests
// ---------------------------------------------------------------------------

describe("Transparent option(T)", () => {
  it("null renders as empty string for option(str)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "[]");
  });

  it("undefined renders as empty string for option(str)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: undefined }).trim(), "[]");
  });

  it("value renders directly for option(str)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: "hello" }).trim(), "[hello]");
  });

  it("has() returns false for null option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "no");
  });

  it("has() returns true for present option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

yes

> {% else %}

no

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: "hello" }).trim(), "yes");
  });

  it("has() returns true for option value that is the string 'None'", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% else %}

absent

> {% /if %}`);
    // The string "None" is a valid string value, not the None variant
    const output = tmpl.render({ x: "None" }).trim();
    assert.strictEqual(output, "None");
  });

  it("kind() returns None for null option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "None");
  });

  it("kind() returns Some for present option", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
{{ kind(x) }}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "Some");
  });

  it("match works with option None", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

value: {{ x }}

> {% case None %}

absent

> {% /match %}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "absent");
  });

  it("match works with option Some", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

value: {{ x }}

> {% case None %}

absent

> {% /match %}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "value: 42");
  });

  it("option(int) accepts number values", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: 7 }).trim(), "7");
  });

  it("option(int) accepts null", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "[]");
  });

  it("option(float) accepts number values", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(float)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: 3.14 }).trim(), "3.14");
  });

  it("option(bool) accepts boolean values", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(bool)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render({ x: true }).trim(), "true");
  });

  it("option(bool) null renders empty", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(bool)
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "[]");
  });

  it("option in struct field — null", () => {
    const tmpl = Template.fromSource(`---
params:
  - person = struct(name = str, email = option(str))
---
> {% if has(person.email) %}

email: {{ person.email }}

> {% else %}

no email

> {% /if %}`);
    assert.strictEqual(
      tmpl.render({ person: { name: "Alice", email: null } }).trim(),
      "no email",
    );
  });

  it("option in struct field — present", () => {
    const tmpl = Template.fromSource(`---
params:
  - person = struct(name = str, email = option(str))
---
> {% if has(person.email) %}

email: {{ person.email }}

> {% else %}

no email

> {% /if %}`);
    assert.strictEqual(
      tmpl.render({ person: { name: "Alice", email: "a@b.com" } }).trim(),
      "email: a@b.com",
    );
  });

  it("option in list items", () => {
    const tmpl = Template.fromSource(`---
params:
  - items = list(name = str, note = option(str))
---
> {% for item in items %}
> {% if has(item.note) %}

{{ item.name }}: {{ item.note }}

> {% else %}

{{ item.name }}: (no note)

> {% /if %}
> {% /for %}`);
    const output = tmpl
      .render({
        items: [
          { name: "a", note: "hello" },
          { name: "b", note: null },
        ],
      })
      .trim();
    assert.ok(output.includes("a: hello"));
    assert.ok(output.includes("b: (no note)"));
  });

  it("throws on undefined variable in expression", () => {
    // Undeclared root variables are rejected at compile time (mirrors the Rust
    // core's `check_undeclared_variables`), so the error surfaces at
    // `fromSource` before `render` is ever reached.
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - x = str
---
{{ x }} {{ y }}`),
      (err: Error) => {
        assert.ok(err instanceof TemplateSyntaxError);
        assert.ok(err.message.includes("undeclared variable"));
        return true;
      },
    );
  });

  it("default None creates null in defaults()", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := None
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const defs = tmpl.defaults();
    assert.strictEqual(defs.x, null);
  });

  it("default value creates the value in defaults()", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str) := "hello"
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const defs = tmpl.defaults();
    assert.strictEqual(defs.x, "hello");
  });

  it("option(int) default renders correctly", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := 42
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.strictEqual(tmpl.render().trim(), "42");
  });

  it("option(int) default None renders empty", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int) := None
---
[{% if has(x) %}{{ x }}{% /if %}]`);
    assert.strictEqual(tmpl.render().trim(), "[]");
  });

  it("type checking rejects wrong type for option inner", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.throws(
      () => tmpl.render({ x: "not a number" }),
      (err: Error) => {
        assert.ok(err instanceof TypeMismatchError);
        return true;
      },
    );
  });

  it("type checking accepts null for option(int)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    assert.doesNotThrow(() => tmpl.render({ x: null }));
  });

  it("rejects option in bare condition at compile time", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - x = option(str)
---
> {% if x %}

yes

> {% else %}

no

> {% /if %}`),
      /cannot evaluate truthiness of option/,
    );
  });

  it("option roundtrip: declarations show option(T)", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% /if %}`);
    const decls = tmpl.declarations();
    assert.strictEqual(decls.length, 1);
    assert.strictEqual(defined(decls[0])[0], "x");
    assert.strictEqual(defined(decls[0])[1], "option(str)");
  });

  it("inline match with option Some", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

got: {{ x }}

> {% case None %}

> {% /match %}`);
    assert.strictEqual(tmpl.render({ x: 42 }).trim(), "got: 42");
    assert.strictEqual(tmpl.render({ x: null }).trim(), "");
  });

  it("match with else arm", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(int)
---
> {% match x %}

> {% case Some %}

{{ x }}

> {% else %}

default

> {% /match %}`);
    assert.strictEqual(tmpl.render({ x: null }).trim(), "default");
    assert.strictEqual(tmpl.render({ x: 99 }).trim(), "99");
  });

  it("rejects option in bare condition at compile time", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params:
  - x = option(str)
---
> {% if x %}

yes

> {% else %}

no

> {% /if %}`),
      /cannot evaluate truthiness of option/,
    );
  });

  it("option renderUnchecked with null", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% else %}

none

> {% /if %}`);
    assert.strictEqual(tmpl.renderUnchecked({ x: null }).trim(), "none");
  });

  it("option renderUnchecked with value", () => {
    const tmpl = Template.fromSource(`---
params:
  - x = option(str)
---
> {% if has(x) %}

{{ x }}

> {% else %}

none

> {% /if %}`);
    assert.strictEqual(tmpl.renderUnchecked({ x: "hi" }).trim(), "hi");
  });
});

// ===========================================================================
// Flow-sensitive narrowing tests
// ===========================================================================

describe("Flow-sensitive narrowing", () => {
  describe("has() narrows option(T) to T", () => {
    it("option(str) inside has() guard compiles and renders", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - x = option(str)
---
> {% if has(x) %}{{ x }}{% /if %}`,
      );
      assert.strictEqual(tmpl.render({ x: "hello" }).trim(), "hello");
    });

    it("option(int) inside has() guard compiles and renders", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - x = option(int)
---
> {% if has(x) %}{{ x }}{% /if %}`,
      );
      assert.strictEqual(tmpl.render({ x: 42 }).trim(), "42");
    });

    it("option(str) without has() guard is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - x = option(str)
---
{{ x }}`,
          ),
        /cannot display.*option/,
      );
    });

    it("option(int) without has() guard is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - x = option(int)
---
{{ x }}`,
          ),
        /cannot display.*option/,
      );
    });

    it("else branch does NOT narrow option", () => {
      // In the else branch of has(x), x is still option — not narrowed
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - x = option(str)
---
> {% if has(x) %}present{% else %}{{ x }}{% /if %}`,
          ),
        /cannot display.*option/,
      );
    });

    it("nested has() narrowing works", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - a = option(str)
  - b = option(int)
---
> {% if has(a) %}{% if has(b) %}{{ a }}-{{ b }}{% /if %}{% /if %}`,
      );
      assert.strictEqual(tmpl.render({ a: "x", b: 5 }).trim(), "x-5");
    });

    it("bare option condition is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - opt = option(str)
---
> {% if opt %}yes{% /if %}`,
          ),
        /cannot evaluate truthiness of option/,
      );
    });

    it("has(test) && test in same condition works due to left-to-right narrowing", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - test = option(str) := None
---
> {% if has(test) && test %}val: {{ test }}{% /if %}`,
      );
      assert.strictEqual(tmpl.render({}), "");
      assert.strictEqual(tmpl.render({ test: "" }), "");
      assert.strictEqual(tmpl.render({ test: "hello" }), "val: hello");
    });
  });

  describe("match narrows enum to matched variant", () => {
    it("enum field access inside match arm compiles", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected)
---
> {% match outcome %}
> {% case Confirmed %}

{{ outcome.evidence }}

> {% case Rejected %}

rejected

> {% /match %}`,
      );
      const result = tmpl.render({
        outcome: { __kind__: "Confirmed", evidence: "proof" },
      });
      assert.ok(result.includes("proof"), `got: ${result}`);
    });

    it("bare unit-variant enum compiles and renders", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - status = enum(Active, Inactive)
---
{{ status }}`,
      );
      assert.strictEqual(tmpl.render({ status: "Active" }).trim(), "Active");
    });

    it("bare struct-variant enum without match is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - status = enum(Active(reason = str), Inactive)
---
{{ status }}`,
          ),
        /cannot display.*enum/,
      );
    });

    it("kind() on enum is allowed without narrowing", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - status = enum(Active, Inactive)
---
{{ kind(status) }}`,
      );
      assert.ok(tmpl);
    });
  });

  describe("for-loop introduces element binding", () => {
    it("for-loop binding allows scalar element display", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - items = list(str)
---
> {% for item in items %}{{ item }} {% /for %}`,
      );
      const result = tmpl.render({ items: ["a", "b", "c"] });
      assert.ok(result.includes("a"), `got: ${result}`);
    });

    it("for-loop binding allows struct field access", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - items = list(name = str, score = int)
---
> {% for item in items %}{{ item.name }}: {{ item.score }} {% /for %}`,
      );
      const result = tmpl.render({ items: [{ name: "Alice", score: 95 }] });
      assert.ok(result.includes("Alice"), `got: ${result}`);
      assert.ok(result.includes("95"), `got: ${result}`);
    });

    it("bare list without for-loop is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - items = list(name = str)
---
{{ items }}`,
          ),
        /cannot display.*list/,
      );
    });
  });

  describe("struct displayability", () => {
    it("bare struct is compile error", () => {
      assert.throws(
        () =>
          Template.fromSource(
            `---
params:
  - config = struct(timeout = int, name = str)
---
{{ config }}`,
          ),
        /cannot display.*struct/,
      );
    });

    it("struct field access is allowed", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - config = struct(timeout = int, name = str)
---
{{ config.timeout }} {{ config.name }}`,
      );
      const result = tmpl.render({ config: { timeout: 30, name: "test" } });
      assert.ok(result.includes("30"), `got: ${result}`);
      assert.ok(result.includes("test"), `got: ${result}`);
    });
  });

  describe("filters skip displayability check", () => {
    it("list | join() passes compile-time check", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - items = list(str)
---
{{ items | join(", ") }}`,
      );
      assert.strictEqual(
        tmpl.render({ items: ["a", "b", "c"] }).trim(),
        "a, b, c",
      );
    });

    it("str | upper passes compile-time check", () => {
      const tmpl = Template.fromSource(
        `---
params:
  - name = str
---
{{ name | upper }}`,
      );
      assert.strictEqual(tmpl.render({ name: "hello" }).trim(), "HELLO");
    });
  });
});

// ---------------------------------------------------------------------------
// Collision and scope tests
// ---------------------------------------------------------------------------

describe("Collision and scope tests", () => {
  // ── 1. Const as param default ──────────────────────────────────────────

  describe("Const as param default", () => {
    it("local const as param default", () => {
      const tmpl = Template.fromSource(`---
consts:
  - MAX = int := 10

params:
  - count = int := MAX
---
{{ count }}`);
      // Without providing count, it should use the const default
      assert.strictEqual(tmpl.render().trim(), "10");
      // Providing count overrides the default
      assert.strictEqual(tmpl.render({ count: 42 }).trim(), "42");
    });

    it("imported const as param default", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-impconst-"));
      try {
        const childContent = `---
consts:
  - LIMIT = int := 100

params: [x = str]
---
{{ x }}`;
        fs.writeFileSync(path.join(dir, "Config.tmpl.md"), childContent);

        const tmpl = Template.fromSourceWithBaseDir(
          `---
imports:
  - "[Config](./Config.tmpl.md)"

params:
  - max_items = int := Config.LIMIT
---
{{ max_items }}`,
          dir,
        );
        assert.strictEqual(tmpl.render().trim(), "100");
        assert.strictEqual(tmpl.render({ max_items: 5 }).trim(), "5");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("rejects const default with type mismatch", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
consts:
  - NAME = str := "hello"

params:
  - count = int := NAME
---
{{ count }}`),
        (err: Error) =>
          err.message.includes("type") && err.message.includes("str"),
      );
    });
  });

  // ── 2. Param name shadows import stem (REJECTED) ─────────────────────

  describe("Param name shadows import stem", () => {
    it("rejects param whose PascalCase matches import stem", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-shadow-imp-"));
      try {
        const childContent = `---
params: [x = str]
---
{{ x }}`;
        fs.writeFileSync(path.join(dir, "Helper.tmpl.md"), childContent);

        assert.throws(
          () =>
            Template.fromSourceWithBaseDir(
              `---
imports:
  - "[Helper](./Helper.tmpl.md)"

params:
  - helper = str
---
{{ helper }}`,
              dir,
            ),
          (err: Error) => err.message.includes("shadows import"),
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("rejects const whose PascalCase matches import stem", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-shadow-cimp-"));
      try {
        const childContent = `---
params: [x = str]
---
{{ x }}`;
        fs.writeFileSync(path.join(dir, "Config.tmpl.md"), childContent);

        assert.throws(
          () =>
            Template.fromSourceWithBaseDir(
              `---
imports:
  - "[Config](./Config.tmpl.md)"

consts:
  - config = str := "val"
---
{{ config }}`,
              dir,
            ),
          (err: Error) => err.message.includes("shadows import"),
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  // ── 3. Param name shadows type alias (REJECTED unless type matches) ──

  describe("Param name shadows type alias", () => {
    it("rejects param PascalCase matching type alias with different type", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
types:
  - TaskList = list(title = str)

params:
  - task_list = str
---
{{ task_list }}`),
        (err: Error) => err.message.includes("conflicts with type alias"),
      );
    });

    it("rejects const PascalCase matching type alias with different type", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "types:",
              "  - MyItem = list(x = int)",
              "",
              "consts:",
              '  - my_item = str := "hello"',
              `---`,
              "{{ my_item }}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("conflicts with type alias"),
      );
    });

    it("allows param PascalCase matching type alias with SAME type", () => {
      const tmpl = Template.fromSource(`---
types:
  - CodeReview = list(title = str)

params:
  - code_review = CodeReview
---
> {% for item in code_review %}

{{ item.title }}

> {% /for %}`);
      const output = tmpl.render({
        code_review: [{ title: "PR #1" }],
      });
      assert.ok(output.includes("PR #1"));
    });
  });

  // ── 4. Param name shadows const name (REJECTED) ──────────────────────

  describe("Param name shadows const name", () => {
    it("rejects param and const with same name", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
consts:
  - limit = int := 5

params:
  - limit = int
---
{{ limit }}`),
        (err: Error) =>
          err.message.includes("conflicts with constant") ||
          err.message.includes("declared as both"),
      );
    });
  });

  // ── 5. Import stem shadows type alias (REJECTED) ─────────────────────

  describe("Import stem shadows type alias", () => {
    it("rejects type alias with same name as import stem", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "imports:",
              '  - "[Shared](./Shared.tmpl.md)"',
              "",
              "types:",
              "  - Shared = list(x = str)",
              "",
              "params:",
              "  - data = Shared",
              `---`,
              "> {% for item in data %}",
              "",
              "{{ item.x }}",
              "",
              "> {% /for %}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("shadows"),
      );
    });
  });

  // ── 6. Inline tmpl name shadows param/const (REJECTED) ───────────────

  describe("Inline tmpl name shadows param or const", () => {
    it("rejects inline template name colliding with param name", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "params:",
              "  - greeting = str",
              `---`,
              "> {% tmpl greeting %}",
              "",
              `---`,
              "",
              "params:",
              "",
              "- text = str",
              "",
              `---`,
              "",
              "{{ text }}",
              "",
              "> {% /tmpl %}",
              "",
              "{{ greeting }}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("inline template name conflicts"),
      );
    });

    it("rejects inline template name colliding with const name", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "consts:",
              '  - footer = str := "bye"',
              `---`,
              "> {% tmpl footer %}",
              "",
              `---`,
              "",
              "params:",
              "",
              "- text = str",
              "",
              `---`,
              "",
              "{{ text }}",
              "",
              "> {% /tmpl %}",
              "",
              "{{ footer }}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("inline template name conflicts"),
      );
    });
  });

  // ── 7. Inline tmpl name shadows import stem (REJECTED) ───────────────

  describe("Inline tmpl name shadows import stem", () => {
    it("rejects inline template name matching import stem", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "imports:",
              '  - "[Utils](./Utils.tmpl.md)"',
              "",
              "params:",
              "  - x = str",
              `---`,
              "> {% tmpl Utils %}",
              "",
              `---`,
              "",
              "params:",
              "",
              "- y = str",
              "",
              `---`,
              "",
              "{{ y }}",
              "",
              "> {% /tmpl %}",
              "",
              "{{ x }}",
            ].join("\n"),
          ),
        (err: Error) =>
          err.message.includes("inline template name conflicts with import"),
      );
    });
  });

  // ── 8. For-loop binding shadows declared name (REJECTED) ─────────────

  describe("For-loop binding shadows declared name", () => {
    it("rejects for binding that shadows a param", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
params:
  - item = str
  - items = list(str)
---
> {% for item in items %}

{{ item }}

> {% /for %}`),
        (err: Error) =>
          // Rust says "unused" (param 'item' is never referenced as a param,
          // only the loop binding is used). TS now matches this behavior.
          err.message.includes("unused") || err.message.includes("shadows"),
      );
    });

    it("rejects for binding that shadows a const", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
consts:
  - x = int := 1

params:
  - items = list(str)
---
> {% for x in items %}

{{ x }}

> {% /for %}`),
        (err: Error) => err.message.includes("shadows"),
      );
    });

    it("rejects for binding that shadows an import stem", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "imports:",
              '  - "[item](./item.tmpl.md)"',
              "",
              "params:",
              "  - items = list(str)",
              `---`,
              "> {% for item in items %}",
              "",
              "{{ item }}",
              "",
              "> {% /for %}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("shadows"),
      );
    });
  });

  // ── 9. Nested tmpl scope isolation ───────────────────────────────────

  describe("Nested tmpl scope isolation", () => {
    it("child tmpl with its own types works independently", () => {
      const src = [
        `---`,
        "params:",
        "  - items = list(name = str)",
        `---`,
        "> {% tmpl row %}",
        "",
        `---`,
        "",
        "params:",
        "",
        "- label = str",
        "",
        `---`,
        "",
        "[{{ label }}]",
        "",
        "> {% /tmpl %}",
        "> {% for item in items %}",
        "> {% include row with label=item.name %}",
        "> {% /for %}",
      ].join("\n");

      const tmpl = Template.fromSource(src);
      const result = tmpl.render({
        items: [{ name: "alpha" }, { name: "beta" }],
      });
      assert.ok(result.includes("[alpha]"), `expected [alpha] in: ${result}`);
      assert.ok(result.includes("[beta]"), `expected [beta] in: ${result}`);
    });

    it("parent type alias is NOT inherited by child tmpl", () => {
      // Parent declares a type alias. The child inline tmpl has its own
      // scope with only its own params — proving scope isolation.
      // We pass a variable (label) from the parent scope to the child.
      const src = [
        `---`,
        "types:",
        "  - Priority = enum(High, Low)",
        "",
        "params:",
        "  - p = Priority",
        "  - label = str",
        `---`,
        "> {% tmpl detail %}",
        "",
        `---`,
        "",
        "params:",
        "",
        "- msg = str",
        "",
        `---`,
        "",
        "Detail: {{ msg }}",
        "",
        "> {% /tmpl %}",
        "> {% match p %}",
        "> {% case High %}",
        "",
        "> {% include detail with msg=label %}",
        "",
        "> {% case Low %}",
        "",
        "> {% include detail with msg=label %}",
        "",
        "> {% /match %}",
      ].join("\n");

      const tmpl = Template.fromSource(src);
      const result = tmpl.render({ p: "High", label: "urgent" });
      assert.ok(
        result.includes("Detail: urgent"),
        `expected Detail: urgent in: ${result}`,
      );
    });

    it("inline tmpl with own consts can access them", () => {
      const src = [
        `---`,
        "params:",
        "  - name = str",
        `---`,
        "> {% tmpl greeting %}",
        "",
        `---`,
        "",
        "consts:",
        "",
        '  - PREFIX = str := "Hello"',
        "",
        "params:",
        "",
        "- who = str",
        "",
        `---`,
        "",
        "{{ PREFIX }}, {{ who }}!",
        "",
        "> {% /tmpl %}",
        "> {% include greeting with who=name %}",
      ].join("\n");

      const tmpl = Template.fromSource(src);
      const result = tmpl.render({ name: "world" });
      assert.ok(
        result.includes("Hello, world!"),
        `expected 'Hello, world!' in: ${result}`,
      );
    });

    it("inline tmpl consts shadow parent values", () => {
      const src = [
        `---`,
        "consts:",
        '  - LABEL = str := "outer"',
        "",
        "params:",
        "  - x = str",
        `---`,
        "> {% tmpl inner %}",
        "",
        `---`,
        "",
        "consts:",
        "",
        '  - LABEL = str := "inner"',
        "",
        "params:",
        "",
        "- val = str",
        "",
        `---`,
        "",
        "{{ LABEL }}:{{ val }}",
        "",
        "> {% /tmpl %}",
        "",
        "{{ LABEL }}",
        "",
        "> {% include inner with val=x %}",
      ].join("\n");

      const tmpl = Template.fromSource(src);
      const result = tmpl.render({ x: "test" });
      assert.ok(
        result.includes("outer"),
        `expected 'outer' from parent scope in: ${result}`,
      );
      assert.ok(
        result.includes("inner:test"),
        `expected 'inner:test' from child scope in: ${result}`,
      );
    });
  });

  // ── 10. Duplicate const names (REJECTED) ─────────────────────────────

  describe("Duplicate const names", () => {
    it("rejects duplicate constant names", () => {
      assert.throws(
        () =>
          Template.fromSource(`---
consts:
  - MAX = int := 10
  - MAX = int := 20

params:
  - x = str
---
{{ x }}`),
        (err: Error) => err.message.includes("duplicate"),
      );
    });
  });

  // ── 11. Const name conflicts with type alias ─────────────────────────

  describe("Const name conflicts with type alias", () => {
    it("rejects const whose PascalCase matches a non-enum type alias", () => {
      assert.throws(
        () =>
          Template.fromSource(
            [
              `---`,
              "types:",
              "  - MaxSize = list(x = int)",
              "",
              "consts:",
              '  - max_size = str := "big"',
              `---`,
              "{{ max_size }}",
            ].join("\n"),
          ),
        (err: Error) => err.message.includes("conflicts with type alias"),
      );
    });

    it("allows const matching enum type alias (enum auto-inject)", () => {
      // Enum type aliases are auto-injected as constants; a user-defined
      // constant with the same name just takes priority — not a conflict.
      const tmpl = Template.fromSource(`---
types:
  - Stage = enum(Design, Build)

consts:
  - Stage = str := "override"
---
{{ Stage }}`);
      const result = tmpl.render();
      assert.strictEqual(result, "override");
    });
  });
});

describe("Milestone 2 Enforcement", () => {
  it("accepts compound types with parens (...)", () => {
    const tmpl = Template.fromSource(`---
types:
  - MyStruct = struct(name = str)
  - MyEnum = enum(A, B)

params:
  - items = list(MyStruct)
  - opt = option(int)
---
{{ len(items) }}{% if has(opt) %}{{ opt }}{% /if %}`);
    assert.ok(tmpl);
  });

  it("rejects compound types with <...> or [...] throwing TemplateSyntaxError", () => {
    assert.throws(
      () =>
        Template.fromSource(`---
params: [x = list<str>]
---
{{ x }}`),
      (err: unknown) =>
        err instanceof TemplateSyntaxError &&
        err.message.includes("parentheses (...)"),
    );
    assert.throws(
      () =>
        Template.fromSource(`---
params: [x = list[str]]\n---
{{ x }}`),
      (err: unknown) =>
        err instanceof TemplateSyntaxError &&
        err.message.includes("parentheses (...)"),
    );
  });

  it("strips outer quotes in declaration lines in frontmatter", () => {
    const tmpl = Template.fromSource(`---
params:
  - "name = str"
  - 'count = int'
---
{{ name }}: {{ count }}`);
    assert.strictEqual(tmpl.render({ name: "test", count: 5 }), "test: 5");
  });

  it("enforces strict ./ or ../ prefixes for relative file includes", () => {
    assert.throws(
      () =>
        Template.fromSource(
          `---
params: []
---
> {% include [header](header.tmpl.md) %}`,
        ),
      (err: unknown) =>
        err instanceof TemplateSyntaxError &&
        err.message.includes("include path must begin with"),
    );
  });

  describe("Adversarial M2 features (in/not in & panic)", () => {
    it("handles unicode substring checks and empty string checks", () => {
      const tmpl = Template.fromSource(`---
params: [text = str, query = str]
---
> {% if query in text %}FOUND{% else %}MISSING{% /if %}`);
      assert.strictEqual(
        tmpl.render({ text: "Hello 🌍 World!", query: "🌍" }).trim(),
        "FOUND",
      );
      assert.strictEqual(
        tmpl.render({ text: "Hello", query: "" }).trim(),
        "FOUND",
      );
    });

    it("halts rendering on panic inside taken conditional branch", () => {
      const tmpl = Template.fromSource(`---
params: [trigger = bool]
---
> {% if trigger %}{% panic("Security violation: access denied") %}{% /if %}
SAFE`);
      assert.strictEqual(tmpl.render({ trigger: false }).trim(), "SAFE");
      assert.throws(
        () => tmpl.render({ trigger: true }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("Security violation"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Duck typing / structural typing — extra fields in struct values
// ---------------------------------------------------------------------------

describe("Duck typing / structural typing", () => {
  it("struct param with extra fields renders correctly", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}:{{ config.port }}`,
    );
    // Extra field "protocol" should be silently ignored
    const output = tmpl.render({
      config: { host: "localhost", port: 8080, protocol: "https" },
    });
    assert.strictEqual(output, "localhost:8080");
  });

  it("struct with many extra fields still renders declared fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - user = struct(name = str, active = bool)
---
{{ user.name }} is {{ user.active }}`,
    );
    const output = tmpl.render({
      user: {
        name: "Alice",
        active: true,
        email: "alice@example.com",
        age: 30,
        role: "admin",
      },
    });
    assert.strictEqual(output, "Alice is true");
  });

  it("list items with extra fields render correctly", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - tasks = list(title = str, priority = str)
---
> {% for task in tasks %}

- {{ task.title }} ({{ task.priority }})

> {% /for %}`,
    );
    const output = tmpl.render({
      tasks: [
        { title: "Write docs", priority: "High", assignee: "Alice", id: 1 },
        {
          title: "Add tests",
          priority: "Medium",
          status: "open",
          tags: ["test"],
        },
      ],
    });
    assert.ok(output.includes("Write docs"));
    assert.ok(output.includes("High"));
    assert.ok(output.includes("Add tests"));
    assert.ok(output.includes("Medium"));
    // Extra fields should not appear in output
    assert.ok(!output.includes("Alice"));
    assert.ok(!output.includes("assignee"));
  });

  it("type alias (types: block) with duck typing", () => {
    const tmpl = Template.fromSource(`---
types:
  - Config = struct(host = str, port = int)

params:
  - server = Config
---
{{ server.host }}:{{ server.port }}`);
    // Extra "timeout" field should be silently ignored
    const output = tmpl.render({
      server: { host: "example.com", port: 443, timeout: 30 },
    });
    assert.strictEqual(output, "example.com:443");
  });

  it("type alias list with extra fields in items", () => {
    const tmpl = Template.fromSource(`---
types:
  - Entry = struct(label = str, value = int)

params:
  - entries = list(Entry)
---
> {% for e in entries %}{{ e.label }}={{ e.value }} {% /for %}`);
    const output = tmpl.render({
      entries: [
        { label: "x", value: 10, color: "red" },
        { label: "y", value: 20, extra: true },
      ],
    });
    assert.ok(output.includes("x=10"));
    assert.ok(output.includes("y=20"));
  });

  it("nested struct with extra fields at every depth", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - outer = struct(inner = struct(value = str))
---
{{ outer.inner.value }}`,
    );
    const output = tmpl.render({
      outer: {
        inner: { value: "deep", extra_inner: 999, debug: true },
        extra_outer: "ignored",
        metadata: { foo: "bar" },
      },
    });
    assert.strictEqual(output, "deep");
  });

  it("deeply nested struct (3 levels) with extra fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - a = struct(b = struct(c = struct(name = str)))
---
{{ a.b.c.name }}`,
    );
    const output = tmpl.render({
      a: {
        b: {
          c: { name: "leaf", z: 42 },
          extra_b: "bval",
        },
        extra_a: "aval",
      },
    });
    assert.strictEqual(output, "leaf");
  });

  it("struct in conditional with extra fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - config = struct(enabled = bool, label = str)
---
> {% if config.enabled %}

{{ config.label }}

> {% /if %}`,
    );
    const output = tmpl.render({
      config: { enabled: true, label: "ON", priority: 1, debug: false },
    });
    assert.ok(output.includes("ON"));
  });

  it("struct with extra fields still rejects missing declared fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}:{{ config.port }}`,
    );
    // Has extra "protocol" but is missing required "port"
    assert.throws(
      () => tmpl.render({ config: { host: "localhost", protocol: "https" } }),
      (err: Error) => err.message.includes("missing"),
    );
  });

  it("list with nested struct items containing extra fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - items = list(meta = struct(key = str))
---
> {% for item in items %}{{ item.meta.key }} {% /for %}`,
    );
    const output = tmpl.render({
      items: [
        { meta: { key: "a", extra: true }, other: 1 },
        { meta: { key: "b", debug: "yes" }, tag: "x" },
      ],
    });
    assert.ok(output.includes("a"));
    assert.ok(output.includes("b"));
  });

  it("enum variant struct with extra fields", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - result = enum(Ok(value = str), Err)
---
> {% match result %}
> {% case Ok %}

{{ result.value }}

> {% case Err %}

error

> {% /match %}`,
    );
    // Extra "code" field on the Ok variant should be silently ignored
    const output = tmpl.render({
      result: { __kind__: "Ok", value: "success", code: 200 },
    });
    assert.ok(output.trim().includes("success"));
  });
});

// ---------------------------------------------------------------------------
// Duck typing — include with partial struct (child uses subset of fields)
// ---------------------------------------------------------------------------

describe("Duck typing — include with partial struct", () => {
  it("include child that declares subset of parent struct fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-duck-inc-"));
    try {
      // Child only declares "name" but parent passes a struct with name + age
      fs.writeFileSync(
        path.join(dir, "child.tmpl.md"),
        `---
params:
  - user = struct(name = str)
---
Hello {{ user.name }}`,
      );
      const src = [
        `---`,
        "params:",
        "  - user = struct(name = str, age = int)",
        `---`,
        "> {% include [child](./child.tmpl.md) with user=user %}",
      ].join("\n");
      const tmpl = Template.fromSourceWithBaseDir(src, dir);
      const result = tmpl.render({
        user: { name: "Alice", age: 30 },
      });
      assert.ok(
        result.includes("Hello Alice"),
        `expected 'Hello Alice' but got: ${result}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("for-each include where child uses subset of list item fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-duck-for-"));
    try {
      // Child only declares name (subset of name + score)
      fs.writeFileSync(
        path.join(dir, "row.tmpl.md"),
        `---
params:
  - item = struct(name = str)
---
- {{ item.name }}`,
      );
      const mainSrc = [
        `---`,
        "params:",
        "  - items = list(name = str, score = int)",
        `---`,
        "> {% include [row](./row.tmpl.md) for item in items %}",
      ].join("\n");
      const tmpl = Template.fromSourceWithBaseDir(mainSrc, dir);
      const result = tmpl.render({
        items: [
          { name: "Alpha", score: 100, extra: "ignored" },
          { name: "Beta", score: 200, debug: true },
        ],
      });
      assert.ok(result.includes("Alpha"), `missing Alpha in: ${result}`);
      assert.ok(result.includes("Beta"), `missing Beta in: ${result}`);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("include child with extra fields on value passed to subset struct", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-duck-extra-"));
    try {
      // Child declares struct with 1 field
      fs.writeFileSync(
        path.join(dir, "detail.tmpl.md"),
        `---
params:
  - info = struct(title = str)
---
Title: {{ info.title }}`,
      );
      const src = [
        `---`,
        "params:",
        "  - info = struct(title = str, author = str, year = int)",
        `---`,
        "> {% include [detail](./detail.tmpl.md) with info=info %}",
        "",
        "By: {{ info.author }} ({{ info.year }})",
      ].join("\n");
      const tmpl = Template.fromSourceWithBaseDir(src, dir);
      const result = tmpl.render({
        info: { title: "The Book", author: "Jane", year: 2025, isbn: "123" },
      });
      assert.ok(
        result.includes("Title: The Book"),
        `expected title in: ${result}`,
      );
      assert.ok(result.includes("By: Jane"), `expected author in: ${result}`);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Match / Case on strings (quoted case labels)
// ---------------------------------------------------------------------------

describe("Match on strings (quoted case labels)", () => {
  it("matches a multi-arm string match", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - status = str",
        `---`,
        `> {% match status %}`,
        `> {% case "Active" %}`,
        "",
        "currently active",
        "",
        `> {% case "Paused" %}`,
        "",
        "on hold",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(
      tmpl.render({ status: "Active" }).trim(),
      "currently active",
    );
    assert.strictEqual(tmpl.render({ status: "Paused" }).trim(), "on hold");
  });

  it("inline match with quoted case", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - role = str
---
> {% match role case "Admin" %}admin panel{% /match %}`,
    );
    assert.strictEqual(tmpl.render({ role: "Admin" }).trim(), "admin panel");
    assert.strictEqual(tmpl.render({ role: "User" }).trim(), "");
  });

  it("multi-value string arm", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - level = str",
        `---`,
        `> {% match level %}`,
        `> {% case "High" | "Critical" %}`,
        "",
        "urgent",
        "",
        `> {% case "Low" %}`,
        "",
        "fine",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ level: "High" }).trim(), "urgent");
    assert.strictEqual(tmpl.render({ level: "Critical" }).trim(), "urgent");
    assert.strictEqual(tmpl.render({ level: "Low" }).trim(), "fine");
  });

  it("string match with else fallback", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - color = str",
        `---`,
        `> {% match color %}`,
        `> {% case "red" %}`,
        "",
        "stop",
        "",
        `> {% case "green" %}`,
        "",
        "go",
        "",
        `> {% else %}`,
        "",
        "unknown color",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ color: "red" }).trim(), "stop");
    assert.strictEqual(tmpl.render({ color: "green" }).trim(), "go");
    assert.strictEqual(tmpl.render({ color: "blue" }).trim(), "unknown color");
  });

  it("single-quoted string case labels", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - mode = str",
        `---`,
        `> {% match mode %}`,
        `> {% case 'fast' %}`,
        "",
        "speed mode",
        "",
        `> {% case 'slow' %}`,
        "",
        "safe mode",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ mode: "fast" }).trim(), "speed mode");
    assert.strictEqual(tmpl.render({ mode: "slow" }).trim(), "safe mode");
  });
});

// ---------------------------------------------------------------------------
// Match type safety — compile-time errors for str↔enum confusion
// ---------------------------------------------------------------------------

describe("Match type safety (compile-time)", () => {
  it("allows unquoted case labels on str param (matches literally)", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - status = str",
        `---`,
        `> {% match status %}`,
        `> {% case Active %}`,
        "",
        "active",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ status: "Active" }).trim(), "active");
    assert.strictEqual(tmpl.render({ status: "Other" }).trim(), "");
  });

  it("allows unquoted inline case on str param (matches literally)", () => {
    const tmpl = Template.fromSource(
      `---
params:
  - role = str
---
> {% match role case Admin %}admin{% /match %}`,
    );
    assert.strictEqual(tmpl.render({ role: "Admin" }).trim(), "admin");
    assert.strictEqual(tmpl.render({ role: "User" }).trim(), "");
  });

  it("counts an unquoted case label that matches a declared param as a reference", () => {
    // `{% case expected %}` on a str match reads the param `expected`'s value
    // at runtime for comparison — the param IS used. The collector must count
    // it, so no `allow_unused` is needed and no unused-param error is thrown.
    const tmpl = Template.fromSource(
      `---
params:
  - status = str
  - expected = str
---
> {% match status %}{% case expected %}matched{% else %}nope{% /match %}`,
    );
    // Runtime: param-ref match — `expected`'s value is compared to `status`.
    assert.strictEqual(
      tmpl.render({ status: "Active", expected: "Active" }).trim(),
      "matched",
    );
    assert.strictEqual(
      tmpl.render({ status: "Active", expected: "Paused" }).trim(),
      "nope",
    );
  });

  it("rejects quoted case labels on enum param", () => {
    assert.throws(
      () =>
        Template.fromSource(
          [
            `---`,
            "params:",
            "  - status = enum(Active, Inactive)",
            `---`,
            `> {% match status %}`,
            `> {% case "Active" %}`,
            "",
            "active",
            "",
            `> {% /match %}`,
          ].join("\n"),
        ),
      (err: Error) =>
        err.message.includes("quoted string") &&
        err.message.includes("enum variants"),
    );
  });

  it("allows unquoted case labels on enum param", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - status = enum(Active, Inactive)",
        `---`,
        `> {% match status %}`,
        `> {% case Active %}`,
        "",
        "on",
        "",
        `> {% case Inactive %}`,
        "",
        "off",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ status: "Active" }).trim(), "on");
  });

  it("allows quoted case labels on str param", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - role = str",
        `---`,
        `> {% match role %}`,
        `> {% case "Admin" %}`,
        "",
        "admin",
        "",
        `> {% case "User" %}`,
        "",
        "user",
        "",
        `> {% /match %}`,
      ].join("\n"),
    );
    assert.strictEqual(tmpl.render({ role: "Admin" }).trim(), "admin");
  });
});

// ---------------------------------------------------------------------------
// Higher-order templates (tmpl() with actual Template refs)
// ---------------------------------------------------------------------------

describe("Higher-order templates — basic tmpl() param passing", () => {
  it("passes a Template as a tmpl() param and renders via include", () => {
    const child = Template.fromSource(`---
params:
  - msg = str
---
Child: {{ msg }}`);
    const parent = Template.fromSource(`---
params:
  - sub = tmpl(msg = str)
  - greeting = str
---
> {% include sub with msg=greeting %}`);
    const result = parent.render({ sub: child, greeting: "hello" });
    assert.ok(
      result.includes("Child: hello"),
      `expected 'Child: hello' in: ${result}`,
    );
  });

  it("passes a Template with multiple params", () => {
    const child = Template.fromSource(`---
params:
  - name = str
  - count = int
---
{{ name }}: {{ count }}`);
    const parent = Template.fromSource(`---
params:
  - renderer = tmpl(name = str, count = int)
  - user = str
  - n = int
---
> {% include renderer with name=user, count=n %}`);
    const result = parent.render({ renderer: child, user: "Alice", n: 42 });
    assert.ok(
      result.includes("Alice: 42"),
      `expected 'Alice: 42' in: ${result}`,
    );
  });
});

describe("Higher-order templates — signature matching", () => {
  it("accepts Template with matching signature", () => {
    const child = Template.fromSource(`---
params:
  - x = str
---
{{ x }}`);
    const parent = Template.fromSource(`---
params:
  - cb = tmpl(x = str)
  - val = str
---
> {% include cb with x=val %}`);
    // Should not throw
    const result = parent.render({ cb: child, val: "ok" });
    assert.ok(result.includes("ok"));
  });

  it("rejects Template with wrong param type", () => {
    const child = Template.fromSource(`---
params:
  - x = int
---
{{ x }}`);
    const parent = Template.fromSource(`---
params:
  - cb = tmpl(x = str)
  - val = str
---
> {% include cb with x=val %}`);
    assert.throws(
      () => parent.render({ cb: child, val: "ok" }),
      (err: Error) =>
        err.message.includes("x") &&
        (err.message.includes("str") || err.message.includes("int")),
    );
  });

  it("accepts Template with extra param that has a default (signature only)", () => {
    const child = Template.fromSource(`---
params:
  - x = str
  - extra = str := "default"
---
{{ x }}-{{ extra }}`);
    const parent = Template.fromSource(`---
params:
  - cb = tmpl(x = str)
  - val = str
---
> {% include cb with x=val %}`);
    // Signature check should accept the child: 'extra' has a default so it
    // doesn't violate the tmpl(x = str) contract. We only verify that
    // type-checking passes — rendering may fail because renderForInclude
    // doesn't auto-fill child defaults for unmapped params.
    // Use buildContext indirectly via the type-checking path.
    assert.doesNotThrow(() => {
      // We can verify the child is accepted as a TmplRef by the parent's
      // type-checking. If signature validation fails it throws during render.
      // We catch the *render* error (undefined variable) but not type errors.
      try {
        parent.render({ cb: child, val: "ok" });
      } catch (err: unknown) {
        // Render error for 'extra' is expected — it's not mapped in the include.
        // But a TypeMismatchError would mean signature check failed.
        if (err instanceof Error && err.name === "TypeMismatchError") {
          throw err;
        }
        // Non-type errors (like UndefinedVariableError) are fine — signature passed.
      }
    });
  });

  it("rejects Template with extra required param (no default)", () => {
    const child = Template.fromSource(`---
params:
  - x = str
  - extra = str
---
{{ x }}-{{ extra }}`);
    const parent = Template.fromSource(`---
params:
  - cb = tmpl(x = str)
  - val = str
---
> {% include cb with x=val %}`);
    assert.throws(
      () => parent.render({ cb: child, val: "ok" }),
      (err: Error) => err.message.includes("extra"),
    );
  });
});

describe("Higher-order templates — empty signature tmpl()", () => {
  it("accepts Template with no params for tmpl()", () => {
    const child = Template.fromSource(`---
params: []
---
Static content`);
    const parent = Template.fromSource(`---
params:
  - cb = tmpl()
---
> {% include cb %}`);
    const result = parent.render({ cb: child });
    assert.ok(
      result.includes("Static content"),
      `expected 'Static content' in: ${result}`,
    );
  });
});

describe("Higher-order templates — option(tmpl(...)) Some and None", () => {
  it("renders Some with actual Template ref", () => {
    const child = Template.fromSource(`---
params:
  - msg = str
---
From child: {{ msg }}`);
    const parent = Template.fromSource(`---
params:
  - cb = option(tmpl(msg = str))
  - val = str
---
> {% if has(cb) %}
> {% include cb with msg=val %}
> {% else %}

no callback

> {% /if %}`);
    const result = parent.render({ cb: child, val: "hi" });
    assert.ok(
      result.includes("From child: hi"),
      `expected 'From child: hi' in: ${result}`,
    );
  });

  it("renders None path when cb is null", () => {
    const parent = Template.fromSource(`---
params:
  - cb = option(tmpl(msg = str))
  - val = str
---
> {% if has(cb) %}
> {% include cb with msg=val %}
> {% else %}

no callback

> {% /if %}`);
    const result = parent.render({ cb: null, val: "hi" });
    assert.ok(
      result.includes("no callback"),
      `expected 'no callback' in: ${result}`,
    );
    assert.ok(
      !result.includes("From child"),
      `should not contain child output`,
    );
  });
});

describe("Higher-order templates — nested: tmpl param uses file include", () => {
  it("child template with file include renders through tmpl param", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-hot-nested-"));
    try {
      // Create a grandchild template on disk
      const grandchildPath = path.join(dir, "grandchild.tmpl.md");
      fs.writeFileSync(
        grandchildPath,
        `---
params:
  - label = str
---
[{{ label }}]`,
      );

      // Create child template on disk that includes grandchild
      const childPath = path.join(dir, "child.tmpl.md");
      fs.writeFileSync(
        childPath,
        `---
params:
  - title = str
---
> {% include [grandchild](./grandchild.tmpl.md) with label=title %}`,
      );

      // Load child via fromFile so it has a base path for includes
      const child = Template.fromFile(childPath);

      // Create parent that accepts a tmpl param
      const parent = Template.fromSource(`---
params:
  - renderer = tmpl(title = str)
  - heading = str
---
> {% include renderer with title=heading %}`);

      const result = parent.render({ renderer: child, heading: "Nested" });
      assert.ok(
        result.includes("[Nested]"),
        `expected '[Nested]' in: ${result}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("Higher-order templates — for-each with tmpl include", () => {
  it("iterates list items through a tmpl param include", () => {
    const row = Template.fromSource(`---
params:
  - item = struct(name = str)
---
- {{ item.name }}
`);
    const parent = Template.fromSource(`---
params:
  - renderer = tmpl(item = struct(name = str))
  - items = list(name = str)
---
> {% include renderer for item in items %}`);
    const result = parent.render({
      renderer: row,
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });
    assert.ok(result.includes("- A"), `missing A in: ${result}`);
    assert.ok(result.includes("- B"), `missing B in: ${result}`);
    assert.ok(result.includes("- C"), `missing C in: ${result}`);
  });
});

describe("Higher-order templates — constants passed through tmpl param", () => {
  it("child template accesses its own constants when rendered via tmpl", () => {
    const child = Template.fromSource(`---
params:
  - name = str

consts:
  - VER = str := "child-1.0"
---
{{ name }} v{{ VER }}`);
    const parent = Template.fromSource(`---
params:
  - renderer = tmpl(name = str)
  - user = str

consts:
  - APP = str := "app-2.0"
---
> {% include renderer with name=user %}`);
    const result = parent.render({ renderer: child, user: "Alice" });
    // Child's own consts should work
    assert.ok(result.includes("Alice"), `expected 'Alice' in: ${result}`);
    assert.ok(
      result.includes("child-1.0"),
      `expected child const 'child-1.0' in: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Higher-order templates — nested tmpl: tmpl(target = tmpl(val = str))
// ---------------------------------------------------------------------------

describe("Higher-order templates — nested tmpl param forwarding", () => {
  it("forwards a tmpl() param through another tmpl() via include", () => {
    // inner: the leaf template
    const inner = Template.fromSource(`---
params: [val = str]
---
Inner: {{ val }}`);

    // middle: accepts a tmpl() and includes it
    const middle = Template.fromSource(`---
params:
  - target = tmpl(val = str)
  - value = str
---
> {% include target with val=value %}`);

    // main: declares nested tmpl signature: tmpl(target = tmpl(...), value = str)
    const main = Template.fromSource(`---
params:
  - processor = tmpl(target = tmpl(val = str), value = str)
  - callback = tmpl(val = str)
---
> {% include processor with target=callback, value="Success" %}`);

    const result = main.render({ processor: middle, callback: inner });
    assert.ok(
      result.includes("Inner: Success"),
      `expected 'Inner: Success' in: ${result}`,
    );
  });

  it("rejects nested tmpl with wrong inner signature", () => {
    // inner: has x = int, not val = str
    const inner = Template.fromSource(`---
params: [x = int]
---
{{ x }}`);

    // middle: expects target = tmpl(val = str)
    const middle = Template.fromSource(`---
params:
  - target = tmpl(val = str)
  - value = str
---
> {% include target with val=value %}`);

    const main = Template.fromSource(`---
params:
  - processor = tmpl(target = tmpl(val = str), value = str)
  - callback = tmpl(val = str)
---
> {% include processor with target=callback, value="hi" %}`);

    // inner doesn't match tmpl(val = str) — it has x = int
    assert.throws(
      () => main.render({ processor: middle, callback: inner }),
      (err: Error) => err.message.includes("val") || err.message.includes("x"),
    );
  });
});

describe("Higher-order templates — deeply nested option(tmpl(option(tmpl(...))))", () => {
  it("renders with all levels present", () => {
    // inner leaf
    const innerTmpl = Template.fromSource(`---
params: [test = str]
---
Leaf: {{ test }}`);

    // middle: has an option(tmpl(...)) param
    const middleTmpl = Template.fromSource(`---
params: [sub = option(tmpl(test = str))]
---
> {% if has(sub) %}
> {% include sub with test="NestedOK" %}
> {% else %}

No sub

> {% /if %}`);

    // main: option(tmpl(sub = option(tmpl(test = str))))
    const mainTmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(sub = option(tmpl(test = str))))
  - target = option(tmpl(test = str))
---
> {% if has(cb) %}
> {% include cb with sub=target %}
> {% else %}

No cb

> {% /if %}`);

    const result = mainTmpl.render({ cb: middleTmpl, target: innerTmpl });
    assert.ok(
      result.includes("Leaf: NestedOK"),
      `expected 'Leaf: NestedOK' in: ${result}`,
    );
  });

  it("renders None at outer level", () => {
    const mainTmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(sub = option(tmpl(test = str))))
  - target = option(tmpl(test = str))
---
> {% if has(cb) %}
> {% include cb with sub=target %}
> {% else %}

No cb

> {% /if %}`);

    const result = mainTmpl.render({ cb: null, target: null });
    assert.ok(result.includes("No cb"), `expected 'No cb' in: ${result}`);
  });

  it("renders None at inner level", () => {
    const middleTmpl = Template.fromSource(`---
params: [sub = option(tmpl(test = str))]
---
> {% if has(sub) %}
> {% include sub with test="inner" %}
> {% else %}

No sub

> {% /if %}`);

    const mainTmpl = Template.fromSource(`---
params:
  - cb = option(tmpl(sub = option(tmpl(test = str))))
  - target = option(tmpl(test = str))
---
> {% if has(cb) %}
> {% include cb with sub=target %}
> {% else %}

No cb

> {% /if %}`);

    // cb present but target is null → inner "No sub" path
    const result = mainTmpl.render({ cb: middleTmpl, target: null });
    assert.ok(result.includes("No sub"), `expected 'No sub' in: ${result}`);
  });
});

describe("Higher-order templates — tmpl inside struct field", () => {
  it("struct(widget = tmpl(x = str)) passes and renders", () => {
    const widget = Template.fromSource(`---
params: [x = str]
---
Widget: {{ x }}`);

    const main = Template.fromSource(`---
params:
  - config = struct(widget = tmpl(x = str), label = str)
---
{{ config.label }}: {% include config.widget with x=config.label %}`);

    const result = main.render({
      config: { widget, label: "Test" },
    });
    assert.ok(
      result.includes("Widget: Test"),
      `expected 'Widget: Test' in: ${result}`,
    );
  });
});

// ---------------------------------------------------------------------------
// API review findings — behavior-change coverage
// ---------------------------------------------------------------------------

describe("API review: public exports", () => {
  it("exposes the preferred struct value constructor structVal", () => {
    const v = structVal([
      ["a", str("x")],
      ["n", int(1)],
    ]);
    assert.strictEqual(v.type, "struct");
    assert.strictEqual(v.fields.get("a")?.type, "str");
    assert.strictEqual(v.fields.get("n")?.type, "int");
  });

  it("keeps the deprecated dict alias pointing at structVal", () => {
    assert.strictEqual(dict, structVal);
    // DictValue is a deprecated alias of StructValue — assignable both ways.
    const asDict: DictValue = dict([["k", str("v")]]);
    const asStruct: StructValue = asDict;
    assert.strictEqual(asStruct.fields.get("k")?.type, "str");
  });

  it("exposes the full error hierarchy as constructors", () => {
    assert.strictEqual(typeof TemplatePanicError, "function");
    assert.strictEqual(typeof IncludeNotFoundError, "function");
    assert.strictEqual(typeof DeclarationsMutatedError, "function");
    assert.ok(new TemplatePanicError("x") instanceof TemplateError);
    assert.ok(new IncludeNotFoundError("x") instanceof TemplateError);
    assert.ok(new DeclarationsMutatedError("x") instanceof TemplateError);
  });
});

describe("API review: typed error classes", () => {
  it("IncludeNotFoundError carries the unresolved include path", () => {
    const err = new IncludeNotFoundError("./missing.tmpl.md");
    assert.strictEqual(err.name, "IncludeNotFoundError");
    assert.strictEqual(err.include, "./missing.tmpl.md");
    assert.ok(err.message.includes("include not found"));
    assert.ok(err.message.includes("./missing.tmpl.md"));
  });

  it("DeclarationsMutatedError carries details and clear message", () => {
    const err = new DeclarationsMutatedError("param 'x' retyped");
    assert.strictEqual(err.name, "DeclarationsMutatedError");
    assert.strictEqual(err.details, "param 'x' retyped");
    assert.ok(err.message.includes("declarations were modified"));
    assert.ok(err.message.includes("param 'x' retyped"));
  });

  it("TemplatePanicError is thrown when {% panic %} executes", () => {
    const tmpl = Template.fromSource(`---
params: [trigger = bool]
---
> {% if trigger %}{% panic("boom") %}{% /if %}
SAFE`);
    assert.strictEqual(tmpl.render({ trigger: false }).trim(), "SAFE");
    assert.throws(
      () => tmpl.render({ trigger: true }),
      (err: Error) =>
        err instanceof TemplatePanicError && err.message.includes("boom"),
    );
  });
});

describe("API review: renderEmpty typed error", () => {
  it("throws MissingParamsError listing every required param", () => {
    const tmpl = Template.fromSource(`---
params: [name = str, age = int]
---
{{ name }} {{ age }}`);
    assert.throws(
      () => tmpl.renderEmpty(),
      (err: Error) =>
        err instanceof MissingParamsError &&
        err.missing.includes("name") &&
        err.missing.includes("age"),
    );
  });

  it("renders successfully when all params have defaults", () => {
    const tmpl = Template.fromSource(`---
params:
  - greeting = str := "Hi"
---
{{ greeting }}!`);
    assert.strictEqual(tmpl.renderEmpty().trim(), "Hi!");
  });
});

describe("API review: variant __kind__ convergence", () => {
  it("round-trips through match and isVariant", () => {
    const Status = defineVariants({
      Approved: null,
      NeedsChanges: ["reason"],
    });
    const nc = Status.NeedsChanges({ reason: "fix" });
    assert.strictEqual(nc.__kind__, "NeedsChanges");
    assert.ok(isVariant(nc, "NeedsChanges"));
    assert.ok(!isVariant(nc, "Approved"));
    assert.strictEqual(
      match(nc, {
        Approved: () => "ok",
        NeedsChanges: (v) => `changes: ${String(v.reason)}`,
      }),
      "changes: fix",
    );
  });

  it("plain { __kind__ } objects (codegen shape) also match", () => {
    const plain = { __kind__: "Approved" };
    assert.ok(isVariant(plain, "Approved"));
    assert.strictEqual(
      match(plain, { Approved: () => "a", _: () => "?" }),
      "a",
    );
  });

  it("renders a __kind__ struct passed as a param", () => {
    const tmpl = Template.fromSource(
      [
        `---`,
        "params:",
        "  - outcome = enum(Approved, NeedsChanges(reason = str))",
        `---`,
        "> {% match outcome %}",
        "> {% case Approved %}",
        "",
        "Approved",
        "",
        "> {% case NeedsChanges %}",
        "",
        "Needs: {{ outcome.reason }}",
        "",
        "> {% /match %}",
      ].join("\n"),
    );
    const out = tmpl.render({
      outcome: { __kind__: "NeedsChanges", reason: "tests" },
    });
    assert.ok(out.includes("Needs: tests"), `got: ${out}`);
  });
});

describe("API review: allowUnused compile option", () => {
  const SRC = `---
params: [used = str, unused = str]
---
{{ used }}`;

  it("rejects unused declared params by default", () => {
    assert.throws(
      () => Template.fromSource(SRC),
      (err: Error) =>
        err instanceof TemplateSyntaxError && err.message.includes("unused"),
    );
  });

  it("honors allowUnused: true via fromSourceWithOptions", () => {
    const tmpl = Template.fromSourceWithOptions(SRC, { allowUnused: true });
    assert.strictEqual(tmpl.render({ used: "x", unused: "y" }).trim(), "x");
  });
});

describe("API review: fromSourceWithEnv flat signature", () => {
  const SRC = `---
env: [region = str]

params: [name = str]
---
{{ name }} @ {{ region }}`;

  it("accepts a flat env record (WASM-consistent signature)", () => {
    const tmpl = Template.fromSourceWithEnv(SRC, { region: "us" });
    assert.strictEqual(tmpl.render({ name: "svc" }).trim(), "svc @ us");
  });

  it("defaults env to an empty object", () => {
    const tmpl = Template.fromSourceWithEnv(`---
params: [name = str]
---
Hi {{ name }}`);
    assert.strictEqual(tmpl.render({ name: "x" }).trim(), "Hi x");
  });
});

describe("API review: Context render path", () => {
  it("renderContext renders using a pre-built Context", () => {
    const tmpl = Template.fromSource(`---
params: [name = str]
---
Hello {{ name }}!`);
    const ctx = Context.from({ name: "world" });
    assert.strictEqual(tmpl.renderContext(ctx).trim(), "Hello world!");
  });

  it("renderContext reuses raw Values set via setRaw", () => {
    const tmpl = Template.fromSource(`---
params: [count = int]
---
Count: {{ count }}`);
    const ctx = new Context();
    ctx.setRaw("count", int(42));
    assert.strictEqual(tmpl.renderContext(ctx).trim(), "Count: 42");
  });
});

describe("API review: codegen single canonical all-variants constant", () => {
  const SRC = `---
params: [stage = enum(Design, Build, Ship)]
---
{{ stage }}`;

  it("exposes all variants exactly once via the namespace `kinds` tuple", () => {
    const code = generateTypes(SRC);
    // The `kinds` tuple is the single canonical enumeration of variant names.
    const kindsMatches = code.match(/\bkinds:/g) ?? [];
    assert.strictEqual(
      kindsMatches.length,
      1,
      `expected exactly one 'kinds' tuple in:\n${code}`,
    );
    assert.ok(
      code.includes('kinds: ["Design", "Build", "Ship"] as const,'),
      `expected canonical 'kinds' tuple in:\n${code}`,
    );
    // The legacy flat aliases must be gone.
    assert.ok(!/\bSTAGE_ALL\b/.test(code), "STAGE_ALL alias should be gone");
    assert.ok(!/\bALL_STAGES\b/.test(code), "ALL_STAGES alias should be gone");
    assert.ok(!/\bconst\s+STAGES\b/.test(code), "STAGES alias should be gone");
  });
});

describe("Condition Truthiness and Type Checking", () => {
  it("accepts scalar str in condition and evaluates truthiness", () => {
    const src = `---
params:
  - name = str
---
> {% if name %}hello {{ name }}{% /if %}`;
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ name: "" }), "");
    assert.strictEqual(tmpl.render({ name: "Alice" }), "hello Alice");
  });

  it("accepts scalar int in condition and evaluates non-zero truthiness", () => {
    const src = `---
params:
  - count = int
---
> {% if count %}yes{% else %}no{% /if %}`;
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ count: 0 }), "no");
    assert.strictEqual(tmpl.render({ count: 5 }), "yes");
  });

  it("rejects option(str) in bare condition at compile time", () => {
    const src = `---
params:
  - opt = option(str) := None
---
> {% if opt %} · {{ opt }}{% /if %}`;
    assert.throws(
      () => Template.fromSource(src),
      /cannot evaluate truthiness of option/,
    );
  });

  it("accepts list in bare condition for non-empty truthiness check", () => {
    const src = `---
params:
  - items = list(str)
---
> {% if items %}items present{% else %}empty{% /if %}`;
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ items: [] }), "empty");
    assert.strictEqual(tmpl.render({ items: ["a"] }), "items present");
  });

  it("rejects has() on non-option types (str, list, int, struct) at compile time", () => {
    const srcStr = `---
params:
  - title = str
---
> {% if has(title) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcStr),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );

    const srcList = `---
params:
  - items = list(str)
---
> {% if has(items) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcList),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );

    const srcInt = `---
params:
  - count = int
---
> {% if has(count) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcInt),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );

    const srcStruct = `---
params:
  - info = struct(id = int)
---
> {% if has(info) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcStruct),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );

    const srcTmpl = `---
params:
  - t = tmpl()
---
> {% if has(t) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcTmpl),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );

    const srcEnum = `---
params:
  - stage = enum(Design, Build)
---
> {% if has(stage) %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcEnum),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("'has()' requires an option type"),
    );
  });

  it("rejects bare struct, enum, or tmpl in a condition (no truthiness)", () => {
    const srcStruct = `---
params:
  - info = struct(id = int)
---
> {% if info %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcStruct),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("cannot evaluate truthiness of struct"),
    );

    const srcEnum = `---
params:
  - stage = enum(Design, Build)
---
> {% if stage %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcEnum),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("cannot evaluate truthiness of enum"),
    );

    const srcTmpl = `---
params:
  - t = tmpl()
---
> {% if t %}hi{% /if %}`;
    assert.throws(
      () => Template.fromSource(srcTmpl),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("cannot evaluate truthiness of template handle"),
    );
  });

  it("rejects limit filter on string at render time", () => {
    const src = `---
params:
  - name = str
---
{{ name | limit(2) }}`;
    const tmpl = Template.fromSource(src);
    assert.throws(
      () => tmpl.render({ name: "hello" }),
      (err: unknown) =>
        err instanceof Error && err.message.includes("'limit' requires a list"),
    );
  });

  it("rejects kind() on plain str parameter at render time", () => {
    const src = `---
params:
  - msg = str
---
{{ kind(msg) }}`;
    const tmpl = Template.fromSource(src);
    assert.throws(
      () => tmpl.render({ msg: "hello" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("kind() requires an enum or option value"),
    );
  });

  it("rejects has() on plain str parameter at render time", () => {
    const src = `---
params:
  - msg = str
---
{{ has(msg) }}`;
    const tmpl = Template.fromSource(src);
    assert.throws(
      () => tmpl.render({ msg: "hello" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("has() requires an option value"),
    );
  });

  it("rejects wildcard _ in {% case %}", () => {
    const src = `---
params:
  - outcome = enum(Confirmed, NotConfirmed, Pending)
---
> {% match outcome %}
> {% case Confirmed %}

confirmed

> {% case _ %}

fallback

> {% /match %}`;
    assert.throws(
      () => Template.fromSource(src),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("wildcard '_' in {% case %} is not supported"),
    );
  });

  it("rejects non-exhaustive option match without else arm", () => {
    const src = `---
params:
  - opt = option(str)
---
> {% match opt %}
> {% case Some && opt == "special" %}

special

> {% case Some %}

has: {{ opt }}

> {% /match %}`;
    assert.throws(
      () => Template.fromSource(src),
      (err: unknown) =>
        err instanceof Error && err.message.includes("non-exhaustive"),
    );
  });

  it("accepts match with else arm fallback", () => {
    const src = `---
params:
  - outcome = enum(Confirmed, NotConfirmed, Pending)
---
> {% match outcome %}
> {% case Confirmed %}

confirmed

> {% else %}

fallback

> {% /match %}`;
    const tmpl = Template.fromSource(src);
    assert.strictEqual(tmpl.render({ outcome: "Pending" }).trim(), "fallback");
  });
});
