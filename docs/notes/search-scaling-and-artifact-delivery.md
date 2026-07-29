# miku-text-file-ops Search Scaling and Artifact Delivery Notes

## Status

This document contains design work in progress beyond the accepted bounded
search contract.

It consolidates two related questions:

- how an agent should continue when a search produces many matches
- how bulk search records should be delivered without filling model context

The projection, default-budget, and initial facet decisions originally explored
here have been promoted to the normative specification. Additional facet
types, exhaustive delivery, artifact, and continuation proposals are not
normative.

Related documents:

- [`miku-text-file-ops` specification](../specification.md)
- [Agent integration design](../agent-integration.md)
- [Environment capability cache notes](./environment-capability-cache.md)

## Problem

A broad search may produce hundreds, thousands, or more matches.

Returning every match directly to an AI agent creates predictable failures:

- host output truncation
- excessive model-context use
- repetitive evidence crowding out useful context
- false conclusions from incomplete output
- blind pagination
- agent abandonment

A hard result limit prevents output explosion, but a limit alone does not help
the agent choose the next action.

The accepted projections and range-first Skill workflow now provide:

- a refinement protocol for high-cardinality results

The remaining design problem is a bulk delivery path that does not require
model ingestion.

## Existing Normative Baseline

The current specification already requires:

- bounded search results
- default returned-text and canonical core-payload byte budgets
- `matches`, `files`, `summary`, and `count` projections
- `extension` and `topLevelPath` summary facets
- projection-specific record limits
- range-refined `READ`
- explicit `partial` status
- explicit completeness information
- structured limit reasons

The initial normative contract does not define continuation or artifact
delivery. This WIP document explores behavior beyond the accepted baseline.

## Working Principle

The runtime should separate control-plane information from bulk data.

```text
SEARCH
  |
  +-- control plane
  |     small inline result
  |     status, completeness, counts, facets, resource metadata
  |
  +-- data plane
        bounded inline records, proposed exhaustive stream, or managed artifact
```

The runtime performs deterministic counting, grouping, and serialization.

The agent receives only enough evidence to:

- narrow the next search
- select files for `READ`
- decide whether exhaustive traversal is necessary
- locate a bulk artifact when exhaustive processing is required

The core does not add semantic relevance ranking or model-generated advice.

Core search fields, adapter serialization, and proposed delivery behavior must
not be collapsed into one request `mode`:

```text
core mode: paths | content                     accepted request field
core projection: files | summary | count       accepted in both modes
core projection: matches                       accepted in content mode
CLI format: text | json                        accepted adapter behavior
CLI format: jsonl                              work in progress
delivery: bounded inline                       accepted behavior, not a request field
delivery: exhaustive-stream | artifact | auto  proposed request field
```

`paths` mode enumerates candidate filesystem paths without evaluating a content
pattern. Its `files` projection returns enumerated candidates. `content` mode
searches decoded text, where `files` means “files containing at least one
match.”

## Promoted Projection Contract

Projection semantics now have one authoritative home:
[Modes and Projections](../specification.md#modes-and-projections).

This note must not redefine the accepted record fields or default limits.
Remaining projection-adjacent questions are limited to additional deterministic
facet types and their output cost.

## Serialization Format

The accepted CLI formats are:

- compact line-oriented text
- one JSON response

JSONL remains a proposed adapter format, not a separate search projection.
Its event types, ordering, usage summary, byte accounting, cancellation,
backpressure, final summary, and failure semantics must be decided before
promotion. No accepted core request or CLI flag selects it yet.

## Delivery Modes

### `inline`

Return bounded data in the tool result.

Intended for small and selective searches.

This remains the default.

### `exhaustive-stream`

Write a sequence of records to protocol stdout for immediate pipeline
consumption while allowing a scan to exceed the normal inline record budget.
JSONL is the preferred candidate format.

The stream is transient delivery. It does not imply that the core creates a
durable file. There is no accepted bounded JSONL serialization yet; both its
event schema and this exhaustive delivery behavior remain work in progress.

### `artifact`

Materialize records in a managed artifact and return a small manifest.

Intended for:

- searches expected to be large
- multi-turn analysis
- repeated filtering
- exhaustive inventories
- MCP flows without a Unix pipeline

### `auto`

Allow the runtime to switch from inline delivery to an artifact when an output
threshold is reached.

This mode must be explicitly selected by the request or host policy. It must
not silently create files as an unannounced default.

Open questions:

- Should `auto` retain a small inline sample?
- How does it avoid duplicating records already prepared for inline output?
- Must a writable spool be validated before the scan starts?

## Operation Classification and Side Effects

`SEARCH` remains read-only with respect to the configured workspace.

- `inline` and `exhaustive-stream` delivery do not create durable product
  state.
- `artifact` delivery may write only to an opaque, host-authorized managed
  spool that is outside the five workspace data operations.
- Artifact materialization must be explicitly requested or enabled by a host
  policy through `auto`.
- An artifact is not addressable through workspace `READ`.
- Writing a caller-selected workspace file is shell or host redirection, or a
  separately approved create operation; it is not a hidden side effect of
  `SEARCH`.

If an MCP host interprets a read-only annotation as prohibiting all durable
server-side state, artifact materialization must use a separate truthfully
annotated tool or resource flow. The final adapter contract must not label a
state-creating operation inaccurately.

## Pipeline and Artifact Are Complementary

A pipeline is transient computation.

An artifact is deliberate materialization.

| Need | Preferred path |
| --- | --- |
| Count once | `count` or pipeline |
| Aggregate by extension or path | `summary` or pipeline |
| Pass records immediately to one command | pipeline |
| Revisit records across turns | artifact |
| Apply several follow-up filters | artifact |
| Produce a human-reviewable inventory | caller-controlled durable stream output |
| Deliver a large MCP result | managed artifact or resource |
| Perform exhaustive CLI processing | proposed exhaustive JSONL pipeline |

Conceptual CLI pipeline:

```sh
miku-text-file-ops search ... \
  --projection matches \
  --format jsonl \
  --delivery exhaustive-stream |
  jq -r '.path' |
  sort |
  uniq -c
```

Conceptual explicit materialization:

```sh
miku-text-file-ops search ... \
  --projection matches \
  --format jsonl \
  --delivery artifact
```

This returns a managed artifact identifier. A caller that instead redirects a
JSONL stream to a durable path owns that separate filesystem write. Exact flags
remain undecided.

## Completeness Axes

Three facts must remain distinct:

- envelope `completeness.complete`: the requested projection and delivery are
  complete
- summary `scanComplete`: the candidate scan required by the projection
  completed
- artifact `complete`: materialization finished without truncation or
  interruption

| Source scan | Requested delivery | Envelope |
| --- | --- | --- |
| Complete | Complete inline, exhaustive-stream, or artifact | `complete: true` |
| Complete | Inline sample truncated | `complete: false`, reason `match_limit` |
| Incomplete | Any delivery | `complete: false`, reason identifying the scan limit |
| Complete | Artifact interrupted or truncated | `complete: false`, artifact `complete: false` |

Completeness reasons describe why the requested result is bounded or
unfinished. Diagnostics describe errors, warnings, and actionable conditions.
One condition may require both, but neither field substitutes for the other.

## Exact Totals and Lower Bounds

Exact and lower-bound count semantics have been promoted to
[Modes and Projections](../specification.md#modes-and-projections). This note no
longer defines an alternative count contract.

## Additional Deterministic Facets

The normative `extension` and `topLevelPath` facets are search facts rather
than recommendations. Additional candidates are:

- encoding
- decode status
- file-size range
- configurable path-prefix depth

Facets must not include:

- semantic categories inferred by an LLM
- opaque relevance scores
- hidden sampling heuristics
- generated explanations of why a file matters

Open questions:

- Which facets provide enough value to justify their output cost?
- Should additional facets remain available only for `summary`?
- Does a file-size range remain deterministic across implementations?
- Does a configurable path depth add value beyond `topLevelPath`?

## Sampling

The first N path-ordered matches are deterministic but may all come from one
file.

The accepted default `maxMatchesPerFile` prevents one file from consuming the
entire result budget. Experiments may evaluate whether its normative default
produces useful cross-file evidence, but a changed value must be recorded in
the specification.

## Refinement Flow

Projection-first refinement and range-first reading are now accepted in
[Agent-Context-Efficient Routing](../agent-integration.md#agent-context-efficient-routing).

Continuation is not in the initial normative contract. If adopted, it remains
an exhaustive-traversal mechanism after projection selection and query
refinement, not the preferred first reaction to a broad query.

## Continuation Proposal

Any future continuation mechanism should be deterministic and request-bound.

Current possible position:

- token is opaque
- token is bound to the normalized request
- token is best-effort rather than snapshot-consistent
- filesystem changes may produce `continuation_stale`
- mutation operations never consume search continuation tokens

Until these semantics are accepted, agents must refine the query. An explicit
exhaustive-stream or artifact experiment may be used only outside the accepted
Skill contract; agents must not assume a continuation token exists.

Open questions:

- What changes invalidate a token?
- Does changing only output limits preserve validity?
- How long is a token valid?
- Is the resume position a path and line tuple?

## Artifact Manifest

Artifact delivery returns a small inline manifest.
The accepted envelope and `searchSummary` remain exactly as defined by the
normative specification; this proposal adds only the following result record
after that summary:

```json
{
  "type": "artifact",
  "artifactId": "search-01",
  "resourceUri": "miku-text-file-ops://artifact/search-01",
  "format": "jsonl",
  "records": 10542,
  "bytes": 2845210,
  "sha256": "sha256:0123456789abcdef",
  "complete": true,
  "expiresAt": "2026-07-29T18:00:00+09:00"
}
```

Possible fields:

- artifact identifier
- resource URI
- optional local path only when the host confirms a shared filesystem and
  permits path disclosure
- format
- record count
- serialized byte count
- checksum
- completion status
- creation and expiration times
- normalized request fingerprint
- cleanup owner

## Artifact Records

Current preference:

```json
{
  "type": "match",
  "path": "docs/example.md",
  "line": 42,
  "text": "matching text",
  "encoding": "utf-8"
}
```

Open questions:

- Is file metadata repeated per match or emitted once per file?
- Are context lines embedded or separate records?
- Does a final summary record close the stream?
- Are diagnostics interleaved or kept in the manifest?

## Artifact Lifecycle and Safety

A managed artifact should:

- use UTF-8 JSONL
- use a versioned schema
- store the normalized request fingerprint
- record exact or lower-bound completeness
- enforce a maximum artifact size
- use owner-only permissions where supported
- write to an incomplete temporary name
- atomically rename when complete
- remain marked incomplete after interruption
- expose a checksum
- have an explicit retention policy
- be cleaned by the spool owner
- remain outside normal source-search traversal

The runtime should not silently create a repository directory such as:

```text
.miku-search-results/
```

Doing so creates Git noise, recursive search contamination, cleanup ambiguity,
and accidental retention.

Preferred model:

- host provides a managed spool root
- runtime writes an operation-specific artifact
- spool remains outside ordinary workspace traversal
- manifest states expiration
- durable repository output requires an explicit caller-selected path

## Retention

Candidate retention classes:

- `turn`
- `session`
- `ttl`
- `durable`

Likely division:

- CLI pipeline: no retention
- standalone CLI managed artifact: TTL
- caller-controlled stream redirection: outside artifact lifecycle
- Agent Skill under a host: host-managed session artifact
- MCP: server-managed artifact or resource

Open questions:

- Which component defines a session?
- Can a standalone CLI implement session retention?
- Which component owns cleanup?

## MCP Considerations

MCP does not provide a Unix pipeline between tools.

Possible MCP delivery forms:

- MCP resource URI
- opaque artifact identifier
- bounded resource reads
- managed local path only when the host explicitly confirms shared filesystem
  access

A resource URI or identifier is preferable when server and client do not share
the same filesystem.

Current boundary:

- normal workspace `READ` does not consume artifacts
- artifact access is an adapter resource or administrative surface
- artifact access does not expand the five workspace data operations

Open questions:

- Is lifecycle owned by the core or adapter?
- How is authorization preserved after the original call?

## Proposed Skill Rules for Unaccepted Delivery Modes

Accepted projection and read-range routing lives in
[Agent integration](../agent-integration.md#agent-context-efficient-routing).
If exhaustive delivery is later promoted, the Skill may additionally instruct
the agent:

- use `exhaustive-stream` for one-pass mechanical aggregation
- use `artifact` for repeated or multi-turn access
- select artifact delivery before an obviously broad search
- never place an exhaustive artifact into model context
- mechanically search or aggregate the artifact
- keep temporary artifacts out of the repository
- use durable output only for an explicit deliverable

Possible signals that artifact delivery may be appropriate:

- repository-wide query without include globs
- common language token or punctuation
- explicit request for every occurrence
- expected generated-code or dependency matches
- prior summary showing a large result

These signals guide the Skill. They are not core ranking logic.

## Limits

Artifact mode does not remove limits.

Separate limits remain necessary for:

- inline result bytes
- artifact bytes
- visited files
- decoded source bytes
- total matches
- runtime duration
- diagnostic bytes

When a limit is reached:

- preserve status and completeness
- preserve essential counts
- reduce facet detail before hiding completeness
- mark an artifact incomplete
- report the limiting reason

The host must not be the first component to truncate output.

## Failure and Diagnostics

Possible conditions:

- spool unavailable
- permission denied
- disk full
- artifact byte limit
- cancellation
- source decode failure
- source changes during scan
- stale continuation

Accepted search limit and source diagnostics still apply. Additional candidate
codes are:

- `exhaustive_stream_failed`
- `exhaustive_stream_canceled`
- `continuation_stale`
- `continuation_request_mismatch`
- `artifact_unavailable`
- `artifact_permission_denied`
- `artifact_size_limit`
- `artifact_write_failed`
- `artifact_incomplete`
- `artifact_expired`
- `artifact_not_found`

The final contract must decide which conditions are completeness reasons and
which are diagnostics.

## Exhaustive Requests

Some tasks genuinely require every match.

Examples:

- complete migration inventory
- compliance report
- review before a repository-wide update

Proposed workflow:

1. Run complete `count` or `summary`.
2. Stream matches to a pipeline or explicit artifact.
3. Aggregate mechanically.
4. Return the aggregate and, when materialized, the artifact manifest to the
   agent.
5. Let the agent inspect selected exceptions.

This does not authorize automatic durable file generation for ordinary
searches.

## Experiments

Experiments for the remaining proposals should answer:

1. Does an encoding, decode-status, size, or deeper-path facet improve agent
   refinement enough to justify its output?
2. Does continuation encourage blind pagination after accepted projections are
   available?
3. When should the Skill select `exhaustive-stream` or `artifact`?
4. How does Qwen Code handle an artifact manifest or exhaustive stream?
5. Can interrupted artifacts be diagnosed and cleaned safely?
6. Does an exhaustive pipeline or artifact produce better agent behavior for
   the same complete-inventory task?
7. Can `auto` spill avoid surprising side effects and duplicated records?

## Current Non-Normative Preference

The current preference is:

- support explicit artifact delivery
- allow auto-spill only through request or host policy
- add further deterministic facet types only when agent tests justify their
  output cost
- keep continuation as an unpromoted proposal until its validity and stale
  behavior are specified
- use proposed exhaustive streams for one-pass aggregation
- use artifacts for repeated access
- keep artifacts outside the repository by default
- avoid relevance scoring and generated advice in the core

## Promotion Criteria

The remaining design may be promoted into the normative specification after:

- additional-facet and exhaustive-delivery schemas are prototyped
- a high-cardinality fixture exists
- continuation semantics are decided
- the value and exact schema of any additional facet are established
- exhaustive-stream cancellation and final-summary behavior are decided
- spool ownership is decided
- cleanup and expiration are tested
- interrupted artifact writes are tested
- Codex refinement and artifact behavior are tested

Until then, this document remains design work in progress.
