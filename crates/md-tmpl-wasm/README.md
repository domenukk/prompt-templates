# md-tmpl-wasm

WebAssembly bindings for the
[md-tmpl](https://github.com/domenukk/md-tmpl) engine.
Wraps the full Rust engine via `wasm-bindgen` for use in Node.js and
browser environments.

Implements the same `ITemplate` interface as the pure-TypeScript
`md-tmpl` package — swap backends without changing application
code.

## Building

```bash
wasm-pack build --target nodejs --out-dir pkg

# For browser:
wasm-pack build --target web --out-dir pkg
```

## Quick Start

```ts
import { Template } from "./pkg/md_tmpl_wasm";

const tmpl = Template.fromSource(`---
params:
  - name = str
  - role = str
---
You are {{ role }}. Hello {{ name }}!`);

console.log(tmpl.render({ name: "Alice", role: "an AI assistant" }));
// → "You are an AI assistant. Hello Alice!"
```

## Environment Variables

Inject values at compile time from the build environment using `env:`
declarations. Env vars are resolved once when the template is compiled and
behave like constants at render time.

```ts
import { Template } from "./pkg/md_tmpl_wasm";

const tmpl = Template.fromSourceWithEnv(
  `---
params:
  - name = str
env:
  - MODEL = str
  - MAX_TOKENS = int := 4096
---
Hello {{ name }}! Using {{ MODEL }} (max {{ MAX_TOKENS }} tokens).`,
  { MODEL: "gemini-2.0-flash" },
);

console.log(tmpl.render({ name: "Alice" }));
// → "Hello Alice! Using gemini-2.0-flash (max 4096 tokens)."
```

## API

### Constructors

```ts
Template.fromSource(source: string): Template
Template.fromSourceWithBaseDir(source: string, baseDir: string): Template
Template.fromSourceWithEnv(source: string, env: Record<string, string>): Template
Template.fromSourceWithOptions(source: string, options: object): Template
```

### Rendering

```ts
tmpl.render(params: object): string              // type-validated
tmpl.renderEmpty(): string                        // render with defaults only (no params)
tmpl.renderUnchecked(params: object): string      // skip ALL validation
tmpl.renderAllowingExtra(params: object): string  // allow undeclared extra params
tmpl.renderJson(jsonStr: string): string          // avoids per-field WASM crossings
tmpl.renderUncheckedJson(jsonStr: string): string
tmpl.renderAllowingExtraJson(jsonStr: string): string
tmpl.renderFlexbuffers(buffer: Uint8Array): string        // zero-copy binary
tmpl.renderUncheckedFlexbuffers(buffer: Uint8Array): string
tmpl.renderAllowingExtraFlexbuffers(buffer: Uint8Array): string
```

### Metadata

```ts
tmpl.body(): string
tmpl.defaults(): object
tmpl.consts(): object
tmpl.importedConsts(): object
tmpl.declarations(): [string, string][]
tmpl.sourceHash(): number
```

## Serialization Tiers

| Method                | Input        | Overhead                         |
| --------------------- | ------------ | -------------------------------- |
| `render()`            | JS object    | serde-wasm-bindgen per field     |
| `renderJson()`        | JSON string  | One string copy, JSON parse      |
| `renderFlexbuffers()` | `Uint8Array` | Zero-copy binary deserialization |

For small templates, `render()` is simplest. For high-throughput
scenarios, `renderFlexbuffers()` eliminates serialization overhead.

## ITemplate Compatibility

```ts
import type { ITemplate } from "md-tmpl";

function renderGreeting(tmpl: ITemplate, name: string): string {
  return tmpl.render({ name });
}

import { Template as WasmTemplate } from "md-tmpl-wasm";
import { Template as TsTemplate } from "md-tmpl";

renderGreeting(WasmTemplate.fromSource(src), "Alice");
renderGreeting(TsTemplate.fromSource(src), "Alice");
```

## Performance

### WASM vs Pure-TypeScript

([source](benchmarks/bench.ts))

| Scenario                                |     WASM (Rust) |      TypeScript | speedup |
| --------------------------------------- | --------------: | --------------: | ------: |
| parse simple                            | **10.88 µs** 🏆 |        12.52 µs |    1.2× |
| render simple (1 param)                 |         4.17 µs |  **1.77 µs** 🏆 | 2.4× TS |
| render list/for (20 items)              |        44.14 µs | **29.11 µs** 🏆 | 1.5× TS |
| render complex (nested+list+filter)     |        12.80 µs |  **8.76 µs** 🏆 | 1.5× TS |
| declarations()                          |    **27 ns** 🏆 |          560 ns |   20.4× |
| renderJson complex (nested+list+filter) |  **6.07 µs** 🏆 |         8.70 µs |    1.4× |

Pure-TS is faster for rendering due to JS↔WASM serialization overhead.
WASM wins on metadata access. Use WASM when you need exact Rust-engine
parity.

## Full Reference

See **[SPEC.md](../../SPEC.md)** for the complete syntax reference.

## License

Apache-2.0 OR MIT
