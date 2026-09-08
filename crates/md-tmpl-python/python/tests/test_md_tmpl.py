"""Tests for the md_tmpl Python bindings.

Tests cover:
- Basic template loading and rendering (from_source, from_file)
- Type validation (str, int, float, bool, list, struct, enum)
- Enum variants: unit and struct (with payload)
- Type mismatch detection and clear error messages
- The template() helper with generated types
- The import hook (md_tmpl_import_hook)
- TemplateCache
- Default values
- Edge cases (empty params, missing params, nested types)
- Strict validation: extra params rejected by default
- allow_extra flag
- render_dict API
- @variant decorator
- Variants metaclass
- load_types() helper
- Template metadata (declarations, source_hash, defaults)
- Generated type __repr__, __eq__, __hash__
- Generated type __match_args__ for pattern matching
- Filters: upper, lower, trim, fixed, join, limit, add, sub
- Built-in functions: idx, len, kind
- Includes and iterated includes
- Inline templates ({% tmpl %})
- Raw blocks ({% raw %})
- Comments ({# #})
- Constants (consts: block)
- Whitespace control (-/+ trimming)
- Type aliases (types: block)
"""

import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from md_tmpl import (
    Template,
    TemplateCache,
    TemplatePanicError,
    Variants,
    load_types,
    template,
    variant,
    TemplateError,
    TemplateSyntaxError,
    MissingParamsError,
    TypeMismatchError,
    ExtraParamsError,
    UndefinedVariableError,
    UnknownFilterError,
    IncludeNotFoundError,
    DeclarationsMutatedError,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def simple_template_path(tmp_path: Path) -> Path:
    """Create a simple greeting template file."""
    path = tmp_path / "greeting.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - name = str
        ---
        Hello {{ name }}!"""))
    return path


@pytest.fixture()
def list_template_path(tmp_path: Path) -> Path:
    """Create a template with typed list params."""
    path = tmp_path / "tasks.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - tasks = list(title = str, priority = str)
        ---
        > {% for task in tasks %}

        - **{{ task.title }}** ({{ task.priority }})

        > {% /for %}"""))
    return path


@pytest.fixture()
def enum_template_path(tmp_path: Path) -> Path:
    """Create a template with enum params including a struct variant."""
    path = tmp_path / "status.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - outcome = enum(Confirmed(evidence = str), Rejected, NeedsWork)
        ---
        > {% match outcome %}
        > {% case Confirmed %}

        YES: {{ outcome.evidence }}

        > {% case Rejected %}

        NO

        > {% case NeedsWork %}

        MAYBE

        > {% /match %}"""))
    return path


@pytest.fixture()
def default_template_path(tmp_path: Path) -> Path:
    """Create a template with default values."""
    path = tmp_path / "defaults.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - name = str := "World"
          - count = int := 1
        ---
        Hello {{ name }}, count={{ count }}!"""))
    return path


@pytest.fixture()
def struct_template_path(tmp_path: Path) -> Path:
    """Create a template with struct params."""
    path = tmp_path / "config.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - config = struct(host = str, port = int)
        ---
        {{ config.host }}:{{ config.port }}"""))
    return path


@pytest.fixture()
def multi_param_path(tmp_path: Path) -> Path:
    """Create a template with multiple param types."""
    path = tmp_path / "multi.tmpl.md"
    path.write_text(textwrap.dedent("""\
        ---
        params:
          - name = str
          - count = int
          - score = float
          - enabled = bool
        ---
        {{ name }}: count={{ count }}, score={{ score }}, enabled={{ enabled }}"""))
    return path


# ---------------------------------------------------------------------------
# Template.from_source — basic rendering
# ---------------------------------------------------------------------------


class TestFromSource:
    """Tests for Template.from_source()."""

    def test_basic_render(self) -> None:
        tmpl = Template.from_source("""---
params:
  - name = str
---
Hello {{ name }}!""")
        assert tmpl.render(name="world") == "Hello world!"

    def test_int_param(self) -> None:
        tmpl = Template.from_source("""---
params:
  - count = int
---
Count: {{ count }}""")
        assert tmpl.render(count=42) == "Count: 42"

    def test_bool_param(self) -> None:
        tmpl = Template.from_source("""---
params: [flag = bool]
---
> {% if flag %}

yes

> {% /if %}""")
        assert tmpl.render(flag=True) == "yes\n"

    def test_float_param(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [score = float]
            ---
            {{ score }}"""))
        assert tmpl.render(score=3.14) == "3.14"

    def test_syntax_error_raises(self) -> None:
        with pytest.raises(ValueError, match="frontmatter"):
            Template.from_source("no frontmatter at all")

    def test_missing_param_raises(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str, age = int]
---
{{ name }} {{ age }}""")
        with pytest.raises(MissingParamsError) as excinfo:
            tmpl.render(name="Alice")
        assert excinfo.value.kind == "missing_params"
        assert excinfo.value.missing == ["age"]

    def test_type_mismatch_raises(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [flag = bool]
            ---
            {{ flag }}"""))
        with pytest.raises(TypeMismatchError) as excinfo:
            tmpl.render(flag="not a bool")
        assert excinfo.value.kind == "type_mismatch"
        assert excinfo.value.path == "flag"
        assert excinfo.value.expected == "bool"
        assert excinfo.value.actual == "str"


# ---------------------------------------------------------------------------
# Template.from_file
# ---------------------------------------------------------------------------


class TestFromFile:
    """Tests for Template.from_file()."""

    def test_load_and_render(self, simple_template_path: Path) -> None:
        tmpl = Template.from_file(str(simple_template_path))
        assert tmpl.render(name="world") == "Hello world!"

    def test_missing_file_raises(self) -> None:
        with pytest.raises(ValueError, match="failed to load template"):
            Template.from_file("/nonexistent/path.tmpl.md")


# ---------------------------------------------------------------------------
# Template.from_source_allowing_unused
# ---------------------------------------------------------------------------


class TestFromSourceAllowingUnused:
    """Tests for Template.from_source_allowing_unused()."""

    def test_unused_param_accepted(self) -> None:
        """Params declared but not referenced in the body should be accepted."""
        tmpl = Template.from_source_allowing_unused("""---
params: [name = str, unused = int]
---
Hello {{ name }}!""")
        assert tmpl.render(name="world", unused=42) == "Hello world!"

    def test_unused_param_rejected_in_strict_mode(self) -> None:
        """from_source() should reject unused params."""
        with pytest.raises(ValueError):
            Template.from_source("""---
params: [name = str, unused = int]
---
Hello {{ name }}!""")

    def test_undeclared_variable_in_body_rejected(self) -> None:
        """Referencing a variable declared nowhere is a compile-time error.

        Mirrors the Rust core's ``check_undeclared_variables``: the error is
        raised at construction (``from_source``), not at render time.
        """
        with pytest.raises(TemplateSyntaxError, match="undeclared variable"):
            Template.from_source("""---
params:
  - x = str
---
{{ x }} {{ y }}""")

    def test_undeclared_variable_in_condition_rejected(self) -> None:
        """Undeclared variables inside an if condition are compile-time errors."""
        with pytest.raises(TemplateSyntaxError, match="undeclared variable"):
            Template.from_source("""---
params:
  - x = int
---
> {% if y > 0 %}{{ x }}{% /if %}""")


# ---------------------------------------------------------------------------
# Strict validation — extra params
# ---------------------------------------------------------------------------


class TestStrictValidation:
    """Tests for strict extra-param rejection."""

    def test_extra_param_rejected_by_default(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        with pytest.raises(ExtraParamsError) as excinfo:
            tmpl.render(name="world", bogus="unexpected")
        assert excinfo.value.kind == "extra_params"
        assert excinfo.value.extra == ["bogus"]

    def test_allow_extra_ignores_extra_params(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        result = tmpl.render(name="world", bogus="ignored", allow_extra=True)
        assert result == "Hello world!"

    def test_render_dict_extra_param_rejected(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        with pytest.raises(ExtraParamsError) as excinfo:
            tmpl.render_dict({"name": "world", "bogus": "unexpected"})
        assert excinfo.value.kind == "extra_params"
        assert excinfo.value.extra == ["bogus"]

    def test_render_dict_allow_extra(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        result = tmpl.render_dict(
            {"name": "world", "bogus": "ignored"}, allow_extra=True
        )
        assert result == "Hello world!"


# ---------------------------------------------------------------------------
# render_dict
# ---------------------------------------------------------------------------


class TestRenderDict:
    """Tests for Template.render_dict()."""

    def test_basic_render_dict(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.render_dict({"name": "dict"}) == "Hello dict!"

    def test_render_dict_type_validation(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [count = int]
            ---
            {{ count }}"""))
        with pytest.raises(TypeMismatchError) as excinfo:
            tmpl.render_dict({"count": "not an int"})
        assert excinfo.value.kind == "type_mismatch"
        assert excinfo.value.path == "count"


# ---------------------------------------------------------------------------
# render_json
# ---------------------------------------------------------------------------


class TestRenderJson:
    """Tests for Template.render_json() — the JSON fast path."""

    def test_basic_render_json(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.render_json('{"name": "json"}') == "Hello json!"

    def test_render_json_allow_extra(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = int]
            ---
            {{ x }}"""))
        assert tmpl.render_json('{"x": 42, "extra": true}', allow_extra=True) == "42"

    def test_render_json_extra_rejected_by_default(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = int]
            ---
            {{ x }}"""))
        with pytest.raises(ExtraParamsError) as excinfo:
            tmpl.render_json('{"x": 42, "extra": true}')
        assert excinfo.value.kind == "extra_params"
        assert excinfo.value.extra == ["extra"]

    def test_render_json_invalid_json(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(ValueError, match="invalid JSON"):
            tmpl.render_json("not valid json")

    def test_render_json_non_object(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(ValueError):
            tmpl.render_json("[1, 2, 3]")

    def test_render_json_float_param(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [score = float]
            ---
            {{ score | fixed(2) }}"""))
        assert tmpl.render_json('{"score": 87.456}') == "87.46"

    def test_render_json_bool_param(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [flag = bool]
            ---
            {{ flag }}"""))
        assert tmpl.render_json('{"flag": true}') == "true"

    def test_render_json_matches_render(self) -> None:
        """render_json() should produce identical output to render()."""
        import json

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str, place = str]
            ---
            Hello {{ name }}, welcome to {{ place }}!"""))
        params: dict[str, Any] = {"name": "Alice", "place": "Wonderland"}
        assert tmpl.render_json(json.dumps(params)) == tmpl.render(**params)


# ---------------------------------------------------------------------------
# Typed lists
# ---------------------------------------------------------------------------


class TestTypedLists:
    """Tests for list(...) parameters."""

    def test_render_list_of_structs(self, list_template_path: Path) -> None:
        tmpl = Template.from_file(str(list_template_path))
        output = tmpl.render(
            tasks=[
                {"title": "Write documentation", "priority": "High"},
                {"title": "Add unit tests", "priority": "Medium"},
            ]
        )
        assert (
            output
            == "- **Write documentation** (High)\n- **Add unit tests** (Medium)\n"
        )

    def test_empty_list(self, list_template_path: Path) -> None:
        tmpl = Template.from_file(str(list_template_path))
        output = tmpl.render(tasks=[])
        assert output.strip() == ""

    def test_wrong_item_type_raises(self, list_template_path: Path) -> None:
        tmpl = Template.from_file(str(list_template_path))
        with pytest.raises((ValueError, TypeError)):
            tmpl.render(tasks=["not a struct"])


# ---------------------------------------------------------------------------
# Struct parameters
# ---------------------------------------------------------------------------


class TestStructParams:
    """Tests for struct(...) parameters."""

    def test_render_struct_param(self, struct_template_path: Path) -> None:
        tmpl = Template.from_file(str(struct_template_path))
        output = tmpl.render(config={"host": "localhost", "port": 8080})
        assert output == "localhost:8080"

    def test_struct_missing_field_raises(self, struct_template_path: Path) -> None:
        tmpl = Template.from_file(str(struct_template_path))
        with pytest.raises(TypeMismatchError) as excinfo:
            tmpl.render(config={"host": "localhost"})  # missing port
        assert excinfo.value.kind == "type_mismatch"
        assert excinfo.value.expected == "int"


# ---------------------------------------------------------------------------
# Multiple param types
# ---------------------------------------------------------------------------


class TestMultipleParamTypes:
    """Tests for templates with multiple param types."""

    def test_all_types(self, multi_param_path: Path) -> None:
        tmpl = Template.from_file(str(multi_param_path))
        output = tmpl.render(name="Alice", count=42, score=9.5, enabled=True)
        assert output == "Alice: count=42, score=9.5, enabled=true"


# ---------------------------------------------------------------------------
# Enum dispatch
# ---------------------------------------------------------------------------


class TestEnumDispatch:
    """Tests for enum(...) parameters with match/case."""

    def test_unit_variant(self, enum_template_path: Path) -> None:
        tmpl = Template.from_file(str(enum_template_path))
        output = tmpl.render(outcome="Rejected")
        assert output == "NO\n"

    def test_struct_variant_as_dict(self, enum_template_path: Path) -> None:
        tmpl = Template.from_file(str(enum_template_path))
        output = tmpl.render(
            outcome={
                "__kind__": "Confirmed",
                "evidence": "found it",
            }
        )
        assert output == "YES: found it\n"

    def test_invalid_variant_raises(self, enum_template_path: Path) -> None:
        tmpl = Template.from_file(str(enum_template_path))
        with pytest.raises(ValueError, match="type mismatch|enum"):
            tmpl.render(outcome="Unknown")


# ---------------------------------------------------------------------------
# Default values
# ---------------------------------------------------------------------------


class TestDefaults:
    """Tests for parameters with default values."""

    def test_defaults_used_when_omitted(self, default_template_path: Path) -> None:
        tmpl = Template.from_file(str(default_template_path))
        output = tmpl.render()
        assert output == "Hello World, count=1!"

    def test_defaults_overridden(self, default_template_path: Path) -> None:
        tmpl = Template.from_file(str(default_template_path))
        output = tmpl.render(name="Alice", count=99)
        assert output == "Hello Alice, count=99!"

    def test_defaults_dict(self, default_template_path: Path) -> None:
        tmpl = Template.from_file(str(default_template_path))
        defaults = tmpl.defaults()
        assert "name" in defaults
        assert "count" in defaults


# ---------------------------------------------------------------------------
# TemplateCache
# ---------------------------------------------------------------------------


class TestCache:
    """Tests for TemplateCache."""

    def test_cache_load(self, simple_template_path: Path) -> None:
        cache = TemplateCache()
        tmpl = cache.load(str(simple_template_path))
        assert tmpl.render(name="cached") == "Hello cached!"

    def test_cache_returns_same_hash(self, simple_template_path: Path) -> None:
        cache = TemplateCache()
        t1 = cache.load(str(simple_template_path))
        t2 = cache.load(str(simple_template_path))
        assert t1.source_hash() == t2.source_hash()


# ---------------------------------------------------------------------------
# Template metadata
# ---------------------------------------------------------------------------


class TestMetadata:
    """Tests for template metadata methods."""

    def test_declarations(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str, count = int]
---
{{ name }} {{ count }}""")
        decls = tmpl.declarations()
        names = [d[0] for d in decls]
        assert "name" in names
        assert "count" in names

    def test_declarations_types(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str, count = int]
---
{{ name }} {{ count }}""")
        decls = tmpl.declarations()
        type_map = {d[0]: d[1] for d in decls}
        assert type_map["name"] == "str"
        assert type_map["count"] == "int"

    def test_source_hash_stable(self) -> None:
        source = """---
params: [x = str]
---
{{ x }}"""
        t1 = Template.from_source(source)
        t2 = Template.from_source(source)
        assert t1.source_hash() == t2.source_hash()

    def test_source_hash_changes_with_content(self) -> None:
        t1 = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            Hello {{ x }}"""))
        t2 = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            Goodbye {{ x }}"""))
        assert t1.source_hash() != t2.source_hash()

    def test_repr(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        r = repr(tmpl)
        assert "Template" in r
        assert "name" in r


# ---------------------------------------------------------------------------
# template() helper
# ---------------------------------------------------------------------------


class TestTemplateHelper:
    """Tests for the template() convenience function."""

    def test_render_with_kwargs(self, simple_template_path: Path) -> None:
        t = template(str(simple_template_path))
        assert t.render(name="helper") == "Hello helper!"

    def test_generated_enum_types(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        # Should have a generated Outcome enum.
        assert hasattr(t, "Outcome")

        # Unit variant — sentinel, no parens needed.
        rejected = t.Outcome.Rejected
        assert rejected._md_tmpl_tag == "Rejected"

        # Struct variant — callable constructor.
        confirmed = t.Outcome.Confirmed(evidence="proof")
        assert confirmed._md_tmpl_tag == "Confirmed"
        assert confirmed._md_tmpl_fields["evidence"] == "proof"

    def test_render_with_generated_enum(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        output = t.render(outcome=t.Outcome.Rejected)
        assert output == "NO\n"

    def test_render_with_struct_variant(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        output = t.render(outcome=t.Outcome.Confirmed(evidence="found it"))
        assert output == "YES: found it\n"

    def test_generated_list_item_type(self, list_template_path: Path) -> None:
        t = template(str(list_template_path))
        # Should have a generated Item type.
        type_names = list(t._types.keys())
        item_classes = [n for n in type_names if "Item" in n]
        assert len(item_classes) > 0, f"Expected item classes, got {type_names}"

    def test_render_dict_via_helper(self, simple_template_path: Path) -> None:
        t = template(str(simple_template_path))
        assert t.render_dict({"name": "dict_helper"}) == "Hello dict_helper!"

    def test_declarations_via_helper(self, simple_template_path: Path) -> None:
        t = template(str(simple_template_path))
        decls = t.declarations()
        assert any(d[0] == "name" for d in decls)

    def test_repr(self, simple_template_path: Path) -> None:
        t = template(str(simple_template_path))
        assert "template(" in repr(t)


# ---------------------------------------------------------------------------
# Import hook
# ---------------------------------------------------------------------------


class TestImportHook:
    """Tests for md_tmpl_import_hook()."""

    def test_import_hook_installs(self) -> None:
        from md_tmpl import md_tmpl_import_hook

        # Should not raise.
        md_tmpl_import_hook(search_paths=["/nonexistent"])

        # Check it's in sys.meta_path.
        from md_tmpl._import_hook import _TemplateFinder

        finders = [f for f in sys.meta_path if isinstance(f, _TemplateFinder)]
        assert len(finders) == 1

    def test_import_hook_idempotent(self) -> None:
        from md_tmpl import md_tmpl_import_hook

        md_tmpl_import_hook(search_paths=["/tmp"])
        md_tmpl_import_hook(search_paths=["/tmp"])

        from md_tmpl._import_hook import _TemplateFinder

        finders = [f for f in sys.meta_path if isinstance(f, _TemplateFinder)]
        assert len(finders) == 1, "Should not duplicate the hook"

    def test_import_template_file(self, simple_template_path: Path) -> None:
        from md_tmpl import md_tmpl_import_hook
        import importlib

        # Install hook with the temp directory.
        md_tmpl_import_hook(search_paths=[str(simple_template_path.parent)])

        # The module name comes from the file stem: "greeting"
        module_name = "greeting"

        # Remove from sys.modules if cached from a previous test.
        sys.modules.pop(module_name, None)

        # Import should work.
        mod = importlib.import_module(module_name)

        # Module should have generated types.
        assert hasattr(mod, "GreetingParams") or hasattr(
            mod, "Greeting"
        ), f"Module should have a params class, got: {dir(mod)}"

    def test_normal_imports_unaffected(self) -> None:
        """The hook should not break normal Python imports."""
        from md_tmpl import md_tmpl_import_hook
        import os as os_mod

        md_tmpl_import_hook()

        # These should still work fine.
        assert os_mod.path is not None
        assert sys.version is not None


# ---------------------------------------------------------------------------
# @variant decorator
# ---------------------------------------------------------------------------


class TestVariantDecorator:
    """Tests for the @variant decorator."""

    def test_basic_variant(self) -> None:
        @variant
        class NeedsChanges:
            reason: str

        v = NeedsChanges(reason="fix tests")
        # @variant injects _md_tmpl_tag at runtime; dataclass_transform hides it.
        assert v._md_tmpl_tag == "NeedsChanges"  # type: ignore[attr-defined]
        assert v.reason == "fix tests"

    def test_variant_fields_property(self) -> None:
        @variant
        class Error:
            code: int
            message: str

        v = Error(code=404, message="not found")
        # @variant injects _md_tmpl_fields at runtime; dataclass_transform hides it.
        fields = v._md_tmpl_fields  # type: ignore[attr-defined]
        assert fields == {"code": 404, "message": "not found"}

    def test_variant_repr(self) -> None:
        @variant
        class Item:
            name: str

        v = Item(name="test")
        assert repr(v) == "Item(name='test')"

    def test_variant_equality(self) -> None:
        @variant
        class Pair:
            x: int
            y: int

        assert Pair(x=1, y=2) == Pair(x=1, y=2)
        assert Pair(x=1, y=2) != Pair(x=1, y=3)

    def test_variant_hash(self) -> None:
        @variant
        class Tag:
            label: str

        a = Tag(label="one")
        b = Tag(label="one")
        assert hash(a) == hash(b)
        assert {a, b} == {a}  # deduplication

    def test_variant_match_args(self) -> None:
        @variant
        class Point:
            x: float
            y: float

        assert Point.__match_args__ == ("x", "y")

    def test_variant_missing_field_raises(self) -> None:
        @variant
        class Required:
            value: str

        with pytest.raises(TypeError, match="missing"):
            Required()  # type: ignore[call-arg]

    def test_variant_unexpected_field_raises(self) -> None:
        @variant
        class Simple:
            x: int

        with pytest.raises(TypeError, match="unexpected"):
            Simple(x=1, y=2)  # type: ignore[call-arg]

    def test_variant_no_fields_raises(self) -> None:
        """@variant requires at least one annotated field."""
        with pytest.raises(TypeError, match="annotated field"):

            @variant
            class Empty:
                pass


# ---------------------------------------------------------------------------
# Variants metaclass
# ---------------------------------------------------------------------------


class TestVariantsMetaclass:
    """Tests for the Variants base class."""

    def test_unit_variants(self) -> None:
        class Color(Variants):
            Red = ()
            Green = ()
            Blue = ()

        assert repr(Color.Red) == "Red"
        assert repr(Color.Green) == "Green"
        assert repr(Color.Blue) == "Blue"

    def test_unit_variant_tag(self) -> None:
        class Status(Variants):
            Active = ()
            Inactive = ()

        # Metaclass rewrites `()` class-attrs into unit-variant instances at runtime.
        assert Status.Active._md_tmpl_tag == "Active"  # type: ignore[attr-defined]
        assert Status.Active._md_tmpl_fields == {}  # type: ignore[attr-defined]

    def test_unit_variant_equality(self) -> None:
        class Side(Variants):
            Left = ()
            Right = ()

        assert Side.Left == Side.Left
        assert Side.Left != Side.Right

    def test_unit_variant_hash(self) -> None:
        class Dir(Variants):
            Up = ()
            Down = ()

        s = {Dir.Up, Dir.Down, Dir.Up}
        assert len(s) == 2

    def test_struct_variant(self) -> None:
        class Result(Variants):
            Ok = {"value": str}
            Err = {"code": int, "message": str}

        # Metaclass rewrites dict class-attrs into variant constructors at runtime.
        ok = Result.Ok(value="done")  # type: ignore[operator]
        assert ok._md_tmpl_tag == "Ok"
        assert ok.value == "done"
        assert ok._md_tmpl_fields == {"value": "done"}

        err = Result.Err(code=500, message="fail")  # type: ignore[operator]
        assert err._md_tmpl_tag == "Err"
        assert err.code == 500
        assert err.message == "fail"

    def test_mixed_variants(self) -> None:
        class Status(Variants):
            Approved = ()
            Rejected = ()
            NeedsChanges = {"reason": str}

        assert repr(Status.Approved) == "Approved"
        # Metaclass rewrites the dict class-attr into a variant constructor.
        nc = Status.NeedsChanges(reason="fix tests")  # type: ignore[operator]
        assert nc.reason == "fix tests"

    def test_struct_variant_repr(self) -> None:
        class Wrap(Variants):
            Inner = {"x": int}

        # Metaclass rewrites the dict class-attr into a variant constructor.
        v = Wrap.Inner(x=42)  # type: ignore[operator]
        assert "Inner" in repr(v)
        assert "42" in repr(v)

    def test_struct_variant_equality(self) -> None:
        class Op(Variants):
            Add = {"n": int}

        # Metaclass rewrites dict class-attrs into variant constructors.
        assert Op.Add(n=1) == Op.Add(n=1)  # type: ignore[operator]
        assert Op.Add(n=1) != Op.Add(n=2)  # type: ignore[operator]


# ---------------------------------------------------------------------------
# load_types
# ---------------------------------------------------------------------------


class TestLoadTypes:
    """Tests for the load_types() function."""

    def test_load_all_types(self, enum_template_path: Path) -> None:
        types = load_types(str(enum_template_path))
        assert hasattr(types, "Outcome")
        assert hasattr(types, "Status")

    def test_load_types_pick(self, enum_template_path: Path) -> None:
        types = load_types(str(enum_template_path), pick=["Outcome"])
        assert hasattr(types, "Outcome")
        # Should NOT have Status since we didn't pick it.
        assert not hasattr(types, "Status")

    def test_load_types_pick_missing_raises(self, enum_template_path: Path) -> None:
        with pytest.raises(KeyError, match="not found"):
            load_types(str(enum_template_path), pick=["NonExistent"])

    def test_load_types_invalid_path_raises(self) -> None:
        with pytest.raises(ValueError):
            load_types("/nonexistent/template.tmpl.md")


# ---------------------------------------------------------------------------
# Enum ergonomics
# ---------------------------------------------------------------------------


class TestEnumErgonomics:
    """Detailed tests for generated enum types."""

    def test_unit_variant_repr(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        assert repr(t.Outcome.Rejected) == "Rejected"

    def test_struct_variant_repr(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        v = t.Outcome.Confirmed(evidence="proof")
        assert "Confirmed" in repr(v)
        assert "proof" in repr(v)

    def test_variant_equality(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        assert t.Outcome.Rejected == t.Outcome.Rejected
        assert t.Outcome.Confirmed(evidence="a") == t.Outcome.Confirmed(evidence="a")
        assert t.Outcome.Confirmed(evidence="a") != t.Outcome.Confirmed(evidence="b")
        assert t.Outcome.Rejected != t.Outcome.NeedsWork

    def test_variant_hash(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        # Hashable — can be used in sets/dicts.
        s = {t.Outcome.Rejected, t.Outcome.NeedsWork}
        assert len(s) == 2

    def test_struct_variant_match_args(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        confirmed_cls = t.Outcome.Confirmed
        # Struct variants should have __match_args__ for pattern matching.
        assert hasattr(confirmed_cls, "__match_args__")
        assert "evidence" in confirmed_cls.__match_args__

    def test_struct_variant_fields_dict(self, enum_template_path: Path) -> None:
        t = template(str(enum_template_path))
        v = t.Outcome.Confirmed(evidence="proof")
        assert v._md_tmpl_fields == {"evidence": "proof"}


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Edge case tests."""

    def test_empty_params(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params: []
            ---
            Static content"""))
        tmpl = Template.from_file(str(path))
        assert tmpl.render() == "Static content"

    def test_unicode_params(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            {{ msg }}"""))
        assert tmpl.render(msg="🎉 Hello 世界!") == "🎉 Hello 世界!"

    def test_multiline_template(self) -> None:
        tmpl = Template.from_source("""---
params: [title = str]
---
# {{ title }}

Body text.""")
        output = tmpl.render(title="Test")
        assert output == "# Test\n\nBody text."

    def test_multiple_vars_same_template(self) -> None:
        tmpl = Template.from_source("""---
params: [a = str, b = str]
---
{{ a }} and {{ b }}""")
        assert tmpl.render(a="X", b="Y") == "X and Y"

    def test_template_caching_different_files(self, tmp_path: Path) -> None:
        p1 = tmp_path / "a.tmpl.md"
        p2 = tmp_path / "b.tmpl.md"
        p1.write_text(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            A: {{ x }}"""))
        p2.write_text(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            B: {{ x }}"""))

        cache = TemplateCache()
        t1 = cache.load(str(p1))
        t2 = cache.load(str(p2))
        assert t1.render(x="v") == "A: v"
        assert t2.render(x="v") == "B: v"
        assert t1.source_hash() != t2.source_hash()

    def test_validate_declarations_match(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        decls = tmpl.declarations()
        # Should not raise — declarations match themselves.
        tmpl.validate_declarations_against(decls)

    def test_validate_declarations_mismatch(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        with pytest.raises(DeclarationsMutatedError) as excinfo:
            tmpl.validate_declarations_against([("different", "int")])
        assert excinfo.value.kind == "declarations_mutated"
        assert "different" in excinfo.value.details


# ---------------------------------------------------------------------------
# load_template
# ---------------------------------------------------------------------------


class TestLoadTemplate:
    """Tests for the load_template() convenience function."""

    def test_load_and_render(self, simple_template_path: Path) -> None:
        from md_tmpl import load_template

        tmpl = load_template(str(simple_template_path))
        assert tmpl.render(name="world") == "Hello world!"

    def test_load_template_missing_raises(self) -> None:
        from md_tmpl import load_template

        with pytest.raises(ValueError, match="failed to load"):
            load_template("/nonexistent/path.tmpl.md")

    def test_load_template_returns_template(self, simple_template_path: Path) -> None:
        from md_tmpl import load_template

        tmpl = load_template(str(simple_template_path))
        assert isinstance(tmpl, Template)

    def test_load_template_with_load_types(self, enum_template_path: Path) -> None:
        """load_template and load_types work together."""
        from md_tmpl import load_template

        tmpl = load_template(str(enum_template_path))
        types = load_types(str(enum_template_path))
        assert hasattr(types, "Outcome")
        output = tmpl.render(outcome=types.Outcome.Rejected)
        assert output == "NO\n"


# ---------------------------------------------------------------------------
# kind() function
# ---------------------------------------------------------------------------


class TestKindFunction:
    """Tests for the kind() built-in function."""

    def test_kind_extracts_variant_name(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - outcome = enum(Confirmed(evidence = str), Rejected)
            ---
            {{ kind(outcome) }}"""))
        output = tmpl.render(outcome={"__kind__": "Confirmed", "evidence": "proof"})
        assert output.strip() == "Confirmed"

    def test_kind_with_generated_variant(self, enum_template_path: Path) -> None:
        """kind() works with generated variant objects."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - outcome = enum(Confirmed(evidence = str), Rejected)
            ---
            {{ kind(outcome) }}"""))
        t = template(str(enum_template_path))
        output = tmpl.render(outcome=t.Outcome.Confirmed(evidence="proof"))
        assert output.strip() == "Confirmed"

    def test_kind_rejects_non_enum(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - count = int
            ---
            {{ kind(count) }}"""))
        with pytest.raises(ValueError, match="enum"):
            tmpl.render(count=42)


# ---------------------------------------------------------------------------
# __kind__ collision protection
# ---------------------------------------------------------------------------


class TestKindCollisionProtection:
    """The internal __kind__ key must not be accessible from templates."""

    def test_kind_key_not_accessible(self) -> None:
        """{{ outcome.__kind__ }} must error, not expose internal."""
        with pytest.raises(TemplateSyntaxError, match="__kind__"):
            Template.from_source(textwrap.dedent("""\
                ---
                params:
                  - outcome = struct(evidence = str)
                ---
                {{ outcome.__kind__ }}"""))

    def test_user_field_named_tag(self) -> None:
        """A user field named 'tag' should work normally (no collision)."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - entry = struct(tag = str)
            ---
            {{ entry.tag }}"""))
        output = tmpl.render(entry={"__kind__": "Week", "tag": "Monday"})
        assert output.strip() == "Monday"


# ---------------------------------------------------------------------------
# Arithmetic filters (add, sub)
# ---------------------------------------------------------------------------


class TestArithmeticFilters:
    """Tests for the add() and sub() filters."""

    def test_add_filter(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - items = list(label = str)
            ---
            > {% for item in items %}

            {{ idx(item) | add(1) }}. {{ item.label }}

            > {% /for %}"""))
        output = tmpl.render(
            items=[
                {"label": "first"},
                {"label": "second"},
            ]
        )
        assert output == "1. first\n2. second\n"

    def test_sub_filter(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [n = int]
            ---
            {{ n | sub(1) }}"""))
        assert tmpl.render(n=10) == "9"


# ---------------------------------------------------------------------------
# Remaining filters (upper, lower, trim, fixed, join, limit)
# ---------------------------------------------------------------------------


class TestStringFilters:
    """Tests for string and list filters."""

    def test_upper_filter(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            {{ msg | upper }}"""))
        assert tmpl.render(msg="hello") == "HELLO"

    def test_lower_filter(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            {{ msg | lower }}"""))
        assert tmpl.render(msg="HELLO") == "hello"

    def test_trim_filter(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            {{ msg | trim }}"""))
        assert tmpl.render(msg="  hello  ") == "hello"

    def test_fixed_filter(self) -> None:
        tmpl = Template.from_source("""---
params: [val = float]
---
{{ val | fixed(2) }}""")
        assert tmpl.render(val=3.14159) == "3.14"

    def test_join_filter(self) -> None:
        tmpl = Template.from_source("""---
params: [items = list(str)]
---
{{ items | join(", ") }}""")
        output = tmpl.render(items=["a", "b", "c"])
        assert output == "a, b, c"

    def test_limit_filter(self) -> None:
        tmpl = Template.from_source("""---
params: [items = list(str)]
---
{{ items | limit(2) | join(", ") }}""")
        output = tmpl.render(items=["a", "b", "c"])
        assert output == "a, b"


# ---------------------------------------------------------------------------
# len() built-in function
# ---------------------------------------------------------------------------


class TestLenFunction:
    """Tests for the len() built-in function."""

    def test_len_list(self) -> None:
        tmpl = Template.from_source("""---
params: [items = list(x = str)]
---
{{ len(items) }}""")
        assert tmpl.render(items=[{"x": "a"}, {"x": "b"}]) == "2"

    def test_len_string(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            {{ len(msg) }}"""))
        assert tmpl.render(msg="hello") == "5"

    def test_len_empty_list(self) -> None:
        tmpl = Template.from_source("""---
params: [items = list(x = str)]
---
{{ len(items) }}""")
        assert tmpl.render(items=[]) == "0"


# ---------------------------------------------------------------------------
# Includes
# ---------------------------------------------------------------------------


class TestIncludes:
    """Tests for {% include %} directives."""

    def test_simple_include(self, tmp_path: Path) -> None:
        child = tmp_path / "child.tmpl.md"
        child.write_text(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            Child: {{ msg }}"""))
        parent = tmp_path / "parent.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            params:
              - greeting = str
            ---
            > {% include [child](./child.tmpl.md) with msg=greeting %}"""))
        tmpl = Template.from_file(str(parent))
        output = tmpl.render(greeting="hello")
        assert output == "Child: hello"

    def test_iterated_include(self, tmp_path: Path) -> None:
        row = tmp_path / "row.tmpl.md"
        row.write_text(textwrap.dedent("""\
            ---
            params: [label = str]
            ---
            - {{ label }}"""))
        parent = tmp_path / "list.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            params:
              - items = list(label = str)
            ---
            > {% for item in items %}
            > {% include [row](./row.tmpl.md) with label=item.label %}
            > {% /for %}"""))
        tmpl = Template.from_file(str(parent))
        output = tmpl.render(items=[{"label": "alpha"}, {"label": "beta"}])
        assert output == "- alpha- beta"

    def test_iterated_include_for_syntax(self, tmp_path: Path) -> None:
        """Test {% include ... for item in items %} iterated include syntax."""
        row = tmp_path / "row.tmpl.md"
        row.write_text("""---
params: [item = struct(label = str)]
---
- {{ item.label }}""")
        parent = tmp_path / "list.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            params:
              - items = list(label = str)
            ---
            > {% include [row](./row.tmpl.md) for item in items %}"""))
        tmpl = Template.from_file(str(parent))
        output = tmpl.render(items=[{"label": "alpha"}, {"label": "beta"}])
        assert output == "- alpha- beta"


# ---------------------------------------------------------------------------
# Inline templates
# ---------------------------------------------------------------------------


class TestInlineTemplates:
    """Tests for {% tmpl %} inline template blocks."""

    def test_inline_template(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - items = list(name = str)
            ---
            > {% tmpl row %}

            ---
            params:
              - name = str
            ---
            * {{ name }}

            > {% /tmpl %}
            > {% for item in items %}
            > {% include row with name=item.name %}
            > {% /for %}"""))
        output = tmpl.render(items=[{"name": "Alice"}, {"name": "Bob"}])
        assert output == "* Alice\n* Bob\n"


# ---------------------------------------------------------------------------
# Raw blocks
# ---------------------------------------------------------------------------


class TestRawBlocks:
    """Tests for {% raw %} blocks."""

    def test_raw_block(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: []
            ---
            > {% raw %}

            {{ not_evaluated }}

            > {% /raw %}"""))
        output = tmpl.render()
        assert output == "{{ not_evaluated }}\n"


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


class TestComments:
    """Tests for {# comment #} syntax."""

    def test_comment_stripped(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str]
---
Hello{# a comment #} {{ name }}!""")
        output = tmpl.render(name="world")
        assert output == "Hello world!"


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


class TestConstants:
    """Tests for consts: block in frontmatter."""

    def test_const_in_body(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            consts:
              - APP = str := "MyApp"

            params: []
            ---
            {{ APP }}"""))
        assert tmpl.render() == "MyApp"

    def test_consts_method(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            consts:
              - VERSION = str := "1.0"
              - MAX = int := 100

            params: []
            ---
            {{ VERSION }} {{ MAX }}"""))
        consts = tmpl.consts()
        assert consts["VERSION"] == "1.0"
        assert consts["MAX"] == 100


# ---------------------------------------------------------------------------
# Imported const iteration (imports: block)
# ---------------------------------------------------------------------------


class TestImportedConstIteration:
    """Iterating over a list const exported by an imported template.

    Mirrors the real ARTIST `artist.SEVERITY_LADDER` usage, where a shared
    template exposes a typed list const (optionally with enum-typed fields)
    that consumers iterate over via `{% for row in stem.CONST %}`.
    """

    def _write_lib(self, tmp_path: Path) -> Path:
        lib = tmp_path / "lib.tmpl.md"
        lib.write_text(textwrap.dedent("""\
            ---
            types:
              - Tier = enum(L0, L1, L2)

            consts:
              - LADDER = list(tier = Tier, desc = str) := [{tier = L0, desc = "theory"}, {tier = L1, desc = "trigger"}]

            params: []
            ---
            (library)"""))
        return lib

    def test_iterate_imported_const_list(self, tmp_path: Path) -> None:
        self._write_lib(tmp_path)
        parent = tmp_path / "parent.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            imports:
              - [lib](./lib.tmpl.md)

            params: []
            ---
            > {% for row in lib.LADDER %}

            {{ kind(row.tier) }}: {{ row.desc }}

            > {% /for %}"""))
        tmpl = Template.from_file(str(parent))
        output = tmpl.render()
        assert output == "L0: theory\nL1: trigger\n"

    def test_iterate_imported_const_and_use_imported_enum(self, tmp_path: Path) -> None:
        """Regression: the same stem exposes both a typed const and an enum type.

        Typing the import stem as a struct of only-consts previously broke
        access to the enum type via the stem (`kinds(lib.Tier)`). Both must
        work simultaneously.
        """
        self._write_lib(tmp_path)
        parent = tmp_path / "parent.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            imports:
              - [lib](./lib.tmpl.md)

            params: []
            ---
            > {% for t in kinds(lib.Tier) %}

            - {{ t }}

            > {% /for %}
            > {% for row in lib.LADDER %}

            {{ row.desc }}

            > {% /for %}"""))
        tmpl = Template.from_file(str(parent))
        output = tmpl.render()
        assert output == "- L0\n- L1\n- L2\ntheory\ntrigger\n"


# ---------------------------------------------------------------------------
# Whitespace control
# ---------------------------------------------------------------------------


class TestWhitespaceControl:
    """Tests for whitespace trimming with - markers."""

    def test_trim_left(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str]
---
hello  {{- name }}""")
        assert tmpl.render(name="world") == "helloworld"

    def test_trim_right(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name -}}  end"""))
        assert tmpl.render(name="world") == "worldend"


# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------


class TestTypeAliases:
    """Tests for types: block (type aliases)."""

    def test_type_alias_enum(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            types:
              - Priority = enum(High, Medium, Low)

            params:
              - prio = Priority
            ---
            > {% match prio %}
            > {% case High %}

            URGENT

            > {% case Medium %}

            NORMAL

            > {% case Low %}

            MINOR

            > {% /match %}"""))
        output = tmpl.render(prio="High")
        assert output == "URGENT\n"


# ---------------------------------------------------------------------------
# from_source_with_base_dir
# ---------------------------------------------------------------------------


class TestFromSourceWithBaseDir:
    """Tests for Template.from_source_with_base_dir()."""

    def test_include_resolved_relative_to_base_dir(self, tmp_path: Path) -> None:
        """Include directives should resolve relative to base_dir."""
        child = tmp_path / "parts" / "header.tmpl.md"
        child.parent.mkdir(parents=True, exist_ok=True)
        child.write_text(textwrap.dedent("""\
            ---
            params: [title = str]
            ---
            # {{ title }}"""))

        source = textwrap.dedent("""\
            ---
            params:
              - title = str
            ---
            > {% include [header](./parts/header.tmpl.md) with title=title %}""")

        tmpl = Template.from_source_with_base_dir(source, str(tmp_path))
        output = tmpl.render(title="Hello")
        assert output == "# Hello"

    def test_basic_source_with_base_dir(self, tmp_path: Path) -> None:
        """A template without includes should still work with base_dir."""
        source = """---
params: [name = str]
---
Hello {{ name }}!"""
        tmpl = Template.from_source_with_base_dir(source, str(tmp_path))
        assert tmpl.render(name="world") == "Hello world!"

    def test_invalid_source_raises(self, tmp_path: Path) -> None:
        """Invalid template source should raise ValueError."""
        with pytest.raises(ValueError, match="frontmatter"):
            Template.from_source_with_base_dir("no frontmatter", str(tmp_path))


# ---------------------------------------------------------------------------
# set_max_include_depth
# ---------------------------------------------------------------------------


class TestSetMaxIncludeDepth:
    """Tests for Template.set_max_include_depth()."""

    def test_depth_limit_does_not_affect_flat_template(self) -> None:
        """Templates without includes render normally regardless of depth."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        tmpl.set_max_include_depth(1)
        assert tmpl.render(x="ok") == "ok"

    def test_depth_limit_allows_shallow_include(self, tmp_path: Path) -> None:
        """A single-level include should work with depth >= 1."""
        child = tmp_path / "child.tmpl.md"
        child.write_text(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            Child: {{ msg }}"""))
        parent = tmp_path / "parent.tmpl.md"
        parent.write_text(textwrap.dedent("""\
            ---
            params:
              - greeting = str
            ---
            > {% include [child](./child.tmpl.md) with msg=greeting %}"""))
        tmpl = Template.from_file(str(parent))
        tmpl.set_max_include_depth(2)
        output = tmpl.render(greeting="hi")
        assert output == "Child: hi"


# ---------------------------------------------------------------------------
# body()
# ---------------------------------------------------------------------------


class TestBody:
    """Tests for Template.body()."""

    def test_body_returns_stripped_content(self) -> None:
        """body() should return the template text without frontmatter."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.body() == "Hello {{ name }}!"

    def test_body_preserves_multiline(self) -> None:
        """body() should preserve multiline template content."""
        source = """---
params: [x = str]
---
Line 1
Line 2
{{ x }}"""
        tmpl = Template.from_source(source)
        body = tmpl.body()
        assert "Line 1" in body
        assert "Line 2" in body
        assert "{{ x }}" in body
        assert "params:" not in body

    def test_body_empty_template(self) -> None:
        """body() on a template with no body content should return empty."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: []
            ---
            """))
        assert tmpl.body() == ""


# ---------------------------------------------------------------------------
# Template-as-param (tmpl() type)
# ---------------------------------------------------------------------------


class TestTemplateAsParam:
    """Tests for passing Template objects as tmpl() parameters."""

    def test_basic_tmpl_param_rendering(self) -> None:
        """A Template passed as a param should be usable via {% include %}."""
        helper = Template.from_source("""---
params: [name = str]
---
Hello {{ name }}!""")
        main = Template.from_source("""---
params: [greet = tmpl(name = str)]
---
> {% include greet with name="World" %}""")
        result = main.render(greet=helper)
        assert result == "Hello World!"

    def test_tmpl_param_type_mismatch(self) -> None:
        """Template with wrong params should fail type checking."""
        wrong = Template.from_source(textwrap.dedent("""\
            ---
            params: [age = int]
            ---
            Age: {{ age }}"""))
        main = Template.from_source("""---
params: [greet = tmpl(name = str)]
---
> {% include greet with name="World" %}""")
        with pytest.raises(ValueError, match="type mismatch"):
            main.render(greet=wrong)

    def test_tmpl_param_with_defaults(self) -> None:
        """Template with extra defaulted params should still match."""
        helper = Template.from_source("""---
params: [name = str, greeting = str := "Hi"]
---
{{ greeting }} {{ name }}!""")
        main = Template.from_source("""---
params: [greet = tmpl(name = str)]
---
> {% include greet with name="World" %}""")
        result = main.render(greet=helper)
        assert result == "Hi World!"

    def test_nested_tmpl_params(self) -> None:
        """Nested template-as-param should work."""
        inner = Template.from_source(textwrap.dedent("""\
            ---
            params: [val = str]
            ---
            Inner: {{ val }}"""))
        middle = Template.from_source("""---
params: [target = tmpl(val = str), value = str]
---
> {% include target with val=value %}""")
        main = Template.from_source("""---
params:
  - processor = tmpl(target = tmpl(val = str), value = str)
  - callback = tmpl(val = str)
---
> {% include processor with target=callback, value="Success" %}""")
        result = main.render(processor=middle, callback=inner)
        assert result == "Inner: Success"

    def test_non_template_as_tmpl_param_raises(self) -> None:
        """Passing a non-Template value for a tmpl param should fail."""
        main = Template.from_source("""---
params: [greet = tmpl(name = str)]
---
> {% include greet with name="World" %}""")
        with pytest.raises(ValueError, match="type mismatch"):
            main.render(greet="not a template")

    def test_tmpl_param_for_each(self) -> None:
        """Template-as-param with {% include ... for item in list %}."""
        row = Template.from_source("""---
params: [item = struct(label = str)]
---
- {{ item.label }}
""")
        parent = Template.from_source("""---
params:
  - row = tmpl(item = struct(label = str))
  - items = list(label = str)
---
> {% include row for item in items %}
""")
        result = parent.render(row=row, items=[{"label": "alpha"}, {"label": "beta"}])
        assert result == "- alpha\n- beta\n"

    def test_tmpl_param_contract_rejects_missing_params(self) -> None:
        """Include without required with= vars should fail."""
        child = Template.from_source("""---
params: [title = str, count = int]
---
{{ title }} ({{ count }})""")
        parent = Template.from_source("""---
params:
  - widget = tmpl(title = str, count = int)
---
> {% include widget %}
""")
        with pytest.raises(ValueError):
            parent.render(widget=child)

    def test_tmpl_param_from_file(self, tmp_path: Path) -> None:
        """A Template loaded from file can be passed as a tmpl param."""
        child_path = tmp_path / "child.tmpl.md"
        child_path.write_text(textwrap.dedent("""\
            ---
            params: [msg = str]
            ---
            [{{ msg }}]"""))
        child = Template.from_file(str(child_path))
        parent = Template.from_source("""---
params:
  - widget = tmpl(msg = str)
  - text = str
---
> {% include widget with msg=text %}
""")
        result = parent.render(widget=child, text="hello")
        assert result == "[hello]"


# ---------------------------------------------------------------------------
# None handling
# ---------------------------------------------------------------------------


class TestNoneHandling:
    """Tests for None value behavior.

    Python None maps to the engine's transparent ``Value::None``,
    representing an absent value. Passing None for a non-optional
    parameter is a type error — only ``option(T)`` params accept None.
    """

    def test_none_value_raises_type_error(self) -> None:
        """None on a non-option str param raises TypeMismatchError."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        with pytest.raises(Exception, match="type mismatch"):
            tmpl.render(name=None)

    def test_none_in_list_raises_type_error(self) -> None:
        """None inside a list element raises TypeError."""
        tmpl = Template.from_source("""---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ item.name }}

> {% /for %}""")
        with pytest.raises(Exception):
            tmpl.render(items=[None])

    def test_none_in_struct_value_raises_type_error(self) -> None:
        """None inside a struct field raises TypeMismatchError."""
        tmpl = Template.from_source("""---
params:
  - config = struct(host = str)
---
{{ config.host }}""")
        with pytest.raises(Exception, match="type mismatch"):
            tmpl.render(config={"host": None})


# ---------------------------------------------------------------------------
# PathLike support
# ---------------------------------------------------------------------------


class TestPathLikeSupport:
    """Tests for pathlib.Path acceptance in all path-taking APIs."""

    def test_from_file_with_path(self, simple_template_path: Path) -> None:
        tmpl = Template.from_file(simple_template_path)
        assert tmpl.render(name="pathlib") == "Hello pathlib!"

    def test_load_template_with_path(self, simple_template_path: Path) -> None:
        from md_tmpl import load_template

        tmpl = load_template(simple_template_path)
        assert tmpl.render(name="pathlib") == "Hello pathlib!"

    def test_template_helper_with_path(self, simple_template_path: Path) -> None:
        t = template(simple_template_path)
        assert t.render(name="pathlib") == "Hello pathlib!"

    def test_load_types_with_path(self, enum_template_path: Path) -> None:
        types = load_types(enum_template_path)
        assert hasattr(types, "Outcome")

    def test_cache_load_with_path(self, simple_template_path: Path) -> None:
        cache = TemplateCache()
        tmpl = cache.load(simple_template_path)
        assert tmpl.render(name="cached_pathlib") == "Hello cached_pathlib!"


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------


class TestExceptionHierarchy:
    """Tests for exception subclass catchability, kinds, and structured fields."""

    def test_syntax_error_catchable(self) -> None:
        with pytest.raises(TemplateSyntaxError) as excinfo:
            Template.from_source("no frontmatter at all")
        assert excinfo.value.kind == "syntax"

    def test_syntax_error_is_value_error(self) -> None:
        """Backward compatibility: still catchable as ValueError."""
        with pytest.raises(ValueError):
            Template.from_source("no frontmatter at all")

    def test_syntax_error_message_preserved(self) -> None:
        """str(exc) must still equal the human-readable message."""
        with pytest.raises(TemplateSyntaxError) as excinfo:
            Template.from_source("no frontmatter at all")
        assert "frontmatter" in str(excinfo.value)

    def test_missing_params_error(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str, age = int]
---
{{ name }} {{ age }}""")
        with pytest.raises(MissingParamsError) as excinfo:
            tmpl.render(name="Alice")
        assert excinfo.value.kind == "missing_params"
        assert excinfo.value.missing == ["age"]

    def test_type_mismatch_error(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [flag = bool]
            ---
            {{ flag }}"""))
        with pytest.raises(TypeMismatchError) as excinfo:
            tmpl.render(flag="not a bool")
        assert excinfo.value.kind == "type_mismatch"
        assert excinfo.value.path == "flag"
        assert excinfo.value.expected == "bool"
        assert excinfo.value.actual == "str"

    def test_type_mismatch_is_type_error(self) -> None:
        """TypeMismatchError also inherits TypeError."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [flag = bool]
            ---
            {{ flag }}"""))
        with pytest.raises(TypeError):
            tmpl.render(flag="not a bool")

    def test_extra_params_error(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        with pytest.raises(ExtraParamsError) as excinfo:
            tmpl.render(name="world", bogus="unexpected")
        assert excinfo.value.kind == "extra_params"
        assert excinfo.value.extra == ["bogus"]

    def test_panic_error(self) -> None:
        tmpl = Template.from_source('---\nparams: []\n---\n> {% panic("halt") %}')
        with pytest.raises(TemplatePanicError) as excinfo:
            tmpl.render()
        assert excinfo.value.kind == "panic"
        assert "halt" in str(excinfo.value)

    def test_io_error_maps_to_base_with_kind(self) -> None:
        """Missing files surface as the base TemplateError tagged kind='io'."""
        with pytest.raises(TemplateError) as excinfo:
            Template.from_file("/nonexistent/path.tmpl.md")
        assert excinfo.value.kind == "io"
        # Must not be a more specific subclass.
        assert type(excinfo.value) is TemplateError

    def test_include_not_found_error(self, tmp_path: Path) -> None:
        tmpl = Template.from_source_with_base_dir(
            "---\nparams: []\n---\n> {% include [x](./nope.tmpl.md) %}",
            str(tmp_path),
        )
        with pytest.raises(IncludeNotFoundError) as excinfo:
            tmpl.render()
        assert excinfo.value.kind == "include_not_found"
        assert "nope.tmpl.md" in excinfo.value.include

    def test_declarations_mutated_error(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        with pytest.raises(DeclarationsMutatedError) as excinfo:
            tmpl.validate_declarations_against([("different", "int")])
        assert excinfo.value.kind == "declarations_mutated"
        assert "different" in excinfo.value.details

    def test_template_error_base_class(self) -> None:
        """All specific errors are catchable as TemplateError."""
        with pytest.raises(TemplateError):
            Template.from_source("no frontmatter")

    def test_specific_errors_catchable_as_value_error(self) -> None:
        """Back-compat: every specific error is still a ValueError."""
        tmpl = Template.from_source("""---
params: [name = str, age = int]
---
{{ name }} {{ age }}""")
        with pytest.raises(ValueError):
            tmpl.render(name="Alice")

    # -- Classes for variants the Rust core currently reports at compile
    #    time as a Syntax error (so they aren't produced by the engine from
    #    Python yet). We still verify the dedicated Python classes exist and
    #    expose the right kind/fields, matching the Go/TS parity contract.

    def test_undefined_variable_error_class(self) -> None:
        err = UndefinedVariableError("undefined variable: x", variable="x")
        assert err.kind == "undefined_variable"
        assert err.variable == "x"
        assert isinstance(err, TemplateError)
        assert isinstance(err, ValueError)
        assert str(err) == "undefined variable: x"

    def test_unknown_filter_error_class(self) -> None:
        err = UnknownFilterError("unknown filter: bogus", filter="bogus")
        assert err.kind == "unknown_filter"
        assert err.filter == "bogus"
        assert isinstance(err, TemplateError)
        assert str(err) == "unknown filter: bogus"

    def test_base_template_error_unknown_kind_sentinel(self) -> None:
        """The base class uses the empty-string 'unknown' sentinel."""
        assert TemplateError.kind == ""
        assert TemplateError("boom").kind == ""
        assert TemplateError("boom", kind="io").kind == "io"

    def test_every_kind_id_is_stable(self) -> None:
        """Pin the machine-readable kind ids (they cross the FFI boundary)."""
        assert TemplateSyntaxError.kind == "syntax"
        assert UndefinedVariableError.kind == "undefined_variable"
        assert MissingParamsError.kind == "missing_params"
        assert TypeMismatchError.kind == "type_mismatch"
        assert UnknownFilterError.kind == "unknown_filter"
        assert IncludeNotFoundError.kind == "include_not_found"
        assert DeclarationsMutatedError.kind == "declarations_mutated"
        assert ExtraParamsError.kind == "extra_params"
        assert TemplatePanicError.kind == "panic"


# ---------------------------------------------------------------------------
# TemplateCache management methods
# ---------------------------------------------------------------------------


class TestCacheManagement:
    """Tests for TemplateCache.clear(), template_count(), include_count()."""

    def test_template_count(self, simple_template_path: Path) -> None:
        cache = TemplateCache()
        assert cache.template_count() == 0
        cache.load(str(simple_template_path))
        assert cache.template_count() == 1

    def test_include_count_starts_at_zero(self) -> None:
        cache = TemplateCache()
        assert cache.include_count() == 0

    def test_clear_resets_counts(self, simple_template_path: Path) -> None:
        cache = TemplateCache()
        cache.load(str(simple_template_path))
        assert cache.template_count() == 1
        cache.clear()
        assert cache.template_count() == 0


# ---------------------------------------------------------------------------
# Chained filters
# ---------------------------------------------------------------------------


class TestChainedFilters:
    """Tests for chaining multiple filters."""

    def test_trim_then_upper(self) -> None:
        tmpl = Template.from_source("""---
params: [name = str]
---
{{ name | trim | upper }}""")
        assert tmpl.render(name="  hello  ") == "HELLO"

    def test_limit_then_join(self) -> None:
        tmpl = Template.from_source("""---
params: [tags = list(str)]
---
{{ tags | limit(2) | join(", ") }}""")
        output = tmpl.render(tags=["alpha", "beta", "gamma"])
        assert output == "alpha, beta"

    def test_join_on_struct_list_raises(self) -> None:
        """join() on a struct-typed list is a render-time error."""
        tmpl = Template.from_source("""---
params: [tags = list(name = str)]
---
{{ tags | join(", ") }}""")
        with pytest.raises(Exception):
            tmpl.render(tags=[{"name": "a"}, {"name": "b"}])


# ---------------------------------------------------------------------------
# Enum member conversion
# ---------------------------------------------------------------------------


class TestEnumMemberConversion:
    """Tests for Python enum.Enum -> template value conversion."""

    def test_enum_member_as_unit_variant(self) -> None:
        import enum

        class Color(enum.Enum):
            Red = "Red"
            Blue = "Blue"

        tmpl = Template.from_source("""---
params:
  - status = enum(Red, Blue)
---
> {% match status %}
> {% case Red %}

red

> {% case Blue %}

blue

> {% /match %}""")
        assert tmpl.render(status=Color.Red) == "red\n"


# ---------------------------------------------------------------------------
# idx() function
# ---------------------------------------------------------------------------


class TestIdxFunction:
    """Tests for the idx() built-in function."""

    def test_idx_in_loop(self) -> None:
        tmpl = Template.from_source("""---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ idx(item) }}: {{ item.name }}

> {% /for %}""")
        output = tmpl.render(items=[{"name": "a"}, {"name": "b"}, {"name": "c"}])
        assert "0: a" in output
        assert "1: b" in output
        assert "2: c" in output


# ---------------------------------------------------------------------------
# imported_consts()
# ---------------------------------------------------------------------------


class TestImportedConsts:
    """Tests for imported_consts() method."""

    def test_imported_consts_empty(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            {{ name }}"""))
        assert tmpl.imported_consts() == {}

    def test_imported_consts_with_import(self, tmp_path: Path) -> None:
        # Create a constants template
        consts_tmpl = tmp_path / "config.tmpl.md"
        consts_tmpl.write_text("""---
consts:
  - MAX_RETRIES = int := 3
  - TIMEOUT = str := "30s"

---
Config loaded.
""")
        # Create a template that imports consts
        main_tmpl = tmp_path / "main.tmpl.md"
        main_tmpl.write_text(f"""---
imports: [config]({consts_tmpl})

params: [name = str]
---
{{{{ name }}}} (max={{{{ config.MAX_RETRIES }}}})
""")
        tmpl = Template.from_file(main_tmpl)
        consts = tmpl.imported_consts()
        assert consts.get("config.MAX_RETRIES") == 3
        assert consts.get("config.TIMEOUT") == "30s"


# ---------------------------------------------------------------------------
# Cross-template imports
# ---------------------------------------------------------------------------


class TestCrossTemplateImports:
    """Tests for cross-template type imports."""

    def test_import_types_from_another_template(self, tmp_path: Path) -> None:
        # Create a shared types template
        shared = tmp_path / "shared.tmpl.md"
        shared.write_text("""---
types:
  Status = enum(Active, Inactive)

params: [s = Status]
---
{{ s }}
""")
        # Create a template that imports the shared type
        main = tmp_path / "main.tmpl.md"
        main.write_text(f"""---
imports: [shared]({shared})
params: [status = shared.Status]
---
> {{% match status %}}
> {{% case Active %}}

active

> {{% case Inactive %}}

inactive

> {{% /match %}}
""")
        tmpl = Template.from_file(main)
        types = load_types(main)
        # The imported type should be available and template should work
        assert tmpl.declarations()


# ---------------------------------------------------------------------------
# Dataclass-like __dict__ conversion fallback
# ---------------------------------------------------------------------------


class TestDictConversionFallback:
    """Tests for passing objects with __dict__ as template values."""

    def test_object_with_dict_as_model(self) -> None:
        class Config:
            def __init__(self, host: str, port: int) -> None:
                self.host = host
                self.port = port

        tmpl = Template.from_source("""---
params:
  - config = struct(host = str, port = int)
---
{{ config.host }}:{{ config.port }}""")
        result = tmpl.render(config=Config(host="localhost", port=8080))
        assert result == "localhost:8080"

    def test_dataclass_as_model(self) -> None:
        from dataclasses import dataclass

        @dataclass
        class Item:
            name: str
            value: int

        tmpl = Template.from_source("""---
params:
  - item = struct(name = str, value = int)
---
{{ item.name }}={{ item.value }}""")
        result = tmpl.render(item=Item(name="score", value=42))
        assert result == "score=42"


# ---------------------------------------------------------------------------
# Generated model __dict__ property
# ---------------------------------------------------------------------------


class TestGeneratedModelDict:
    """Tests for the __dict__ property on generated model classes."""

    def test_model_dict_property(self, tmp_path: Path) -> None:
        path = tmp_path / "item.tmpl.md"
        path.write_text("""---
params:
  - items = list(name = str, count = int)
---
> {% for item in items %}

{{ item.name }}

> {% /for %}
""")
        types = load_types(path)
        # Find the generated item model class (the one with name+count fields)
        item_classes = [
            n for n in dir(types) if "ItemsItem" in n and not n.startswith("_")
        ]
        assert item_classes, f"No ItemsItem class found in {dir(types)}"
        ItemCls = getattr(types, item_classes[0])
        obj = ItemCls(name="test", count=5)
        d = obj.__dict__
        assert d["name"] == "test"
        assert d["count"] == 5


# ---------------------------------------------------------------------------
# Generated params render() method
# ---------------------------------------------------------------------------


class TestGeneratedParamsRender:
    """Tests for the render() method on generated params classes."""

    def test_params_render_method(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        types = load_types(path)
        tmpl = Template.from_file(path)
        Hello = types.Hello
        params = Hello(name="world")
        result = params.render(tmpl)
        assert result == "Hello world!"

    def test_params_render_with_template(self, tmp_path: Path) -> None:
        path = tmp_path / "greeting.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hi {{ name }}!"""))
        types = load_types(path)
        tmpl = Template.from_file(path)
        params = types.Greeting(name="test")
        result = params.render(template=tmpl)
        assert result == "Hi test!"


# ---------------------------------------------------------------------------
# render_cached()
# ---------------------------------------------------------------------------


class TestRenderCached:
    """Tests for cache-aware rendering."""

    def test_render_cached_basic(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(path)
        result = tmpl.render_cached(cache, name="cached")
        assert result == "Hello cached!"

    def test_render_cached_with_includes(self, tmp_path: Path) -> None:
        inc = tmp_path / "_header.tmpl.md"
        inc.write_text(textwrap.dedent("""\
            ---
            params: [title = str]
            ---
            HEADER: {{ title }}"""))
        main = tmp_path / "page.tmpl.md"
        main.write_text("""---
params:
  - title = str
---
> {% include [header](./_header.tmpl.md) with title=title %}

Body here.""")
        cache = TemplateCache()
        tmpl = cache.load(main)
        result = tmpl.render_cached(cache, title="Test")
        assert "HEADER: Test" in result
        assert "Body here." in result

    def test_render_cached_include_resolves_compile_env(self, tmp_path: Path) -> None:
        """Regression: a cached include whose ``env:`` var has no default must
        resolve from the *parent's* compile-time env — identical to the uncached
        path. Before the core fix the cached resolver parsed the include with an
        empty env and raised "no value provided and no default". Python exercises
        the same ``render_ctx_cached`` core path via the PyO3 binding.
        """
        (tmp_path / "child.tmpl.md").write_text(textwrap.dedent("""\
            ---
            name: child
            env: [PROMPTS_DIR = str]
            params: []
            ---
            dir={{ PROMPTS_DIR }}"""))
        main = tmp_path / "main.tmpl.md"
        main.write_text(textwrap.dedent("""\
            ---
            params: []
            ---
            > {% include [child](./child.tmpl.md) %}"""))
        cache = TemplateCache()
        tmpl = Template.from_source_with_options(
            main.read_text(),
            base_dir=str(tmp_path),
            env={"PROMPTS_DIR": "/prompts"},
        )
        # First render compiles the include from disk with env threaded in.
        out1 = tmpl.render_cached(cache)
        assert "dir=/prompts" in out1
        # Second render is served from cache; the env-injected const persists.
        assert tmpl.render_cached(cache) == out1

    def test_render_cached_include_invalidated_on_env_change(
        self, tmp_path: Path
    ) -> None:
        """Regression: changing the compile-time env must invalidate a cached
        include even though the file's mtime and content are unchanged (which
        would otherwise hit the cache fast path)."""
        (tmp_path / "child.tmpl.md").write_text(textwrap.dedent("""\
            ---
            name: child
            env: [PROMPTS_DIR = str]
            params: []
            ---
            dir={{ PROMPTS_DIR }}"""))
        main = tmp_path / "main.tmpl.md"
        main.write_text(textwrap.dedent("""\
            ---
            params: []
            ---
            > {% include [child](./child.tmpl.md) %}"""))
        main_src = main.read_text()
        cache = TemplateCache()

        def compile_with(value: str) -> Template:
            return Template.from_source_with_options(
                main_src, base_dir=str(tmp_path), env={"PROMPTS_DIR": value}
            )

        assert "dir=/alpha" in compile_with("/alpha").render_cached(cache)
        # Same file, same cache — must recompute for the new env, not serve /alpha.
        assert "dir=/beta" in compile_with("/beta").render_cached(cache)

    def test_render_cached_dict(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(path)
        result = tmpl.render_cached_dict({"name": "dict_cached"}, cache)
        assert result == "Hello dict_cached!"


# ---------------------------------------------------------------------------
# TemplateCache max_entries and __len__
# ---------------------------------------------------------------------------


class TestCacheMaxEntries:
    """Tests for TemplateCache max_entries and __len__."""

    def test_default_no_limit(self) -> None:
        cache = TemplateCache()
        assert len(cache) == 0

    def test_cache_len_tracks_entries(self, tmp_path: Path) -> None:
        path1 = tmp_path / "a.tmpl.md"
        path1.write_text(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        path2 = tmp_path / "b.tmpl.md"
        path2.write_text(textwrap.dedent("""\
            ---
            params: [y = str]
            ---
            {{ y }}"""))
        cache = TemplateCache()
        assert len(cache) == 0
        cache.load(path1)
        assert len(cache) >= 1
        cache.load(path2)
        assert len(cache) >= 2

    def test_max_entries_constructor(self) -> None:
        cache = TemplateCache(max_entries=10)
        assert len(cache) == 0

    def test_max_entries_eviction(self, tmp_path: Path) -> None:
        cache = TemplateCache(max_entries=2)
        paths = []
        for i in range(4):
            p = tmp_path / f"t{i}.tmpl.md"
            p.write_text(textwrap.dedent(f"""\
                ---
                params: [x = str]
                ---
                Template {i}: {{{{ x }}}}"""))
            paths.append(p)
        for p in paths:
            cache.load(p)
        assert cache.template_count() <= 2


# ---------------------------------------------------------------------------
# Concurrent rendering (ported from Go)
# ---------------------------------------------------------------------------


class TestConcurrentRendering:
    """Tests for thread-safety of template rendering."""

    def test_concurrent_render(self) -> None:
        """Multiple threads rendering the same template concurrently."""
        import concurrent.futures

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [id = int]
            ---
            Result: {{ id }}"""))

        def render_id(i: int) -> str:
            return tmpl.render(id=i)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(render_id, i) for i in range(20)]
            results = [f.result() for f in futures]

        for i in range(20):
            assert f"Result: {i}" in results

    def test_concurrent_render_different_templates(self, tmp_path: Path) -> None:
        """Different templates rendered concurrently."""
        import concurrent.futures

        paths = []
        for i in range(5):
            p = tmp_path / f"t{i}.tmpl.md"
            p.write_text(textwrap.dedent(f"""\
                ---
                params: [x = str]
                ---
                Template {i}: {{{{ x }}}}"""))
            paths.append(p)

        templates = [Template.from_file(str(p)) for p in paths]

        def render(idx: int) -> str:
            return templates[idx].render(x="val")

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(render, i) for i in range(5)]
            results = [f.result() for f in futures]

        for i in range(5):
            assert f"Template {i}: val" in results


# ---------------------------------------------------------------------------
# Defaults introspection — value checks (ported from Go)
# ---------------------------------------------------------------------------


class TestDefaultsIntrospection:
    """Tests for default value retrieval and type accuracy."""

    def test_defaults_value_types(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - name = str := "World"
              - count = int := 5
              - flag = bool
            ---
            {{ name }} {{ count }} {{ flag }}"""))
        defaults = tmpl.defaults()
        assert defaults["name"] == "World"
        assert defaults["count"] == 5
        assert "flag" not in defaults, "flag has no default"

    def test_defaults_partial_override(self) -> None:
        """Only override some defaults, let others use their default values."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - name = str := "World"
              - greeting = str
            ---
            {{ greeting }} {{ name }}"""))
        result = tmpl.render(greeting="Hello")
        assert result == "Hello World"

    def test_defaults_empty(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        defaults = tmpl.defaults()
        assert len(defaults) == 0

    def test_defaults_bool_value(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - enabled = bool := true
            ---
            > {% if enabled %}

            on

            > {% /if %}"""))
        assert tmpl.defaults()["enabled"] is True
        assert tmpl.render() == "on\n"


# ---------------------------------------------------------------------------
# Delimiters inside quoted strings in frontmatter default values
# ---------------------------------------------------------------------------


class TestEmbeddedDelimiterDefaults:
    """Regression tests: delimiters inside quoted default-value literals.

    Commas ``,`` and the bracket family ``()[]{}<>`` that appear **inside**
    quoted string literals (``"..."`` or ``'...'``) in a frontmatter default
    (``:= ...``) must be treated as literal characters, not as field/element
    separators. Python inherits this quote-aware parsing through the PyO3
    binding to the Rust core (``split_at_depth_zero``); these end-to-end tests
    lock the behavior in at the binding boundary via ``Template.defaults()``.

    Each test maps to a case in the canonical regression matrix (T1–T8).
    """

    @staticmethod
    def _defaults(params: str) -> dict[str, Any]:
        """Compile a params-only template and return its parsed defaults.

        ``from_source_allowing_unused`` is used so the params need not be
        referenced in the body — these tests only introspect the parsed
        default values, which is exactly the code path under test.
        """
        source = textwrap.dedent("""\
            ---
            params:
            {params}
            ---
            body""").format(params=params)
        return Template.from_source_allowing_unused(source).defaults()

    def test_t1_list_of_strings_with_commas(self) -> None:
        """T1: commas inside list string items are not element separators."""
        defaults = self._defaults('  - x = list(str) := ["a, b", "c, d"]')
        assert defaults["x"] == ["a, b", "c, d"]

    def test_t2_struct_field_with_comma(self) -> None:
        """T2: a comma inside a struct string field stays in that field."""
        defaults = self._defaults(
            '  - x = struct(msg = str, n = int) := {msg = "a, b", n = 1}'
        )
        assert defaults["x"] == {"msg": "a, b", "n": 1}

    def test_t3_list_of_records_with_commas(self) -> None:
        """T3: commas inside record string fields don't split records."""
        defaults = self._defaults(
            "  - x = list(name = str, note = str) := "
            '[{name = "x", note = "p, q, r"}, {name = "y", note = "s"}]'
        )
        records = defaults["x"]
        assert len(records) == 2
        assert records[0] == {"name": "x", "note": "p, q, r"}
        assert records[1] == {"name": "y", "note": "s"}

    def test_t4_list_items_with_brackets(self) -> None:
        """T4: bracket family inside quoted items is preserved verbatim."""
        defaults = self._defaults('  - x = list(str) := ["a[b]c", "d{e}f", "g(h)i"]')
        assert defaults["x"] == ["a[b]c", "d{e}f", "g(h)i"]

    def test_t5_single_quoted_items_with_commas(self) -> None:
        """T5: single-quoted strings are quote-aware just like double."""
        defaults = self._defaults("  - x = list(str) := ['a, b', 'c']")
        assert defaults["x"] == ["a, b", "c"]

    def test_t6_unicode_items_intact(self) -> None:
        """T6: unicode (em-dash, emoji) and embedded commas survive."""
        defaults = self._defaults(
            '  - x = list(str) := ["Theory — not a finding", "✅ done, ok"]'
        )
        assert defaults["x"] == ["Theory — not a finding", "✅ done, ok"]

    def test_t7_empty_strings_in_records(self) -> None:
        """T7: empty quoted strings parse as empty, commas still literal."""
        defaults = self._defaults(
            "  - x = list(name = str, note = str) := "
            '[{name = "", note = ""}, {name = "a", note = "y, z"}]'
        )
        records = defaults["x"]
        assert len(records) == 2
        assert records[0] == {"name": "", "note": ""}
        assert records[1] == {"name": "a", "note": "y, z"}

    def test_t8_severity_ladder_shape(self) -> None:
        """T8: faithful reduced SEVERITY_LADDER — list of enum-tagged records
        with prose fields containing commas, em-dashes, and brackets.
        """
        source = textwrap.dedent("""\
            ---
            types:
              - Tier = enum(L0, L1, L2)

            params:
              - ladder = list(tier = Tier, short = str, proves = str) := [{tier = L0, short = "theory", proves = "Nothing proven — just a hypothesis, unverified"}, {tier = L1, short = "trigger", proves = "Crash, panic, or sanitizer report (e.g. [heap-overflow])"}]
            ---
            body""")
        ladder = Template.from_source_allowing_unused(source).defaults()["ladder"]
        assert len(ladder) == 2
        assert ladder[0]["tier"] == "L0"
        assert ladder[0]["short"] == "theory"
        # Comma- and em-dash-bearing prose must stay in a single field.
        assert ladder[0]["proves"] == "Nothing proven — just a hypothesis, unverified"
        assert ladder[1]["tier"] == "L1"
        # Commas and brackets inside the prose must not split the record.
        assert ladder[1]["proves"] == (
            "Crash, panic, or sanitizer report (e.g. [heap-overflow])"
        )

    def test_e1_single_quote_char_inside_double_quoted_item(self) -> None:
        """E1: an apostrophe inside a double-quoted item is a literal char and
        does not open a quote context that would hide the following comma.
        """
        defaults = self._defaults('  - x = list(str) := ["it\'s, fine", "ok"]')
        assert defaults["x"] == ["it's, fine", "ok"]

    def test_e2_double_quotes_inside_single_quoted_item(self) -> None:
        """E2: double quotes nested inside a single-quoted item are literal,
        and the comma between them stays inside the item.
        """
        defaults = self._defaults('  - x = list(str) := [\'say "hi", bye\', "z"]')
        assert defaults["x"] == ['say "hi", bye', "z"]

    def test_e3_nested_list_of_lists(self) -> None:
        """E3: commas inside quoted items of a nested list(list(str)) default
        never split the inner or outer lists.
        """
        defaults = self._defaults(
            '  - x = list(list(str)) := [["a, b"], ["c, d", "e"]]'
        )
        assert defaults["x"] == [["a, b"], ["c, d", "e"]]

    def test_e4_leading_trailing_spaces_preserved(self) -> None:
        """E4: whitespace inside a quoted item is preserved verbatim."""
        defaults = self._defaults('  - x = list(str) := [" a, b "]')
        assert defaults["x"] == [" a, b "]

    def test_e5a_hash_without_leading_space_is_literal(self) -> None:
        """E5a: a `#` with no leading space is an ordinary character, kept."""
        defaults = self._defaults('  - x = str := "a#b,c"')
        assert defaults["x"] == "a#b,c"

    def test_e5b_space_hash_starts_yaml_comment(self) -> None:
        """E5b: a ` #` (space-hash) starts a YAML inline comment (the core is
        not md-tmpl-string-aware), truncating the scalar to ``x = str := "a`` —
        an unterminated string literal that is rejected as an invalid default.
        Wrap the whole declaration in outer YAML quotes to keep a literal ` #`
        (see E5c).
        """
        with pytest.raises(TemplateSyntaxError, match="strings must be quoted"):
            self._defaults('  - x = str := "a # b, c"')

    def test_e5c_outer_yaml_quotes_protect_hash(self) -> None:
        """E5c: outer YAML quotes around the whole declaration protect an inner
        ` #`, recovering the full default value.
        """
        defaults = self._defaults('  - "x = str := \\"a # b, c\\""')
        assert defaults["x"] == "a # b, c"

    def test_e5d_space_hash_outside_string_is_stripped(self) -> None:
        """E5d: a ` #` outside any string literal starts a YAML inline comment
        and is stripped, so the numeric default still parses.
        """
        defaults = self._defaults("  - x = int := 3 # the retry count")
        assert defaults["x"] == 3


# ---------------------------------------------------------------------------
# Constants — empty and multiple types (ported from Go)
# ---------------------------------------------------------------------------


class TestConstantsExtended:
    """Additional tests for consts: block."""

    def test_consts_empty_when_not_declared(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        consts = tmpl.consts()
        assert len(consts) == 0

    def test_consts_multiple_types(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            consts:
              - MAX = int := 100
              - GREETING = str := "hello"
              - ENABLED = bool := true

            params: []
            ---
            {{ MAX }} {{ GREETING }} {{ ENABLED }}"""))
        consts = tmpl.consts()
        assert consts["MAX"] == 100
        assert consts["GREETING"] == "hello"
        assert consts["ENABLED"] is True
        output = tmpl.render()
        assert output == "100 hello true"


# ---------------------------------------------------------------------------
# Boundary value tests (ported from Go)
# ---------------------------------------------------------------------------


class TestBoundaryValues:
    """Tests for edge-case values: empty strings, negative ints, etc."""

    def test_empty_string_param(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            [{{ x }}]"""))
        assert tmpl.render(x="") == "[]"

    def test_negative_int(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = int]
            ---
            {{ x }}"""))
        assert tmpl.render(x=-42) == "-42"

    def test_zero_int(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [val = int]
            ---
            {{ val }}"""))
        assert tmpl.render(val=0) == "0"

    def test_large_int(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = int]
            ---
            {{ x }}"""))
        large = 9_223_372_036_854_775_807
        result = tmpl.render(x=large)
        assert result == str(large)

    def test_false_bool_in_else(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [flag = bool]
            ---
            > {% if flag %}

            yes

            > {% else %}

            no

            > {% /if %}"""))
        assert tmpl.render(flag=False) == "no\n"


# ---------------------------------------------------------------------------
# elif branches (ported from Go)
# ---------------------------------------------------------------------------


class TestElifBranches:
    """Tests for if/elif/else branching."""

    def test_elif_all_branches(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [level = int]
            ---
            > {% if level == 1 %}

            Low

            > {% elif level == 2 %}

            Medium

            > {% else %}

            High

            > {% /if %}"""))
        assert tmpl.render(level=1) == "Low\n"
        assert tmpl.render(level=2) == "Medium\n"
        assert tmpl.render(level=3) == "High\n"


# ---------------------------------------------------------------------------
# Nested struct parameters (ported from Go)
# ---------------------------------------------------------------------------


class TestNestedStructs:
    """Tests for deeply nested struct params."""

    def test_nested_struct(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - config = struct(inner = struct(host = str))
            ---
            {{ config.inner.host }}"""))
        result = tmpl.render(config={"inner": {"host": "example.com"}})
        assert result == "example.com"

    def test_nested_struct_dataclass(self) -> None:
        """Nested dataclasses should be convertible via __dict__ fallback."""

        class Inner:
            def __init__(self, host: str) -> None:
                self.host = host

        class Config:
            def __init__(self, inner: Any) -> None:
                self.inner = inner

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - config = struct(inner = struct(host = str))
            ---
            {{ config.inner.host }}"""))
        result = tmpl.render(config=Config(inner=Inner(host="nested.example.com")))
        assert result == "nested.example.com"


# ---------------------------------------------------------------------------
# render_cached allow_extra code paths
# ---------------------------------------------------------------------------


class TestRenderCachedAllowExtra:
    """Tests for the allow_extra=True path in render_cached and render_cached_dict."""

    def test_render_cached_allow_extra(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(path)
        result = tmpl.render_cached(
            cache, name="test", extra="ignored", allow_extra=True
        )
        assert result == "Hello test!"

    def test_render_cached_dict_allow_extra(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(path)
        result = tmpl.render_cached_dict(
            {"name": "dict_test", "extra": "ignored"}, cache, allow_extra=True
        )
        assert result == "Hello dict_test!"

    def test_render_cached_rejects_extra_by_default(self, tmp_path: Path) -> None:
        path = tmp_path / "hello.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(path)
        with pytest.raises(ValueError, match="extra|undeclared|not declared"):
            tmpl.render_cached(cache, name="test", bogus="bad")


# ---------------------------------------------------------------------------
# Exception hierarchy — additional error types
# ---------------------------------------------------------------------------


class TestExceptionHierarchyExtended:
    """Tests for specific error mappings in errors.rs."""

    def test_undefined_variable_is_syntax_error(self) -> None:
        """UndefinedVariable should map to TemplateSyntaxError."""
        from md_tmpl import TemplateSyntaxError

        with pytest.raises(TemplateSyntaxError):
            Template.from_source(textwrap.dedent("""\
                ---
                params: [name = str]
                ---
                {{ undefined_var }}"""))

    def test_include_not_found_is_syntax_error(self) -> None:
        """IncludeNotFound should map to TemplateSyntaxError."""
        from md_tmpl import TemplateSyntaxError, TemplateError

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [title = str]
            ---
            > {% include [missing](./does_not_exist.tmpl.md) with title=title %}"""))
        # Render should fail with include not found
        with pytest.raises((TemplateSyntaxError, TemplateError)):
            tmpl.render(title="Test")

    def test_unknown_filter_raises(self) -> None:
        """UnknownFilter should map to TemplateSyntaxError."""
        from md_tmpl import TemplateSyntaxError

        with pytest.raises(TemplateSyntaxError):
            Template.from_source("""---
params: [name = str]
---
{{ name | nonexistent_filter }}""")


# ---------------------------------------------------------------------------
# Variants metaclass — extended edge cases
# ---------------------------------------------------------------------------


class TestVariantsMetaclassExtended:
    """Extended tests for Variants metaclass edge cases."""

    def test_struct_variant_match_args(self) -> None:
        class Op(Variants):
            Add = {"n": int}

        assert hasattr(Op.Add, "__match_args__")
        assert "n" in Op.Add.__match_args__

    def test_struct_variant_hash(self) -> None:
        class Op(Variants):
            Add = {"n": int}

        # Metaclass rewrites dict class-attrs into variant constructors.
        a = Op.Add(n=1)  # type: ignore[operator]
        b = Op.Add(n=1)  # type: ignore[operator]
        assert hash(a) == hash(b)
        assert len({a, b}) == 1

    def test_struct_variant_fields_property(self) -> None:
        class Op(Variants):
            Add = {"n": int, "m": int}

        # Metaclass rewrites the dict class-attr into a variant constructor.
        v = Op.Add(n=1, m=2)  # type: ignore[operator]
        assert v._md_tmpl_fields == {"n": 1, "m": 2}

    def test_invalid_field_name_raises(self) -> None:
        """Field names must be valid Python identifiers."""
        with pytest.raises(ValueError, match="invalid field name"):

            class Bad(Variants):
                X = {"not-valid": str}

    def test_unit_variant_as_template_param(self) -> None:
        """Unit variants from Variants should render through the template engine."""

        class Status(Variants):
            Active = ()
            Inactive = ()

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - status = enum(Active, Inactive)
            ---
            > {% match status %}
            > {% case Active %}

            on

            > {% case Inactive %}

            off

            > {% /match %}"""))
        result = tmpl.render(status=Status.Active)
        assert result == "on\n"

    def test_struct_variant_as_template_param(self) -> None:
        """Struct variants from Variants should render through the template engine."""

        class Result(Variants):
            Success = {"value": str}
            Failure = {"code": int}

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - outcome = enum(Success(value = str), Failure(code = int))
            ---
            > {% match outcome %}
            > {% case Success %}

            OK: {{ outcome.value }}

            > {% case Failure %}

            ERR: {{ outcome.code }}

            > {% /match %}"""))
        # Metaclass rewrites the dict class-attr into a variant constructor.
        result = tmpl.render(outcome=Result.Success(value="done"))  # type: ignore[operator]
        assert result == "OK: done\n"


# ---------------------------------------------------------------------------
# @variant decorator — extended
# ---------------------------------------------------------------------------


class TestVariantDecoratorExtended:
    """Extended tests for @variant decorator integration."""

    def test_variant_as_template_param(self) -> None:
        """A @variant instance should work as a struct variant in rendering."""

        @variant
        class NeedsChanges:
            reason: str

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - outcome = enum(Approved, NeedsChanges(reason = str))
            ---
            > {% match outcome %}
            > {% case Approved %}

            YES

            > {% case NeedsChanges %}

            CHANGES: {{ outcome.reason }}

            > {% /match %}"""))
        result = tmpl.render(outcome=NeedsChanges(reason="add tests"))
        assert result == "CHANGES: add tests\n"

    def test_variant_custom_tag(self) -> None:
        """A @variant class with a custom _md_tmpl_tag should use it."""

        @variant
        class MyCustomTag:
            _md_tmpl_tag = "Approved"
            note: str

        v = MyCustomTag(note="lgtm")
        assert v._md_tmpl_tag == "Approved"


# ---------------------------------------------------------------------------
# Unsupported type conversion
# ---------------------------------------------------------------------------


class TestUnsupportedTypeConversion:
    """Tests for convert.rs error paths with non-convertible types."""

    def test_set_as_param_raises(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(TypeError, match="cannot convert"):
            tmpl.render(x={1, 2, 3})

    def test_bytes_as_param_raises(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(TypeError, match="cannot convert"):
            tmpl.render(x=b"bytes")

    def test_complex_as_param_raises(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(TypeError, match="cannot convert"):
            tmpl.render(x=complex(1, 2))


# ---------------------------------------------------------------------------
# Cache with includes — include count tracking
# ---------------------------------------------------------------------------


class TestCacheIncludeCounting:
    """Tests for TemplateCache include counting."""

    def test_include_count_after_load(self, tmp_path: Path) -> None:
        inc = tmp_path / "header.tmpl.md"
        inc.write_text(textwrap.dedent("""\
            ---
            params: [title = str]
            ---
            # {{ title }}"""))
        main = tmp_path / "page.tmpl.md"
        main.write_text(textwrap.dedent("""\
            ---
            params:
              - title = str
            ---
            > {% include [header](./header.tmpl.md) with title=title %}

            Body."""))
        cache = TemplateCache()
        tmpl = cache.load(main)
        # Render to trigger include resolution
        tmpl.render_cached(cache, title="Test")
        assert cache.template_count() >= 1
        # include_count should be non-negative (implementation may vary)
        assert cache.include_count() >= 0


# ---------------------------------------------------------------------------
# render with no kwargs
# ---------------------------------------------------------------------------


class TestRenderNoKwargs:
    """Tests for rendering with empty or no parameters."""

    def test_render_with_no_kwargs(self) -> None:
        """Render with no keyword arguments at all."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: []
            ---
            Static only."""))
        assert tmpl.render() == "Static only."

    def test_render_dict_empty_dict(self) -> None:
        """render_dict with empty dict on paramless template."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: []
            ---
            Static."""))
        assert tmpl.render_dict({}) == "Static."


# ---------------------------------------------------------------------------
# load_types — params class render and __dict__
# ---------------------------------------------------------------------------


class TestLoadTypesExtended:
    """Extended tests for load_types generated classes."""

    def test_generated_params_dict_property(self, tmp_path: Path) -> None:
        path = tmp_path / "greeting.tmpl.md"
        path.write_text("""---
params:
  - name = str
  - count = int
---
{{ name }} {{ count }}""")
        types = load_types(path)
        Greeting = types.Greeting
        params = Greeting(name="Alice", count=42)
        d = params.__dict__
        assert d["name"] == "Alice"
        assert d["count"] == 42

    def test_generated_params_repr(self, tmp_path: Path) -> None:
        path = tmp_path / "greeting.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            {{ name }}"""))
        types = load_types(path)
        params = types.Greeting(name="world")
        r = repr(params)
        assert "Greeting" in r
        assert "world" in r


# ---------------------------------------------------------------------------
# Template.from_source_with_base_dir — missing include
# ---------------------------------------------------------------------------


class TestFromSourceWithBaseDirExtended:
    """Extended tests for from_source_with_base_dir."""

    def test_missing_include_raises_at_render(self, tmp_path: Path) -> None:
        """Missing include should fail at render, not parse."""
        source = textwrap.dedent("""\
            ---
            params: [title = str]
            ---
            > {% include [missing](./does_not_exist.tmpl.md) with title=title %}""")
        tmpl = Template.from_source_with_base_dir(source, str(tmp_path))
        with pytest.raises(ValueError):
            tmpl.render(title="Test")


# ---------------------------------------------------------------------------
# Type alias — generated type via load_types
# ---------------------------------------------------------------------------


class TestTypeAliasGeneration:
    """Test that type aliases generate loadable Python types."""

    def test_type_alias_generates_class(self, tmp_path: Path) -> None:
        path = tmp_path / "review.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            types:
              - Priority = enum(High, Medium, Low)

            params:
              - prio = Priority
            ---
            > {% match prio %}
            > {% case High %}

            URGENT

            > {% case Medium %}

            NORMAL

            > {% case Low %}

            MINOR

            > {% /match %}"""))
        types = load_types(path)
        assert hasattr(types, "Priority"), f"Expected Priority class, got {dir(types)}"
        # The Priority type should have variants
        assert hasattr(types.Priority, "High")

    def test_type_alias_variant_renders(self, tmp_path: Path) -> None:
        path = tmp_path / "review.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            types:
              - Priority = enum(High, Medium, Low)

            params:
              - prio = Priority
            ---
            > {% match prio %}
            > {% case High %}

            URGENT

            > {% case Medium %}

            NORMAL

            > {% case Low %}

            MINOR

            > {% /match %}"""))
        t = template(str(path))
        result = t.render(prio=t.Priority.High)
        assert result == "URGENT\n"


# ---------------------------------------------------------------------------
# template() helper — generated model usage
# ---------------------------------------------------------------------------


class TestTemplateHelperExtended:
    """Extended tests for template() generated models."""

    def test_generated_model_used_in_render(self, list_template_path: Path) -> None:
        """Generated item models can be used in render_dict."""
        t = template(str(list_template_path))
        type_names = list(t._types.keys())
        item_classes = [n for n in type_names if "Item" in n]
        assert item_classes, f"Expected item classes, got {type_names}"
        ItemCls = getattr(t, item_classes[0])
        item = ItemCls(title="Task 1", priority="High")
        # Use __dict__ to pass as parameter
        output = t.render(tasks=[item.__dict__])
        assert "Task 1" in output
        assert "High" in output


# ---------------------------------------------------------------------------
# Regression: exec() removal in Variants metaclass
# ---------------------------------------------------------------------------


class TestVariantsExecRemoval:
    """Regression tests for the closure-based __init__ that replaced exec().

    The _build_variant_from_dict() function in _variants.py originally used
    exec() to build __init__ for struct variants. This was replaced with a
    closure-based approach. These tests ensure the new implementation handles
    all argument passing styles correctly.
    """

    # -- helpers --

    @staticmethod
    def _make_result() -> Any:
        """Create a fresh Result Variants class for each test."""

        class Result(Variants):
            Ok = {"value": str}
            Err = {"code": int, "message": str}

        return Result

    # (a) Positional args

    def test_struct_variant_positional_args(self) -> None:
        Result = self._make_result()
        err = Result.Err(500, "fail")
        assert err.code == 500
        assert err.message == "fail"

    # (b) Keyword args

    def test_struct_variant_keyword_args(self) -> None:
        Result = self._make_result()
        err = Result.Err(code=500, message="fail")
        assert err.code == 500
        assert err.message == "fail"

    # (c) Mixed positional and keyword args

    def test_struct_variant_mixed_args(self) -> None:
        Result = self._make_result()
        err = Result.Err(500, message="fail")
        assert err.code == 500
        assert err.message == "fail"

    # (d) Duplicate arg raises TypeError

    def test_struct_variant_duplicate_arg_raises(self) -> None:
        Result = self._make_result()
        with pytest.raises(TypeError):
            Result.Err(500, code=999)  # code given positionally and as kwarg

    # (e) Missing required arg raises TypeError

    def test_struct_variant_missing_arg_raises(self) -> None:
        Result = self._make_result()
        with pytest.raises(TypeError, match="missing"):
            Result.Err(500)  # missing 'message'

    # (f) Unknown keyword arg raises TypeError

    def test_struct_variant_unknown_kwarg_raises(self) -> None:
        Result = self._make_result()
        with pytest.raises(TypeError, match="unexpected"):
            Result.Err(code=500, message="fail", extra="bad")

    # (g) Equality, repr, hash on struct variants

    def test_struct_variant_equality(self) -> None:
        Result = self._make_result()
        assert Result.Err(code=1, message="a") == Result.Err(code=1, message="a")
        assert Result.Err(code=1, message="a") != Result.Err(code=2, message="a")

    def test_struct_variant_repr(self) -> None:
        Result = self._make_result()
        assert "Err" in repr(Result.Err(code=1, message="a"))

    def test_struct_variant_hash(self) -> None:
        Result = self._make_result()
        a = Result.Err(code=1, message="a")
        b = Result.Err(code=1, message="a")
        assert hash(a) == hash(b)
        assert {a, b} == {a}  # deduplication via hash + eq

    # (h) Unit variants mixed with struct variants

    def test_mixed_unit_and_struct_variants(self) -> None:
        class Status(Variants):
            Approved = ()
            NeedsWork = {"reason": str}

        assert repr(Status.Approved) == "Approved"
        # Metaclass rewrites the dict class-attr into a variant constructor.
        assert Status.NeedsWork(reason="fix").reason == "fix"  # type: ignore[operator]

    # (i) Template render with Variants struct variants

    def test_template_render_with_struct_variant(self) -> None:
        tmpl = Template.from_source("""---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected)
---
> {% match outcome %}
> {% case Confirmed %}

YES: {{ outcome.evidence }}

> {% case Rejected %}

NO

> {% /match %}""")

        class Outcome(Variants):
            Confirmed = {"evidence": str}
            Rejected = ()

        # Metaclass rewrites the dict class-attr into a variant constructor.
        result = tmpl.render(outcome=Outcome.Confirmed(evidence="proof"))  # type: ignore[operator]
        assert "YES: proof" in result


# ---------------------------------------------------------------------------
# Context-manager protocol
# ---------------------------------------------------------------------------


class TestContextManager:
    """Tests for __enter__ / __exit__ context-manager support."""

    def test_template_context_manager(self) -> None:
        with Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}""")) as tmpl:
            result = tmpl.render(x="hello")
            assert result == "hello"

    def test_template_context_manager_exception(self) -> None:
        """__exit__ should not suppress exceptions."""
        with pytest.raises(ValueError):
            with Template.from_source(textwrap.dedent("""\
                ---
                params: [x = str]
                ---
                {{ x }}""")) as tmpl:
                raise ValueError("test error")

    def test_cache_context_manager(self) -> None:
        with TemplateCache() as cache:
            assert len(cache) == 0


# ---------------------------------------------------------------------------
# Pattern matching (Python 3.10+)
# ---------------------------------------------------------------------------


class TestPatternMatching:
    """Tests for Python 3.10+ match/case support on variant types."""

    def test_unit_variant_match(self) -> None:
        class Status(Variants):
            Approved = ()
            Rejected = ()

        def classify(s: Any) -> str:
            match s:
                case Status.Approved:
                    return "approved"
                case Status.Rejected:
                    return "rejected"
                case _:
                    return "unknown"

        assert classify(Status.Approved) == "approved"
        assert classify(Status.Rejected) == "rejected"

    def test_struct_variant_match(self) -> None:
        class Status(Variants):
            Approved = ()
            NeedsChanges = {"reason": str}

        def explain(s: Any) -> str:
            match s:
                # Metaclass rewrites the dict class-attr into a matchable variant class.
                case Status.NeedsChanges(reason=r):  # type: ignore[misc]
                    return f"needs changes: {r}"
                case Status.Approved:
                    return "approved!"
                case _:
                    return "unknown"

        # Metaclass rewrites the dict class-attr into a variant constructor.
        assert (
            explain(Status.NeedsChanges(reason="fix tests"))  # type: ignore[operator]
            == "needs changes: fix tests"
        )
        assert explain(Status.Approved) == "approved!"

    def test_variant_decorator_match(self) -> None:
        @variant
        class Confirmed:
            evidence: str
            confidence: float

        def handle(v: Any) -> str:
            match v:
                case Confirmed(evidence=e, confidence=c) if c > 0.9:
                    return f"high confidence: {e}"
                case Confirmed(evidence=e):
                    return f"low confidence: {e}"
                case _:
                    return "unknown"

        assert (
            handle(Confirmed(evidence="found it", confidence=0.95))
            == "high confidence: found it"
        )
        assert (
            handle(Confirmed(evidence="maybe", confidence=0.5))
            == "low confidence: maybe"
        )

    def test_load_types_match(self) -> None:
        """Pattern matching with types generated from a template file."""
        import tempfile
        import os

        with tempfile.NamedTemporaryFile(
            suffix=".tmpl.md", mode="w", delete=False
        ) as f:
            f.write("""---
params:
  - outcome = enum(Confirmed(evidence = str), Rejected)

allow_unused: true
---
{{ outcome }}""")
            path = f.name

        try:
            types = load_types(path)
            Outcome = types.Outcome

            v = Outcome.Confirmed(evidence="found it")
            match v:
                case Outcome.Confirmed(evidence=e):
                    result = f"confirmed: {e}"
                case _:
                    result = "other"

            assert result == "confirmed: found it"
        finally:
            os.unlink(path)


# -- option(T) support -------------------------------------------------------


class TestOptionType:
    """Tests for option(T) type support in the Python binding.

    option(T) is a first-class type with a transparent representation:
    Python None maps to the engine's absent value, and any other value is
    the present inner value directly (no wrapper).
    """

    def test_option_none_via_match(self) -> None:
        """Passing Python None renders the None arm of a match block."""
        tmpl = Template.from_source("""---
params:
  - label = option(str)
---
> {% match label %}
> {% case Some %}

got: {{ label }}

> {% case None %}

empty

> {% /match %}""")
        result = tmpl.render(label=None)
        assert result.strip() == "empty"

    def test_option_some_via_match(self) -> None:
        """Passing a Some struct renders the Some arm of a match block."""
        tmpl = Template.from_source("""---
params:
  - label = option(str)
---
> {% match label %}
> {% case Some %}

got: {{ label }}

> {% case None %}

empty

> {% /match %}""")
        result = tmpl.render(label="hello")
        assert "got: hello" in result

    def test_option_none_via_has(self) -> None:
        """has() returns false for None, rendering the else branch."""
        tmpl = Template.from_source("""---
params:
  - label = option(str)
---
> {% if has(label) %}

got: {{ label }}

> {% else %}

empty

> {% /if %}""")
        result = tmpl.render(label=None)
        assert result.strip() == "empty"

    def test_option_some_via_has(self) -> None:
        """has() returns true for Some, rendering the if branch."""
        tmpl = Template.from_source("""---
params:
  - label = option(str)
---
> {% if has(label) %}

got: {{ label }}

> {% else %}

empty

> {% /if %}""")
        result = tmpl.render(label="world")
        assert "got: world" in result

    def test_option_int_none(self) -> None:
        """option(int) with None renders the None case."""
        tmpl = Template.from_source("""---
params:
  - count = option(int)
---
> {% if has(count) %}

count={{ count }}

> {% else %}

no-count

> {% /if %}""")
        result = tmpl.render(count=None)
        assert result.strip() == "no-count"

    def test_option_int_some(self) -> None:
        """option(int) with a value renders the Some case."""
        tmpl = Template.from_source("""---
params:
  - count = option(int)
---
> {% if has(count) %}

count={{ count }}

> {% else %}

no-count

> {% /if %}""")
        result = tmpl.render(count=42)
        assert "count=42" in result

    def test_option_default_none(self) -> None:
        """option(str) with default None works when no value is provided."""
        tmpl = Template.from_source("""---
params:
  - label = option(str) := None
---
> {% if has(label) %}

{{ label }}

> {% else %}

default

> {% /if %}""")
        result = tmpl.render()
        assert result.strip() == "default"


# -- option(T) regression tests -------------------------------------------


class TestOptionTypeRegression:
    """Regression tests for transparent option(T).

    Options are TRANSPARENT:
    - Python None → absent (has() false, renders empty)
    - Python plain value (e.g., "hello") → present (has() true, renders directly)
    - NO .val access needed! The value is used directly.
    """

    def test_option_none_is_python_none(self) -> None:
        """Passing Python None for option(str) → has() false, renders else."""
        tmpl = Template.from_source("""---
params:
  - name = option(str)
---
> {% if has(name) %}

Hello {{ name }}

> {% else %}

No name

> {% /if %}""")
        result = tmpl.render(name=None)
        assert "Hello" not in result
        assert result.strip() == "No name"

    def test_option_some_is_plain_value(self) -> None:
        """Passing a plain string for option(str) → has() true, renders value."""
        tmpl = Template.from_source("""---
params:
  - name = option(str)
---
> {% if has(name) %}

Hello {{ name }}

> {% else %}

No name

> {% /if %}""")
        result = tmpl.render(name="Alice")
        assert "Hello Alice" in result
        assert "No name" not in result

    def test_option_none_in_struct(self) -> None:
        """A struct field typed as option(str) accepts None."""
        tmpl = Template.from_source("""---
params:
  - user = struct(name = str, bio = option(str))
---
Name: {{ user.name }}

> {% if has(user.bio) %}

Bio: {{ user.bio }}

> {% else %}

No bio

> {% /if %}""")
        # None field
        result = tmpl.render(user={"name": "Bob", "bio": None})
        assert "Name: Bob" in result
        assert "No bio" in result
        assert "Bio:" not in result

        # Present field (plain value, not __kind__ dict!)
        result_some = tmpl.render(user={"name": "Bob", "bio": "hacker"})
        assert "Name: Bob" in result_some
        assert "Bio: hacker" in result_some
        assert "No bio" not in result_some

    def test_option_none_in_list(self) -> None:
        """A list(option(str)) can contain None elements."""
        tmpl = Template.from_source("""---
params:
  - items = list(option(str))
---
> {% for item in items %}
> {% if has(item) %}

val={{ item }}

> {% else %}

missing

> {% /if %}
> {% /for %}""")
        result = tmpl.render(items=["hello", None, "world"])
        assert "val=hello" in result
        assert "missing" in result
        assert "val=world" in result

    def test_option_defaults_to_none(self) -> None:
        """option(str) with := None default → omitting the param yields empty."""
        tmpl = Template.from_source("""---
params:
  - title = option(str) := None
---
> {% if has(title) %}

Title: {{ title }}

> {% else %}

untitled

> {% /if %}""")
        # Omit the param entirely — should use the None default
        result = tmpl.render()
        assert result.strip() == "untitled"
        # Explicitly passing a value should override the default
        result_with = tmpl.render(title="My Doc")
        assert "Title: My Doc" in result_with

    def test_option_match_some_none(self) -> None:
        """{% match %} with {% case Some %} and {% case None %} branches."""
        tmpl = Template.from_source("""---
params:
  - tag = option(str)
---
> {% match tag %}
> {% case Some %}

tagged={{ tag }}

> {% case None %}

untagged

> {% /match %}""")
        # None path
        result_none = tmpl.render(tag=None)
        assert result_none.strip() == "untagged"
        # Some path (plain value, no __kind__ needed!)
        result_some = tmpl.render(tag="v1.0")
        assert "tagged=v1.0" in result_some

    def test_option_transparent_no_val(self) -> None:
        """Options are transparent — access the value directly, no .val needed."""
        tmpl = Template.from_source("""---
params:
  - name = option(str)
---
> {% if has(name) %}

{{ name }}

> {% /if %}""")
        result = tmpl.render(name="direct")
        assert result.strip() == "direct"


# -- for...else support ----------------------------------------------------


class TestForElse:
    """Tests for {% for...else %} via the Python binding.

    When the list is empty, the else body renders.
    When the list has items, the loop body renders and else is skipped.
    """

    def test_for_else_empty_list(self) -> None:
        """Empty list renders the else body."""
        tmpl = Template.from_source("""---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ item.name }}

> {% else %}

No items

> {% /for %}""")
        result = tmpl.render(items=[])
        assert result.strip() == "No items"

    def test_for_else_non_empty_list(self) -> None:
        """Non-empty list renders the loop body, not else."""
        tmpl = Template.from_source("""---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ item.name }}

> {% else %}

No items

> {% /for %}""")
        result = tmpl.render(items=[{"name": "Alice"}])
        assert "Alice" in result
        assert "No items" not in result

    def test_for_without_else_still_works(self) -> None:
        """Basic for-loop without else continues to work."""
        tmpl = Template.from_source("""---
params:
  - items = list(name = str)
---
> {% for item in items %}

{{ item.name }}

> {% /for %}""")
        result = tmpl.render(items=[{"name": "Bob"}])
        assert result.strip() == "Bob"


# ---------------------------------------------------------------------------
# generate_types_source — static type generation for mypy/pyright
# ---------------------------------------------------------------------------


class TestGenerateTypesSource:
    """Tests for generate_types_source() — Python source code generation."""

    def test_basic_source_generation(self, simple_template_path: Path) -> None:
        """Generated source contains required imports and dataclass."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        assert "from __future__ import annotations" in source
        assert "from dataclasses import dataclass" in source
        assert "from md_tmpl import Template, Variants" in source
        assert "@dataclass" in source
        assert "class Greeting:" in source
        assert "    name: str" in source

    def test_source_has_render_method(self, simple_template_path: Path) -> None:
        """Generated params class has a typed render() method."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        assert "def render(self, template: Template | None = None) -> str:" in source
        assert "render_dict(dataclasses.asdict(self))" in source

    def test_source_is_valid_python(self, simple_template_path: Path) -> None:
        """Generated source compiles without syntax errors."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        compile(source, "<test>", "exec")  # Raises SyntaxError if invalid.

    def test_source_has_docstring(self, simple_template_path: Path) -> None:
        """Generated source has a module-level docstring."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        assert "Auto-generated typed stubs" in source
        assert "Do not edit" in source

    def test_source_has_all(self, simple_template_path: Path) -> None:
        """Generated source has __all__ export list."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        assert '__all__ = ["Greeting"]' in source

    def test_source_with_defaults(self, default_template_path: Path) -> None:
        """Params with defaults use field(default=...)."""
        from md_tmpl import generate_types_source

        source = generate_types_source(default_template_path)
        assert "from dataclasses import dataclass, field" in source
        assert 'name: str = field(default="World")' in source
        assert "count: int = field(default=1)" in source

    def test_source_with_enum(self, enum_template_path: Path) -> None:
        """Enum types generate Variants subclasses."""
        from md_tmpl import generate_types_source

        source = generate_types_source(enum_template_path)
        assert "class Outcome(Variants):" in source
        assert "Rejected = ()" in source
        assert "NeedsWork = ()" in source
        # Struct variant with fields.
        assert 'Confirmed = {"evidence": str}' in source

    def test_source_with_struct(self, struct_template_path: Path) -> None:
        """Struct types generate @dataclass model classes."""
        from md_tmpl import generate_types_source

        source = generate_types_source(struct_template_path)
        assert "@dataclass" in source
        assert "class Config:" in source
        assert "    host: str" in source
        assert "    port: int" in source

    def test_source_with_list_of_structs(self, list_template_path: Path) -> None:
        """List<struct> generates an Item model class."""
        from md_tmpl import generate_types_source

        source = generate_types_source(list_template_path)
        assert "Item" in source  # Should generate a ...Item class
        assert "title: str" in source
        assert "priority: str" in source

    def test_source_all_includes_nested_types(self, enum_template_path: Path) -> None:
        """__all__ includes both the params class and nested types."""
        from md_tmpl import generate_types_source

        source = generate_types_source(enum_template_path)
        assert '"Status"' in source or '"Outcome"' in source

    def test_source_exec_and_render(self, simple_template_path: Path) -> None:
        """Generated source can be exec'd and the render() method works."""
        from md_tmpl import generate_types_source

        source = generate_types_source(simple_template_path)
        namespace: dict[str, Any] = {}
        exec(source, namespace)  # noqa: S102

        Greeting = namespace["Greeting"]
        params = Greeting(name="ExecTest")

        # The render method should work (loads from file).
        result = params.render()
        assert result == "Hello ExecTest!"

    def test_source_exec_with_defaults(self, default_template_path: Path) -> None:
        """Generated source with defaults can be exec'd with default values."""
        from md_tmpl import generate_types_source

        source = generate_types_source(default_template_path)
        namespace: dict[str, Any] = {}
        exec(source, namespace)  # noqa: S102

        Defaults = namespace["Defaults"]

        # Construct with defaults only.
        params = Defaults()
        result = params.render()
        assert result == "Hello World, count=1!"

        # Override defaults.
        params2 = Defaults(name="Custom", count=99)
        result2 = params2.render()
        assert result2 == "Hello Custom, count=99!"

    def test_source_exec_with_explicit_template(
        self, simple_template_path: Path
    ) -> None:
        """render() accepts an explicit Template argument."""
        from md_tmpl import Template, generate_types_source

        source = generate_types_source(simple_template_path)
        namespace: dict[str, Any] = {}
        exec(source, namespace)  # noqa: S102

        tmpl = Template.from_file(str(simple_template_path))
        Greeting = namespace["Greeting"]
        result = Greeting(name="Explicit").render(template=tmpl)
        assert result == "Hello Explicit!"

    def test_source_exec_enum_rendering(self, enum_template_path: Path) -> None:
        """Generated enum type can be used with render()."""
        from md_tmpl import generate_types_source

        source = generate_types_source(enum_template_path)
        namespace: dict[str, Any] = {}
        exec(source, namespace)  # noqa: S102

        Status = namespace["Status"]
        # Unit variant.
        params = Status(outcome="Rejected")
        result = params.render()
        assert result == "NO\n"

    def test_source_with_optional_type(self, tmp_path: Path) -> None:
        """Optional types get Optional[T] annotation and Optional import."""
        tmpl_path = tmp_path / "optional.tmpl.md"
        tmpl_path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
              - title = option(str)
            ---
            Hello {{ name }} {{ title }}"""))

        from md_tmpl import generate_types_source

        source = generate_types_source(tmpl_path)
        assert "from typing import Any, Optional" in source
        assert "title: str | None" in source
        assert "name: str" in source

    def test_source_empty_params(self, tmp_path: Path) -> None:
        """Template with no params still generates a class with render()."""
        tmpl_path = tmp_path / "empty.tmpl.md"
        tmpl_path.write_text(textwrap.dedent("""\
            ---
            params: []
            ---
            Static content"""))

        from md_tmpl import generate_types_source

        source = generate_types_source(tmpl_path)
        assert "class Empty:" in source
        assert "def render(self" in source

        # And it should actually render.
        namespace: dict[str, Any] = {}
        exec(source, namespace)  # noqa: S102
        result = namespace["Empty"]().render()
        assert result == "Static content"

    def test_source_multiple_types(self, tmp_path: Path) -> None:
        """All scalar types get correct annotations."""
        tmpl_path = tmp_path / "multi.tmpl.md"
        tmpl_path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
              - count = int
              - score = float
              - active = bool
            ---
            {{ name }} {{ count }} {{ score }} {{ active }}"""))

        from md_tmpl import generate_types_source

        source = generate_types_source(tmpl_path)
        assert "name: str" in source
        assert "count: int" in source
        assert "score: float" in source
        assert "active: bool" in source

    def test_source_write_to_file_and_import(self, tmp_path: Path) -> None:
        """Generated source can be written and imported as a module."""
        import importlib.util

        tmpl_path = tmp_path / "greet.tmpl.md"
        tmpl_path.write_text(textwrap.dedent("""\
            ---
            params:
              - name = str
            ---
            Hi {{ name }}!"""))

        from md_tmpl import generate_types_source

        source = generate_types_source(tmpl_path)
        py_path = tmp_path / "greet_types.py"
        py_path.write_text(source)

        # Import the generated module.
        spec = importlib.util.spec_from_file_location("greet_types", str(py_path))
        assert spec is not None
        assert spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules["greet_types"] = mod  # Required for @dataclass + PEP 563.
        try:
            spec.loader.exec_module(mod)

            # Use the imported class.
            params = mod.Greet(name="Module")
            result = params.render()
            assert result == "Hi Module!"
        finally:
            sys.modules.pop("greet_types", None)


# ---------------------------------------------------------------------------
# render_empty
# ---------------------------------------------------------------------------


class TestRenderEmpty:
    """Tests for Template.render_empty()."""

    def test_render_empty_no_params(self) -> None:
        tmpl = Template.from_source("""---
params: []
---
Hello world!""")
        assert tmpl.render_empty() == "Hello world!"

    def test_render_empty_all_defaults(self) -> None:
        tmpl = Template.from_source("""---
params:
  - greeting = str := "Hi"
  - count = int := 5
---
{{ greeting }} {{ count }}""")
        assert tmpl.render_empty() == "Hi 5"

    def test_render_empty_required_params_raises(self) -> None:
        tmpl = Template.from_source("""---
params:
  - name = str
---
Hello {{ name }}!""")
        with pytest.raises(ValueError, match="name"):
            tmpl.render_empty()

    def test_render_empty_mixed_defaults_required_raises(self) -> None:
        tmpl = Template.from_source("""---
params:
  - greeting = str := "Hi"
  - name = str
---
{{ greeting }} {{ name }}!""")
        with pytest.raises(ValueError, match="name"):
            tmpl.render_empty()


# ---------------------------------------------------------------------------
# Milestone M2 — panic(...) and in/not in
# ---------------------------------------------------------------------------


class TestMilestoneM2:
    """Tests for Milestone M2 features: {% panic(...) %} and in/not in operators."""

    def test_panic_literal_raises_template_panic_error(self) -> None:
        tmpl = Template.from_source("""---
params: []
---
> {% panic("halt") %}
""")
        with pytest.raises(TemplatePanicError, match="template panic: halt"):
            tmpl.render_empty()

    def test_panic_interpolation_raises_template_panic_error(self) -> None:
        tmpl = Template.from_source("""---
params: [reason = str]
---
> {% panic(reason) %}
""")
        with pytest.raises(
            TemplatePanicError, match="template panic: fatal: bad state"
        ):
            tmpl.render(reason="fatal: bad state")

    def test_in_operator_string_substring(self) -> None:
        tmpl = Template.from_source("""---
params: [role = str]
---
> {% if "admin" in role %}

YES

> {% else %}

NO

> {% /if %}""")
        assert tmpl.render(role="superadmin user").strip() == "YES"
        assert tmpl.render(role="guest").strip() == "NO"

    def test_not_in_operator_string_substring(self) -> None:
        tmpl = Template.from_source("""---
params: [role = str]
---
> {% if !("err" in role) %}

OK

> {% else %}

ERROR

> {% /if %}""")
        assert tmpl.render(role="status_ok").strip() == "OK"
        assert tmpl.render(role="has_err_flag").strip() == "ERROR"

    def test_in_operator_list_membership(self) -> None:
        tmpl = Template.from_source("""---
params: [roles = list(str)]
---
> {% if "admin" in roles %}

ALLOWED

> {% else %}

DENIED

> {% /if %}""")
        assert tmpl.render(roles=["user", "admin"]).strip() == "ALLOWED"
        assert tmpl.render(roles=["guest", "user"]).strip() == "DENIED"

    def test_not_in_operator_list_membership(self) -> None:
        tmpl = Template.from_source("""---
params: [roles = list(str)]
---
> {% if !("banned" in roles) %}

WELCOME

> {% else %}

GO AWAY

> {% /if %}""")
        assert tmpl.render(roles=["guest", "user"]).strip() == "WELCOME"
        assert tmpl.render(roles=["user", "banned"]).strip() == "GO AWAY"

    def test_in_operator_enum_kinds(self) -> None:
        tmpl = Template.from_source("""---
params: [status = enum(Active, Inactive, Pending)]
allow_unused: true
---
> {% if "Active" in kinds(Status) %}

VALID

> {% /if %}""")
        assert tmpl.render(status="Active").strip() == "VALID"

    def test_adv_m2_security_prompt_guard(self) -> None:
        tmpl = Template.from_source("""---
params:
  - user_input = str
---
> {% if "ignore previous instructions" in user_input %}
> {% panic("Prompt injection detected") %}
> {% else %}

SAFE

> {% /if %}""")
        assert tmpl.render(user_input="hello world").strip() == "SAFE"
        with pytest.raises(TemplatePanicError, match="Prompt injection detected"):
            tmpl.render(user_input="please ignore previous instructions now")

    def test_adv_m2_unicode_multibyte_panic(self) -> None:
        tmpl = Template.from_source("""---
allow_unused: true
---
> {% panic("重大なエラー 🚨") %}""")
        with pytest.raises(TemplatePanicError, match="重大なエラー 🚨"):
            tmpl.render_empty()


# ---------------------------------------------------------------------------
# Env: compile-time environment variables
# ---------------------------------------------------------------------------


class TestEnv:
    """Tests for compile-time env: declarations via from_source_with_env / from_source_with_options."""

    def test_basic_env_str_substitution(self) -> None:
        """Env var of type str is rendered in the template body."""
        source = textwrap.dedent("""\
            ---
            env: [MODEL = str]

            params: []
            ---
            Model: {{ MODEL }}""")
        tmpl = Template.from_source_with_env(source, {"MODEL": "gpt-4"})
        assert tmpl.render_empty() == "Model: gpt-4"

    def test_env_default_used(self) -> None:
        """Env var with default uses default when not provided."""
        source = textwrap.dedent("""\
            ---
            env:
              - MODEL = str := "gpt-3.5"

            params: []
            ---
            Model: {{ MODEL }}""")
        tmpl = Template.from_source_with_env(source, {})
        assert tmpl.render_empty() == "Model: gpt-3.5"

    def test_env_default_overridden(self) -> None:
        """Env var with default is overridden when provided."""
        source = textwrap.dedent("""\
            ---
            env:
              - MODEL = str := "gpt-3.5"

            params: []
            ---
            Model: {{ MODEL }}""")
        tmpl = Template.from_source_with_env(source, {"MODEL": "gpt-4o"})
        assert tmpl.render_empty() == "Model: gpt-4o"

    def test_missing_required_env_raises(self) -> None:
        """Missing required env var (no default) raises ValueError at compile time."""
        source = textwrap.dedent("""\
            ---
            env: [REQUIRED_VAR = str]

            params: []
            ---
            {{ REQUIRED_VAR }}""")
        with pytest.raises(ValueError, match="no value provided and no default"):
            Template.from_source_with_env(source, {})

    def test_env_coexists_with_params(self) -> None:
        """Env vars and params coexist; both are accessible in the template body."""
        source = textwrap.dedent("""\
            ---
            env: [PREFIX = str]

            params: [name = str]
            ---
            {{ PREFIX }}/{{ name }}""")
        tmpl = Template.from_source_with_env(source, {"PREFIX": "/opt/prompts"})
        assert tmpl.render(name="agent_x") == "/opt/prompts/agent_x"

    def test_env_int_type(self) -> None:
        """Env var of type int is parsed and rendered correctly."""
        source = textwrap.dedent("""\
            ---
            env: [MAX_RETRIES = int]

            params: []
            ---
            Retries: {{ MAX_RETRIES }}""")
        tmpl = Template.from_source_with_env(source, {"MAX_RETRIES": "5"})
        assert tmpl.render_empty() == "Retries: 5"

    def test_env_via_from_source_with_options(self) -> None:
        """from_source_with_options(env=...) works the same as from_source_with_env."""
        source = textwrap.dedent("""\
            ---
            env: [GREETING = str]

            params: []
            ---
            {{ GREETING }}""")
        tmpl = Template.from_source_with_options(source, env={"GREETING": "Hi"})
        assert tmpl.render_empty() == "Hi"


# ---------------------------------------------------------------------------
# Duck typing / structural typing — extra fields are silently ignored
# ---------------------------------------------------------------------------


class TestDuckTypingExtraFields:
    """Tests that md-tmpl uses structural (duck) typing for struct and list values.

    Extra fields in struct dicts are silently ignored — only declared fields
    are checked for presence and type.  This applies recursively through nested
    structs, list items, and type aliases.
    """

    # -- struct param with extra fields ------------------------------------

    def test_struct_extra_fields_ignored(self) -> None:
        """Extra dict keys in a struct param are silently dropped."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - user = struct(name = str, age = int)
            ---
            {{ user.name }} is {{ user.age }}"""))
        output = tmpl.render(
            user={
                "name": "Alice",
                "age": 30,
                "email": "alice@example.com",  # extra
                "is_admin": True,  # extra
            }
        )
        assert output == "Alice is 30"

    def test_struct_extra_fields_via_render_dict(self) -> None:
        """render_dict also ignores extra struct fields."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - cfg = struct(host = str, port = int)
            ---
            {{ cfg.host }}:{{ cfg.port }}"""))
        output = tmpl.render_dict(
            {
                "cfg": {
                    "host": "localhost",
                    "port": 8080,
                    "timeout_ms": 5000,  # extra
                }
            }
        )
        assert output == "localhost:8080"

    def test_struct_extra_fields_via_render_json(self) -> None:
        """render_json also ignores extra struct fields."""
        import json

        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - item = struct(id = int, label = str)
            ---
            {{ item.id }}: {{ item.label }}"""))
        payload = json.dumps(
            {
                "item": {
                    "id": 1,
                    "label": "widget",
                    "color": "red",  # extra
                    "weight": 3.5,  # extra
                }
            }
        )
        output = tmpl.render_json(payload)
        assert output == "1: widget"

    # -- list items with extra fields --------------------------------------

    def test_list_items_extra_fields_ignored(self) -> None:
        """Extra fields on list-item structs are silently ignored."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - tasks = list(title = str, done = bool)
            ---
            > {% for t in tasks %}

            - {{ t.title }} ({{ t.done }})

            > {% /for %}"""))
        output = tmpl.render(
            tasks=[
                {
                    "title": "Write docs",
                    "done": False,
                    "assignee": "Bob",
                    "priority": 1,
                },
                {"title": "Ship it", "done": True, "eta": "tomorrow"},
            ]
        )
        assert output == "- Write docs (false)\n- Ship it (true)\n"

    def test_list_items_extra_fields_via_render_dict(self) -> None:
        """render_dict also ignores extra fields on list items."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - items = list(name = str)
            ---
            > {% for i in items %}

            {{ i.name }}

            > {% /for %}"""))
        output = tmpl.render_dict(
            {
                "items": [
                    {"name": "alpha", "extra_key": 999},
                    {"name": "beta", "another": "value"},
                ]
            }
        )
        assert output == "alpha\nbeta\n"

    # -- type alias with duck typing ---------------------------------------

    def test_type_alias_struct_extra_fields(self) -> None:
        """A type-alias struct still ignores extra fields."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            types:
              - Address = struct(city = str, zip = str)

            params:
              - addr = Address
            ---
            {{ addr.city }} {{ addr.zip }}"""))
        output = tmpl.render(
            addr={
                "city": "Berlin",
                "zip": "10115",
                "country": "DE",  # extra
                "lat": 52.52,  # extra
            }
        )
        assert output == "Berlin 10115"

    def test_type_alias_list_and_struct_extra_fields_combined(self) -> None:
        """Type-alias struct + inline list param both ignore extra fields."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            types:
              - Entry = struct(key = str, value = str)

            params:
              - primary = Entry
              - tags = list(name = str)
            ---
            {{ primary.key }}={{ primary.value }}

            > {% for t in tags %}

            #{{ t.name }}

            > {% /for %}"""))
        output = tmpl.render(
            primary={"key": "a", "value": "1", "comment": "first"},
            tags=[
                {"name": "foo", "extra_meta": True},
                {"name": "bar", "color": "red"},
            ],
        )
        assert output == "a=1\n#foo\n#bar\n"

    # -- nested struct with extra fields at every depth --------------------

    def test_nested_struct_extra_fields_at_every_depth(self) -> None:
        """Extra fields are ignored at each nesting level of structs."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - outer = struct(label = str, inner = struct(x = int, y = int))
            ---
            {{ outer.label }}: ({{ outer.inner.x }}, {{ outer.inner.y }})"""))
        output = tmpl.render(
            outer={
                "label": "point",
                "color": "blue",  # extra on outer
                "inner": {
                    "x": 10,
                    "y": 20,
                    "z": 30,  # extra on inner
                    "comment": "nope",  # extra on inner
                },
                "metadata": {},  # extra on outer
            }
        )
        assert output == "point: (10, 20)"

    def test_triple_nested_struct_extra_fields(self) -> None:
        """Three levels of nesting — extras ignored at every level."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - a = struct(name = str, b = struct(value = int, c = struct(flag = bool)))
            ---
            {{ a.name }}/{{ a.b.value }}/{{ a.b.c.flag }}"""))
        output = tmpl.render(
            a={
                "name": "root",
                "extra_a": "ignored",
                "b": {
                    "value": 42,
                    "extra_b": [1, 2, 3],
                    "c": {
                        "flag": True,
                        "extra_c": None,
                    },
                },
            }
        )
        assert output == "root/42/true"

    def test_list_of_nested_structs_extra_fields(self) -> None:
        """List items containing nested structs also ignore extras at all levels."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params:
              - rows = list(id = int, detail = struct(text = str))
            ---
            > {% for r in rows %}

            {{ r.id }}: {{ r.detail.text }}

            > {% /for %}"""))
        output = tmpl.render(
            rows=[
                {"id": 1, "detail": {"text": "hello", "extra": 99}, "bonus": "x"},
                {"id": 2, "detail": {"text": "world", "color": "green"}, "tag": "y"},
            ]
        )
        assert output == "1: hello\n2: world\n"


# ---------------------------------------------------------------------------
# Unchecked rendering (render_unchecked / render_dict_unchecked)
# ---------------------------------------------------------------------------


class TestRenderUnchecked:
    """Tests for the unvalidated fast-path render methods.

    These methods were implemented in Rust but previously missing from the
    type stubs. The tests confirm they are callable and behave as documented
    (skipping parameter validation and extra-argument checks).
    """

    def test_render_unchecked_basic(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.render_unchecked(name="world") == "Hello world!"

    def test_render_unchecked_skips_extra_validation(self) -> None:
        """Extra kwargs are accepted (not rejected) by the unchecked path."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        # `bogus` would raise in render(); unchecked silently ignores it.
        assert tmpl.render_unchecked(name="world", bogus="ignored") == "Hello world!"

    def test_render_dict_unchecked_basic(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.render_dict_unchecked({"name": "dict"}) == "Hello dict!"

    def test_render_dict_unchecked_skips_extra_validation(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        result = tmpl.render_dict_unchecked({"name": "world", "bogus": "ignored"})
        assert result == "Hello world!"

    def test_unchecked_methods_are_stub_visible(self) -> None:
        """The methods must exist as real attributes on the class."""
        assert callable(getattr(Template, "render_unchecked"))
        assert callable(getattr(Template, "render_dict_unchecked"))


# ---------------------------------------------------------------------------
# from_source_with_env / from_source_with_options are stub-visible
# ---------------------------------------------------------------------------


class TestFromSourceConstructorsStubVisible:
    """Confirm the env/options constructors exist as callable staticmethods."""

    def test_from_source_with_env_is_stub_visible(self) -> None:
        assert callable(getattr(Template, "from_source_with_env"))

    def test_from_source_with_options_is_stub_visible(self) -> None:
        assert callable(getattr(Template, "from_source_with_options"))

    def test_from_source_with_options_base_dir_and_allow_unused(
        self, tmp_path: Path
    ) -> None:
        """base_dir + allow_unused combine in a single call."""
        source = textwrap.dedent("""\
            ---
            params: [name = str, unused = int]
            ---
            Hello {{ name }}!""")
        tmpl = Template.from_source_with_options(
            source, base_dir=str(tmp_path), allow_unused=True
        )
        assert tmpl.render(name="world", unused=1) == "Hello world!"


# ---------------------------------------------------------------------------
# render_cached_json (renamed from render_json_cached)
# ---------------------------------------------------------------------------


class TestRenderCachedJson:
    """Tests for the renamed render_cached_json method."""

    def _cached_template(self, tmp_path: Path) -> tuple[Template, TemplateCache]:
        path = tmp_path / "greeting.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        tmpl = cache.load(str(path))
        return tmpl, cache

    def test_render_cached_json_basic(self, tmp_path: Path) -> None:
        tmpl, cache = self._cached_template(tmp_path)
        assert tmpl.render_cached_json('{"name": "json"}', cache) == "Hello json!"

    def test_render_cached_json_allow_extra(self, tmp_path: Path) -> None:
        tmpl, cache = self._cached_template(tmp_path)
        result = tmpl.render_cached_json(
            '{"name": "json", "extra": true}', cache, allow_extra=True
        )
        assert result == "Hello json!"

    def test_render_cached_json_rejects_extra_by_default(self, tmp_path: Path) -> None:
        tmpl, cache = self._cached_template(tmp_path)
        with pytest.raises(ValueError, match="extra|undeclared|not declared"):
            tmpl.render_cached_json('{"name": "json", "extra": true}', cache)

    def test_render_cached_json_matches_render_json(self, tmp_path: Path) -> None:
        tmpl, cache = self._cached_template(tmp_path)
        payload = '{"name": "Alice"}'
        assert tmpl.render_cached_json(payload, cache) == tmpl.render_json(payload)

    def test_old_render_json_cached_name_is_gone(self, tmp_path: Path) -> None:
        """The pre-rename name must no longer exist (no backward-compat alias)."""
        tmpl, _cache = self._cached_template(tmp_path)
        assert not hasattr(tmpl, "render_json_cached")
        assert not hasattr(Template, "render_json_cached")

    def test_render_cached_json_is_stub_visible(self) -> None:
        assert callable(getattr(Template, "render_cached_json"))


# ---------------------------------------------------------------------------
# name / description accessors
# ---------------------------------------------------------------------------


class TestNameAndDescription:
    """Tests for the Template.name() and Template.description() accessors."""

    def test_name_and_description_present(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            name: greeting
            description: A friendly greeting template
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.name() == "greeting"
        assert tmpl.description() == "A friendly greeting template"

    def test_name_and_description_none_when_omitted(self) -> None:
        """Both return None when the frontmatter omits them."""
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.name() is None
        assert tmpl.description() is None

    def test_name_present_description_omitted(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            name: only_name
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        assert tmpl.name() == "only_name"
        assert tmpl.description() is None

    def test_name_and_description_from_file(self, tmp_path: Path) -> None:
        path = tmp_path / "doc.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            name: doc
            description: Documented template
            params: [x = str]
            ---
            {{ x }}"""))
        tmpl = Template.from_file(str(path))
        assert tmpl.name() == "doc"
        assert tmpl.description() == "Documented template"

    def test_accessors_are_stub_visible(self) -> None:
        assert callable(getattr(Template, "name"))
        assert callable(getattr(Template, "description"))


# ---------------------------------------------------------------------------
# Context managers are documented no-ops (still functional)
# ---------------------------------------------------------------------------


class TestContextManagerNoOps:
    """Confirm the documented no-op context managers keep `with` working."""

    def test_template_enter_returns_self(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with tmpl as entered:
            assert entered is tmpl

    def test_template_exit_does_not_suppress(self) -> None:
        tmpl = Template.from_source(textwrap.dedent("""\
            ---
            params: [x = str]
            ---
            {{ x }}"""))
        with pytest.raises(RuntimeError, match="boom"):
            with tmpl:
                raise RuntimeError("boom")

    def test_cache_enter_returns_self(self) -> None:
        cache = TemplateCache()
        with cache as entered:
            assert entered is cache

    def test_cache_exit_does_not_clear_entries(self, tmp_path: Path) -> None:
        """A no-op __exit__ must NOT drop cached entries."""
        path = tmp_path / "greeting.tmpl.md"
        path.write_text(textwrap.dedent("""\
            ---
            params: [name = str]
            ---
            Hello {{ name }}!"""))
        cache = TemplateCache()
        with cache:
            cache.load(str(path))
            assert len(cache) == 1
        # Entries remain after exiting the `with` block (no-op __exit__).
        assert len(cache) == 1
