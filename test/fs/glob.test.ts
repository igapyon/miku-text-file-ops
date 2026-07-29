import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRequestGlob,
  gitIgnoreStatus,
  parseGitIgnore,
  requestGlobMatches,
} from "../../src/index.js";

test("request glob supports zero or more directories for double star", () => {
  const glob = compileRequestGlob("docs/**/*.md");
  assert.equal(requestGlobMatches(glob, "docs/readme.md"), true);
  assert.equal(requestGlobMatches(glob, "docs/api/spec.md"), true);
  assert.equal(requestGlobMatches(glob, "README.md"), false);
});

test("double star crosses directories only in Git-style positions", () => {
  for (const pattern of ["dir/a**b", "dir/**b", "dir/a***b"]) {
    const glob = compileRequestGlob(pattern);
    assert.equal(
      requestGlobMatches(glob, "dir/a/x/b"),
      false,
      `${pattern} must not cross a directory separator`,
    );
  }

  const leading = compileRequestGlob("**/name");
  assert.equal(requestGlobMatches(leading, "name"), true);
  assert.equal(requestGlobMatches(leading, "a/b/name"), true);

  const middle = compileRequestGlob("dir/**/name");
  assert.equal(requestGlobMatches(middle, "dir/name"), true);
  assert.equal(requestGlobMatches(middle, "dir/a/b/name"), true);

  const trailing = compileRequestGlob("dir/**");
  assert.equal(requestGlobMatches(trailing, "dir/file"), true);
  assert.equal(requestGlobMatches(trailing, "dir/a/b"), true);
});

test("request glob without slash matches basenames at any depth", () => {
  const glob = compileRequestGlob("*.md");
  assert.equal(requestGlobMatches(glob, "README.md"), true);
  assert.equal(requestGlobMatches(glob, "docs/spec.md"), true);
  assert.equal(requestGlobMatches(glob, "docs/spec.txt"), false);
});

test("a leading slash anchors a glob to its base directory", () => {
  const request = compileRequestGlob("/root.md");
  assert.equal(requestGlobMatches(request, "root.md"), true);
  assert.equal(requestGlobMatches(request, "docs/root.md"), false);

  const rules = parseGitIgnore("/root.log\n", "", ".gitignore");
  assert.equal(gitIgnoreStatus("root.log", false, rules), true);
  assert.equal(gitIgnoreStatus("docs/root.log", false, rules), false);
});

test("gitignore applies later negation and directory-only rules", () => {
  const rules = parseGitIgnore(
    "*.log\n!important.log\nbuild/\n",
    "",
    ".gitignore",
  );
  assert.equal(gitIgnoreStatus("notes.log", false, rules), true);
  assert.equal(gitIgnoreStatus("important.log", false, rules), false);
  assert.equal(gitIgnoreStatus("build", true, rules), true);
  assert.equal(gitIgnoreStatus("build.txt", false, rules), false);
});

test("nested gitignore rules are relative to their directory", () => {
  const rules = parseGitIgnore(
    "*.tmp\n!keep.tmp\n",
    "nested",
    "nested/.gitignore",
  );
  assert.equal(gitIgnoreStatus("nested/cache.tmp", false, rules), true);
  assert.equal(gitIgnoreStatus("nested/keep.tmp", false, rules), false);
  assert.equal(gitIgnoreStatus("other/cache.tmp", false, rules), false);
});

test("gitignore supports comments, escaped markers, and trailing spaces", () => {
  const rules = parseGitIgnore(
    "# comment\n\\!literal\n\\#hash\ntrimmed.txt   \n",
    "",
    ".gitignore",
  );
  assert.equal(gitIgnoreStatus("!literal", false, rules), true);
  assert.equal(gitIgnoreStatus("#hash", false, rules), true);
  assert.equal(gitIgnoreStatus("trimmed.txt", false, rules), true);
  assert.equal(rules.length, 3);
});

test("gitignore shares the Git-style double-star boundary", () => {
  const ordinary = parseGitIgnore("dir/a**b\n", "", ".gitignore");
  assert.equal(gitIgnoreStatus("dir/axxb", false, ordinary), true);
  assert.equal(gitIgnoreStatus("dir/a/x/b", false, ordinary), false);

  const recursive = parseGitIgnore("dir/**/name\n", "", ".gitignore");
  assert.equal(gitIgnoreStatus("dir/name", false, recursive), true);
  assert.equal(gitIgnoreStatus("dir/a/b/name", false, recursive), true);
});
