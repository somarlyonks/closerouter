---
name: todo
description: Manage the closerouter.todo planning file — read its format, add and arrange pending items when asked to make a plan, and mark work as done. Use whenever the user asks to make a plan, track progress, or update the todo list.
disable-model-invocation: true
---

# Todo Tracking

The repository tracks work in `closerouter.todo` (at the repo root). This file is the source of truth for planning and progress — arrange and track all work here.

## When to use

- The user asks you to make a plan.
- The user asks you to track or report progress on ongoing work.
- You're about to start (or finish) a multi-step task and want to record it.
- The user asks to add, remove, or reorganize todo items.

## Format

`closerouter.todo` is a hierarchical indented list. Indentation (4 spaces per level) defines nesting; there is no other syntax.

- **Categories** end with a colon and hold children, e.g. `    server:`
- **Todo items** start with a checkbox: `[ ]` pending, `[x]` done, e.g. `    [ ] server`

Example (from the current file):

```
CloseRouter:
    cli:
        [ ] server
        [ ] version
    server:
        [x] router
        routes:
            v1:
                [x] chat/completions
```

## Rules

1. **Read first.** Always read `closerouter.todo` in full before editing so you match the existing structure and style. Never guess its current state.
2. **Make plans in the todo.** When asked to make a plan, add pending `[ ]` items under the relevant existing category. Create a new category only when nothing existing fits, and keep it consistent with the current hierarchy.
3. **Track as you go.** Flip `[ ]` → `[x]` as soon as a piece of work is done. If the plan changes mid-task, update the items to reflect reality rather than leaving stale entries.
4. **Remove superseded work.** Delete items that are no longer planned instead of leaving dead checkboxes.
5. **Keep it tidy.** Preserve 4-space indentation, one checkbox per item, consistent grouping, and no duplicates. Don't reformat unrelated sections.
6. **Report changes.** When you update the file, briefly note in your final message which items you added, moved, or checked off.
