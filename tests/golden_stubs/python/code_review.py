"""Auto-generated typed stubs for crates/md-tmpl/prompts/code_review.tmpl.md.

Do not edit — regenerate with ``generate_types_source()``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from md_tmpl import Template, Variants

@dataclass
class CodeReviewFindingsItem:
    line: int
    message: str

@dataclass
class CodeReview:
    """Typed parameters for template ``crates/md-tmpl/prompts/code_review.tmpl.md``."""

    file_path: str
    severity: str
    findings: list[CodeReviewFindingsItem]

    def render(self, template: Template | None = None) -> str:
        """Render this params object into its template."""
        if template is None:
            template = Template.from_file("crates/md-tmpl/prompts/code_review.tmpl.md")
        import dataclasses
        return template.render_dict(dataclasses.asdict(self))

__all__ = ["CodeReview", "CodeReviewFindingsItem"]
