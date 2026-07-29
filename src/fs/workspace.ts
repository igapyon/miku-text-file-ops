import {
  lstat,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Diagnostic,
} from "../contracts/types.js";
import { validateWorkspacePath } from "../contracts/requests.js";
import { decodeStrict } from "../text/encoding.js";
import {
  type CompiledGlob,
  type GitIgnoreRule,
  compileRequestGlob,
  gitIgnoreStatus,
  parseGitIgnore,
  requestGlobMatches,
} from "./glob.js";

export interface WorkspaceFile {
  path: string;
  absolutePath: string;
  rawBytes: number;
}

export interface WorkspaceScanOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  maxFiles?: number;
}

export interface WorkspaceScanResult {
  files: readonly WorkspaceFile[];
  diagnostics: readonly Diagnostic[];
  truncated: boolean;
}

interface ScanState {
  files: WorkspaceFile[];
  diagnostics: Diagnostic[];
  maximumFiles: number;
  truncated: boolean;
}

export type WorkspaceBoundaryErrorCode =
  | "path_escape"
  | "symlink_rejected"
  | "target_missing"
  | "target_exists"
  | "parent_missing"
  | "source_error";

export class WorkspaceBoundaryError extends Error {
  readonly code: WorkspaceBoundaryErrorCode;
  readonly path: string | undefined;

  constructor(
    code: WorkspaceBoundaryErrorCode,
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
    this.path = path;
  }
}

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<Workspace> {
    if (!isAbsolute(root)) {
      throw new WorkspaceBoundaryError(
        "path_escape",
        "Workspace root must be absolute",
      );
    }
    const resolved = await realpath(root);
    const status = await lstat(resolved);
    if (!status.isDirectory()) {
      throw new WorkspaceBoundaryError(
        "source_error",
        "Workspace root must be a directory",
      );
    }
    return new Workspace(resolved);
  }

  async resolveExistingFile(path: string): Promise<string> {
    validateWorkspacePath(path, "path", false);
    const absolutePath = await this.#walkExisting(path);
    const status = await lstat(absolutePath);
    if (!status.isFile()) {
      throw new WorkspaceBoundaryError(
        "source_error",
        "Target is not a regular file",
        path,
      );
    }
    return absolutePath;
  }

  async resolveCreateTarget(path: string): Promise<string> {
    validateWorkspacePath(path, "path", true);
    const segments = path.split("/");
    const targetName = segments.pop() as string;
    let current = this.root;

    for (const segment of segments) {
      current = join(current, segment);
      let status;
      try {
        status = await lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          throw new WorkspaceBoundaryError(
            "parent_missing",
            "Create parent directory does not exist",
            path,
          );
        }
        throw error;
      }
      if (status.isSymbolicLink()) {
        throw new WorkspaceBoundaryError(
          "symlink_rejected",
          "Symbolic links are not allowed in a target path",
          path,
        );
      }
      if (!status.isDirectory()) {
        throw new WorkspaceBoundaryError(
          "parent_missing",
          "Create parent is not a directory",
          path,
        );
      }
    }

    const target = join(current, targetName);
    this.#assertContained(target, path);
    try {
      await lstat(target);
      throw new WorkspaceBoundaryError(
        "target_exists",
        "Create target already exists",
        path,
      );
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) {
        throw error;
      }
      if (!isMissing(error)) {
        throw error;
      }
    }
    return target;
  }

  async scan(options: WorkspaceScanOptions = {}): Promise<WorkspaceScanResult> {
    const includes = (options.include ?? []).map(compileRequestGlob);
    const excludes = (options.exclude ?? []).map(compileRequestGlob);
    const state: ScanState = {
      files: [],
      diagnostics: [],
      maximumFiles: options.maxFiles ?? Number.MAX_SAFE_INTEGER,
      truncated: false,
    };

    await this.#scanDirectory(
      "",
      [],
      includes,
      excludes,
      state,
    );
    return {
      files: state.files,
      diagnostics: state.diagnostics,
      truncated: state.truncated,
    };
  }

  async #walkExisting(path: string): Promise<string> {
    let current = this.root;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      let status;
      try {
        status = await lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          throw new WorkspaceBoundaryError(
            "target_missing",
            "Target does not exist",
            path,
          );
        }
        throw error;
      }
      if (status.isSymbolicLink()) {
        throw new WorkspaceBoundaryError(
          "symlink_rejected",
          "Symbolic links are not allowed in a target path",
          path,
        );
      }
    }
    this.#assertContained(current, path);
    return current;
  }

  async #scanDirectory(
    directoryPath: string,
    inheritedRules: readonly GitIgnoreRule[],
    includes: readonly CompiledGlob[],
    excludes: readonly CompiledGlob[],
    state: ScanState,
  ): Promise<void> {
    const absoluteDirectory =
      directoryPath.length === 0
        ? this.root
        : join(this.root, ...directoryPath.split("/"));
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      state.diagnostics.push(sourceDiagnostic(directoryPath, error));
      return;
    }
    entries.sort((left, right) => compareUnicodeScalars(left.name, right.name));

    const localRules = await this.#loadGitIgnore(
      directoryPath,
      absoluteDirectory,
      entries.some((entry) => entry.name === ".gitignore"),
      state.diagnostics,
    );
    const rules = [...inheritedRules, ...localRules];

    for (const entry of entries) {
      if (state.files.length >= state.maximumFiles) {
        state.truncated = true;
        break;
      }
      if (directoryPath.length === 0 && entry.name === ".git") {
        continue;
      }
      const path =
        directoryPath.length === 0
          ? entry.name
          : `${directoryPath}/${entry.name}`;
      const absolutePath = join(absoluteDirectory, entry.name);

      let status;
      try {
        status = await lstat(absolutePath);
      } catch (error) {
        state.diagnostics.push(sourceDiagnostic(path, error));
        continue;
      }
      if (status.isSymbolicLink()) {
        continue;
      }

      if (status.isDirectory()) {
        if (!gitIgnoreStatus(path, true, rules)) {
          await this.#scanDirectory(
            path,
            rules,
            includes,
            excludes,
            state,
          );
          if (state.truncated) break;
        }
        continue;
      }
      if (!status.isFile() || gitIgnoreStatus(path, false, rules)) {
        continue;
      }
      if (
        includes.length > 0 &&
        !includes.some((glob) => requestGlobMatches(glob, path))
      ) {
        continue;
      }
      if (excludes.some((glob) => requestGlobMatches(glob, path))) {
        continue;
      }

      state.files.push({
        path,
        absolutePath,
        rawBytes: status.size,
      });
    }
  }

  async #loadGitIgnore(
    directoryPath: string,
    absoluteDirectory: string,
    present: boolean,
    diagnostics: Diagnostic[],
  ): Promise<readonly GitIgnoreRule[]> {
    if (!present) {
      return [];
    }
    const path =
      directoryPath.length === 0
        ? ".gitignore"
        : `${directoryPath}/.gitignore`;
    const absolutePath = join(absoluteDirectory, ".gitignore");
    try {
      const status = await lstat(absolutePath);
      if (!status.isFile() || status.isSymbolicLink()) {
        return [];
      }
      const bytes = await readFile(absolutePath);
      return parseGitIgnore(decodeStrict(bytes, "utf-8"), directoryPath, path);
    } catch (error) {
      diagnostics.push(sourceDiagnostic(path, error));
      return [];
    }
  }

  #assertContained(absolutePath: string, requestPath: string): void {
    const relativePath = relative(this.root, resolve(absolutePath));
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new WorkspaceBoundaryError(
        "path_escape",
        "Resolved path escapes the workspace root",
        requestPath,
      );
    }
  }
}

function sourceDiagnostic(path: string, error: unknown): Diagnostic {
  return {
    severity: "warning",
    code: "source_error",
    message: error instanceof Error ? error.message : String(error),
    ...(path.length > 0 ? { path } : {}),
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left);
  const rightScalars = Array.from(right);
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftScalars[index]?.codePointAt(0) ?? 0) -
      (rightScalars[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftScalars.length - rightScalars.length;
}
