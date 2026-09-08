#!/usr/bin/env python3
"""Hygiene linter — flags suppression patterns and structural issues.

Run via `just lint-hygiene` or directly: `python3 scripts/lint_hygiene.py`

Exit code 0 = clean, 1 = violations found.

Escape hatch: add `// NOLINT: <reason>` (Rust/TS) on the line ABOVE a flagged
pattern to suppress it.  The reason is mandatory.
Bare `// NOLINT` without a reason is itself flagged as a violation.
Stale NOLINTs (where the next line doesn't trigger any check) are also flagged.
"""

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────────────

MAX_FILE_LINES = 1200

RUST_DIRS = ["crates/"]
TS_DIRS = ["crates/md-tmpl-typescript/src/", "crates/md-tmpl-wasm/"]
RUST_EXTS = {".rs"}
TS_EXTS = {".ts", ".tsx"}
# Go and Python trees — scanned only by the test-integrity checks below, so they
# are deliberately kept out of ALL_DIRS/ALL_EXTS (no long-file scan for them).
GO_DIRS = ["go/"]
GO_EXTS = {".go"}
PY_DIRS = ["crates/md-tmpl-python/python/"]
PY_EXTS = {".py"}
ALL_DIRS = RUST_DIRS + TS_DIRS + GO_DIRS + PY_DIRS
ALL_EXTS = RUST_EXTS | TS_EXTS | GO_EXTS | PY_EXTS

# Suppression markers.
NOLINT_WITH_REASON = re.compile(r"//\s*NOLINT:\s*\S")
NOLINT_ANY = re.compile(r"//\s*NOLINT")
NOLINT_BARE = re.compile(r"//\s*NOLINT\s*$")


# ── Check definitions ────────────────────────────────────────────────────────


@dataclass
class Check:
    """A single hygiene check definition."""

    name: str
    pattern: re.Pattern[str]
    dirs: list[str]
    exts: set[str]
    message: str
    exclude: re.Pattern[str] | None = None  # lines matching this are skipped
    exclude_path: re.Pattern[str] | None = None  # file paths matching this are skipped
    # When True, NOLINT comments are ignored — the check always fires.
    # Use for structural issues where suppression is never acceptable.
    no_nolint: bool = False
    hits: list[str] = field(default_factory=list)
    suppressed: list[str] = field(default_factory=list)


CHECKS: list[Check] = [
    # ── Rust: lint suppression ────────────────────────────────────────────
    Check(
        name="Rust: #[allow(...)]",
        pattern=re.compile(r"#\[allow\("),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Fix the underlying issue instead of suppressing the lint.",
    ),
    Check(
        name="Rust: #[expect(...)]",
        pattern=re.compile(r"#\[expect\("),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Fix the underlying issue instead of suppressing the lint.",
        # PyO3/FFI bindings legitimately need these.
        exclude_path=re.compile(r"md-tmpl-python/|md-tmpl-wasm/|md-tmpl-ffi/"),
    ),
    Check(
        name="Rust: too_many_lines suppression",
        pattern=re.compile(r"#\[(allow|expect)\(.*too_many_lines"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="NEVER suppress too_many_lines — split the function instead.",
        no_nolint=True,
    ),
    Check(
        name="Rust: type_complexity suppression",
        pattern=re.compile(r"#\[(allow|expect)\(.*type_complexity"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="NEVER suppress type_complexity — introduce a type alias instead.",
        no_nolint=True,
    ),
    Check(
        name="Rust: cognitive_complexity suppression",
        pattern=re.compile(r"#\[(allow|expect)\(.*cognitive_complexity"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="NEVER suppress cognitive_complexity — extract sub-functions.",
        no_nolint=True,
    ),
    # ── Rust: silently discarded values ───────────────────────────────────
    Check(
        name="Rust: let _ = (ignored Result/value)",
        pattern=re.compile(r"\blet _\s*="),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Handle the Result/value properly — don't silently discard it.",
        # Legitimate in test code to prove types exist.
        exclude_path=re.compile(r"tests/"),
    ),
    Check(
        name="Rust: if let Ok(...) (silent Err drop)",
        pattern=re.compile(r"\bif let Ok\("),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="The Err branch is silently ignored. Use match, map_err, or ? to handle errors.",
        # Parsing attempts (parse::<type>) are idiomatic try-or-fallback.
        exclude=re.compile(r"\.parse::|try_from"),
        # Test files and FFI bindings use this legitimately.
        exclude_path=re.compile(r"tests/|_tests?\.rs$|md-tmpl-ffi/"),
    ),
    Check(
        name="Rust: .unwrap_or_default() (hidden errors)",
        pattern=re.compile(r"\.unwrap_or_default\(\)"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Silently replaces errors/None with defaults. Log or propagate instead.",
    ),
    Check(
        name="Rust: .ok() (Result→Option, error discarded)",
        pattern=re.compile(r"\.ok\(\)"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Converts Result to Option, silently discarding the error.",
        # .parse().ok() is idiomatic for optional parsing.
        exclude=re.compile(r"\.parse.*\.ok\(\)"),
    ),
    Check(
        name="Rust: .is_ok() / .is_err() (value discarded)",
        pattern=re.compile(r"\.(is_ok|is_err)\(\)"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Checks the Result but discards the inner value. Use match or ? instead.",
        # Legitimate in assertions, conditions, and boolean expressions.
        exclude=re.compile(r"assert|if |while |\|\||&&|return .*\.is_"),
        # Very common in test assertions; only flag production code.
        exclude_path=re.compile(r"tests/|_tests?\.rs$|validation\.rs$|include_core\.rs$|types\.rs$"),
    ),
    Check(
        name="Rust: discarded closure arg |_|",
        pattern=re.compile(r"\|_\|"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Closure discards its argument. Name it and use it (log, propagate, etc.).",
        # Skip doc-comments, string literals, map_err(|_| ...) which rewrites errors.
        exclude=re.compile(r"^\s*///|^\s*//[^/].*\|_\||" + r'".*\|_\||map_err\(\|_\||unwrap_or_else\(\|_\|'),
        # FFI bindings legitimately use this for CString conversion.
        exclude_path=re.compile(r"md-tmpl-ffi/"),
    ),
    Check(
        name="Rust: Err(_) (error value discarded in match)",
        pattern=re.compile(r"\bErr\(_\)"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Error value is discarded in pattern match. Capture and log/propagate it.",
        # Python bindings translate errors to PyO3 exceptions.
        exclude_path=re.compile(r"md-tmpl-python/"),
    ),
    Check(
        name="Rust: .unwrap_or(()) / .unwrap_or(0) (silent swallow)",
        pattern=re.compile(r"\.unwrap_or\(\s*(\(\)|\b0\b|false|true)\s*\)"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Silently swallows errors with a trivial default. Handle the error explicitly.",
        # size_hint().unwrap_or(0) and capacity hints are idiomatic.
        # .position().unwrap_or(0) / find().unwrap_or(0) is common.
        exclude=re.compile(r"size_hint|capacity|with_capacity|position|find"),
    ),
    # ── TypeScript: lint suppression ──────────────────────────────────────
    Check(
        name="TypeScript: @ts-ignore / @ts-expect-error",
        pattern=re.compile(r"@ts-ignore|@ts-expect-error"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Fix the type error instead of suppressing it.",
    ),
    Check(
        name="TypeScript: eslint-disable",
        pattern=re.compile(r"eslint-disable"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Fix the lint error instead of disabling the rule.",
    ),
    Check(
        name="TypeScript: @ts-nocheck",
        pattern=re.compile(r"@ts-nocheck"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Whole-file type suppression — fix the type errors instead.",
    ),
    # ── TypeScript: type safety ───────────────────────────────────────────
    Check(
        name="TypeScript: as any (type escape)",
        pattern=re.compile(r"\bas\s+any\b"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="'as any' defeats TypeScript's type system. Use a proper type or generic.",
        # Exclude comments that happen to say "as any".
        exclude=re.compile(r"^\s*//|^\s*\*"),
    ),
    # ── TypeScript: swallowed errors ──────────────────────────────────────
    Check(
        name="TypeScript: .catch(() => null/undefined) (swallowed error)",
        pattern=re.compile(r"\.catch\(\s*\(\)\s*=>\s*(null|undefined|\{\s*\})"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Promise error is silently swallowed. Log or propagate the error.",
    ),
    Check(
        name="TypeScript: non-null assertion (!) (unsafe)",
        # Match foo!. or foo![ — the TS non-null assertion operator.
        pattern=re.compile(r"\w![\.\[]"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Non-null assertion will crash at runtime if value is null. Use ?? or handle the null case.",
        # Exclude comments.
        exclude=re.compile(r"^\s*//|^\s*\*"),
        # Exclude test and benchmark files.
        exclude_path=re.compile(r"\.test\.|\.spec\.|benchmarks/|correctness\.ts"),
    ),
    Check(
        name="TypeScript: console.log in production code",
        pattern=re.compile(r"\bconsole\.log\b"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Use a proper logger or console.error/warn for intentional output.",
        # Exclude test, benchmark, test-runner files, and doc comments.
        exclude_path=re.compile(r"\.test\.|\.spec\.|benchmarks/|correctness\.ts"),
        exclude=re.compile(r"^\s*\*|^\s*//"),
    ),
    # ── Rust: panic-at-runtime markers ────────────────────────────────────
    Check(
        name="Rust: todo!() / unimplemented!()",
        pattern=re.compile(r"\b(todo|unimplemented)!\("),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Will panic at runtime. Implement or return an error.",
    ),
    # ── Test integrity: ignored/skipped tests are never allowed ───────────
    Check(
        name="Rust: #[ignore] (skipped test)",
        pattern=re.compile(r"#\[ignore\b"),
        dirs=RUST_DIRS,
        exts=RUST_EXTS,
        message="Tests must never be ignored — fix or delete the test.",
    ),
    Check(
        name="Go: t.Skip (skipped test)",
        pattern=re.compile(r"\b[tb]\.Skip(Now|f)?\("),
        dirs=GO_DIRS,
        exts=GO_EXTS,
        message="Tests must never be skipped — fix or delete the test.",
    ),
    Check(
        name="Python: pytest skip/xfail (skipped test)",
        pattern=re.compile(
            r"pytest\.mark\.(skip|skipif|xfail)|pytest\.(skip|xfail)\(|unittest\.skip"
        ),
        dirs=PY_DIRS,
        exts=PY_EXTS,
        message="Tests must never be skipped or xfail'd — fix or delete the test.",
    ),
    Check(
        name="TypeScript: skipped/focused test (.skip/.only/.todo)",
        pattern=re.compile(r"\b(describe|it|test|suite)\.(skip|only|todo)\b"),
        dirs=TS_DIRS,
        exts=TS_EXTS,
        message="Tests must never be skipped or focused — remove .skip/.only/.todo.",
    ),
]


# ── Helpers ──────────────────────────────────────────────────────────────────


EXCLUDED_DIRS = {"node_modules", "target", "dist", "pkg", ".venv", "__pycache__"}


def source_files(dirs: list[str], exts: set[str]) -> list[Path]:
    """Collect all source files under `dirs` matching `exts`."""
    files: list[Path] = []
    for d in dirs:
        root = Path(d)
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in exts:
                # Skip files inside excluded directories.
                if any(part in EXCLUDED_DIRS for part in path.parts):
                    continue
                files.append(path)
    return sorted(files)


def is_nolinted(lines: list[str], lineno: int) -> bool:
    """Check if the line above `lineno` (1-indexed) has a valid NOLINT: reason."""
    if lineno < 2:
        return False
    prev_line = lines[lineno - 2]  # lineno 1-indexed, list 0-indexed
    return bool(NOLINT_WITH_REASON.search(prev_line))


def line_matches_any_check(line: str, checks: list[Check]) -> bool:
    """Return True if `line` would trigger any check pattern (ignoring excludes)."""
    for check in checks:
        if check.pattern.search(line):
            return True
    return False


# ── Check runners ────────────────────────────────────────────────────────────


def run_pattern_checks() -> bool:
    """Run all pattern checks. Returns True if any failed.

    Tracks which NOLINT comments are consumed (suppress a real hit) so we can
    detect stale ones afterwards.
    """
    failed = False
    # Collect all NOLINT locations and whether they were consumed.
    # Key: (path, lineno of NOLINT line), value: consumed?
    nolint_locations: dict[tuple[Path, int], bool] = {}

    # First pass: find all NOLINT lines.
    all_dirs_exts: set[tuple[str, str]] = set()
    for check in CHECKS:
        for d in check.dirs:
            for ext in check.exts:
                all_dirs_exts.add((d, ext))
    all_dirs_set = {d for d, _ in all_dirs_exts}
    all_exts_set = {e for _, e in all_dirs_exts}
    for path in source_files(list(all_dirs_set), all_exts_set):
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for lineno, line in enumerate(lines, start=1):
            if NOLINT_WITH_REASON.search(line):
                nolint_locations[(path, lineno)] = False  # not yet consumed

    # Second pass: run checks, marking consumed NOLINTs.
    for check in CHECKS:
        print(f"=== {check.name} ===")
        files = source_files(check.dirs, check.exts)
        for path in files:
            if check.exclude_path and check.exclude_path.search(str(path)):
                continue
            try:
                lines = path.read_text(errors="replace").splitlines()
            except OSError:
                continue
            for lineno, line in enumerate(lines, start=1):
                if not check.pattern.search(line):
                    continue
                if check.exclude and check.exclude.search(line):
                    continue
                if not check.no_nolint:
                    if is_nolinted(lines, lineno):
                        # Mark the NOLINT as consumed.
                        nolint_key = (path, lineno - 1)
                        if nolint_key in nolint_locations:
                            nolint_locations[nolint_key] = True
                        check.suppressed.append(
                            f"  {path}:{lineno}: {line.strip()}"
                        )
                        continue
                check.hits.append(f"  {path}:{lineno}: {line.strip()}")
        if check.hits:
            for hit in check.hits:
                print(hit)
            print(f"^^^ {check.message}")
            failed = True
        else:
            print("  ✓ clean")
        if check.suppressed:
            for sup in check.suppressed:
                print(f"  ℹ  (suppressed) {sup.strip()}")

    # Check for stale NOLINTs (not consumed by any check).
    print("=== Stale NOLINT comments ===")
    stale: list[str] = []
    for (path, lineno), consumed in sorted(nolint_locations.items()):
        if not consumed:
            try:
                lines = path.read_text(errors="replace").splitlines()
                line_text = lines[lineno - 1].strip() if lineno <= len(lines) else "???"
            except OSError:
                line_text = "???"
            stale.append(f"  {path}:{lineno}: {line_text}")
    if stale:
        for s in stale:
            print(s)
        print("^^^ NOLINT comment doesn't suppress anything — remove it.")
        failed = True
    else:
        print("  ✓ clean")

    return failed


def run_bare_nolint_check() -> bool:
    """Flag NOLINT comments that don't include a reason."""
    print("=== Bare NOLINT (missing reason) ===")
    hits: list[str] = []
    for path in source_files(ALL_DIRS, ALL_EXTS):
        try:
            content = path.read_text(errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(content.splitlines(), start=1):
            if NOLINT_BARE.search(line):
                hits.append(f"  {path}:{lineno}: {line.strip()}")
    if hits:
        for hit in hits:
            print(hit)
        print("^^^ NOLINT must include a reason: // NOLINT: <why this is acceptable>")
        return True
    print("  ✓ clean")
    return False


def run_empty_catch_check() -> bool:
    """Flag empty catch blocks in TypeScript.

    Detects patterns like:
        catch (err) {
        }
    where the body contains nothing meaningful.
    """
    print("=== TypeScript: empty catch blocks ===")
    hits: list[str] = []
    for path in source_files(TS_DIRS, TS_EXTS):
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not re.search(r"\bcatch\b.*\{", stripped):
                continue
            if is_nolinted(lines, i + 1):
                continue
            # Scan forward for closing brace, check if body is empty.
            body_has_content = False
            found_close = False
            for j in range(i + 1, min(i + 10, len(lines))):
                body = lines[j].strip()
                if body == "}":
                    found_close = True
                    break
                # Any non-blank line (including comments) means someone
                # thought about this catch block — it's not truly empty.
                if body:
                    body_has_content = True
                    break
            if found_close and not body_has_content:
                hits.append(f"  {path}:{i + 1}: {stripped}")
    if hits:
        for hit in hits:
            print(hit)
        print("^^^ Empty catch block — log or handle the error, don't swallow it.")
        return True
    print("  ✓ clean")
    return False


def run_long_file_check() -> bool:
    """Flag non-test files exceeding MAX_FILE_LINES."""
    print(f"=== Long files (>{MAX_FILE_LINES} lines) ===")
    long_files: list[tuple[Path, int]] = []
    test_pattern = re.compile(r"tests?[/._]|_tests?\.|\.test\.|\.spec\.|correctness\.ts")

    seen: set[Path] = set()
    for path in source_files(ALL_DIRS, ALL_EXTS):
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if test_pattern.search(str(path)):
            continue
        try:
            line_count = sum(1 for _ in path.open(errors="replace"))
        except OSError:
            continue
        if line_count > MAX_FILE_LINES:
            long_files.append((path, line_count))

    if long_files:
        long_files.sort(key=lambda x: -x[1])
        for path, count in long_files:
            print(f"  ⚠  {path} ({count} lines)")
        print(
            "^^^ Long file detected. Should be refactored to be modular "
            "and testable (with good testing) and a good folder structure."
        )
        return True

    print("  ✓ clean")
    return False


def run_packaging_invariant_check() -> bool:
    """Ensure the published `md-tmpl` crate ships no build script / build-deps.

    The compile-time `template!` test generator lives in the unpublished
    `md-tmpl-compile-tests` crate precisely so downstream consumers don't
    compile the toml/toml_edit/winnow tree (a build-dependency) or run a build
    script that produces nothing outside this workspace. This check fails if
    either is reintroduced into `crates/md-tmpl`.
    """
    print("=== Packaging: md-tmpl has no build script / build-dependencies ===")
    crate_dir = Path("crates/md-tmpl")
    hits: list[str] = []

    build_rs = crate_dir / "build.rs"
    if build_rs.is_file():
        hits.append(
            f"  {build_rs}: build script present — move it to "
            "crates/md-tmpl-compile-tests instead."
        )

    # Match `[build-dependencies]` and target-scoped variants such as
    # `[target.'cfg(...)'.build-dependencies]`, whether inline or dotted.
    manifest = crate_dir / "Cargo.toml"
    build_dep_header = re.compile(r"^\s*\[[^\]]*build-dependencies\]")
    try:
        for lineno, line in enumerate(manifest.read_text().splitlines(), start=1):
            if build_dep_header.search(line):
                hits.append(f"  {manifest}:{lineno}: {line.strip()}")
    except OSError as err:
        # Don't silently ignore a read failure — surface it as a violation.
        hits.append(f"  {manifest}: could not read manifest ({err})")

    if hits:
        for hit in hits:
            print(hit)
        print(
            "^^^ The published md-tmpl crate must stay free of a build script "
            "and build-dependencies (adds compile cost to every downstream)."
        )
        return True
    print("  ✓ clean")
    return False


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    failed = run_pattern_checks()
    failed = run_bare_nolint_check() or failed
    failed = run_empty_catch_check() or failed
    failed = run_packaging_invariant_check() or failed
    failed = run_long_file_check() or failed

    print()
    if failed:
        print("❌ Hygiene check failed — see above")
        return 1
    print("✅ All hygiene checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
