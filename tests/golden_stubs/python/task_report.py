"""Auto-generated typed stubs for crates/md-tmpl/prompts/task_report.tmpl.md.

Do not edit — regenerate with ``generate_types_source()``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from md_tmpl import Template, Variants

class Priority(Variants):
    Critical = ()
    High = ()
    Medium = ()
    Low = ()

@dataclass
class TaskReportTasksItem:
    name: str
    urgency: Priority

@dataclass
class TaskReport:
    """Typed parameters for template ``crates/md-tmpl/prompts/task_report.tmpl.md``."""

    title: str
    priority: Priority
    tasks: list[TaskReportTasksItem]

    def render(self, template: Template | None = None) -> str:
        """Render this params object into its template."""
        if template is None:
            template = Template.from_file("crates/md-tmpl/prompts/task_report.tmpl.md")
        import dataclasses
        return template.render_dict(dataclasses.asdict(self))

__all__ = ["TaskReport", "Priority", "TaskReportTasksItem"]
