#!/usr/bin/env python3
"""Benchmark md-tmpl (PyO3 bindings) vs Jinja2, Mako, Chevron, Django,
and Python's built-in string.Template.

Compares rendering performance across four template scenarios that match
the Rust benchmarks in ``benchmarks/benches/comparison.rs``:

1. **Simple** – variable substitution
2. **Loop** – iterating over a list
3. **Conditional** – if/elif/else branching
4. **Hero** – nested loops + conditionals (the "large" Rust benchmark)

Three benchmarks are run per scenario:

- **Compile**: time to parse/compile a template from source
- **Render**: time to render a pre-compiled template with data
- **End-to-end**: compile + render in a single call

Output correctness is verified before timing to guarantee all engines
produce equivalent results.

Methodology notes:

- ``md-tmpl`` and ``pt-json`` are Rust (PyO3) bindings calling a
  native compiled engine.  All other engines are pure Python (Jinja2 has
  optional C extensions for markup escaping, but template rendering is
  pure Python).  The speed advantage is partly due to native code.
- Chevron (Mustache) has no pre-compiled form — ``chevron.render()``
  re-tokenises the template string on every call.  Its "render" and
  "compile + render" numbers are therefore the same.
- Chevron and string.Template are excluded from conditional and hero
  scenarios because they lack comparison conditionals (``if x == "y"``),
  ``elif``, and filter support.  (Mustache has boolean section blocks
  ``{{#var}}`` but cannot compare values.)
"""

from __future__ import annotations

import logging
import string
import sys
import timeit
from dataclasses import dataclass
from typing import Any, Callable, Protocol

# ---------------------------------------------------------------------------
# Engine imports
# ---------------------------------------------------------------------------

from jinja2 import Environment
from md_tmpl import Template

from mako.template import Template as MakoTemplate  # type: ignore[import-untyped]

import chevron  # type: ignore[import-untyped]

import django  # type: ignore[import-untyped]
from django.conf import settings as django_settings  # type: ignore[import-untyped]

if not django_settings.configured:
    django_settings.configure(
        TEMPLATES=[
            {
                "BACKEND": "django.template.backends.django.DjangoTemplates",
            }
        ],
        USE_TZ=False,
    )
    django.setup()

from django.template import Template as DjangoTemplate, Context  # type: ignore[import-untyped]
from django.template import Library  # noqa: E402

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ITERATIONS = 10_000
COMPILE_ITERATIONS = 1_000
TIMEIT_REPEAT = 5  # best-of-N runs for stability
REFERENCE_ENGINE = "md-tmpl"

# ---------------------------------------------------------------------------
# Engine abstraction
# ---------------------------------------------------------------------------


class CompiledTemplate(Protocol):
    """Minimal protocol for a compiled template object."""

    def __call__(self, **kwargs: Any) -> str:
        """Render the template with the given keyword arguments."""
        ...


class TemplateEngine(Protocol):
    """Protocol for a template engine that can compile and render."""

    @property
    def name(self) -> str: ...

    def compile(self, source: str) -> CompiledTemplate: ...


# ---------------------------------------------------------------------------
# Engine: md-tmpl (PyO3)
# ---------------------------------------------------------------------------


class MdTmplEngine:
    """Adapter for the md-tmpl PyO3 bindings."""

    name = "md-tmpl"

    def compile(self, source: str) -> CompiledTemplate:
        tmpl = Template.from_source(source)
        return lambda **kw: tmpl.render(**kw)


class PromptTemplatesJsonEngine:
    """Adapter using the render_json() fast path.

    Uses json.dumps() on the Python side and a single FFI call with
    serde_json on the Rust side, avoiding N per-key Python→Rust
    conversions.
    """

    name = "pt-json"

    def compile(self, source: str) -> CompiledTemplate:
        import json

        tmpl = Template.from_source(source)
        return lambda **kw: tmpl.render_json(json.dumps(kw))


# ---------------------------------------------------------------------------
# Engine: Jinja2
# ---------------------------------------------------------------------------


def _pt_float(value: float) -> str:
    """Format a float the way md-tmpl does.

    Integer-valued floats are rendered without a decimal part
    (e.g. 3.0 → '3'), while fractional values keep their natural
    representation (e.g. 1.5 → '1.5').
    """
    as_int = int(value)
    if float(as_int) == value:
        return str(as_int)
    return str(value)


class Jinja2Engine:
    """Adapter for Jinja2."""

    name = "Jinja2"

    def __init__(self) -> None:
        self._env = Environment(auto_reload=False)
        self._env.filters["pt_float"] = _pt_float

    def compile(self, source: str) -> CompiledTemplate:
        tmpl = self._env.from_string(source)
        return lambda **kw: tmpl.render(**kw)


# ---------------------------------------------------------------------------
# Engine: Mako
# ---------------------------------------------------------------------------


class MakoEngine:
    """Adapter for the Mako template library."""

    name = "Mako"

    def compile(self, source: str) -> CompiledTemplate:
        tmpl = MakoTemplate(text=source)
        return lambda **kw: tmpl.render(**kw)


# ---------------------------------------------------------------------------
# Engine: Chevron (Mustache)
# ---------------------------------------------------------------------------


class ChevronEngine:
    """Adapter for the Chevron (Mustache) template library.

    Mustache has no filter or conditional support, so this engine only
    participates in simple and loop scenarios.

    Note: Chevron has no pre-compiled template form — ``chevron.render()``
    re-tokenises the source string on every call.  This means the "render"
    benchmark numbers for Chevron include tokenisation overhead.
    """

    name = "Chevron"

    def compile(self, source: str) -> CompiledTemplate:
        # chevron.render works directly from a template string — there is
        # no separate compile step.  We capture the source in a closure.
        return lambda **kw: chevron.render(source, kw)


# ---------------------------------------------------------------------------
# Engine: Django templates
# ---------------------------------------------------------------------------


def _django_trim(value: str) -> str:
    """Django template filter equivalent to Python str.strip()."""
    return value.strip()


def _django_pt_float(value: float) -> str:
    """Django filter: format floats the md-tmpl way."""
    as_int = int(value)
    if float(as_int) == value:
        return str(as_int)
    return str(value)


# Register custom Django filters via a Library.
_django_lib = Library()
_django_lib.filter("trim", _django_trim)
_django_lib.filter("pt_float", _django_pt_float)

# Make filters available globally so templates can use them without
# {% load %}.  We register the library in the default engine's builtins.
from django.template.engine import Engine as _DjangoEngine  # type: ignore[import-untyped]

_default_engine = _DjangoEngine.get_default()
_default_engine.template_libraries["bench_filters"] = _django_lib
_default_engine.template_builtins.append(_django_lib)


class DjangoEngine:
    """Adapter for Django's template engine."""

    name = "Django"

    def compile(self, source: str) -> CompiledTemplate:
        tmpl = DjangoTemplate(source)
        return lambda **kw: tmpl.render(Context(kw))


# ---------------------------------------------------------------------------
# Engine: string.Template (stdlib baseline)
# ---------------------------------------------------------------------------


class StringTemplateEngine:
    """Adapter for Python's built-in string.Template.

    Only supports simple $variable substitution — no loops, conditionals,
    or filters.  Included as a stdlib baseline.
    """

    name = "str.Tmpl"

    def compile(self, source: str) -> CompiledTemplate:
        tmpl = string.Template(source)
        return lambda **kw: tmpl.substitute(**kw)


ALL_ENGINES: list[TemplateEngine] = [
    MdTmplEngine(),
    PromptTemplatesJsonEngine(),
    Jinja2Engine(),
    MakoEngine(),
    ChevronEngine(),
    DjangoEngine(),
    StringTemplateEngine(),
]


# ---------------------------------------------------------------------------
# Scenario definition
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Scenario:
    """A single benchmark scenario with templates keyed by engine name."""

    name: str
    templates: dict[str, str]  # engine name → template source
    render_kwargs: dict[str, Any]  # keyword arguments for rendering


# =========================================================================
# Template sources — grouped per scenario so the engine syntaxes can be
# compared side-by-side.
# =========================================================================

# -- 1. Simple: variable substitution -------------------------------------
#
#   All engines render: "Hello Alice, welcome to Wonderland!"
#
#   md-tmpl:  {{ name }}        (frontmatter declares params)
#   Jinja2:            {{ name }}        (identical body syntax)
#   Mako:              ${name}           (dollar-brace syntax)
#   Chevron:           {{name}}          (Mustache — no spaces required)
#   Django:            {{ name }}        (identical body syntax)
#   str.Template:      $name             (dollar-prefix)

PT_SIMPLE = """\
---
params:
  - name = str
  - place = str
---
Hello {{ name }}, welcome to {{ place }}!"""

J2_SIMPLE = "Hello {{ name }}, welcome to {{ place }}!"

MAKO_SIMPLE = "Hello ${name}, welcome to ${place}!"

CHEVRON_SIMPLE = "Hello {{name}}, welcome to {{place}}!"

DJANGO_SIMPLE = "Hello {{ name }}, welcome to {{ place }}!"

STRTMPL_SIMPLE = "Hello $name, welcome to $place!"

SIMPLE_KWARGS: dict[str, Any] = {"name": "Alice", "place": "Wonderland"}

# -- 2. Loop: iterating over a list ----------------------------------------
#
#   All engines render the same markdown list:
#     - Alpha: 10
#     - Beta: 20
#     - Gamma: 30
#
#   md-tmpl:  > {% for item in items %} ... > {% /for %}
#   Jinja2:            {% for item in items -%} ... {% endfor %}
#   Mako:              % for item in items: ... % endfor
#   Chevron:           {{#items}} ... {{/items}}
#   Django:            {% for item in items %} ... {% endfor %}

PT_LOOP = """\
---
params:
  - items = list(label = str, value = int)
---
> {% for item in items %}

- {{ item.label }}: {{ item.value }}

> {% /for %}"""

J2_LOOP = """\
{% for item in items -%}
- {{ item.label }}: {{ item.value }}
{% endfor %}"""

MAKO_LOOP = """\
% for item in items:
- ${item["label"]}: ${item["value"]}
% endfor
"""

CHEVRON_LOOP = """\
{{#items}}\
- {{label}}: {{value}}
{{/items}}"""

DJANGO_LOOP = """\
{% for item in items %}\
- {{ item.label }}: {{ item.value }}
{% endfor %}"""

# str.Template: no loop support.

LOOP_KWARGS: dict[str, Any] = {
    "items": [
        {"label": "Alpha", "value": 10},
        {"label": "Beta", "value": 20},
        {"label": "Gamma", "value": 30},
    ],
}

# -- 3. Conditional: if/elif/else branching --------------------------------
#
#   All engines render (with level="medium", score=75):
#     Rating: Good (score 75)
#
#   md-tmpl:  > {% if level == "high" %} ... > {% /if %}
#   Jinja2:            {% if level == "high" -%} ... {% endif -%}
#   Mako:              % if level == "high": ... % endif
#   Django:            {% if level == "high" %} ... {% endif %}
#   Chevron:           N/A (no elif support)
#   str.Template:      N/A (no conditional support)

PT_CONDITIONAL = """\
---
params:
  - level = str
  - score = int
---
> {% if level == "high" %}

Rating: Excellent

> {% elif level == "medium" %}

Rating: Good (score {{ score }})

> {% else %}

Rating: Needs Improvement

> {% /if %}"""

J2_CONDITIONAL = """\
{% if level == "high" -%}
Rating: Excellent
{% elif level == "medium" -%}
Rating: Good (score {{ score }})
{% else -%}
Rating: Needs Improvement
{% endif -%}
"""

MAKO_CONDITIONAL = """\
% if level == "high":
Rating: Excellent
% elif level == "medium":
Rating: Good (score ${score})
% else:
Rating: Needs Improvement
% endif
"""

DJANGO_CONDITIONAL = """\
{% if level == "high" %}\
Rating: Excellent
{% elif level == "medium" %}\
Rating: Good (score {{ score }})
{% else %}\
Rating: Needs Improvement
{% endif %}"""

CONDITIONAL_KWARGS: dict[str, Any] = {"level": "medium", "score": 75}

# -- 4. Hero/Complex: nested loops + conditionals --------------------------
#
#   All engines render the same multi-section markdown report with
#   30 entries across 3 sections, conditional status formatting, and
#   float formatting.
#
#   md-tmpl:  > {% for section in sections %} ... > {% /for %}
#   Jinja2:            {% for section in sections -%} ... {% endfor %}
#   Mako:              % for section in sections: ... % endfor
#   Django:            {% for section in sections %} ... {% endfor %}
#   Chevron:           N/A (no filter support)
#   str.Template:      N/A (no loop/conditional support)


PT_HERO = """\
---
params:
  - title = str
  - sections = list(heading = str, entries = list(name = str, active = bool, score = float, tags = list(label = str)))
---
# {{ title }}


> {% for section in sections %}

## {{ section.heading }}


> {% for entry in section.entries %}

### {{ entry.name }}


> {% if entry.active %}

- Status: active
- Score: {{ entry.score | fixed(1) }}

> {% elif entry.score > 0 %}

- Status: inactive (score {{ entry.score | fixed(1) }})

> {% else %}

- Status: inactive

> {% /if %}
> {% for tag in entry.tags %}

  - tag: {{ tag.label }}

> {% /for %}
> {% /for %}
> {% /for %}"""

J2_HERO = """\
# {{ title }}

{% for section in sections -%}
## {{ section.heading }}

{% for entry in section.entries -%}
### {{ entry.name }}

{% if entry.active -%}
- Status: active
- Score: {{ "%.1f" | format(entry.score) }}
{% elif entry.score > 0 -%}
- Status: inactive (score {{ "%.1f" | format(entry.score) }})
{% else -%}
- Status: inactive
{% endif %}{% for tag in entry.tags %}  - tag: {{ tag.label }}
{% endfor -%}
{% endfor -%}
{% endfor -%}
"""

MAKO_HERO = """\
# ${title}

% for section in sections:
${'##'} ${section["heading"]}

% for entry in section["entries"]:
${'###'} ${entry["name"]}

% if entry["active"]:
- Status: active
- Score: ${'%.1f' % entry["score"]}
% elif entry["score"] > 0:
- Status: inactive (score ${'%.1f' % entry["score"]})
% else:
- Status: inactive
% endif
% for tag in entry["tags"]:
  - tag: ${tag["label"]}
% endfor
% endfor
% endfor
"""

DJANGO_HERO = """\
# {{ title }}

{% for section in sections %}\
## {{ section.heading }}

{% for entry in section.entries %}\
### {{ entry.name }}

{% if entry.active %}\
- Status: active
- Score: {{ entry.score|floatformat:1 }}
{% elif entry.score|floatformat:0 != "0" %}\
- Status: inactive (score {{ entry.score|floatformat:1 }})
{% else %}\
- Status: inactive
{% endif %}\
{% for tag in entry.tags %}\
  - tag: {{ tag.label }}
{% endfor %}\
{% endfor %}\
{% endfor %}\
"""


HERO_KWARGS: dict[str, Any] = {
    "title": "System Report",
    "sections": [
        {
            "heading": "Overview",
            "entries": [
                {"name": "Service-A", "active": True, "score": 98.7, "tags": [{"label": "prod"}, {"label": "critical"}]},
                {"name": "Service-B", "active": False, "score": 45.2, "tags": [{"label": "staging"}]},
                {"name": "Service-C", "active": False, "score": 0.0, "tags": [{"label": "deprecated"}]},
            ],
        },
        {
            "heading": "Metrics",
            "entries": [
                {"name": "Latency", "active": True, "score": 12.3, "tags": [{"label": "p99"}]},
                {"name": "Throughput", "active": False, "score": 0.0, "tags": [{"label": "batch"}]},
            ],
        },
    ],
}


# ---------------------------------------------------------------------------
# Scenario registry
# ---------------------------------------------------------------------------

SCENARIOS: list[Scenario] = [
    Scenario(
        "simple",
        {
            "md-tmpl": PT_SIMPLE,
            "pt-json": PT_SIMPLE,
            "Jinja2": J2_SIMPLE,
            "Mako": MAKO_SIMPLE,
            "Chevron": CHEVRON_SIMPLE,
            "Django": DJANGO_SIMPLE,
            "str.Tmpl": STRTMPL_SIMPLE,
        },
        SIMPLE_KWARGS,
    ),
    Scenario(
        "loop",
        {
            "md-tmpl": PT_LOOP,
            "pt-json": PT_LOOP,
            "Jinja2": J2_LOOP,
            "Mako": MAKO_LOOP,
            "Chevron": CHEVRON_LOOP,
            "Django": DJANGO_LOOP,
            # str.Tmpl: no loop support.
        },
        LOOP_KWARGS,
    ),
    Scenario(
        "conditional",
        {
            "md-tmpl": PT_CONDITIONAL,
            "pt-json": PT_CONDITIONAL,
            "Jinja2": J2_CONDITIONAL,
            "Mako": MAKO_CONDITIONAL,
            "Django": DJANGO_CONDITIONAL,
            # Chevron: no elif support.
            # str.Tmpl: no conditional support.
        },
        CONDITIONAL_KWARGS,
    ),
    Scenario(
        "hero",
        {
            "md-tmpl": PT_HERO,
            "pt-json": PT_HERO,
            "Jinja2": J2_HERO,
            "Mako": MAKO_HERO,
            "Django": DJANGO_HERO,
            # Chevron: no filter support.
            # str.Tmpl: no loop/conditional support.
        },
        HERO_KWARGS,
    ),
]


# ---------------------------------------------------------------------------
# Benchmarking
# ---------------------------------------------------------------------------


@dataclass
class BenchResult:
    """Timing result for a single engine on a single scenario."""

    scenario: str
    engine: str
    total_seconds: float
    iterations: int

    @property
    def us_per_iter(self) -> float:
        """Microseconds per iteration."""
        return (self.total_seconds / self.iterations) * 1_000_000


def bench_render(label: str, engine: str, render_fn: Callable[..., Any], iterations: int) -> BenchResult:
    """Time *render_fn* over *iterations* calls, returning the best run."""
    best = min(timeit.repeat(render_fn, number=iterations, repeat=TIMEIT_REPEAT))
    return BenchResult(
        scenario=label,
        engine=engine,
        total_seconds=best,
        iterations=iterations,
    )


def normalize_output(text: str) -> str:
    """Normalize whitespace for output comparison.

    Strips trailing whitespace from each line and trailing newlines
    from the entire string.  This accommodates minor whitespace
    differences between engines (e.g. Mako/Django trailing newlines).
    """
    lines = text.rstrip("\n").split("\n")
    return "\n".join(line.rstrip() for line in lines)


def assert_outputs_equal(
    reference_output: str,
    engine_output: str,
    scenario: str,
    ref_engine: str,
    cmp_engine: str,
) -> None:
    """Assert that two engines produce equivalent output for a scenario."""
    ref_norm = normalize_output(reference_output)
    cmp_norm = normalize_output(engine_output)
    if ref_norm != cmp_norm:
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"OUTPUT MISMATCH in scenario '{scenario}'", file=sys.stderr)
        print(f"  {ref_engine} vs {cmp_engine}", file=sys.stderr)
        print(f"{'='*60}", file=sys.stderr)
        print(f"{ref_engine} ({len(ref_norm)} chars):", file=sys.stderr)
        print(repr(ref_norm), file=sys.stderr)
        print(f"\n{cmp_engine} ({len(cmp_norm)} chars):", file=sys.stderr)
        print(repr(cmp_norm), file=sys.stderr)
        print(f"{'='*60}", file=sys.stderr)
        raise AssertionError(
            f"Output mismatch in '{scenario}': {ref_engine} and {cmp_engine} "
            f"produced different results"
        )


# ---------------------------------------------------------------------------
# Result formatting
# ---------------------------------------------------------------------------


def print_results(
    engine_names: list[str],
    results: dict[str, dict[str, BenchResult]],
) -> None:
    """Print a formatted comparison table of all engines.

    *results* maps scenario name → {engine name → BenchResult}.
    """
    name_col = max(len("Scenario"), max(len(s.name) for s in SCENARIOS)) + 1
    min_val_width = 10  # enough for "12345.67 µs"

    # Per-engine column width: max of engine name length and value width.
    col_widths = [max(len(eng), min_val_width) for eng in engine_names]

    header_parts = [f"{'Scenario':<{name_col}}"]
    for eng, cw in zip(engine_names, col_widths):
        header_parts.append(f"{eng:>{cw}}")
    header = "  ".join(header_parts)
    separator = "-" * len(header)

    print()
    print("Python Template Benchmark Results")
    print(f"({ITERATIONS:,} iterations, best of {TIMEIT_REPEAT} runs)")
    print()
    print(header)
    print(separator)

    for scenario in SCENARIOS:
        scenario_results = results.get(scenario.name, {})
        parts = [f"{scenario.name:<{name_col}}"]
        for eng, cw in zip(engine_names, col_widths):
            br = scenario_results.get(eng)
            if br is None:
                parts.append(f"{'N/A':>{cw}}")
            else:
                parts.append(f"{br.us_per_iter:>{cw - 3}.2f} µs")
        print("  ".join(parts))

    print(separator)
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def compile_all_for_scenario(
    scenario: Scenario,
    engines: list[TemplateEngine],
) -> dict[str, CompiledTemplate]:
    """Compile templates for all engines that participate in *scenario*.

    Returns a dict mapping engine name → compiled render callable.
    Engines whose name is not present in ``scenario.templates`` are skipped.
    """
    compiled: dict[str, CompiledTemplate] = {}
    for engine in engines:
        source = scenario.templates.get(engine.name)
        if source is not None:
            compiled[engine.name] = engine.compile(source)
    return compiled


def verify_outputs(
    scenario: Scenario,
    compiled: dict[str, CompiledTemplate],
) -> None:
    """Verify all engines produce equivalent output for *scenario*.

    Uses the reference engine's output as the ground truth.
    """
    ref_render = compiled.get(REFERENCE_ENGINE)
    if ref_render is None:
        log.warning(
            "Reference engine '%s' not found for scenario '%s'; skipping verification",
            REFERENCE_ENGINE,
            scenario.name,
        )
        return

    ref_output = ref_render(**scenario.render_kwargs)

    for eng_name, render_fn in compiled.items():
        if eng_name == REFERENCE_ENGINE:
            continue
        eng_output = render_fn(**scenario.render_kwargs)
        assert_outputs_equal(
            ref_output,
            eng_output,
            scenario.name,
            REFERENCE_ENGINE,
            eng_name,
        )
    print(f"  ✓ {scenario.name}: outputs match ({len(ref_output)} chars)")


def benchmark_scenario(
    scenario: Scenario,
    compiled: dict[str, CompiledTemplate],
) -> dict[str, BenchResult]:
    """Benchmark all engines for a single scenario.

    Returns a dict mapping engine name → BenchResult.
    """
    results: dict[str, BenchResult] = {}
    for eng_name, render_fn in compiled.items():
        results[eng_name] = bench_render(
            scenario.name,
            eng_name,
            lambda fn=render_fn, kw=scenario.render_kwargs: fn(**kw),
            ITERATIONS,
        )
    return results


def bench_compile(
    scenario: Scenario,
    engines: list[TemplateEngine],
) -> dict[str, BenchResult]:
    """Benchmark template compilation time for each engine."""
    results: dict[str, BenchResult] = {}
    for engine in engines:
        source = scenario.templates.get(engine.name)
        if source is None:
            continue
        results[engine.name] = bench_render(
            scenario.name,
            engine.name,
            lambda eng=engine, src=source: eng.compile(src),
            COMPILE_ITERATIONS,
        )
    return results


def bench_compile_and_render(
    scenario: Scenario,
    engines: list[TemplateEngine],
) -> dict[str, BenchResult]:
    """Benchmark end-to-end template compilation and rendering."""
    results: dict[str, BenchResult] = {}
    for engine in engines:
        source = scenario.templates.get(engine.name)
        if source is None:
            continue

        # Closure that compiles and then immediately renders.
        def run(eng: TemplateEngine = engine, src: str = source, kw: dict[str, Any] = scenario.render_kwargs) -> Any:
            return eng.compile(src)(**kw)

        results[engine.name] = bench_render(
            scenario.name,
            engine.name,
            run,
            COMPILE_ITERATIONS,
        )
    return results


def main() -> None:
    """Run all benchmark scenarios and print results."""
    logging.basicConfig(level=logging.WARNING)

    engine_names = [e.name for e in ALL_ENGINES]

    # ---- Compile & verify ----
    print("Compiling templates and verifying outputs...")
    all_compiled: dict[str, dict[str, CompiledTemplate]] = {}

    for scenario in SCENARIOS:
        compiled = compile_all_for_scenario(scenario, ALL_ENGINES)
        all_compiled[scenario.name] = compiled
        verify_outputs(scenario, compiled)

    # ---- Benchmark: Compile ----
    print("\nBenchmarking compile time...")
    compile_results: dict[str, dict[str, BenchResult]] = {}

    for scenario in SCENARIOS:
        compile_results[scenario.name] = bench_compile(
            scenario,
            ALL_ENGINES,
        )
        print(f"  ✓ {scenario.name}")

    print("\n" + "=" * 60)
    print("COMPILE TIME (parsing template source → compiled object)")
    print("=" * 60)
    print_results(engine_names, compile_results)

    # ---- Benchmark: Render ----
    print("Benchmarking render time...")
    all_results: dict[str, dict[str, BenchResult]] = {}

    for scenario in SCENARIOS:
        compiled = all_compiled[scenario.name]
        all_results[scenario.name] = benchmark_scenario(scenario, compiled)
        print(f"  ✓ {scenario.name}")

    print("\n" + "=" * 60)
    print("RENDER TIME (pre-compiled template + data → output string)")
    print("=" * 60)
    print_results(engine_names, all_results)

    # ---- Benchmark: Compile + Render ----
    print("\nBenchmarking compile + render end-to-end...")
    end_to_end_results: dict[str, dict[str, BenchResult]] = {}

    for scenario in SCENARIOS:
        end_to_end_results[scenario.name] = bench_compile_and_render(
            scenario,
            ALL_ENGINES,
        )
        print(f"  ✓ {scenario.name}")

    print("\n" + "=" * 60)
    print("COMPILE + RENDER TIME (source → compiled → output string)")
    print("=" * 60)
    print_results(engine_names, end_to_end_results)


if __name__ == "__main__":
    main()
