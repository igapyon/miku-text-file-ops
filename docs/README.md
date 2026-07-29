# miku-text-file-ops Documentation

## Purpose

This directory is the documentation entry point for `miku-text-file-ops`.

`miku-text-file-ops` is a clean-slate, local-first filesystem adapter for AI
agents. It provides encoding-aware search and bounded reads across multiple
files, together with exclusive create and revision-guarded update and delete
operations on one file per invocation.

This README is an index. It does not define product behavior by itself.

## Document Map

| Document | Status | Role |
| --- | --- | --- |
| [`specification.md`](./specification.md) | Normative | Product scope, operation contracts, safety rules, encoding behavior, results, and diagnostics |
| [`agent-integration.md`](./agent-integration.md) | Accepted adapter design | Agent Skill discovery, trigger conditions, and CLI routing |
| [`implementation-strategy.md`](./implementation-strategy.md) | Accepted non-normative strategy | Complete-scratch implementation and repository strategy |
| [`release-and-bundles.md`](./release-and-bundles.md) | Accepted operational design | Reproducible CLI/runtime bundles and GitHub Release asset workflow |
| [`conformance-corpus.md`](./conformance-corpus.md) | Executable contract | Runtime-independent byte-level fixtures and runner requirements |
| [`notes/search-scaling-and-artifact-delivery.md`](./notes/search-scaling-and-artifact-delivery.md) | Work in progress | High-cardinality search refinement and out-of-band result artifacts |
| [`notes/environment-capability-cache.md`](./notes/environment-capability-cache.md) | Work in progress | Environment-specific capability probing and failure memory |

## Recommended Reading Order

For product implementation:

1. Read the specification.
2. Read the implementation strategy.
3. Read the release and bundle design when working on distribution.
4. Read the agent integration design.
5. Consult the work-in-progress notes only for the feature being explored.

For Agent Skill design:

1. Read the agent integration design.
2. Follow its links into the relevant normative operation contract.
3. Treat the notes as proposals, not callable behavior.

## Authority and Precedence

Authority follows subject ownership:

- The specification owns public product semantics.
- Agent integration owns Skill discovery and routing, subject to the
  specification.
- Implementation strategy owns repository and implementation provenance,
  subject to the specification.
- Work-in-progress notes have no accepted authority.

Work-in-progress notes never override an accepted or normative document.
Record a later accepted decision in the document that owns its subject before
implementation. A newer date or Git commit alone does not let a note override
that owner.

## Accepted Baseline

The current document set agrees on these decisions:

- The product name is `miku-text-file-ops`.
- The public contract may break compatibility with `miku-grep`,
  `miku-readfile`, and their Agent Skills.
- The implementation is created completely from scratch in a new repository.
  Existing source code, schemas, tests, fixtures, and runtime packages are not
  copied, ported, forked, wrapped, or used as implementation dependencies.
- The operation vocabulary is `search`, `read`, `create`, `update`, and
  `delete`.
- Search and read may address multiple files.
- Every mutation invocation addresses exactly one regular file.
- Text operations are encoding-aware, bounded, machine-readable, and explicit
  about truncation or partial results.
- Content search provides `matches`, `files`, `summary`, and `count`;
  path enumeration provides `files`, `summary`, and `count`.
- Regular-expression search uses a bounded, linear-time `rg`-like v1 subset
  with Unicode 17.0 simple case folding and no runtime-specific backtracking
  behavior.
- Search and read enforce default returned-text and canonical core-payload byte
  budgets even when the caller omits limits.
- The Agent Skill uses broad-result projections first and explicit read ranges
  before expanding context.
- The primary distribution is an Agent Skill with a bundled CLI; MCP remains
  an optional separately enabled adapter.
- GitHub Releases publish a standalone CLI bundle, an importable runtime
  bundle, and a reproducible source archive from a reviewed `v*` release tag.
- `CREATE` fails if its target already exists; `UPDATE` and `DELETE` use
  revision guards and fail closed when the target has changed.
- Contextual updates use a line-oriented, header-free hunk grammar with exact
  unique matching, original-file validation, and deterministic inserted-line
  newline selection.
- Ordinary UTF-8 repository work may continue to use native agent tools such
  as `rg` and contextual patching. The Agent Skill is selected when its
  encoding-preservation or text-shape guarantees are needed.

## Open Design Work

The `notes/` directory currently explores:

- additional facet types, exhaustive stream delivery, and possible
  continuation for very large search results
- when to return an artifact reference instead of inline records
- how to remember verified environment limitations without turning transient
  failures into permanent assumptions

These topics are deliberately separated from the accepted contract until
their semantics, limits, lifecycle, and failure behavior are settled.

## Document Maintenance Rules

- Add every product document to the document map.
- State each document's status near its title.
- Keep active filenames stable and use Git history for revision tracking.
- Keep one authoritative home for each accepted rule.
- Merge notes that answer the same design question instead of maintaining
  parallel variants.
- Move an accepted proposal out of `notes/` by updating the relevant
  normative or accepted document.
- Update links and this index whenever a document is renamed or moved.
