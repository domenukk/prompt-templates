# Extract version from the main Cargo.toml

version := `grep '^version' crates/md-tmpl/Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/'`

# Python venv for the bindings crate

pyvenv := "crates/md-tmpl-python/.venv/bin/"

# Default recipe: format, lint, and test
default: fmt lint test

# ── Format ────────────────────────────────────────────────────────────

# Format all code (Rust, TOML, Markdown, Justfile, Go, Python, TypeScript)
fmt: fmt-rust fmt-toml fmt-markdown fmt-just fmt-python fmt-go fmt-ts

# Format Rust code (nightly required for import grouping)
fmt-rust:
    cargo +nightly fmt

# Format TOML files
fmt-toml:
    taplo fmt

# Format Markdown files with prettier
fmt-markdown:
    npx -y prettier@latest --write '**/*.md'

# Format the justfile itself
fmt-just:
    just --fmt --unstable

# Format Python files with black
fmt-python:
    {{ pyvenv }}black crates/md-tmpl-python/python/

# Format Go files
fmt-go:
    cd go/md_tmpl && gofmt -w .
    cd go/cmd/pt-gen-go && gofmt -w .

# Format TypeScript files with prettier
fmt-ts:
    cd crates/md-tmpl-typescript && npx -y prettier@latest --write '**/*.ts'

# ── Lint ──────────────────────────────────────────────────────────────

# Lint all code (Rust clippy, TOML, Markdown, Justfile, Go, Python, TypeScript, codegen, hygiene)
lint: lint-rust lint-toml lint-markdown lint-just lint-python lint-go lint-ts lint-codegen lint-hygiene

# Lint Rust with clippy (pedantic + all, deny warnings)
lint-rust:
    cargo clippy --workspace --all-targets --exclude md-tmpl-macros --all-features -- -D warnings
    cargo clippy -p md-tmpl-macros --all-targets -- -D warnings
    # Reduced feature combos: catch lints that only surface without `std`/all-features
    # (e.g. an unused generic in a `no_std` render path). See the codec features.
    cargo clippy -p md-tmpl-core --no-default-features -- -D warnings
    cargo clippy -p md-tmpl-core --no-default-features --features std -- -D warnings
    cargo clippy -p md-tmpl-core --no-default-features --features serde -- -D warnings
    cargo clippy -p md-tmpl-core --no-default-features --features cbor -- -D warnings
    cargo clippy -p md-tmpl-core --no-default-features --features flexbuffers -- -D warnings

# Check Rust formatting without modifying files
lint-rust-fmt:
    cargo +nightly fmt -- --check

# Lint TOML files
lint-toml:
    taplo check

# Lint Markdown files
lint-markdown:
    npx -y markdownlint-cli2@latest '**/*.md'
    npx -y prettier@latest --check '**/*.md'

# Lint the justfile (check formatting)
lint-just:
    just --fmt --unstable --check

# Lint Python files with black (check) and mypy
lint-python:
    {{ pyvenv }}black --check crates/md-tmpl-python/python/
    {{ pyvenv }}mypy crates/md-tmpl-python/python/md_tmpl/ --ignore-missing-imports

# Lint Go files (vet)
lint-go: build-go-ffi
    cd go/md_tmpl && go vet ./...
    cd go/cmd/pt-gen-go && go vet ./...
    @cd go/md_tmpl && if [ -n "$(gofmt -l .)" ]; then echo "Go code is not formatted. Run 'just fmt'"; exit 1; fi
    @cd go/cmd/pt-gen-go && if [ -n "$(gofmt -l .)" ]; then echo "Go code is not formatted. Run 'just fmt'"; exit 1; fi

# Lint TypeScript (strict type-check with tsc, ESLint, prettier)
lint-ts:
    cd crates/md-tmpl-typescript && npx tsc --noEmit --strict
    cd crates/md-tmpl-typescript && npx eslint .
    cd crates/md-tmpl-typescript && npx -y prettier@latest --check '**/*.ts'

# Verify zero-diff of generated static type-generator stubs across TS, Go, and Python
lint-codegen: build-ts build-go-ffi
    cd crates/md-tmpl-python && .venv/bin/maturin develop
    python3 scripts/lint_codegen.py --check

# Regenerate golden static type-generator stubs across TS, Go, and Python
gen-stubs: build-ts build-go-ffi
    cd crates/md-tmpl-python && .venv/bin/maturin develop
    python3 scripts/lint_codegen.py --write

# Run hygiene linter (suppression patterns, error handling, file length)
lint-hygiene:
    python3 scripts/lint_hygiene.py

# Run all tests
test: test-rust test-no-std test-python test-go test-ts test-wasm

# Run Rust tests (lib + doctests + integration + macros, zero ignored)
test-rust:
    cargo test --workspace --exclude md-tmpl-macros --all-features 2>&1 | tee /tmp/cargo-test-output.txt
    cargo test -p md-tmpl-macros 2>&1 | tee -a /tmp/cargo-test-output.txt
    @echo "Verifying zero ignored tests..."
    @if grep 'test result:' /tmp/cargo-test-output.txt | grep -v '0 ignored'; then echo "ERROR: ignored tests found!" && exit 1; fi
    @echo "All tests pass, none ignored ✓"

# Verify no_std compatibility (integration tests + true no_std target build)
test-no-std:
    @echo "── no_std integration tests ──"
    cargo test -p md-tmpl --no-default-features --test no_std_compat
    @echo ""
    @echo "── no_std target build (thumbv7em-none-eabihf) ──"
    cargo build -p md-tmpl --no-default-features --target thumbv7em-none-eabihf
    cargo build -p md-tmpl --no-default-features --features serde --target thumbv7em-none-eabihf
    cargo build -p md-tmpl --no-default-features --features macros --target thumbv7em-none-eabihf
    cargo build -p md-tmpl --no-default-features --features serde,macros --target thumbv7em-none-eabihf
    cargo build -p md-tmpl --no-default-features --features cbor --target thumbv7em-none-eabihf
    cargo build -p md-tmpl --no-default-features --features serde,cbor,macros --target thumbv7em-none-eabihf
    @echo "All no_std checks pass ✓"

# Build and test Python bindings
test-python:
    cd crates/md-tmpl-python && .venv/bin/maturin develop && .venv/bin/pytest python/tests/ -v

# Build and test Go bindings
test-go: build-go-ffi
    cd go/md_tmpl && go test -v -count=1 ./...

# Build and test TypeScript bindings
test-ts: build-ts
    cd crates/md-tmpl-typescript && node --test dist/tests/*.test.js

# Run WASM tests (parity + comprehensive unit tests)
test-wasm: build-wasm
    cd crates/md-tmpl-wasm && npm test

# Replay the shared cross-language conformance corpus against ALL FIVE backends
test-conformance: build-ts build-go-ffi build-wasm
    @echo "── Rust conformance harness ──"
    cargo test -p md-tmpl-core --test conformance --all-features
    @echo "── TypeScript conformance harness ──"
    cd crates/md-tmpl-typescript && node --test dist/tests/conformance.test.js
    @echo "── Go conformance harness ──"
    cd go/md_tmpl && go test -run TestConformance -count=1 ./...
    @echo "── Python conformance harness ──"
    cd crates/md-tmpl-python && .venv/bin/maturin develop && .venv/bin/pytest python/tests/test_conformance.py -q
    @echo "── WASM conformance harness ──"
    cd crates/md-tmpl-wasm && node --test dist/conformance.test.js

# ── Docs ──────────────────────────────────────────────────────────────

# Build documentation (checks for broken intra-doc links)
doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --all-features --no-deps

# ── Benchmark ─────────────────────────────────────────────────────────

# Run all benchmarks (Rust + Go + TypeScript + WASM + Python)
bench: bench-rust bench-go bench-ts bench-wasm bench-python

# Run Rust benchmarks (via criterion)
bench-rust:
    cargo bench -p md-tmpl

# Run Go benchmarks
bench-go: build-go-ffi
    cd go/md_tmpl && go test -bench=. -benchmem -count=1 ./...

# Run TypeScript benchmarks
bench-ts: build-ts
    cd crates/md-tmpl-typescript && node dist/benchmarks/bench.js

# Run TypeScript comparison benchmarks (vs Handlebars, Mustache)
bench-ts-compare: build-ts
    cd crates/md-tmpl-typescript && node dist/benchmarks/comparison.js

# Run WASM vs TypeScript comparative benchmarks
bench-wasm: build-wasm
    cd crates/md-tmpl-wasm && npm run bench

# Run Python benchmarks (vs Jinja2, Mako, Chevron, Django)
bench-python:
    {{ pyvenv }}python benchmarks/python/bench_templates.py

# Micro-benchmark: validation overhead (render_ctx_allowing_extra vs render_ctx_unchecked)
bench-perf:
    cd benchmarks && cargo run --release --example perf_test

# Run all benchmarks and update README.md + RESULTS.md tables
bench-update:
    python3 benchmarks/scripts/run_and_update.py

# Run Rust benchmarks and update tables
bench-update-rust:
    python3 benchmarks/scripts/run_and_update.py --lang rust

# Run Python benchmarks and update tables
bench-update-python:
    python3 benchmarks/scripts/run_and_update.py --lang python

# Run Go benchmarks and update tables
bench-update-go:
    python3 benchmarks/scripts/run_and_update.py --lang go

# Run TypeScript benchmarks and update tables
bench-update-ts:
    python3 benchmarks/scripts/run_and_update.py --lang ts

# Run WASM benchmarks and update tables
bench-update-wasm:
    python3 benchmarks/scripts/run_and_update.py --lang wasm

# ── Build ─────────────────────────────────────────────────────────────

# Build the FFI static library (required by Go bindings)
build-go-ffi:
    cargo build -p md-tmpl-ffi --release

# Build the TypeScript bindings
build-ts:
    cd crates/md-tmpl-typescript && npx tsc

# Build the WASM package (via wasm-pack)
build-wasm:
    cd crates/md-tmpl-wasm && rm -rf pkg && wasm-pack build --target nodejs --out-dir pkg --release && npm run build

# ── Other ─────────────────────────────────────────────────────────────

# Run all checks (fmt check + lint + test + doc)
check: lint-rust-fmt lint test doc

# ── Publish ───────────────────────────────────────────────────────────

# Publish everything (lint + test first, then all packages)
publish: lint test publish-rust publish-python publish-ts

# Publish Rust crates to crates.io in dependency order (core → macros → md-tmpl)
publish-rust:
    cargo publish -p md-tmpl-core
    @echo "Waiting for crates.io index..."
    sleep 30
    cargo publish -p md-tmpl-macros
    @echo "Waiting for crates.io index..."
    sleep 30
    cargo publish -p md-tmpl

# Publish Python package to PyPI via maturin
publish-python:
    cd crates/md-tmpl-python && maturin publish

# Publish TypeScript package to npm
publish-ts: build-ts
    cd crates/md-tmpl-typescript && npm publish --access public

# Tag a Go module release (Go modules are released via git tags)

# Version is read from crates/md-tmpl/Cargo.toml
publish-go:
    @echo "Tagging Go module release: go/md_tmpl/v{{ version }}"
    git tag "go/md_tmpl/v{{ version }}"
    @echo "Tagged. Push with: git push origin go/md_tmpl/v{{ version }}"

# ── Setup ─────────────────────────────────────────────────────────────

# Set up Python development environment
setup-python:
    python3 -m venv crates/md-tmpl-python/.venv
    crates/md-tmpl-python/.venv/bin/pip install maturin pytest black mypy tomli

# Set up TypeScript development environment
setup-ts:
    cd crates/md-tmpl-typescript && npm install
