# Release and Bundle Design

Status: Accepted operational design.

## Purpose

This document defines how `miku-text-file-ops` packages its existing
TypeScript core and CLI for GitHub Releases. It owns build and release
operations, not product semantics. Search, read, mutation, encoding, patch,
result-envelope, and exit-code behavior remain owned by
[the specification](./specification.md).

## Local Build Contract

The release build starts from the checked-out source and uses:

```sh
npm ci
npm run build:bundle
npm run smoke:bundle
npm run smoke:runtime
```

`build:bundle` first performs the normal TypeScript build and then creates:

- `bundle/miku-text-file-ops.mjs`
  - standalone executable CLI bundle
  - responds to `--help` and `--version` without stdin
- `bundle/miku-text-file-ops-runtime.mjs`
  - importable public runtime API
  - exposes product metadata and core operation functions
- `bundle/miku-text-file-ops-sources.tgz`
  - source, tests, documentation, licenses, build scripts, and workflow source
  - uses a stable path order, portable archive metadata, and a fixed timestamp

The CLI and runtime JavaScript bundles are built from the normal compiled
entrypoints. Bundling is an adapter and distribution step; it must not
reimplement or change core behavior.

`src/metadata.ts`, `package.json`, and both root version fields in
`package-lock.json` must agree. `npm run check:version` enforces this alignment
and runs as part of `npm test`.

## Smoke Contract

`npm run smoke:bundle` executes the standalone CLI bundle and verifies:

- `--version` succeeds without stdin and equals the package version
- `--help` succeeds without stdin and documents usage and metadata options
- neither successful metadata command writes to stderr

`npm run smoke:runtime` imports the runtime bundle and verifies:

- product name and version metadata
- search and read API exports
- update API export

These checks are intentionally local and run before upload. GitHub Actions is
not the first place where a bundle's basic integrity is tested.

## GitHub Release Workflow

The workflow file is:

```text
.github/workflows/release-cli-runtime-bundles.yml
```

It runs only when a GitHub Release is published. Release creation is performed
by a human in GitHub using a `v*` tag. The workflow:

1. checks out the exact release tag
2. installs locked dependencies with Node.js 24
3. requires a tag beginning with `v`
4. requires the tag version to equal `package.json` or add a dot suffix
5. builds and smoke-tests all release bundles
6. stages versioned asset filenames
7. attaches only those prepared files to the existing GitHub Release

For package version `0.3.1`, accepted examples are `v0.3.1` and `v0.3.1.2`.
`v0.3.2` is rejected because it does not describe the checked-out package
version.

## Published Asset Names

The attached asset names use the release tag version without the leading `v`:

```text
miku-text-file-ops-<version>.mjs
miku-text-file-ops-runtime-<version>.mjs
miku-text-file-ops-sources-<version>.tgz
```

The first file is executable, the second is importable, and the third is a
reviewable source archive. An npm package tarball is not substituted for any
of these roles.

## Repository Boundary

Generated `dist/`, `bundle/`, and `release-assets/` directories are ignored by
Git. The workflow definition, build scripts, smoke scripts, source metadata,
and lockfile are tracked.

The workflow does not:

- create a GitHub Release or choose a tag
- publish to npm
- run on ordinary branch pushes or pull requests
- create or update an Agent Skill
- publish a tag, PR, or Release from local development automation
