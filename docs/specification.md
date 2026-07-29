# miku-text-file-ops Specification

## Status

This document is the current normative clean-slate specification for
`miku-text-file-ops`.

It intentionally does not preserve compatibility with the existing
`miku-grep`, `miku-readfile`, or their Agent Skills contracts.

Supporting documents:

- [Agent integration](./agent-integration.md) defines Skill discovery,
  triggering, and routing.
- [Implementation strategy](./implementation-strategy.md) defines how the new
  product is built from scratch.
- [Work-in-progress notes](./README.md#open-design-work) do not alter this
  contract until promoted here.

## Product Definition

`miku-text-file-ops` is:

> A local-first filesystem adapter that enables generative AI agents to search
> and read bounded portions of workspace text, and to apply single-file changes
> safely without having to manipulate the original character encoding directly.

The product is not a general database-like CRUD API. Its operation model is
based on the way current coding agents actually investigate and modify a
workspace:

1. Narrow the candidate files with path or text search.
2. Read only the necessary files or line ranges.
3. Apply a contextual change to one file.
4. Use the operation result as the authoritative write result.
5. Re-read only when semantic confirmation is needed.

OpenAI Codex explicitly prefers `rg` and `rg --files` for search and uses a
contextual, file-oriented patch format for edits. The OpenAI Apply Patch API
also models each patch call as one create, update, or delete operation on a
single file.

References:

- [Codex prompt with apply_patch instructions](https://github.com/openai/codex/blob/main/codex-rs/core/prompt_with_apply_patch_instructions.md)
- [OpenAI Apply Patch guide](https://developers.openai.com/api/docs/guides/tools-apply-patch)
- [Codex agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## Design Principles

- Search and read operations may address multiple files.
- Every mutation invocation addresses exactly one regular file.
- Search and read output is explicitly bounded.
- Output budgets are enforced by the core even when the caller omits them.
- Truncation and skipped files are never hidden.
- Existing file updates are revision guarded.
- Contextual patches are the primary update form.
- Character encoding is handled by the core, not by the agent prompt.
- Decoding and encoding never use silent replacement characters.
- The workspace root is a capability boundary.
- The host or agent harness owns sandboxing and approval policy.
- CLI, Agent Skill, and any optional MCP surface are thin adapters over one
  semantic core.
- Runtime implementations must conform to the same byte-level behavior.

## Workspace Data Operations

The public workspace data-operation set is fixed to five operations.

| Operation | Cardinality | Purpose |
| --- | ---: | --- |
| `SEARCH` | multiple files | Enumerate paths or search decoded text |
| `READ` | multiple files | Read full files or selected line ranges |
| `CREATE` | one file | Create a file only when the target is absent |
| `UPDATE` | one file | Patch, replace, or explicitly transcode a file |
| `DELETE` | one file | Delete one revision-guarded regular file |

The product does not expose `WRITE` or `UPSERT`. Those names hide the
difference between creation and replacement and make accidental overwrites more
likely.

Multi-file changes are expressed as multiple single-file mutation calls. The
initial version does not provide a multi-file mutation transaction.

Administrative CLI commands, adapter-internal state, and managed result
resources are not workspace data operations. If introduced later, they must
not make additional workspace files addressable or allow the five operations
to bypass their path and mutation rules.

## Agent-Context Output Budget

`SEARCH` and `READ` must remain bounded before their results reach an agent
harness. The core must not depend on a model-specific tokenizer. Tokenizers and
context-window sizes vary, while Unicode scalar counts and emitted UTF-8 bytes
are deterministic and testable across runtimes.

Requests may contain a `limits` object. Omitted fields use the initial defaults
below.

Every supplied limit is a positive integer. Zero, negative, fractional, and
unknown limit fields are validation errors.

| Limit | `SEARCH` default | `READ` default | Meaning |
| --- | ---: | ---: | --- |
| `maxResultBytes` | 32,768 | 32,768 | Maximum canonical core-payload bytes |
| `maxTextCharsReturned` | 16,384 | 16,384 | Maximum Unicode scalar values in returned source text |
| `maxDiagnostics` | 50 | 50 | Maximum individual diagnostic records |
| `maxFilesVisited` | 10,000 | — | Maximum candidate files examined |
| `maxSourceBytes` | 268,435,456 | — | Maximum raw source bytes examined |
| `maxMatches` | 100 | — | Maximum `match` records |
| `maxMatchesPerFile` | 10 | — | Maximum `match` records from one file |
| `maxFilesReturned` | 100 | — | Maximum `file` records |
| `maxFacetValues` | 10 | — | Maximum explicit values returned per requested facet |
| `maxItems` | — | 8 | Maximum explicit read selections processed |
| `maxLinesPerItem` | — | 400 | Maximum logical lines returned for one read item |

Together these values form the versioned `agent-v1` default profile. They are
product behavior, not suggestions to the Agent Skill. A later calibration
changes the named profile or specification version rather than silently
changing an existing profile. `agent-v1` is a conformance-profile identifier,
not an additional request field.

- A caller may request lower limits.
- A caller may request higher limits only within host-configured ceilings.
- The runtime returns the effective limits used for the operation.
- When a requested value exceeds a host ceiling, the runtime clamps it,
  reports `limit_clamped`, and exposes the effective value.
- `maxTextCharsReturned` is global across all source-text fields in one
  invocation.
- `maxResultBytes` applies to the UTF-8 byte length of the canonical compact
  one-response JSON serialization plus one final LF.
- Adapter-specific RPC envelopes, transport framing, and host-side escaping
  are outside this metric. All adapters make record-admission decisions using
  the same canonical core-payload measurement.
- The byte budget includes results, diagnostics, completeness, and usage
  metadata.
- The runtime reserves enough space for a minimal envelope and reduces result
  records or context text before reducing individual diagnostic detail.
- Diagnostics beyond `maxDiagnostics` are aggregated by stable code; their
  existence and counts are never hidden.
- A `maxResultBytes` value below 4,096 is rejected with
  `result_budget_too_small`.

When a budget prevents the complete requested result:

- `status` is `partial` if useful result data was returned
- `completeness.complete` is `false`
- `completeness.reasons` identifies every limit that affected completeness
- exact counts are not implied when the scan stopped early
- omitted records or text are never represented as a complete result

The response `usage` object includes:

- `limitProfile`
- `textCharsReturned`
- `resultBytes`
- `recordsReturned`
- `diagnosticsReturned`
- `diagnosticsOmitted`
- `effectiveLimits`

These are deterministic resource measurements, not estimated model tokens.
`usage.resultBytes` is the byte length of the final canonical one-response JSON
serialization, including the decimal value of `usage.resultBytes` itself and
the final LF.
`READ` additionally reports `itemsRequested`, `itemsProcessed`, and
`itemsSkipped`, plus `nextItemIndex` when one or more items were not processed.

## SEARCH

### Modes and Projections

`SEARCH` separates what is examined from how results are projected.

- `paths`: enumerate candidate regular-file paths, equivalent in purpose to
  `rg --files`, without decoding file content
- `content`: search decoded text by literal or regular expression

| Mode | Supported projections | Default |
| --- | --- | --- |
| `paths` | `files`, `summary`, `count` | `files` |
| `content` | `matches`, `files`, `summary`, `count` | `matches` |

`projection: "matches"` with `mode: "paths"` is a validation error. Path
searches use include and exclude filters; content-only pattern, syntax, case,
context, and source-byte request fields are invalid in path mode.

SEARCH limit applicability is:

- `maxResultBytes`, `maxDiagnostics`, and `maxFilesVisited`: every mode and
  projection
- `maxSourceBytes`: content mode
- `maxTextCharsReturned`, `maxMatches`, and `maxMatchesPerFile`: content
  `matches`
- `maxFilesReturned`: `files`
- `maxFacetValues`: `summary`

Projection selection is part of the output contract, not a presentation hint.
An agent should not have to receive up to 100 paths merely to learn a path
count or directory shape.

Every search returns exactly one `type: "searchSummary"` record before any
projection-specific records. Common fields are:

- `mode`
- `scanComplete`
- `filesVisited`
- exact `filesMatched`, or `null`
- `filesMatchedAtLeast` when the exact value is unavailable
- `filesReturned`

For `paths`, a matched file is a root-contained regular-file path satisfying
the include and exclude filters.

For `content`, a matched file is a successfully decoded candidate containing
at least one match. Its summary additionally contains:

- `matchUnit: "logicalLine"`
- `filesDecoded`
- `filesSkipped`
- exact `matchesFound`, or `null`
- `matchesFoundAtLeast` when the exact value is unavailable
- `matchesReturned`

Exactly one member of every applicable exact/lower-bound pair is non-null. A
content match is one logical line containing one or more pattern hits. Multiple
literal or regular-expression hits on the same logical line count as one
match.

`scanComplete` means that all candidates required by the selected projection
were examined. It does not mean that all source content within a matched file
was examined, or that every requested record was delivered.

The projections have deliberately different traversal behavior:

- `matches` stops the whole traversal when the global match-record or output
  budget prevents another record. When `maxMatchesPerFile` is reached, it
  stops scanning that file and continues with the next candidate.
- `files` in path mode admits one record per candidate. In content mode it
  stops each file at the first matching logical line.
- `files` stops the whole traversal when its file-record or output budget
  prevents another record. It does not continue expensive traversal merely to
  compute an exact total; use `count` for that purpose.
- `summary` and `count` attempt the complete traversal needed for their
  aggregates. Content mode inspects complete decoded files.

If `matches` or `files` stops traversal, `scanComplete` is false and the
affected totals are lower bounds. At an exact limit boundary,
`scanComplete` is true if and only if no required candidate or logical line
remained unexamined. This is a conformance rule, not an adapter choice. A
configured limit that suppresses nothing does not make the result partial.

First-hit scanning in the content `files` projection can produce
`scanComplete: true` and exact `filesMatched` while
`matchesFoundAtLeast` remains a lower bound. Record suppression after a
complete scan still makes envelope `completeness.complete` false.

#### `matches`

This projection is available only in content mode. Each result record
contains:

- `type: "match"`
- normalized root-relative `path`
- one-based logical `line`
- matched `text`
- optional bounded before/after context
- resolved `encoding`

`maxMatches` and `maxMatchesPerFile` apply only to this projection.
Before/after context defaults to zero logical lines.

#### `files`

Each result record contains:

- `type: "file"`
- normalized root-relative `path`
- `rawBytes`

A content-mode record additionally contains `firstMatchLine`. No matching
source text or per-file exact match count is returned. `maxFilesReturned`
applies only to this projection.

#### `summary`

This projection returns the common `searchSummary` plus bounded deterministic
facet records. It returns no match text or file records.

The optional `facets` request field accepts:

- `extension`
- `topLevelPath`

When omitted for `summary`, both facets are returned. `maxFacetValues` applies
to each facet.

Facet records contain:

- `type: "facet"`
- `facet`
- `value`
- `files`
- `matches` in content mode
- `exact`

Values are ordered by descending `matches` in content mode or descending
`files` in path mode, then ascending Unicode scalar value order. When more
distinct values were observed, one `type: "facetRemainder"` record reports the
facet name, `valuesOmitted`, aggregate `files`, optional content-mode
`matches`, and `exact`.

`exact: true` means every required candidate was successfully accounted for in
the facet. `scanComplete: true` alone is insufficient when a source was
skipped or failed. `exact: false` means the counts are lower bounds over
successfully observed candidates. On an incomplete scan, `valuesOmitted`
counts only distinct observed values omitted by `maxFacetValues`; additional
unobserved values may exist.

A returned `facetRemainder` aggregates every omitted observed value, so
reaching `maxFacetValues` alone does not make the envelope partial. If even the
remainder record cannot be admitted within the output budget, the result is
partial.

`extension` is the final suffix of the basename including its leading dot,
without case folding. A basename with no suffix, including a single leading-dot
name such as `.gitignore`, uses `""`. Thus `archive.tar.gz` uses `.gz`.

`topLevelPath` is the first segment of the normalized root-relative path. A
file directly under the root uses `""`.

Facets are deterministic filesystem facts. They never contain semantic
categories, relevance scores, or model-generated advice.

#### `count`

This projection returns only the common `searchSummary`. It is the smallest
response for existence and quantity questions.

`summary` and `count` continue scanning after a record-delivery budget that
would stop `matches` or `files`. They remain subject to applicable visit,
source-byte, decode, cancellation, and host limits.

### Request Capabilities

A search request may specify:

- mode and a mode-supported projection
- include globs
- exclude globs
- summary facets
- a `limits` object

Content mode additionally accepts:

- required `pattern`
- optional `syntax: "literal" | "regex"`
- optional `caseSensitive`
- optional non-negative `beforeContext` and `afterContext` line counts

Syntax defaults to `literal`, matching defaults to case-sensitive, and match
context defaults to zero lines.

`beforeContext` and `afterContext` are valid only for the `matches`
projection. `facets` is valid only for `summary`. An explicitly supplied field
or limit that does not apply to the selected mode and projection fails with
`field_not_applicable`.

An explicitly supplied projection-specific field or limit that has no meaning
for the selected mode and projection is a validation error. The response may
still list inactive `agent-v1` defaults inside `effectiveLimits` so the complete
profile remains observable.

### Content Pattern Contract

A content-search pattern contains from 1 through 4,096 Unicode scalar values.
An empty pattern fails with `pattern_empty`; a longer pattern fails with
`pattern_too_large`. A pattern containing CR or LF is invalid because matching
is performed independently against one logical line.

Literal syntax treats every pattern scalar as literal text. Regular-expression
syntax uses the versioned `safe-regex-v1` subset below. Both syntaxes:

- perform substring matching within one logical line
- use no Unicode normalization
- default to case-sensitive matching
- use Unicode 17.0 locale-independent Simple Case Folding when
  `caseSensitive` is `false`

Simple Case Folding uses the `C` and `S` mappings in the Unicode 17.0
[`CaseFolding.txt`](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt).
Implementations must not substitute runtime-default lowercase conversion,
locale-sensitive conversion, or a different Unicode version.

#### `safe-regex-v1`

The supported regular-expression constructs are:

- Unicode-scalar literals and escaped punctuation
- `.` for any one scalar in the logical line
- `^` and `$` for the start and end of the logical line
- positive and negated character classes, including scalar ranges
- concatenation and `|`
- capturing `(...)` and non-capturing `(?:...)` grouping
- greedy `*`, `+`, `?`, `{n}`, `{n,}`, and `{n,m}` repetition
- lazy `*?`, `+?`, `??`, `{n}?`, `{n,}?`, and `{n,m}?` repetition
- ASCII `\d`, `\D`, `\s`, `\S`, `\w`, and `\W` classes
- ASCII `\b` and `\B` word-boundary assertions
- `\t`, `\f`, and `\v` control-character escapes
- `\xNN` and `\x{...}` scalar escapes

The ASCII classes have fixed meanings:

- `\d` is `[0-9]`
- `\w` is `[0-9A-Za-z_]`
- `\s` is `[\t\n\f\r ]`; CR and LF cannot occur inside a logical line
- the uppercase form is the complement of its lowercase form
- word boundaries use the fixed ASCII `\w` definition

Capturing groups provide grouping only. Search records do not expose captures.
Counted repetition values must not exceed 1,000, and the lower bound must not
exceed the upper bound. Escaped scalar values must be valid Unicode scalar
values and must not identify a surrogate.

Group nesting must not exceed 64 levels. The compiled Thompson NFA must not
exceed 100,000 states. Either condition fails with `regex_resource_limit`.
These are versioned `safe-regex-v1` constants rather than host-variable
defaults.

The initial subset excludes:

- lookahead and lookbehind
- numbered or named backreferences
- named groups
- inline flags
- possessive repetition and atomic groups
- recursion, conditionals, subroutine calls, and executable code
- byte-oriented matching such as `\C`
- Unicode property classes such as `\p{...}` and `\P{...}`
- multiline and dot-all modes

Unsupported syntax fails with `regex_feature_not_supported`; malformed
supported syntax fails with `regex_syntax_error`. Compilation or execution
that exceeds the fixed runtime regular-expression resource budget fails closed
with `regex_resource_limit`.

A conforming engine must provide worst-case linear-time matching in the input
line length and a bounded compilation-memory policy. It must not expose a
runtime's unrestricted backtracking expression engine as the product
contract. This safety boundary follows the principles documented by
[RE2](https://github.com/google/re2), while the list above, not the complete
RE2 syntax, is normative for this product.

A valid expression may match an empty substring. That condition does not
create multiple records: one logical line still counts as at most one match.

Search results are ordered deterministically by normalized path and line
number. The core does not add relevance scores, opaque rankings, or agent
recommendations.

### Broad Path Inventory Example

A broad path inventory can be summarized without returning individual paths.

```json
{
  "mode": "paths",
  "projection": "summary",
  "include": ["**/*.md"],
  "exclude": ["vendor/**"],
  "facets": ["topLevelPath", "extension"],
  "limits": {
    "maxFilesVisited": 10000,
    "maxFacetValues": 10
  }
}
```

### ATX Heading Candidate Search Example

Markdown ATX heading candidates do not require a format-specific operation.
They are a normal content search.

```json
{
  "mode": "content",
  "projection": "matches",
  "syntax": "regex",
  "pattern": "^#{1,6}\\s",
  "include": ["**/*.md"],
  "limits": {
    "maxMatches": 40,
    "maxMatchesPerFile": 10
  }
}
```

This expression is not a Markdown parser. It does not guarantee section
boundaries, distinguish fenced-code content, or find Setext headings. The
initial contract deliberately provides text search rather than format-aware
Markdown retrieval.

### Completeness

When a limit affects completeness, the response must contain:

- `status: "partial"`
- `completeness.complete: false`
- one or more structured reasons

A configured limit does not make a result partial unless it actually suppresses
requested data or stops required scanning. A skipped or undecodable candidate
produces a diagnostic, makes the result partial, and prevents exact workspace
totals.

Exact search counts describe the candidate paths or file bytes actually
observed during the scan. They do not claim a filesystem snapshot when other
processes modify files concurrently.

The runtime must stop before the host or agent harness truncates the output.
Continuation is not part of the initial normative contract.
Additional facet types, exhaustive stream delivery, managed artifacts, and
possible continuation semantics remain
[design work in progress](./notes/search-scaling-and-artifact-delivery.md).

## READ

`READ` accepts multiple explicit selections. It does not accept an unbounded
directory as an implicit request to return every file.

Example:

```json
{
  "items": [
    {
      "path": "README.md",
      "range": {
        "startLine": 1,
        "endLine": 80
      }
    },
    {
      "path": "docs/spec.md",
      "range": {
        "startLine": 120,
        "endLine": 120
      }
    }
  ],
  "limits": {
    "maxLinesPerItem": 120,
    "maxTextCharsReturned": 8192
  }
}
```

Supported selections are:

- `full: true`
- inclusive `range.startLine` and `range.endLine`
- `firstLines`
- `lastLines`

Exactly one selector is required for every item. Omitting a selector is a
validation error; it never implies a full-file read.

### Bounded Read Semantics

Every selection, including `full file`, remains subject to the effective output
budget.

- Items are processed in request order.
- No invocation processes more than `maxItems`.
- No item returns more than `maxLinesPerItem`.
- The global text-character and result-byte budgets apply across all items.
- A full-file selection is a convenience request, not permission to emit an
  unbounded file.
- The runtime stops at a logical-line boundary before exceeding a budget.
- For `range`, `firstLines`, and `full`, it returns the largest whole-line
  prefix that fits.
- For `lastLines`, it returns the largest whole-line suffix that fits.
- It never cuts a Unicode scalar or silently emits a partial logical line.
- If one logical line cannot fit by itself, the runtime omits that line and
  reports `line_too_large` with its logical line number and character count.
- Later items that cannot be processed within the effective budget do not
  produce one result record each. `usage.itemsSkipped` reports their count and
  `usage.nextItemIndex` identifies the first unprocessed request item.

Each item result identifies:

- zero-based request `itemIndex`
- requested selection
- actual inclusive `returnedRange`, when text was returned
- zero or more inclusive `remainingRanges`
- item-level completeness and reasons

`remainingRanges` are ordered, non-overlapping ranges within the requested
selection that exist in the file but were not returned. Together with
`returnedRange`, they partition only the requested selection after clipping it
to the file's logical-line domain. They do not describe every unread part of
the file.

An agent can request a remaining line range explicitly. This is deterministic
range refinement, not an opaque continuation token.

The raw-byte `revision` and complete file-shape metadata describe the entire
source file even when returned text is partial. A caller may use that revision
for a contextual update if the returned range contains all required patch
context.

Every successful read item returns:

- normalized root-relative `path`
- decoded text with LF in the agent-facing view
- raw-byte SHA-256 `revision`
- resolved character encoding
- encoding determination source
- BOM presence
- original line-ending shape
- final-newline presence
- raw byte size
- logical line count
- completeness information

Each item may additionally contain an `encoding` field naming one canonical
encoding. This is the explicit item override at the first position in the
encoding-resolution order. Omitting it does not imply UTF-8.

## Logical Line Model

The same line model is used by search, read, and update.

- Line numbers are 1-based.
- `startLine` and `endLine` are inclusive.
- CRLF, LF, and CR are recognized as newline sequences.
- A final newline is a content property, not an additional phantom line.
- Agent-facing text uses LF.
- Text is not Unicode-normalized.
- The initial contract does not expose character columns.

Avoiding public column semantics prevents disagreement between byte offsets,
Unicode scalar positions, and UTF-16 code-unit positions.

## CREATE

`CREATE` accepts exactly one root-relative path and Unicode content.

Required behavior:

- Fail with `target_exists` when the target exists.
- Do not implicitly overwrite.
- Do not implicitly create parent directories.
- Require every path component to remain inside the configured root.
- Reject symbolic links in the target path.
- Create with UTF-8, LF, and no BOM by default.
- Permit explicit encoding, line-ending, and BOM selection.
- Use exclusive creation semantics.
- Return the new raw-byte revision and final text format.

## UPDATE

`UPDATE` accepts exactly one existing regular file and requires its previously
observed raw-byte revision.

### Change Types

The `change` discriminated union contains:

- `context-diff`: apply one or more contextual line hunks
- `replace`: replace the entire decoded content explicitly
- `transcode`: preserve decoded content while changing its byte representation

`context-diff` is the default and recommended form for AI-generated changes.

Example:

```json
{
  "path": "docs/spec.md",
  "expectedRevision": "sha256:0123456789abcdef",
  "change": {
    "type": "context-diff",
    "diff": "@@\n old context\n-old text\n+new text\n"
  },
  "writeAs": {
    "encoding": "preserve",
    "lineEnding": "preserve",
    "bom": "preserve"
  }
}
```

### Patch Semantics

The `context-diff` transport is a product-specific, line-oriented Unicode
format. It borrows the conventional space, `-`, and `+` line indicators but
does not accept Git file headers, file paths, or line-number ranges.

Its grammar is:

```text
patch      = hunk, { hunk };
hunk       = "@@", LF, hunk-line, { hunk-line };
hunk-line  = (" " | "-" | "+"), line-text, LF;
```

`line-text` may be empty. It contains no CR or LF. The complete patch must use
LF structural delimiters and end in LF. A CR anywhere in the patch,
non-prefixed body line, header text after `@@`, `---` or `+++` file header,
line-number range, or `\ No newline at end of file` marker is a
`patch_syntax_error`.

Every hunk must contain:

- at least one changed line, indicated by `-` or `+`
- at least one source anchor, indicated by a space or `-`

The source sequence is the ordered sequence of space and `-` line texts. The
replacement sequence is the ordered sequence of space and `+` line texts.
Patch indicators and structural LF delimiters are not part of either
sequence's line text.

Each source sequence is matched against the complete original logical-line
sequence:

- matching uses exact Unicode scalar and whitespace equality
- matching performs no normalization, whitespace correction, or fuzzy search
- original newline-sequence differences do not affect line-text matching
- no match fails with `patch_context_mismatch`
- more than one match fails with `patch_ambiguous`

All hunks are independently located in the unchanged original file. Their
matched ranges must occur in patch order and must not overlap. An out-of-order
set fails with `patch_hunks_out_of_order`; an overlapping set fails with
`patch_hunks_overlap`. Relative position to another hunk does not disambiguate
a source sequence that has multiple matches.

The runtime validates every hunk, the complete resulting Unicode text, the
output encoding, and the revision guard before writing. A multi-hunk update is
all-or-nothing for that file. Line numbers may appear in diagnostics but are
not patch identity.

An addition-only hunk is valid only when it contains at least one space-prefixed
context line as its source anchor. An empty source file therefore cannot be
updated by `context-diff`. A patch that would produce zero logical lines is
also not representable while preserving the final-newline property. Both cases
fail with `patch_requires_replace`; the caller must use `replace`.

The LF that terminates a patch body line is structural and does not request a
source-file newline. `context-diff` preserves the source file's final-newline
presence whenever the result is non-empty. It does not accept a separate
no-final-newline marker.

When `writeAs.lineEnding` explicitly selects `lf`, `crlf`, or `cr`, every
result separator uses that selection. When it is `preserve`, unchanged
newline bytes remain unchanged. For each hunk, every newly required separator
uses one newline sequence selected in this order:

1. the first removed source line in that hunk that has a newline
2. the nearest preceding original line's newline
3. the nearest following original line's newline
4. the most frequent newline in the original file
5. for a frequency tie, the tied newline that appears first in the file
6. LF when the original file contains no newline

The selection is based on the unchanged original file and is deterministic.
It applies to separators introduced by the hunk, including a separator after
an added final line when the original file had a final newline.

### Whole-File Replace Semantics

For `replace`, `change.content` determines the complete result's logical-line
texts, separator positions, and final-newline presence. The newline sequences
used inside `change.content` do not by themselves request an output
line-ending kind.

When `writeAs.lineEnding` explicitly selects `lf`, `crlf`, or `cr`, every
result separator uses that selection.

When `writeAs.lineEnding` is `preserve`, result separators are selected from
the unchanged original file as follows:

1. If the original file uses exactly one newline kind, every result separator
   uses that kind.
2. If the original file uses mixed newline kinds, the separator after result
   logical line N uses the separator after original logical line N when that
   original separator exists.
3. A result separator without an original separator at the same logical-line
   number uses the most frequent newline kind in the original file.
4. For a frequency tie, the tied newline kind that appears first in the
   original file is used.
5. If the original file contains no newline, LF is used.

This rule is ordinal rather than content-based: equal line text does not move
or otherwise associate an original separator with a different result line.
It applies independently to every separator required by `change.content`,
including a separator after the final logical line. An empty
`change.content` produces an empty file.

### Revision Guard

`expectedRevision` is the SHA-256 of the complete original byte sequence.

The runtime must:

1. Verify the revision before applying the change.
2. Prepare and strictly encode the complete result.
3. Recheck the source revision immediately before replacement.
4. Fail with `stale_revision` when the revision differs.
5. Replace the file atomically through a same-directory temporary file.

The revision guard is optimistic conflict detection. It must not be described as
a fully linearizable filesystem transaction.

### Preservation Rules

When `writeAs` uses `preserve`:

- preserve the original encoding
- preserve BOM presence
- preserve final-newline presence
- preserve unchanged line bytes when possible
- preserve unchanged newline bytes
- preserve mixed line endings on unchanged lines
- choose a deterministic neighboring or dominant newline for inserted lines
- preserve file permission bits

If a newly added character cannot be represented in the preserved encoding,
the update fails with `encode_error`. The runtime must not replace it with `?`
or another fallback character.

The caller may explicitly request UTF-8 or another supported encoding in
`writeAs.encoding`.

### Update Result

A successful update returns:

- path
- old revision
- new revision
- encoding and line-ending result
- applied hunk count
- added line count
- removed line count
- written byte count

The result does not echo the complete input diff or the complete updated file.
It is authoritative for write success, so an agent is not required to re-read
the file after every successful update.

## DELETE

`DELETE` accepts exactly one existing regular file.

Required behavior:

- require `expectedRevision`
- reject directories
- reject recursive deletion
- reject symbolic links
- recheck the revision immediately before deletion
- classify the operation as destructive in protocol adapters
- return the deleted path and old revision

The core delete operation is a real deletion. Backup, Git recovery, operating
system trash integration, and approval prompts are host policies rather than
portable core semantics.

## Character Encoding Contract

### Transport Encoding

JSON, patches, diagnostics, and agent-facing text are always UTF-8. Any future
JSONL protocol must also use UTF-8.

### Initial Canonical Encodings

The initial required encoding set is:

- `utf-8`
- `utf-16le`
- `utf-16be`
- `windows-31j`

The ambiguous canonical name `shift_jis` is not used for Japanese Windows text.
Additional encodings may be added only with byte-level conformance fixtures.

### Resolution Order

Encoding resolution order is:

1. explicit request item override
2. repository path rule
3. BOM
4. strict UTF-8
5. an explicitly enabled legacy fallback such as `windows-31j`
6. `encoding_undetermined`

An explicit encoding or repository rule that conflicts with a BOM produces
`encoding_conflict`.

### Strictness

- Decode replacement with U+FFFD is prohibited.
- Encode replacement with `?` is prohibited.
- The runtime reports the first useful byte offset on decode failure.
- The runtime reports the first useful character location on encode failure.
- Encoding detection does not normalize Unicode.
- A legacy fallback is never enabled merely by a vague locale guess.

### Repository Configuration

Repository rules belong to the semantic core, not to an Agent Skill helper.

Recommended configuration path:

```text
.mikusoft/miku-text-file-ops.json
```

Example:

```json
{
  "schemaVersion": 1,
  "encodingRules": [
    {
      "glob": "legacy/**/*.txt",
      "encoding": "windows-31j"
    }
  ],
  "defaultCreate": {
    "encoding": "utf-8",
    "lineEnding": "lf",
    "bom": false
  }
}
```

## Ignore and Glob Contract

Traversal reads root and nested `.gitignore` files without invoking Git or
searching for a Git root. Rules are relative to the directory containing the
ignore file and support:

- blank lines and `#` comments
- `!` negation
- escaped leading `!` and `#`
- `*`, `?`, character classes, and Git-style `**`
- leading `/` anchoring
- trailing `/` directory-only matching
- later-rule precedence

An ignored directory is not traversed. A descendant cannot be re-included
unless its ignored parent is first re-included, matching Git's traversal
constraint. `.git/**` is always excluded from traversal. Global Git excludes
and `.git/info/exclude` are not read.

Request `include` and `exclude` arrays use the same `/`-based glob vocabulary.
An include narrows the non-ignored candidate set and never re-includes an
ignored path. Exclude is applied after include. A pattern without `/` matches
a basename at any depth; `**/` may match zero or more directory segments.

Ignore files are decoded as strict UTF-8. An unreadable or undecodable ignore
file produces `source_error`, leaves the result partial, and contributes no
rules. Ignore and request globs are compiled through the same bounded
linear-time matching core as `safe-regex-v1`; they do not expose an
unrestricted backtracking engine.

## Workspace and Path Boundary

The workspace root is configured by the CLI or server host.

- The core does not search parent directories for a Git root.
- Request paths are root-relative.
- JSON paths use `/` on every operating system.
- Absolute paths are rejected.
- `..` escape is rejected.
- empty, `.`, repeated-separator, trailing-separator, backslash, drive-letter,
  and UNC-like path forms are rejected
- NUL-containing paths are rejected.
- Path containment is verified using resolved filesystem paths.
- Symlinks are not followed.
- Only regular files are readable or mutable as file items.
- `.git/**` mutation is prohibited.

The core enforces containment. The Agent Skill must not rely on prompt-only
consent as a filesystem security boundary.

This boundary applies to request-addressable paths used by the five workspace
data operations. An adapter-internal cache or managed result resource, if
introduced, must use a distinct host-authorized capability and must not be
reachable through `SEARCH`, `READ`, `CREATE`, `UPDATE`, or `DELETE`.

## Host Permissions and Approval

The runtime does not ask interactive approval questions.

The host or agent harness owns:

- workspace selection
- sandbox enforcement
- read and write capability
- destructive-action approval
- external-root access
- backup and recovery policy

This separation matches the Codex model in which sandbox mode defines what can
be done technically and approval policy defines when execution must stop for
human authorization.

## Result Envelope

The structured response envelope is shown below with a complete `count`
search:

```json
{
  "schemaVersion": "miku-text-file-ops/v1",
  "operation": "search",
  "status": "success",
  "completeness": {
    "complete": true,
    "reasons": []
  },
  "results": [
    {
      "type": "searchSummary",
      "mode": "content",
      "scanComplete": true,
      "matchUnit": "logicalLine",
      "filesVisited": 1,
      "filesDecoded": 1,
      "filesSkipped": 0,
      "filesMatched": 0,
      "filesMatchedAtLeast": null,
      "matchesFound": 0,
      "matchesFoundAtLeast": null,
      "filesReturned": 0,
      "matchesReturned": 0
    }
  ],
  "diagnostics": [],
  "diagnosticSummary": {
    "returned": 0,
    "omitted": 0,
    "byCode": []
  },
  "usage": {
    "limitProfile": "agent-v1",
    "filesVisited": 1,
    "bytesRead": 1200,
    "textCharsReturned": 0,
    "resultBytes": 884,
    "recordsReturned": 1,
    "diagnosticsReturned": 0,
    "diagnosticsOmitted": 0,
    "effectiveLimits": {
      "maxResultBytes": 32768,
      "maxTextCharsReturned": 16384,
      "maxDiagnostics": 50,
      "maxFilesVisited": 10000,
      "maxSourceBytes": 268435456,
      "maxMatches": 100,
      "maxMatchesPerFile": 10,
      "maxFilesReturned": 100,
      "maxFacetValues": 10
    }
  }
}
```

`status` is one of:

- `success`: every requested result is complete
- `partial`: at least one useful result was returned, but a result or scan is
  incomplete
- `failed`: validation failed or no useful requested result could be produced

Each diagnostic contains:

- `severity`
- stable `code`
- human-readable `message`
- optional `path`
- optional logical line
- optional raw byte offset
- optional structured `details`

`diagnosticSummary.byCode` contains deterministic `{ "code", "count" }`
records ordered by diagnostic code. It counts returned and omitted diagnostics.

Important diagnostic codes include:

- `projection_not_supported`
- `match_limit`
- `file_result_limit`
- `file_visit_limit`
- `source_byte_limit`
- `source_error`
- `item_limit`
- `line_limit`
- `text_char_limit`
- `result_byte_limit`
- `diagnostic_limit`
- `budget_exhausted`
- `line_too_large`
- `limit_clamped`
- `result_budget_too_small`
- `pattern_empty`
- `pattern_too_large`
- `regex_syntax_error`
- `regex_feature_not_supported`
- `regex_resource_limit`
- `decode_error`
- `encoding_undetermined`
- `encoding_conflict`
- `encode_error`
- `stale_revision`
- `patch_syntax_error`
- `patch_context_mismatch`
- `patch_ambiguous`
- `patch_hunks_out_of_order`
- `patch_hunks_overlap`
- `patch_requires_replace`
- `path_escape`
- `symlink_rejected`
- `target_exists`
- `target_missing`
- `parent_missing`
- `protected_path`

Unknown request fields are validation errors. This catches misspelled
agent-generated field names instead of silently ignoring them.

## CLI Surface

The executable provides:

```text
miku-text-file-ops search
miku-text-file-ops read
miku-text-file-ops create
miku-text-file-ops update
miku-text-file-ops delete
```

These commands map one-to-one to the five workspace data operations.
Administrative commands may be added only under a separate contract; they do
not expand this operation set.

The executable also provides two global metadata options:

```text
miku-text-file-ops --help
miku-text-file-ops --version
```

Each metadata option is valid only as the sole argument. It does not read
standard input, open a workspace, or perform a data operation. Both options
write UTF-8 text without BOM to stdout, write nothing to stderr, terminate the
output with LF, and exit with code `0`.

`--version` emits exactly the `package.json` version followed by LF. `--help`
is a self-contained agent-facing interface reference. It identifies the
product and version and documents:

- the five operation commands and global options
- workspace-root, path, and stdin JSON transport rules
- the request shape, allowed values, defaults, and an example for every
  operation
- copyable stdin invocation examples whose rendered JSON is checked against
  the operation request validators
- revision handoff and contextual-diff requirements
- the supported safe-regex surface and applicable limit names with their
  `agent-v1` defaults
- whole-file replace and preserved line-ending behavior needed to predict
  mutation results
- the structured result-envelope shape and partial-result handling
- exit-code interpretation
- the minimal search, read, and guarded-mutation workflow

An agent with access to the executable and `--help` output must be able to
construct valid requests without inspecting package source or repository
documentation. These metadata options are distribution and discovery surfaces;
they do not alter the five-operation vocabulary or structured result-envelope
contract.

Each command accepts exactly one request object as a UTF-8 JSON document on
standard input. A UTF-8 BOM, malformed UTF-8, an empty input, trailing
non-whitespace data, and more than one JSON document are request errors. This
stdin contract carries multiline content and patches without shell quoting.

The CLI accepts `--root PATH` and `--json` before or after the command name.
`--root` is resolved against the process working directory when relative and
defaults to that working directory when omitted. No Git-root discovery or
parent-directory search is performed.

The default CLI projection is concise, deterministic, line-oriented text that
resembles familiar `rg` and line-numbered file output.

The normative machine mode is `--json` for one structured response.

JSONL event types, ordering, final usage reporting, cancellation, and
record-admission semantics are not part of the initial contract. A CLI must not
advertise `--jsonl` as conforming behavior until those semantics are promoted
from the work-in-progress search design.

Machine JSON emission is canonical for byte-budget conformance:

- UTF-8 without BOM
- no insignificant whitespace
- non-ASCII characters emitted directly rather than optional `\u` escapes
- stable schema field order
- one LF terminator after the JSON response

The LF terminator counts toward `maxResultBytes`. The emitted `--json` stdout
payload is exactly the canonical representation measured by
`usage.resultBytes`. An MCP adapter applies the same canonical core-payload
measurement before handing structured data to its host; host transport framing
is excluded.

Human-oriented CLI output renders the same already-bounded record set and must
not be larger than that response's canonical JSON payload. If a renderer cannot
meet that constraint, it falls back to compact JSON instead of admitting or
silently dropping a different record set. Presentation bytes do not redefine
`usage.resultBytes`.

In machine modes, stdout contains only protocol output. Progress and
human-oriented runtime messages must not corrupt stdout.

CLI exit codes are:

| Exit code | Meaning |
| ---: | --- |
| `0` | Complete success |
| `1` | Useful but partial result |
| `2` | CLI syntax, JSON, or request-validation error |
| `3` | Valid request whose operation failed, or an unexpected runtime error |

A nonzero exit does not make a structured response disposable. In `--json`
mode, callers must inspect the emitted envelope, including partial results and
diagnostics.

The normative CLI behavior is shared by the package executable and the
standalone release CLI bundle. The importable runtime bundle exposes the same
public core API without executing the CLI entrypoint. Release packaging and
asset naming are defined in
[Release and bundles](./release-and-bundles.md).

## Agent Skill and MCP Surfaces

The Agent Skill is a thin workflow adapter. It explains when to search, read,
and mutate, but does not implement encoding rules, path policy, ranking, or
patch semantics.

Its accepted trigger and routing behavior is defined in
[Agent integration](./agent-integration.md).

The MCP adapter is optional and separately enabled. When present, it exposes
separate tools:

```text
miku_text_search
miku_text_read
miku_text_create
miku_text_update
miku_text_delete
```

Separate tools allow read-only, mutating, and destructive annotations to remain
static and understandable to an agent harness.

## Authoritative Core and Runtime Conformance

There is one normative semantic core.

```text
miku-text-file-ops core
├── CLI adapter
├── Agent Skill
└── MCP adapter (optional)
```

Node.js and Java must not independently redefine:

- encoding names
- malformed-byte behavior
- regular-expression behavior
- logical line behavior
- path ordering
- patch matching
- output completeness
- revision calculation

If multiple runtime implementations are distributed, they must pass the same
conformance corpus. Required fixtures include:

- valid and invalid UTF-8
- UTF-16LE and UTF-16BE with BOM
- Windows-31J extension characters
- malformed legacy byte sequences
- characters not encodable in Windows-31J
- LF, CRLF, CR, and mixed line endings
- files with and without a final newline
- empty files and single-line files
- ambiguous and mismatched patches
- stale revisions
- path traversal and symlink cases
- bounded and explicitly partial search results

Runtime preference must be based on conformance, not on a fixed "Java first" or
"Node first" rule. The clean-slate implementation and rejected legacy assets
are governed by the [implementation strategy](./implementation-strategy.md).

## Non-Goals

The initial version does not provide:

- binary file reading or writing
- directory creation or deletion
- recursive deletion
- symlink traversal
- arbitrary filesystem access outside the configured root
- semantic or embedding search
- LLM invocation
- Git operations
- network access
- multi-file mutation transactions
- format-aware Markdown, source-code, or document parsing
- arbitrary global regex replacement

## Final Decision Summary

The core value of `miku-text-file-ops` is not the number of file operations.
Its value is one consistent boundary for:

- broad but bounded search and read
- exact character encoding behavior
- a shared logical line model
- exclusive create and revision-guarded update/delete
- contextual patch application
- deterministic structured diagnostics
- host-controlled permissions

This is the smallest product shape that directly supports the actual
search-read-edit loop used by Codex-style agents while solving the legacy text
encoding problem that ordinary agent harnesses often leave unresolved.
