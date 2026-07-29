import {
  type SafeRegex,
  compileSafeRegex,
} from "../regex/safe-regex.js";

export interface GitIgnoreRule {
  basePath: string;
  negated: boolean;
  directoryOnly: boolean;
  basenameOnly: boolean;
  matcher: SafeRegex;
  source: string;
  line: number;
}

export interface CompiledGlob {
  basenameOnly: boolean;
  matcher: SafeRegex;
}

export function compileRequestGlob(pattern: string): CompiledGlob {
  const anchored = pattern.startsWith("/");
  const normalized = stripLeadingSlash(pattern);
  return {
    basenameOnly: !anchored && !normalized.includes("/"),
    matcher: compileSafeRegex(`^${globToRegexSource(normalized)}$`),
  };
}

export function requestGlobMatches(
  glob: CompiledGlob,
  path: string,
): boolean {
  return glob.matcher.matchesLine(
    glob.basenameOnly ? basename(path) : path,
  );
}

export function parseGitIgnore(
  text: string,
  basePath: string,
  source: string,
): readonly GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const [index, rawLine] of text.split(/\r\n|\n|\r/u).entries()) {
    let line = stripUnescapedTrailingSpaces(rawLine);
    if (line.length === 0 || line === "/") {
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    if (line.length === 0) {
      continue;
    }

    const directoryOnly = endsWithUnescapedSlash(line);
    if (directoryOnly) {
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/");
    line = stripLeadingSlash(line);
    if (line.length === 0) {
      continue;
    }

    rules.push({
      basePath,
      negated,
      directoryOnly,
      basenameOnly: !anchored && !hasUnescapedSlash(line),
      matcher: compileSafeRegex(`^${globToRegexSource(line)}$`),
      source,
      line: index + 1,
    });
  }
  return rules;
}

export function gitIgnoreStatus(
  path: string,
  directory: boolean,
  rules: readonly GitIgnoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) {
      continue;
    }
    const relative = relativeToBase(path, rule.basePath);
    if (relative === undefined || relative.length === 0) {
      continue;
    }
    const candidate = rule.basenameOnly ? basename(relative) : relative;
    if (rule.matcher.matchesLine(candidate)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function globToRegexSource(glob: string): string {
  const scalars = Array.from(glob);
  let output = "";

  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index] as string;
    if (scalar === "\\") {
      const next = scalars[index + 1];
      if (next === undefined) {
        output += "\\\\";
      } else {
        output += escapeRegexLiteral(next);
        index += 1;
      }
      continue;
    }
    if (scalar === "*") {
      if (scalars[index + 1] === "*") {
        while (scalars[index + 1] === "*") {
          index += 1;
        }
        if (scalars[index + 1] === "/") {
          output += "(?:.*/)?";
          index += 1;
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (scalar === "?") {
      output += "[^/]";
      continue;
    }
    if (scalar === "[") {
      const { source, endIndex } = copyGlobCharacterClass(scalars, index);
      output += source;
      index = endIndex;
      continue;
    }
    output += escapeRegexLiteral(scalar);
  }

  return output;
}

function copyGlobCharacterClass(
  scalars: readonly string[],
  startIndex: number,
): { source: string; endIndex: number } {
  let index = startIndex + 1;
  let source = "[";
  if (scalars[index] === "!" || scalars[index] === "^") {
    source += "^";
    index += 1;
  }

  let atoms = 0;
  for (; index < scalars.length; index += 1) {
    const scalar = scalars[index] as string;
    if (scalar === "]" && atoms > 0) {
      return { source: `${source}]`, endIndex: index };
    }
    if (scalar === "\\") {
      const next = scalars[index + 1];
      if (next === undefined) {
        throw new Error("Invalid trailing escape in glob character class");
      }
      source += escapeRegexLiteral(next);
      index += 1;
    } else {
      source += scalar === "[" ? "\\[" : scalar;
    }
    atoms += 1;
  }
  throw new Error("Unclosed glob character class");
}

function escapeRegexLiteral(scalar: string): string {
  return /[.\\^$|?*+()[\]{}]/u.test(scalar) ? `\\${scalar}` : scalar;
}

function relativeToBase(path: string, basePath: string): string | undefined {
  if (basePath.length === 0) {
    return path;
  }
  const prefix = `${basePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function hasUnescapedSlash(value: string): boolean {
  let escaped = false;
  for (const scalar of value) {
    if (!escaped && scalar === "/") {
      return true;
    }
    if (!escaped && scalar === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return false;
}

function endsWithUnescapedSlash(value: string): boolean {
  if (!value.endsWith("/")) {
    return false;
  }
  let backslashes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function stripUnescapedTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let backslashes = 0;
    for (
      let index = end - 2;
      index >= 0 && value[index] === "\\";
      index -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
