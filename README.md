# miku-text-file-ops

Local text file operations for AI agents, supporting Windows-31J and UTF
encodings.

The project provides bounded search and read operations together with
exclusive create and revision-guarded update and delete operations. Product behavior is
defined in [the specification](docs/specification.md), and the documentation
index is available at [docs/README.md](docs/README.md).
Stable stdin/stdout invocation patterns, including Windows examples, are
documented in [docs/cli-invocation.md](docs/cli-invocation.md).

## Development

Requirements:

- Node.js 22 or later
- npm with `package-lock.json`

Common commands:

```sh
npm ci
npm test
npm run build:bundle
npm run smoke:bundle
npm run smoke:runtime
```

Generated files under `dist/`, `bundle/`, and `release-assets/` are not
committed. Local references and verification artifacts belong under
`workplace/`; only `workplace/.gitkeep` is tracked.

## Release assets

Publishing a GitHub Release with a `v*` tag runs
`.github/workflows/release-cli-runtime-bundles.yml`. The tag must match the
`package.json` version, with an optional dot suffix such as `v0.5.0.2`.

The workflow builds and attaches:

- `miku-text-file-ops-<version>.mjs`
- `miku-text-file-ops-runtime-<version>.mjs`
- `miku-text-file-ops-sources-<version>.tgz`

Release creation, tagging, and publication remain human-operated GitHub tasks.
