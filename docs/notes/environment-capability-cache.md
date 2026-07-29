# miku-text-file-ops Environment Capability Cache Notes

## Status

This document contains design work in progress.

It explores how `miku-text-file-ops` can record environment-specific file
access failures and verified workarounds so that later agent sessions avoid
repeating the same failed strategy.

It is not yet a normative part of the product specification.

Related documents:

- [`miku-text-file-ops` specification](../specification.md)
- [Agent integration design](../agent-integration.md)
- [Implementation strategy](../implementation-strategy.md)
- [Search scaling and artifact delivery notes](./search-scaling-and-artifact-delivery.md)

## Problem

The same logical file operation may succeed or fail depending on:

- operating system
- filesystem
- runtime and runtime version
- sandbox or harness policy
- temporary-directory access
- symbolic-link and junction behavior
- case sensitivity
- file locking
- antivirus or filesystem filters
- available executables
- codec implementation

Without persistent environment knowledge, an AI agent may repeat a strategy
that already failed in a previous session.

Natural-language notes are insufficient because:

- the agent may not load them
- the notes may not match the current environment
- failure scope may be ambiguous
- a transient failure may be mistaken for a permanent limitation
- the agent may select a semantically different fallback

## Working Principle

The CLI should maintain a verified capability cache.

This is not machine learning. It is structured evidence about attempted
strategies and their observed results.

```text
operation request
  |
  +-- determine environment fingerprint
  |
  +-- load known capabilities and failures
  |
  +-- select a known-good strategy
  |     or run a minimal preflight
  |
  +-- execute
  |
  +-- classify and record the result
  |
  +-- try one semantically equivalent fallback when allowed
  |
  +-- prefer the fallback later only after verified success
```

The agent should consume the CLI's decision rather than interpret a growing
collection of raw failure logs.

## Surface and Side-Effect Boundary

The five accepted workspace data operations remain `SEARCH`, `READ`, `CREATE`,
`UPDATE`, and `DELETE`.

The proposed `doctor`, `capabilities`, and `state` commands are administrative
CLI surfaces. They do not add workspace data operations, and their internal
files are not addressable through workspace `SEARCH` or `READ`.

Durable cache updates are adapter-internal side effects and require a
host-authorized state capability. When that capability is absent, the runtime
must use memory-only evidence or disable the cache; it must not discover a
writable location by escaping the configured workspace.

`SEARCH` and `READ` remain read-only with respect to workspace data. A host
whose read-only annotation also prohibits internal durable state must disable
cache writes for those calls or expose cache administration separately.

## Scope Model

A failure must be stored at the narrowest scope that explains it.

| Scope | Example |
| --- | --- |
| operating system or machine | Atomic replacement behaves differently on this Windows machine |
| runtime | A codec implementation is unavailable in this runtime version |
| harness or sandbox | The Codex workspace sandbox cannot write to the selected OS temp directory |
| workspace | This repository requires explicit legacy encoding rules |
| directory or path | This directory is read-only |
| file | This file conflicts with its declared encoding |
| operation or strategy | Artifact delivery fails while inline read remains available |

A path-specific permission failure must not disable the same strategy for every
workspace.

A file-specific decode error must not mark the complete machine as incapable of
decoding that encoding.

## Environment Fingerprint

The environment fingerprint should include enough information to invalidate
stale observations without storing unnecessary personal information.

Possible input:

```json
{
  "os": "windows",
  "arch": "x64",
  "runtime": {
    "name": "node",
    "version": "24.3.0"
  },
  "productVersion": "0.1.0",
  "filesystem": {
    "caseSensitive": false
  },
  "harness": "codex",
  "sandboxProfile": "workspace-write"
}
```

The stored identifier may be a hash of the normalized fingerprint.

Avoid recording:

- full user-home paths
- file contents
- credentials
- environment variables unrelated to capability selection
- user names
- raw prompts

## Invalidation Inputs

Re-evaluate cached capabilities when relevant inputs change.

Candidates:

- product version
- runtime name or version
- executable checksum
- operating-system version
- sandbox profile
- workspace root filesystem
- codec implementation version
- configured spool directory
- MCP or CLI adapter version

Not every version change requires complete invalidation. The final design may
associate capabilities with narrower implementation components.

## Proposed Capability State

```json
{
  "schemaVersion": 1,
  "environmentId": "sha256:0123456789abcdef",
  "capabilities": {
    "workspaceAtomicReplace": {
      "status": "supported",
      "verifiedAt": "2026-07-29T12:00:00+09:00"
    },
    "osTempArtifact": {
      "status": "unsupported",
      "reason": "sandbox_denied",
      "verifiedAt": "2026-07-29T12:02:00+09:00",
      "expiresAt": "2026-07-30T12:02:00+09:00"
    }
  },
  "strategies": {
    "artifactDirectory": {
      "preferred": "workspace-managed-spool",
      "avoided": [
        "os-temp"
      ]
    }
  }
}
```

Possible capability status values:

- `unknown`
- `supported`
- `unsupported`
- `degraded`
- `stale`

## Failure Evidence

A failure event should record:

- operation identifier
- operation type
- attempted strategy
- environment identifier
- failure scope
- stable diagnostic code
- operating-system error code or exit code when useful
- timestamp
- product and runtime versions
- fallback attempted
- fallback result
- evidence expiration

Paths should be root-relative where possible. Absolute paths should be removed
or hashed when they are not required for diagnosis.

## Promotion Rule

One failure must not permanently disable a strategy.

The preferred promotion rule is:

```text
original strategy failed
  +
semantically equivalent fallback succeeded
  =
prefer the verified fallback in the matching environment scope
```

Example:

```text
OS temporary directory artifact
  -> sandbox_denied

host-provided managed spool
  -> success

future selection
  -> prefer host-provided managed spool
```

If the fallback has not succeeded, record the failure as evidence but do not
promote a replacement strategy.

## Semantic Equivalence Requirement

Automatic fallback is allowed only when the alternate strategy preserves the
same public semantics.

Allowed example:

- use a different writable spool location while preserving artifact format and
  lifecycle

Disallowed example:

- switch from strict Windows-31J decoding to a replacement-oriented decoder

The capability system must not turn an environmental failure into silent data
corruption.

## Persistent and Non-Persistent Failures

Failures that may justify persistent capability state:

- command not found
- runtime or codec unavailable
- sandbox boundary
- filesystem does not support the required atomic operation
- symlink or junction restriction
- filesystem case-sensitivity behavior
- selected temp directory unavailable
- repeatable Windows file-lock behavior

Failures that should normally remain operation or file events:

- file not found
- stale revision
- patch context mismatch
- user removed the target
- one file has malformed bytes
- temporary disk-full condition
- one transient antivirus lock
- one cancellation

The second group may be logged for diagnostics but must not automatically
change machine-wide strategy.

## Proposed Development Storage

During product development, local evidence may be stored under:

```text
workplace/
└── miku-text-file-ops/
    ├── environment-cache/
    │   └── <environment-id>.json
    ├── failure-events/
    │   └── <timestamp>-<operation-id>.json
    └── doctor-reports/
        └── <environment-id>.json
```

This directory should remain outside Git tracking.

The exact production storage location remains undecided.

## Production State Directory Precedence

Possible precedence:

1. explicit `--state-dir`
2. host-provided state directory
3. environment-variable state directory
4. explicitly enabled workspace `workplace/` directory
5. memory-only mode

The runtime must not silently escape the workspace sandbox to write global
state.

An explicit option or environment variable selects a location; it does not
grant filesystem authority. The host must already authorize the selected
location. State paths must never be returned as workspace-relative paths.

Open questions:

- Should the product define an environment variable for the state directory?
- Should workspace-local state require repository configuration?
- How does an MCP server provide a session-specific state directory?
- Which state belongs to the core and which belongs to an adapter?

## Proposed Administrative CLI Surface

```text
miku-text-file-ops doctor
miku-text-file-ops doctor --refresh
miku-text-file-ops capabilities
miku-text-file-ops capabilities --explain
miku-text-file-ops state show
miku-text-file-ops state clear
```

### `doctor`

Run bounded, non-destructive environment probes.

Possible probes:

- configured state directory writable
- configured artifact spool writable
- same-directory temporary file creation
- atomic replacement behavior
- runtime codec availability
- strict encoding fixture behavior
- symlink containment behavior
- case-sensitivity behavior

Doctor probes must not modify user files. They may create and remove bounded
probe files only inside a host-authorized scratch, state, or spool capability.
Persisting a doctor report is an explicit administrative side effect.

### `capabilities --explain`

Explain why the runtime selected or avoided a strategy.

Example:

```json
{
  "selectedStrategy": "host-managed-spool",
  "reason": "os-temp was previously denied by this sandbox",
  "evidence": {
    "code": "sandbox_denied",
    "verifiedFallback": true,
    "verifiedAt": "2026-07-29T12:02:00+09:00"
  }
}
```

### `state clear`

Allow the user or host to remove stale or incorrect local evidence.

Possible scopes:

- all state
- current environment
- one workspace
- one capability
- one strategy

## Expiration and Confidence

Capability observations should have an expiration policy.

Possible classes:

- stable machine fact
- version-bound implementation fact
- session-bound sandbox fact
- short-lived transient observation

The runtime should prefer explicit expiration classes over an opaque numeric
confidence score.

Open questions:

- How long should a sandbox denial remain valid?
- Should repeated success extend expiration?
- Should one contradictory success immediately clear an unsupported status?
- Should operating-system upgrades invalidate all filesystem capabilities?

## Agent Skill Behavior

The Agent Skill should:

- let the CLI select a strategy
- respect the returned strategy and capability diagnostics
- request `--explain` only when selection needs investigation
- avoid modifying capability state directly
- avoid silently selecting a semantically different tool
- use `doctor --refresh` after a material environment change
- report persistent capability failure when no equivalent fallback exists

The Skill should not load every raw failure event into model context.

## Diagnostics Under Consideration

Possible diagnostic codes:

- `capability_unknown`
- `capability_probe_failed`
- `capability_stale`
- `strategy_unsupported`
- `strategy_degraded`
- `fallback_selected`
- `fallback_unverified`
- `state_unavailable`
- `state_read_failed`
- `state_write_failed`
- `state_schema_unsupported`

These codes should remain distinct from the underlying operation failure.

Example:

```text
underlying failure: sandbox_denied
capability consequence: fallback_selected
```

## Security and Privacy

The capability memory must not become a broad telemetry or prompt-history
system.

Requirements under consideration:

- local-only by default
- no network upload
- no file contents
- no user prompts
- root-relative or redacted paths
- owner-only permissions where supported
- bounded event retention
- explicit state inspection and deletion
- stable schema version

## Concurrency

Multiple agent processes may update the same capability state.

Questions requiring design:

- Is state append-only with periodic compaction?
- Does each process write an independent event file?
- How are capability summaries rebuilt?
- Is a lock required?
- Can a stale process overwrite newer evidence?

Possible direction:

- append independent immutable event records
- derive the current capability summary
- atomically replace only the derived summary

This reduces destructive contention between concurrent agents.

## Testing

Tests should cover:

- first run with no state
- successful probe persistence
- repeatable failure plus successful fallback
- failure without verified fallback
- state invalidation after runtime upgrade
- session-scoped sandbox change
- corrupt state file
- unsupported state schema
- concurrent state writers
- expired evidence
- user-cleared evidence
- fallback semantic-equivalence enforcement

## Current Non-Normative Preference

The current preference is:

- implement a structured capability cache behind an administrative adapter
- treat it as verified evidence rather than AI memory
- scope failures narrowly
- promote a fallback only after verified success
- reject semantically different fallbacks
- provide `doctor`, `capabilities --explain`, and state reset
- store development evidence under `workplace/`
- let the host select the production state directory
- keep state local, inspectable, bounded, and removable

## Promotion Criteria

This design may be promoted into the normative specification after:

- environment fingerprint fields are minimized
- state directory ownership is decided
- capability scopes are formalized
- expiration classes are defined
- at least one Windows and one sandbox-specific failure are reproduced
- fallback promotion is tested
- concurrent state updates are tested
- privacy review confirms that no unnecessary path or content data is stored

Until then, this document remains design work in progress.
