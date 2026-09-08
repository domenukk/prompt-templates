"""Auto-generated typed stubs for crates/md-tmpl/prompts/greeting.tmpl.md.

Do not edit — regenerate with ``generate_types_source()``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from md_tmpl import Template, Variants

@dataclass
class GreetingItemsItem:
    label: str

@dataclass
class Greeting:
    """Typed parameters for template ``crates/md-tmpl/prompts/greeting.tmpl.md``."""

    name: str
    count: int
    items: list[GreetingItemsItem]

    def render(self, template: Template | None = None) -> str:
        """Render this params object into its template."""
        if template is None:
            template = Template.from_file("crates/md-tmpl/prompts/greeting.tmpl.md")
        import dataclasses
        return template.render_dict(dataclasses.asdict(self))

__all__ = ["Greeting", "GreetingItemsItem"]
