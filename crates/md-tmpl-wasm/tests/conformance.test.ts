/**
 * Cross-language conformance harness (WASM side).
 *
 * Replays the shared TOML corpus in `<repo>/tests/conformance` through the
 * WASM `md-tmpl` engine and asserts that every case matches the recorded
 * expectation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TOML = require("smol-toml") as {
  parse: (s: string) => { cases: unknown[] };
};

import { Template } from "../pkg/md_tmpl_wasm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, "../../../tests/conformance");

const CORPUS_FILES = [
  "render.toml",
  "interpolation.toml",
  "frontmatter.toml",
  "errors.toml",
  "escapes.toml",
  "comments.toml",
  "literals.toml",
] as const;

interface Expect {
  kind: "render" | "default" | "error";
  output?: string;
  defaults?: Record<string, unknown>;
  phase?: "compile" | "render" | "any";
  error_contains?: string;
}

interface Case {
  name: string;
  source: string;
  params?: Record<string, unknown>;
  env?: Record<string, unknown>;
  expect: Expect;
}

function denull(x: unknown): unknown {
  if (Array.isArray(x)) {
    return x.map(denull);
  }
  if (x !== null && typeof x === "object") {
    const obj = x as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && obj.__none__ === true) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = denull(obj[k]);
    }
    return out;
  }
  return x;
}

function loadCases(file: string): Case[] {
  const text = readFileSync(resolve(CORPUS_DIR, file), "utf8");
  const root = TOML.parse(text);
  return denull(root.cases) as Case[];
}

function compile(c: Case): Template {
  return c.env !== undefined
    ? Template.fromSourceWithEnv(c.source, c.env)
    : Template.fromSource(c.source);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tryCompile(c: Case): { tmpl: Template | null; err: string | null } {
  try {
    return { tmpl: compile(c), err: null };
  } catch (e) {
    return { tmpl: null, err: messageOf(e) };
  }
}

function checkRender(c: Case): void {
  assert.ok(c.expect.output !== undefined, "render case needs expect.output");
  const out = compile(c).render(c.params ?? {});
  assert.strictEqual(out, c.expect.output);
}

function checkDefault(c: Case): void {
  assert.ok(
    c.expect.defaults !== undefined,
    "default case needs expect.defaults",
  );
  const defs = compile(c).defaults();
  assert.deepStrictEqual(defs, c.expect.defaults);
}

function assertNeedle(needle: string | undefined, haystack: string): void {
  if (needle !== undefined) {
    assert.ok(
      haystack.includes(needle),
      `error ${JSON.stringify(haystack)} lacks substring ${JSON.stringify(needle)}`,
    );
  }
}

function checkError(c: Case): void {
  const phase = c.expect.phase;
  assert.ok(phase !== undefined, "error case needs expect.phase");
  const needle = c.expect.error_contains;
  const { tmpl, err } = tryCompile(c);

  if (phase === "compile") {
    assert.ok(err !== null, "expected a COMPILE error but compile succeeded");
    assertNeedle(needle, err);
    return;
  }

  if (err !== null) {
    assert.strictEqual(
      phase,
      "any",
      `expected a RENDER error but failed at COMPILE: ${err}`,
    );
    assertNeedle(needle, err);
    return;
  }

  assert.ok(tmpl !== null, "compile reported success but produced no template");
  let renderErr: string | null = null;
  try {
    tmpl.render(c.params ?? {});
  } catch (e) {
    renderErr = messageOf(e);
  }
  assert.ok(renderErr !== null, "expected a RENDER error but render succeeded");
  assertNeedle(needle, renderErr);
}

function runCase(c: Case): void {
  switch (c.expect.kind) {
    case "render":
      checkRender(c);
      break;
    case "default":
      checkDefault(c);
      break;
    case "error":
      checkError(c);
      break;
    default:
      throw new Error(`unknown expect.kind for case ${c.name}`);
  }
}

for (const file of CORPUS_FILES) {
  describe(`conformance (WASM): ${file}`, () => {
    const cases = loadCases(file);
    assert.ok(cases.length > 0, `corpus file ${file} is empty`);
    for (const c of cases) {
      it(c.name, () => {
        runCase(c);
      });
    }
  });
}
