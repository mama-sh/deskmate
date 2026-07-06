---
name: agentic-coding
description: "Make a scoped change in a GitHub repo and open a reviewable pull request. Use when asked to fix a bug, apply a small feature, bump a dependency, or make a well-defined code change in a repo. Covers scoping, reproducing, minimal diffs, running tests, and writing a PR a human can review quickly."
---

# Agentic coding: change a repo, open a PR

You've been asked to change code in a real repo. Your job is to land a **small,
correct, reviewable pull request** — not to be clever. A reviewer should be able
to understand and trust your diff in a couple of minutes.

## The loop

### 1. Scope the request
State the goal in one line. Decide if it fits in **one focused PR**. If the ask is
vague, spans many concerns, or you'd be guessing at intent — ask first. A wrong
big PR wastes more time than a clarifying question.

### 2. Clone & orient
Clone the target repo into `/workspace`. Get your bearings before editing:
- Read the README/CONTRIBUTING for how the project is built and tested.
- Use `grep`/`glob` to find the relevant code and how it's used elsewhere.
- Note the conventions: language version, formatting, test framework, commit style.

### 3. Reproduce
For a bug, reproduce it first (a failing test, a script, a command). For a feature,
find the closest existing pattern and follow it. Don't fix what you can't observe.

### 4. Make the smallest correct change
- Create a `deskmate/engineer/<slug>` branch. Never work on the default branch.
- Change only what the task needs. No unrelated refactors, no reformatting files
  you didn't have to touch, no gold-plating.
- Match the surrounding style exactly — naming, imports, error handling, comments.
- Prefer the change the maintainers would make, not the one that's fastest to type.

### 5. Verify
Run the repo's tests, and its build/lint if present. Add or update a test when the
change warrants one. If you genuinely can't run the suite, say so explicitly in the
PR body — don't imply it's green.

### 6. Commit & open the PR
- Commit on your feature branch with a clear, conventional-commit message.
- Call `open_pull_request` (it pauses for human approval — that's the only way you
  push). Write a body a reviewer can act on:
  - **What** changed (one or two sentences).
  - **Why** — the bug/behavior and the fix, or the feature and its shape.
  - **How you verified** it — tests run and their result, or "tests not run" and why.
  - Anything risky, uncertain, or deliberately left out of scope.
- Post the PR link back.

## Anti-patterns

- **Scope creep.** "While I was in there…" — don't. Open a separate PR (or note it).
- **Reformatting the file.** A diff full of whitespace/format churn hides the real
  change and is unreviewable. Keep the diff to the substance.
- **Unverified claims.** Never say "tests pass" unless you ran them and saw them pass.
- **Guessing the fix.** If you can't reproduce or don't understand the root cause,
  investigate more or ask — don't ship a plausible-looking patch.
- **Pushing to main / merging.** You never do either. Every change is a PR a human
  reviews and merges.

## Hard rules (always in effect)

Never push to the default branch. Never merge. Never `git push` outside the
approval-gated `open_pull_request` tool. Stay within your allowlisted repos. Never
print or exfiltrate secrets — your GitHub auth is handled for you; you never need a
token.
