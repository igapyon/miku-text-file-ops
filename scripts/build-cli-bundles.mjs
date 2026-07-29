import { readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { create as createTar } from "tar";

const product = "miku-text-file-ops";
const root = resolve(import.meta.dirname, "..");
const bundleDirectory = join(root, "bundle");
const requireShim =
  'import { createRequire as __mikuCreateRequire } from "node:module";' +
  "const require = __mikuCreateRequire(import.meta.url);";

await rm(bundleDirectory, { recursive: true, force: true });

await Promise.all([
  build({
    entryPoints: [join(root, "dist/src/bin.js")],
    outfile: join(bundleDirectory, `${product}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: requireShim },
    legalComments: "eof",
  }),
  build({
    entryPoints: [join(root, "dist/src/index.js")],
    outfile: join(bundleDirectory, `${product}-runtime.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: requireShim },
    legalComments: "eof",
  }),
]);

const sourceRoots = [
  ".github",
  "docs",
  "licenses",
  "scripts",
  "src",
  "test",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];
const sourceFiles = (
  await Promise.all(sourceRoots.map((path) => collectFiles(join(root, path))))
)
  .flat()
  .map((path) => relative(root, path).split(sep).join("/"))
  .sort();

await createTar(
  {
    cwd: root,
    file: join(bundleDirectory, `${product}-sources.tgz`),
    gzip: { level: 9, mtime: 0 },
    portable: true,
    mtime: new Date(0),
    prefix: product,
    strict: true,
  },
  sourceFiles,
);

async function collectFiles(path) {
  const status = await stat(path);
  if (status.isFile()) {
    return [path];
  }
  if (!status.isDirectory()) {
    throw new Error(`Unsupported source archive entry: ${path}`);
  }

  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Source archive does not accept symlinks: ${entry.name}`);
    }
    files.push(...await collectFiles(join(path, entry.name)));
  }
  return files;
}
