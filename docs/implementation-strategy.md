# miku-text-file-ops Implementation Strategy

## Status

This document defines the accepted complete-scratch implementation strategy
for the clean-slate `miku-text-file-ops` product. It is authoritative for
repository and implementation provenance, but it does not redefine the public
semantics in the normative specification.

It complements:

- [`miku-text-file-ops` specification](./specification.md)
- [Agent integration design](./agent-integration.md)

## Decision

The product and its public contract should be created from scratch in a new
repository.

Existing product source code, schemas, tests, fixtures, and runtime packages
must not be copied, ported, forked, wrapped, or used as implementation
dependencies.

The guiding rule is:

> Observe prior failures and external behavior, but author every product
> artifact from the new specification.

This is a complete-scratch implementation, not an in-place extension of
`miku-grep`, `miku-readfile`, or another existing filesystem tool.

## Why an In-Place Extension Is Not Recommended

Renaming one of the existing repositories and adding the missing operations
would make it easy to preserve old assumptions unintentionally.

Those assumptions include:

- separate grep and read request contracts
- different logical line behavior
- different result and diagnostic semantics
- backend-dependent character encoding behavior
- agent-specific relevance ranking
- implicit Git-root expansion
- Skill-local configuration merging
- fixed Java-first or Node-first runtime selection

These are not isolated implementation details. They affect the semantic center
of the new product.

Starting from an existing public API would therefore spend substantial effort
removing compatibility behavior while still risking hidden compatibility
constraints.

## New Repository

Create a new upstream repository:

```text
miku-text-file-ops
```

The initial repository owns:

- normative request schemas
- normative response schemas
- workspace and path rules
- character encoding behavior
- logical line behavior
- search behavior
- revision calculation
- contextual patch behavior
- atomic mutation behavior
- structured diagnostics
- conformance fixtures
- CLI projections

The existing repositories may remain available only as historical evidence of
problems that the new specification must avoid. They are not source, schema,
fixture, test, or runtime dependencies of the new product.

## Contracts to Build from Scratch

Every contract in the
[normative specification](./specification.md) must be independently
implemented. This strategy deliberately does not restate those contracts,
because parallel copies would drift.

The fresh codebase must include newly authored implementations of:

- the shared request validation and result envelope
- strict decoding, encoding, and logical-line handling
- deterministic search and bounded read behavior
- root-relative path containment
- raw-byte revisions and atomic single-file mutation
- contextual patch matching and application
- CLI and Agent Skill adapters over the same semantic core

No item in this list authorizes copying an older implementation, schema, test,
or fixture.

An MCP adapter is an optional separately built surface. If implemented, it must
use the same semantic core and conformance corpus, but it is not a prerequisite
for the initial product release.

## Prior Knowledge That Informs Fresh Tests

Complete-scratch implementation does not require forgetting already observed
failure categories. It requires independently authoring the implementation and
its proof artifacts.

Fresh tests should cover:

- LF, CRLF, CR, and mixed line endings
- final newline present and absent
- empty and one-line files
- valid and invalid UTF-8
- UTF BOM variants
- Windows-31J Japanese and extension characters
- malformed Windows-31J bytes
- characters not encodable in Windows-31J
- every supported `safe-regex-v1` construct
- every rejected regular-expression construct
- Unicode 17.0 simple case-folding behavior
- regular-expression pattern, repetition, and resource limits
- contextual patch syntax, anchoring, ordering, and overlap
- deterministic inserted-line newline selection
- root escape and symbolic links
- missing and non-regular files
- deterministic paths and ignore behavior
- pure machine-mode stdout
- structured diagnostics
- strict validation of unknown fields
- success, partial, request-error, and runtime-error exits

These tests must be authored from the normative requirements. Existing test
files, expected-result files, and fixture bytes are not copied.

Known Node and Java behavior differences justify requirements but are not
accepted as implementation input. In particular, the new tests must prove that:

- one canonical encoding name has one meaning
- malformed input is rejected consistently
- repository encoding policy is executed rather than merely accepted by
  validation
- regular-expression matching does not inherit Node or Java backtracking,
  case-folding, or Unicode-version behavior
- contextual patches produce the same logical text and newline bytes

## Existing Assets That Must Not Be Reused

Do not import or port the following into the new product.

- source files or algorithms from the old products
- test source or binary fixtures from the old products
- existing grep request and response types
- existing readfile request and response types
- `readfileHints`
- agent-specific output mode
- fixed relevance heuristics
- `detectGitRoot`
- ambiguous `shift_jis` canonical naming
- Skill-side encoding config merging
- backend-specific parity exceptions
- separate grep and read logical line models
- separate grep and read repository configuration contracts
- line-number-only update semantics
- implicit overwrite behavior
- implicit parent-directory creation
- silent result truncation
- silent decode or encode replacement
- compatibility aliases for old commands

The new repository must not contain compatibility branches for these concepts.

## No-Porting Rule

The implementation process must not:

- copy a source file and refactor it
- translate an existing implementation into another language
- fork an existing repository
- wrap an existing CLI or MCP server
- copy request or response schemas
- copy test cases or binary fixtures
- retain compatibility aliases
- depend on an old runtime package

External products may be executed as black-box comparison subjects during
research. Their output does not define the new contract and they are not part
of the new test suite.

## Initial Authoritative Runtime

The recommended first authoritative implementation is TypeScript and Node.js.

Reasons:

- request schemas and diagnostics can evolve quickly during the initial design
  phase
- the CLI can be bundled for Agent Skills
- the same core can serve a later Node MCP adapter
- development and testing are practical on Windows, macOS, and Linux
- a single JavaScript CLI artifact fits the established miku-soft distribution
  model

This choice does not make current Node encoding behavior normative. The new
specification and conformance corpus are normative.

## Node Encoding Requirements

If `iconv-lite` or another replacement-oriented codec is used, add a strict
boundary around it.

Required checks include:

- detect U+FFFD introduced during decoding
- reject malformed byte sequences
- verify decode-to-encode round trips where needed
- distinguish a real U+FFFD character from decoder replacement
- verify Windows-31J extension-character fixtures
- reject unencodable output before opening the atomic replacement path

A codec library's convenient default behavior must not become the public
contract accidentally.

## Java Runtime Timing

Do not implement the Java runtime in parallel with the first Node core.

The Java version should begin only after:

- the operation schemas are stable
- the result envelope is stable
- encoding names and precedence are stable
- the logical line model is stable
- contextual patch fixtures are complete
- the Node reference implementation passes the conformance corpus

The Java implementation is a downstream conformance runtime. It must not
redesign the public semantics.

Runtime availability or preference must not override conformance results.

## Conformance-First Development

The first substantial project artifact should be the conformance corpus rather
than the CLI parser.

Recommended shape:

```text
fixtures/
├── encoding/
│   ├── utf8/
│   ├── utf16le/
│   ├── utf16be/
│   └── windows31j/
├── newlines/
├── patch/
├── revision/
├── paths/
├── output-budgets/
├── read-ranges/
└── search-projections/
```

Each fixture should include:

- input bytes or filesystem shape
- request
- expected structured result
- expected diagnostics
- expected output bytes for mutations

Byte output should be asserted directly. Comparing only decoded Unicode text is
insufficient for BOM, newline, and legacy-encoding preservation.

## Recommended Implementation Order

### Phase 1: Normative Contract

1. Freeze operation names and cardinality.
2. Define request discriminated unions.
3. Define the result envelope and diagnostic codes.
4. Define path normalization and containment.
5. Define encoding and logical line behavior.
6. Freeze default output budgets and host-ceiling behavior.
7. Freeze the path/content mode and projection matrix plus `matches`, `files`,
   `summary`, and `count` result records.
8. Freeze `safe-regex-v1`, including Unicode 17.0 simple case folding,
   unsupported syntax, and resource failures.
9. Freeze the contextual patch grammar, original-file matching, hunk
   interaction, and inserted-line newline selection.

### Phase 2: Conformance Corpus

1. Build raw-byte encoding fixtures.
2. Build newline and final-newline fixtures.
3. Build path and symlink fixtures.
4. Build revision and stale-update fixtures.
5. Build `safe-regex-v1` positive, negative, case-folding, and resource-limit
   fixtures.
6. Build contextual patch grammar, exact-match, ambiguity, ordering, overlap,
   final-newline, and mixed-newline fixtures.
7. Build default, lowered, raised, and host-clamped budget fixtures.
8. Build Unicode-scalar, canonical core-payload byte, oversized-line, and
   multi-item read budget fixtures.
9. Build diagnostic aggregation and minimal-envelope fixtures.
10. Build logical-line match-unit and all path/content search projection
   fixtures.
11. Build exact-versus-lower-bound, lightweight `files`, initial-facet, and
    facet-remainder fixtures.
12. Build canonical compact JSON byte-count fixtures.
13. Prototype artifact, exhaustive stream, additional-facet, and continuation
   behavior separately against the
   [work-in-progress search design](./notes/search-scaling-and-artifact-delivery.md).

### Phase 3: Read-Only Core

1. Implement the strict decoder.
2. Implement the logical line model.
3. Implement `READ`.
4. Implement traversal and ignore policy.
5. Implement `SEARCH` using the same decoder and line model.
6. Implement all normative search projections over one scan engine.

### Phase 4: Mutation Core

1. Implement raw-byte revisions.
2. Implement exclusive `CREATE`.
3. Implement contextual patch application.
4. Implement full replacement and transcoding.
5. Implement atomic `UPDATE`.
6. Implement guarded `DELETE`.

### Phase 5: Product Surfaces

1. Add concise CLI text output.
2. Add canonical one-response JSON mode.
3. Add stdin-independent `--help` and `--version` metadata output.
4. Build a standalone CLI bundle, an importable runtime bundle, and a
   reproducible source archive.
5. Smoke-test CLI metadata and runtime exports locally.
6. Publish the three prepared assets from a GitHub Release `published` event
   after validating its `v*` tag against `package.json`.
7. Bundle the CLI for the Agent Skill.
8. Add Skill trigger, projection-routing, range-first, and partial-result
   workflow tests.
9. Add Skill description and body size checks.
10. If a target host justifies it, add the optional MCP adapter as a separate
   deliverable.

The release asset implementation keeps product behavior in the existing core.
`esbuild` packages the already-built CLI and public runtime entrypoint; it does
not define operation semantics. The source archive is generated from an
explicit, sorted repository file set with portable metadata and a fixed
timestamp. Generated `dist/`, `bundle/`, and `release-assets/` directories are
local or CI outputs and remain outside Git.

The release workflow is separate from ordinary push and pull-request CI. Its
standard trigger is GitHub Release `published`, and it checks out the exact
release tag before building. A tag must begin with `v` and match the
`package.json` version, optionally followed by a dot suffix. Release creation,
tag selection, and publication remain human-operated GitHub actions.

### Phase 6: Additional Runtimes

1. Freeze a conformance release of the specification.
2. Implement the Java runtime.
3. Run the complete byte-level corpus against both runtimes.
4. Distribute only conforming runtimes under the same product name.

## Repository Relationship During Migration

During implementation:

- `miku-grep` and `miku-readfile` remain historical, independent repositories
- they may be observed only as black-box behavior references
- their Skills remain unchanged except for eventual deprecation notices
- the new repository does not import their code, tests, fixtures, schemas, or
  runtime packages
- behavior differences are documented in migration notes

After the new product is stable:

- mark the old products as superseded
- direct new Agent Skill use to `miku-text-file-ops`
- preserve the old repositories for history and existing users
- avoid compatibility wrappers unless a concrete external requirement emerges

## Final Position

The correct meaning of "from scratch" is:

- new repository
- new semantic contract
- new public schemas
- new mutation architecture
- no compatibility burden

It does not mean:

- ignoring known encoding failures
- losing traceability to prior work

All code, schemas, tests, and fixtures are newly authored. Prior products and
competitors remain evidence that informs requirements, never architectural or
implementation foundations.
