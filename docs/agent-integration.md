# miku-text-file-ops Agent Integration

## Status

This document is the accepted design for when an AI coding agent, especially
OpenAI Codex, should select the `miku-text-file-ops` Agent Skill and its bundled
CLI.

It complements the
[`miku-text-file-ops` specification](./specification.md).
The specification defines file-operation semantics. This document defines
agent discovery, triggering, and routing behavior.

## Conclusion

An agent is likely to use `miku-text-file-ops` when:

- the skill is visible to the agent
- the skill description clearly matches the current task
- the triggering condition identifies a capability that ordinary tools do not
  safely provide
- the skill gives deterministic CLI invocation instructions

The skill should not attempt to replace every ordinary UTF-8 file operation.
Codex already prefers `rg`, `rg --files`, and contextual patch operations for
normal repository work.

The intended position is:

> Use `miku-text-file-ops` when ordinary search and patch tools cannot safely
> detect, preserve, or convert the file's character encoding and text shape.

## Codex Skill Discovery Model

Codex initially receives skill metadata, especially the skill `name` and
`description`. It loads the complete `SKILL.md` only after selecting the skill.

Skills may be selected in two ways:

1. Explicit invocation, such as `$miku-text-file-ops`
2. Implicit invocation when the user request matches the skill description

Implicit selection is model-driven rather than a guaranteed dispatch rule.
Therefore, the description must front-load the principal use case and trigger
terms.

References:

- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex prompt with apply_patch instructions](https://github.com/openai/codex/blob/main/codex-rs/core/prompt_with_apply_patch_instructions.md)

## Expected Invocation Reliability

| User request or situation | Expected selection |
| --- | --- |
| Explicit `$miku-text-file-ops` invocation | Very high |
| Explicit product-name request | Very high |
| Preserve or convert Windows-31J text | High |
| Repair mojibake or a decode failure | High |
| Search a directory containing mixed encodings | High |
| Preserve BOM, mixed line endings, or final newline exactly | High |
| Ordinary UTF-8 search and patch | Low by design |
| Generic request such as "fix the TODO" | Low by design |

Low selection for ordinary UTF-8 work is desirable. It avoids competing with
the agent's efficient built-in workflow when the additional encoding-aware
boundary provides no material benefit.

## Recommended Skill Description

```yaml
---
name: miku-text-file-ops
description: Local text file operations supporting Windows-31J and UTF encodings, with bounded search/read, exclusive create, and revision-guarded update/delete. Use when the user explicitly names miku-text-file-ops, when files may use Windows-31J, when BOM or line endings must be preserved, or after ordinary tools produce mojibake or decode errors. Do not use for ordinary UTF-8-only file work where rg and apply_patch are sufficient.
---
```

This wording includes:

- the product name for explicit matching
- the user-facing operation scope
- concrete implicit triggers
- failure-recovery triggers
- a negative boundary that prevents over-triggering

The most important recovery phrase is:

> after ordinary tools produce mojibake or decode errors

Many tasks do not reveal the encoding problem in the initial request. The skill
must remain a valid choice after the agent discovers the problem during normal
investigation.

## Trigger Conditions

The skill should trigger when at least one of the following is true.

### Explicit Product Trigger

- The user names `miku-text-file-ops`.
- The user invokes `$miku-text-file-ops`.
- The user asks to use the miku encoding-aware text workflow.

### Encoding Trigger

- A file is known or suspected to use Windows-31J or another supported
  non-UTF-8 encoding.
- A repository contains stable path-based encoding rules.
- Search must span files with different encodings.
- The requested update may contain characters that are not representable in
  the source encoding.
- The user requests an explicit encoding conversion.

### Text-Shape Preservation Trigger

- BOM presence must be preserved or changed explicitly.
- CRLF, LF, CR, or mixed line endings must be preserved.
- Final-newline presence must be preserved.
- An update must avoid rewriting unchanged legacy-encoded bytes.

### Recovery Trigger

- Ordinary file reading reports a decode error.
- Search unexpectedly skips a text file.
- Output contains mojibake.
- A normal patch tool cannot read or safely rewrite the target.
- Node and Java runtimes interpret the same encoding label differently.

## Non-Trigger Conditions

The skill should not activate merely because:

- the task includes a local text file
- the user asks for ordinary source-code search
- the user asks for a normal UTF-8 edit
- the task can be completed safely with `rg` and the host patch tool
- the user requests generic code review
- the task concerns binary files

Making the trigger description cover all local file work would create
competition with Codex's native tool preferences and reduce selection
predictability.

## Workflow After Selection

Once the skill is selected, it should use one consistent semantic path for the
selected encoding-sensitive files.

1. Fix the workspace root before invoking the CLI.
2. Confirm the bundled CLI runtime path once.
3. Use `SEARCH` to identify candidates when needed.
4. For `UPDATE` or `DELETE`, use `READ` to obtain the required content and
   raw-byte revision.
5. For `CREATE`, do not attempt to read a nonexistent target; rely on exclusive
   creation and fail if the target already exists.
6. Use one single-file mutation operation.
7. Pass the observed revision to `UPDATE` or `DELETE`.
8. Treat the successful mutation result as authoritative.
9. Re-read only when semantic confirmation is required.

For an encoding-sensitive target, the skill must not:

- read with `miku-text-file-ops` and then update with an unrelated patch tool
- bypass a decode failure by silently treating the file as UTF-8
- drop the revision between read and update
- invoke a different backend with different encoding semantics
- perform multi-file mutation in one CLI invocation

## Agent-Context-Efficient Routing

The Skill must treat the CLI's deterministic character and byte limits as
portable context-budget proxies. It must not estimate model tokens or assume a
particular context-window size.

These rules apply after the Skill has been selected. Context efficiency alone
does not expand the trigger boundary to ordinary UTF-8 work that native `rg`
and patch tools already handle efficiently.

Optimization priority is:

1. Do not return bulk data to the model.
2. Select the smallest search projection.
3. Read the smallest useful source range.
4. Keep Skill instructions progressively disclosed.
5. Avoid optional always-visible tool schemas.

Choose the smallest projection that answers the current question:

| Need | First choice |
| --- | --- |
| Existence or quantity only | `count` |
| Size and scan-health overview of a broad query | `summary` |
| Candidate paths for later reads | `files` |
| Matching source evidence from a selective query | `matches` |

`files`, `summary`, and `count` apply to both path enumeration and content
search. `matches` applies only to content search. Thus a broad `rg --files`
equivalent should begin with path-mode `count` or `summary` when the agent does
not yet need individual paths.

The routing workflow is:

1. For an obviously broad path enumeration or content query, begin with
   `count`, `summary`, or `files`; do not begin by returning bulk paths or match
   text.
2. Narrow by path, include glob, extension, or a stronger literal/regular
   expression before asking for more records.
3. Use `matches` only when matching text is needed, with zero search-context
   lines by default.
4. For a match on logical line `L`, begin with
   `startLine = max(1, L - 40)` and `endLine = L + 40`.
5. Merge overlapping read windows for the same file before invoking `READ`.
   If a merged window would exceed the effective per-item line limit, split it
   into bounded adjacent ranges and request only the ranges still needed.
6. When no useful match line is available, begin with `firstLines: 120`.
7. Expand an adjacent range only when the first range does not contain enough
   semantic context.
8. Use a full-file read only when the task needs most of the file and its known
   raw size is at most 16 KiB, or when the user explicitly requires the whole
   file.
9. Treat `partial`, lower-bound counts, `exact: false` facets, skipped items,
   and `remainingRanges` as incomplete evidence.
10. Raise an output limit only for a concrete exhaustive requirement and only
    within the host ceiling.

When `usage.nextItemIndex` is present, resubmit only the still-needed
unprocessed items; do not automatically replay the entire multi-item request.

The Skill uses compact `--json` responses for control decisions. A partial
range read is sufficient before `UPDATE` when it contains all required patch
context and returns the full-file raw-byte revision. `DELETE` needs an observed
full-file revision but does not require source text beyond target
confirmation. `CREATE` needs no preliminary read.

The 81-line match window, 120-line initial read, and 16 KiB small-file
threshold are versioned Skill heuristics. They are tested with agent tasks and
may evolve without changing the core file-operation semantics.

The Skill must not:

- raise limits merely because the first result was partial
- repeat a broad `matches` search with a larger result budget before refining
- read a complete file merely to inspect one heading or one matched line
- concatenate several bounded results into one unbounded model response
- claim an exact total from a lower-bound count

## Skill Context Budget and Packaging

The Agent Skill uses progressive disclosure:

1. `name` and `description` are always visible.
2. `SKILL.md` is loaded only after the Skill is selected.
3. Operation references are loaded only for the selected operation or failure.
4. The bundled CLI performs deterministic work without its runtime source being
   loaded into model context.

Packaging requirements:

- Consume a smoke-tested standalone CLI bundle produced from the authoritative
  main-application core.
- Record or verify the bundled product version instead of inferring it from an
  Agent Skill package version.
- Keep the frontmatter description at or below 100 words.
- Target at most 200 lines for `SKILL.md`; 500 lines is a hard review
  threshold, not a target.
- Keep only the core workflow, projection selection, safety
  invariants, canonical launcher use, and reference routing in `SKILL.md`.
- Place full request schemas, result schemas, diagnostic catalogues, encoding
  configuration, and extended examples in one-level-deep `references/` files.
- Link every reference directly from `SKILL.md` and state exactly when to read
  it.
- Do not duplicate the same contract in `SKILL.md` and a reference.
- Do not require the agent to inspect bundled runtime source or rediscover its
  executable.

CI should record the description word count and the `SKILL.md` line, word, and
UTF-8 byte counts. Model-specific token counts may be measured during
forward-testing, but they are not portable conformance requirements.

## Tool-Schema Exposure

The primary Agent Skill distribution uses its bundled CLI through the host's
existing command-execution tool. It does not require registration of five
always-visible MCP tool schemas.

- The base package exposes only Skill metadata until selection.
- The primary package does not auto-install or auto-register an MCP server.
- An MCP adapter is a separately selected integration for hosts that benefit
  from typed tools or resources.
- Enabling MCP must not change core operation semantics or output budgets.
- Token savings from avoiding tool schemas are host-dependent because some
  harnesses already load tools lazily.

This is an incremental context saving. Bounded result data and range-first
reading remain the larger source of savings.

## CLI Discoverability

Installing a CLI on `PATH` is not sufficient for reliable use. An agent may not
know that the executable exists, and ordinary shell tools are already familiar.

The preferred package shape is:

```text
miku-text-file-ops Agent Skill
└── bundled deterministic CLI launcher
    └── authoritative miku-text-file-ops core
```

The skill should provide:

- the exact launcher path
- one canonical command for each operation
- stdin-based examples for multiline content and patches
- structured output examples
- exit-code interpretation
- revision handoff examples
- explicit fallback rules

The executable's global `--help` output duplicates this essential invocation
contract intentionally. It is the self-contained fallback for an agent that
can execute the CLI but does not have the Agent Skill references in context.
It includes the five request shapes, examples, revision handoff, structured
response handling, and exit-code interpretation.

When a mutation returns structured `stale_revision`, the Skill must:

- never resend the unchanged request
- read the reported `path` again through the bundled CLI
- retain and compare the new `actualRevision`
- rebuild the mutation from the latest content and new revision
- explain the intervening change when it materially affects the requested edit

The Skill consumes `details.expectedRevision`, `details.actualRevision`,
`details.recovery`, and `details.retryUnchangedRequest` directly. It must not
parse hashes or recovery instructions from the human-readable message.

The skill must not require the agent to search the repository broadly for a jar,
JavaScript bundle, or executable on every invocation.

The main application publishes the standalone CLI bundle separately from its
importable runtime bundle and source archive. The Agent Skill embeds or
otherwise selects the CLI artifact; it does not substitute the importable
runtime bundle as an executable. Distribution details are defined in
[Release and bundles](./release-and-bundles.md).

## CLI and MCP Roles

The CLI/MCP operation split and shared-core requirement are defined in the
[specification](./specification.md#agent-skill-and-mcp-surfaces).

For routing purposes, a Skill with a bundled CLI is the first local-workspace
surface. MCP is an optional, more visible adapter when the host exposes it. The
Skill must not invent a different semantic path based on which adapter is
available.

Exhaustive-stream/artifact delivery and persistent environment capability state
remain non-normative design work:

- [Search scaling and artifact delivery](./notes/search-scaling-and-artifact-delivery.md)
- [Environment capability cache](./notes/environment-capability-cache.md)

The Skill must not advertise or invoke those proposed surfaces until they are
promoted into an accepted contract.

## Repository-Wide Enforcement

A skill description improves routing but does not mechanically force every
matching operation through the CLI.

If a repository requires `miku-text-file-ops` for all applicable legacy files,
record that durable rule in repository guidance such as `AGENTS.md`. For
example:

```md
For files matched by the repository's legacy encoding rules, use
`miku-text-file-ops` for search, read, and mutation. Do not update those files
with ordinary UTF-8-only patch tools.
```

Use this only for repositories that genuinely require it. A global rule forcing
all UTF-8 source work through the product would add latency and reduce the
benefit of native agent tools.

## Trigger Testing

Trigger behavior should be tested as a routing contract.

Maintain a golden prompt set containing:

- prompts that must trigger
- prompts that should trigger after a discovered decode failure
- prompts that must not trigger
- explicit invocation prompts
- ambiguous prompts that should remain with native tools

Example positive prompts:

```text
Windows-31Jの設定ファイルを文字コードを維持したまま更新して。
```

```text
このフォルダはUTF-8とCP932が混在している。エラーコードを横断検索して。
```

```text
通常のreadで文字化けしたので、安全に読み直して修正して。
```

Example negative prompts:

```text
UTF-8のREADME.mdでTODOを検索して修正して。
```

```text
src以下のTypeScriptで未使用importを探して。
```

For each positive case, verify both:

- the skill is selected
- the bundled CLI is actually invoked

Selection without CLI execution is not a successful routing result.

## Context-Efficiency Testing

Forward-test the Skill with Codex and, where practical, Qwen Code using raw
task prompts rather than review prompts.

Include cases for:

- an obviously broad path inventory
- an obviously broad mixed-encoding query
- an exact count request
- candidate-file selection
- one selective match followed by a source read
- overlapping matches in one file
- a small file that genuinely needs a full read
- a large file where only one section is relevant
- a partial search result
- a partial multi-item read

Capture and assert:

- selected search mode
- selected search projection
- search context-line counts
- requested read selectors and ranges
- whether overlapping ranges were merged
- whether full-file reads obeyed the 16 KiB heuristic
- effective limits
- returned text characters and protocol bytes
- whether the agent refined before raising a limit
- whether the agent made a false completeness or exact-count claim

Model-reported token counts are useful observational metrics, but conformance
is based on deterministic CLI fields and emitted bytes.

## Final Decision

The skill should not be marketed to the agent as a universal replacement for
ordinary filesystem tools.

Its reliable and defensible trigger boundary is:

> Select `miku-text-file-ops` for local text operations when character encoding,
> BOM, newline shape, revision safety, or a previous decode failure makes the
> ordinary `rg` and patch workflow insufficient.

With this boundary, explicit invocation should be highly reliable and implicit
invocation should be reasonably reliable without creating unnecessary
competition with Codex's built-in search and patch behavior.
