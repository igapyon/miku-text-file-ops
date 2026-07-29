import { simpleCaseFoldEquivalents } from "./simple-case-folding-17.js";

export type SafeRegexErrorCode =
  | "pattern_empty"
  | "pattern_too_large"
  | "regex_syntax_error"
  | "regex_feature_not_supported"
  | "regex_resource_limit";

export interface SafeRegexOptions {
  caseSensitive?: boolean;
}

export interface SafeRegex {
  readonly pattern: string;
  readonly caseSensitive: boolean;
  matchesLine(line: string): boolean;
}

type Ast =
  | { type: "empty" }
  | { type: "char"; matcher: CharacterMatcher }
  | { type: "assert"; assertion: Assertion }
  | { type: "concat"; children: readonly Ast[] }
  | { type: "alternate"; children: readonly Ast[] }
  | { type: "repeat"; child: Ast; min: number; max: number | null };

type Assertion = "start" | "end" | "wordBoundary" | "notWordBoundary";

interface ScalarRange {
  start: number;
  end: number;
}

interface ClassTerm {
  ranges: readonly ScalarRange[];
  negated: boolean;
}

interface CharacterMatcher {
  any: boolean;
  terms: readonly ClassTerm[];
  negated: boolean;
}

type NfaState =
  | { type: "char"; matcher: CharacterMatcher; out: number }
  | { type: "split"; first: number; second: number }
  | { type: "assert"; assertion: Assertion; out: number }
  | { type: "match" };

interface CompiledRegex {
  states: readonly NfaState[];
  start: number;
  caseSensitive: boolean;
}

interface ClassAtom {
  term: ClassTerm;
  singleton?: number;
}

const MAX_PATTERN_SCALARS = 4_096;
const MAX_REPETITION = 1_000;
const MAX_GROUP_DEPTH = 64;
const MAX_NFA_STATES = 100_000;

const ASCII_DIGIT = ranges([0x30, 0x39]);
const ASCII_WORD = ranges(
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
);
const ASCII_SPACE = ranges(
  [0x09, 0x0a],
  [0x0c, 0x0d],
  [0x20, 0x20],
);

export class SafeRegexError extends Error {
  readonly code: SafeRegexErrorCode;
  readonly patternIndex: number | undefined;

  constructor(
    code: SafeRegexErrorCode,
    message: string,
    patternIndex?: number,
  ) {
    super(message);
    this.name = "SafeRegexError";
    this.code = code;
    this.patternIndex = patternIndex;
  }
}

export function compileSafeRegex(
  pattern: string,
  options: SafeRegexOptions = {},
): SafeRegex {
  const scalars = Array.from(pattern);
  if (scalars.length === 0) {
    throw new SafeRegexError("pattern_empty", "Pattern must not be empty");
  }
  if (scalars.length > MAX_PATTERN_SCALARS) {
    throw new SafeRegexError(
      "pattern_too_large",
      `Pattern must not exceed ${MAX_PATTERN_SCALARS} Unicode scalars`,
    );
  }
  validatePatternScalars(scalars);

  const parser = new Parser(scalars);
  const ast = parser.parse();
  const caseSensitive = options.caseSensitive ?? true;
  const compiled = compileAst(ast, caseSensitive);

  return {
    pattern,
    caseSensitive,
    matchesLine(line: string): boolean {
      return matchesCompiledLine(compiled, line);
    },
  };
}

class Parser {
  readonly #scalars: readonly string[];
  #index = 0;
  #depth = 0;

  constructor(scalars: readonly string[]) {
    this.#scalars = scalars;
  }

  parse(): Ast {
    const ast = this.#parseAlternation();
    if (!this.#atEnd()) {
      throw this.#syntax(`Unexpected ${this.#peek()}`);
    }
    return ast;
  }

  #parseAlternation(): Ast {
    const children = [this.#parseConcatenation()];
    while (this.#peek() === "|") {
      this.#index += 1;
      children.push(this.#parseConcatenation());
    }
    return children.length === 1 ? (children[0] as Ast) : {
      type: "alternate",
      children,
    };
  }

  #parseConcatenation(): Ast {
    const children: Ast[] = [];
    while (!this.#atEnd() && this.#peek() !== ")" && this.#peek() !== "|") {
      children.push(this.#parseRepetition());
    }
    if (children.length === 0) {
      return { type: "empty" };
    }
    return children.length === 1 ? (children[0] as Ast) : {
      type: "concat",
      children,
    };
  }

  #parseRepetition(): Ast {
    let atom = this.#parseAtom();
    const quantifier = this.#peek();
    if (
      quantifier !== "*" &&
      quantifier !== "+" &&
      quantifier !== "?" &&
      quantifier !== "{"
    ) {
      return atom;
    }
    if (atom.type === "assert") {
      throw this.#syntax("An assertion cannot be repeated");
    }

    let min: number;
    let max: number | null;
    if (quantifier === "*") {
      this.#index += 1;
      min = 0;
      max = null;
    } else if (quantifier === "+") {
      this.#index += 1;
      min = 1;
      max = null;
    } else if (quantifier === "?") {
      this.#index += 1;
      min = 0;
      max = 1;
    } else {
      ({ min, max } = this.#parseCountedRepetition());
    }

    if (this.#peek() === "+") {
      throw this.#unsupported("Possessive repetition is not supported");
    }
    if (this.#peek() === "?") {
      this.#index += 1;
    }
    if (isQuantifierStart(this.#peek())) {
      throw this.#syntax("Only one repetition operator may follow an atom");
    }

    atom = { type: "repeat", child: atom, min, max };
    return atom;
  }

  #parseCountedRepetition(): { min: number; max: number | null } {
    this.#expect("{");
    const min = this.#parseDecimal();
    if (min === undefined) {
      throw this.#syntax("A counted repetition requires a lower bound");
    }

    let max: number | null;
    if (this.#peek() === "}") {
      this.#index += 1;
      max = min;
    } else {
      this.#expect(",");
      max = this.#parseDecimal() ?? null;
      this.#expect("}");
    }

    if (min > MAX_REPETITION || (max !== null && max > MAX_REPETITION)) {
      throw new SafeRegexError(
        "regex_resource_limit",
        `Counted repetition must not exceed ${MAX_REPETITION}`,
        this.#index,
      );
    }
    if (max !== null && min > max) {
      throw this.#syntax(
        "A repetition lower bound must not exceed its upper bound",
      );
    }
    return { min, max };
  }

  #parseAtom(): Ast {
    const scalar = this.#peek();
    if (scalar === undefined) {
      throw this.#syntax("Expected an expression atom");
    }

    switch (scalar) {
      case ".":
        this.#index += 1;
        return { type: "char", matcher: anyScalarMatcher() };
      case "^":
        this.#index += 1;
        return { type: "assert", assertion: "start" };
      case "$":
        this.#index += 1;
        return { type: "assert", assertion: "end" };
      case "(":
        return this.#parseGroup();
      case "[":
        return { type: "char", matcher: this.#parseCharacterClass() };
      case "\\":
        return this.#parseEscape(false);
      case ")":
      case "|":
        throw this.#syntax(`Unexpected ${scalar}`);
      case "*":
      case "+":
      case "?":
      case "{":
        throw this.#syntax("A repetition operator requires a preceding atom");
      case "]":
      case "}":
        throw this.#syntax(`Unmatched ${scalar}`);
      default:
        this.#index += 1;
        return {
          type: "char",
          matcher: scalarMatcher(codePoint(scalar)),
        };
    }
  }

  #parseGroup(): Ast {
    this.#expect("(");
    let nonCapturing = false;
    if (this.#peek() === "?") {
      this.#index += 1;
      if (this.#peek() !== ":") {
        throw this.#unsupported(
          "Lookaround, named groups, and inline flags are not supported",
        );
      }
      this.#index += 1;
      nonCapturing = true;
    }

    this.#depth += 1;
    if (this.#depth > MAX_GROUP_DEPTH) {
      throw new SafeRegexError(
        "regex_resource_limit",
        `Group nesting must not exceed ${MAX_GROUP_DEPTH}`,
        this.#index,
      );
    }
    const child = this.#parseAlternation();
    this.#expect(")");
    this.#depth -= 1;
    void nonCapturing;
    return child;
  }

  #parseCharacterClass(): CharacterMatcher {
    this.#expect("[");
    const negated = this.#peek() === "^";
    if (negated) {
      this.#index += 1;
    }

    const terms: ClassTerm[] = [];
    let sawAtom = false;
    while (!this.#atEnd() && this.#peek() !== "]") {
      const left = this.#parseClassAtom();
      sawAtom = true;
      if (this.#peek() === "-" && this.#peek(1) !== "]") {
        this.#index += 1;
        const right = this.#parseClassAtom();
        if (left.singleton === undefined || right.singleton === undefined) {
          throw this.#syntax(
            "Character-class ranges require scalar endpoints",
          );
        }
        if (left.singleton > right.singleton) {
          throw this.#syntax(
            "Character-class range start must not exceed its end",
          );
        }
        terms.push({
          ranges: ranges([left.singleton, right.singleton]),
          negated: false,
        });
      } else {
        terms.push(left.term);
      }
    }

    if (!sawAtom) {
      throw this.#syntax("A character class must not be empty");
    }
    this.#expect("]");
    return { any: false, terms, negated };
  }

  #parseClassAtom(): ClassAtom {
    const scalar = this.#peek();
    if (scalar === undefined || scalar === "]") {
      throw this.#syntax("Expected a character-class atom");
    }
    if (scalar === "\\") {
      const escaped = this.#parseEscape(true);
      if (escaped.type !== "char") {
        throw this.#syntax("Assertions are not valid in a character class");
      }
      const term = escaped.matcher.terms[0];
      if (term === undefined) {
        throw this.#syntax("Expected a character-class term");
      }
      const onlyRange = term.ranges[0];
      if (
        term.ranges.length === 1 &&
        term.negated === false &&
        onlyRange !== undefined &&
        onlyRange.start === onlyRange.end
      ) {
        return { term, singleton: onlyRange.start };
      }
      return { term };
    }
    this.#index += 1;
    const singleton = codePoint(scalar);
    return {
      term: { ranges: ranges([singleton, singleton]), negated: false },
      singleton,
    };
  }

  #parseEscape(inClass: boolean): Ast {
    this.#expect("\\");
    const escaped = this.#peek();
    if (escaped === undefined) {
      throw this.#syntax("A trailing backslash is invalid");
    }
    this.#index += 1;

    switch (escaped) {
      case "d":
        return charAst(ASCII_DIGIT);
      case "D":
        return charAst(ASCII_DIGIT, true);
      case "s":
        return charAst(ASCII_SPACE);
      case "S":
        return charAst(ASCII_SPACE, true);
      case "w":
        return charAst(ASCII_WORD);
      case "W":
        return charAst(ASCII_WORD, true);
      case "b":
        if (inClass) {
          throw this.#unsupported("\\b is not supported in a character class");
        }
        return { type: "assert", assertion: "wordBoundary" };
      case "B":
        if (inClass) {
          throw this.#unsupported("\\B is not supported in a character class");
        }
        return { type: "assert", assertion: "notWordBoundary" };
      case "t":
        return charAst(ranges([0x09, 0x09]));
      case "f":
        return charAst(ranges([0x0c, 0x0c]));
      case "v":
        return charAst(ranges([0x0b, 0x0b]));
      case "x":
        return charAst(ranges(this.#parseHexEscape()));
      case "n":
      case "r":
        throw this.#unsupported(
          "CR and LF cannot be matched inside one logical line",
        );
      case "p":
      case "P":
        throw this.#unsupported("Unicode property classes are not supported");
      case "C":
        throw this.#unsupported("Byte-oriented matching is not supported");
      default:
        if (/^[0-9A-Za-z]$/u.test(escaped)) {
          throw this.#unsupported(`Unsupported escape: \\${escaped}`);
        }
        return {
          type: "char",
          matcher: scalarMatcher(codePoint(escaped)),
        };
    }
  }

  #parseHexEscape(): [number, number] {
    if (this.#peek() === "{") {
      this.#index += 1;
      const start = this.#index;
      while (isHex(this.#peek())) {
        this.#index += 1;
      }
      const digits = this.#scalars.slice(start, this.#index).join("");
      if (digits.length < 1 || digits.length > 6) {
        throw this.#syntax(
          "A braced hexadecimal escape requires 1 through 6 digits",
        );
      }
      this.#expect("}");
      const value = Number.parseInt(digits, 16);
      validateEscapedScalar(value, this.#index);
      return [value, value];
    }

    const first = this.#peek();
    const second = this.#peek(1);
    if (!isHex(first) || !isHex(second)) {
      throw this.#syntax("A hexadecimal escape requires exactly 2 digits");
    }
    this.#index += 2;
    const value = Number.parseInt(`${first}${second}`, 16);
    return [value, value];
  }

  #parseDecimal(): number | undefined {
    const start = this.#index;
    while (/^[0-9]$/u.test(this.#peek() ?? "")) {
      this.#index += 1;
    }
    return start === this.#index
      ? undefined
      : Number.parseInt(this.#scalars.slice(start, this.#index).join(""), 10);
  }

  #peek(offset = 0): string | undefined {
    return this.#scalars[this.#index + offset];
  }

  #atEnd(): boolean {
    return this.#index >= this.#scalars.length;
  }

  #expect(expected: string): void {
    if (this.#peek() !== expected) {
      throw this.#syntax(`Expected ${expected}`);
    }
    this.#index += 1;
  }

  #syntax(message: string): SafeRegexError {
    return new SafeRegexError("regex_syntax_error", message, this.#index);
  }

  #unsupported(message: string): SafeRegexError {
    return new SafeRegexError(
      "regex_feature_not_supported",
      message,
      this.#index,
    );
  }
}

function compileAst(ast: Ast, caseSensitive: boolean): CompiledRegex {
  const states: NfaState[] = [{ type: "match" }];
  const start = compileNode(ast, 0, states);
  return { states, start, caseSensitive };
}

function compileNode(ast: Ast, next: number, states: NfaState[]): number {
  switch (ast.type) {
    case "empty":
      return next;
    case "char":
      return addState(states, { type: "char", matcher: ast.matcher, out: next });
    case "assert":
      return addState(states, {
        type: "assert",
        assertion: ast.assertion,
        out: next,
      });
    case "concat": {
      let start = next;
      for (let index = ast.children.length - 1; index >= 0; index -= 1) {
        start = compileNode(ast.children[index] as Ast, start, states);
      }
      return start;
    }
    case "alternate": {
      const starts = ast.children.map((child) =>
        compileNode(child, next, states),
      );
      let start = starts.pop() ?? next;
      while (starts.length > 0) {
        start = addState(states, {
          type: "split",
          first: starts.pop() as number,
          second: start,
        });
      }
      return start;
    }
    case "repeat":
      return compileRepeat(ast, next, states);
  }
}

function compileRepeat(
  ast: Extract<Ast, { type: "repeat" }>,
  next: number,
  states: NfaState[],
): number {
  let start = next;
  if (ast.max === null) {
    const splitIndex = addState(states, {
      type: "split",
      first: -1,
      second: next,
    });
    const repeatedStart = compileNode(ast.child, splitIndex, states);
    states[splitIndex] = {
      type: "split",
      first: repeatedStart,
      second: next,
    };
    start = splitIndex;
  } else {
    for (let count = ast.max - ast.min; count > 0; count -= 1) {
      const optionalStart = compileNode(ast.child, start, states);
      start = addState(states, {
        type: "split",
        first: optionalStart,
        second: start,
      });
    }
  }

  for (let count = ast.min; count > 0; count -= 1) {
    start = compileNode(ast.child, start, states);
  }
  return start;
}

function addState(states: NfaState[], state: NfaState): number {
  if (states.length >= MAX_NFA_STATES) {
    throw new SafeRegexError(
      "regex_resource_limit",
      `Compiled expression must not exceed ${MAX_NFA_STATES} NFA states`,
    );
  }
  states.push(state);
  return states.length - 1;
}

function matchesCompiledLine(compiled: CompiledRegex, line: string): boolean {
  const scalars = Array.from(line);
  validateLineScalars(scalars);
  let current = new Set<number>();

  for (let position = 0; position <= scalars.length; position += 1) {
    addClosure(compiled, current, compiled.start, position, scalars);
    if (containsMatch(compiled.states, current)) {
      return true;
    }
    if (position === scalars.length) {
      break;
    }

    const currentCodePoint = codePoint(scalars[position] as string);
    const next = new Set<number>();
    for (const stateIndex of current) {
      const state = compiled.states[stateIndex];
      if (
        state?.type === "char" &&
        characterMatches(
          state.matcher,
          currentCodePoint,
          compiled.caseSensitive,
        )
      ) {
        addClosure(compiled, next, state.out, position + 1, scalars);
      }
    }
    current = next;
  }

  return false;
}

function addClosure(
  compiled: CompiledRegex,
  target: Set<number>,
  start: number,
  position: number,
  input: readonly string[],
): void {
  const stack = [start];
  while (stack.length > 0) {
    const stateIndex = stack.pop() as number;
    if (target.has(stateIndex)) {
      continue;
    }
    target.add(stateIndex);
    const state = compiled.states[stateIndex];
    if (state?.type === "split") {
      stack.push(state.second, state.first);
    } else if (
      state?.type === "assert" &&
      assertionMatches(state.assertion, position, input)
    ) {
      stack.push(state.out);
    }
  }
}

function containsMatch(
  states: readonly NfaState[],
  active: ReadonlySet<number>,
): boolean {
  for (const stateIndex of active) {
    if (states[stateIndex]?.type === "match") {
      return true;
    }
  }
  return false;
}

function assertionMatches(
  assertion: Assertion,
  position: number,
  input: readonly string[],
): boolean {
  switch (assertion) {
    case "start":
      return position === 0;
    case "end":
      return position === input.length;
    case "wordBoundary": {
      const before = position > 0 && isAsciiWord(input[position - 1]);
      const after =
        position < input.length && isAsciiWord(input[position]);
      return before !== after;
    }
    case "notWordBoundary": {
      const before = position > 0 && isAsciiWord(input[position - 1]);
      const after =
        position < input.length && isAsciiWord(input[position]);
      return before === after;
    }
  }
}

function characterMatches(
  matcher: CharacterMatcher,
  input: number,
  caseSensitive: boolean,
): boolean {
  if (matcher.any) {
    return true;
  }
  const positive = matcher.terms.some((term) => {
    const inRanges = scalarOrEquivalentInRanges(
      input,
      term.ranges,
      caseSensitive,
    );
    return term.negated ? !inRanges : inRanges;
  });
  return matcher.negated ? !positive : positive;
}

function scalarOrEquivalentInRanges(
  input: number,
  scalarRanges: readonly ScalarRange[],
  caseSensitive: boolean,
): boolean {
  const candidates = caseSensitive
    ? [input]
    : simpleCaseFoldEquivalents(input);
  return candidates.some((candidate) =>
    scalarRanges.some(
      (range) => candidate >= range.start && candidate <= range.end,
    ),
  );
}

function anyScalarMatcher(): CharacterMatcher {
  return { any: true, terms: [], negated: false };
}

function scalarMatcher(scalar: number): CharacterMatcher {
  return {
    any: false,
    terms: [
      {
        ranges: ranges([scalar, scalar]),
        negated: false,
      },
    ],
    negated: false,
  };
}

function charAst(
  scalarRanges: readonly ScalarRange[],
  negated = false,
): Ast {
  return {
    type: "char",
    matcher: {
      any: false,
      terms: [{ ranges: scalarRanges, negated }],
      negated: false,
    },
  };
}

function ranges(...values: ReadonlyArray<readonly [number, number]>): ScalarRange[] {
  return values.map(([start, end]) => ({ start, end }));
}

function validatePatternScalars(scalars: readonly string[]): void {
  for (const [index, scalar] of scalars.entries()) {
    const value = codePoint(scalar);
    if (value === 0x0a || value === 0x0d) {
      throw new SafeRegexError(
        "regex_syntax_error",
        "Pattern must not contain CR or LF",
        index,
      );
    }
    if (isSurrogate(value)) {
      throw new SafeRegexError(
        "regex_syntax_error",
        "Pattern must contain only Unicode scalar values",
        index,
      );
    }
  }
}

function validateLineScalars(scalars: readonly string[]): void {
  for (const scalar of scalars) {
    const value = codePoint(scalar);
    if (value === 0x0a || value === 0x0d || isSurrogate(value)) {
      throw new Error("matchesLine requires one valid Unicode logical line");
    }
  }
}

function validateEscapedScalar(value: number, patternIndex: number): void {
  if (value > 0x10ffff || isSurrogate(value)) {
    throw new SafeRegexError(
      "regex_syntax_error",
      "Hex escape must identify a Unicode scalar value",
      patternIndex,
    );
  }
}

function codePoint(scalar: string): number {
  return scalar.codePointAt(0) as number;
}

function isSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff;
}

function isHex(value: string | undefined): boolean {
  return value !== undefined && /^[0-9A-Fa-f]$/u.test(value);
}

function isQuantifierStart(value: string | undefined): boolean {
  return value === "*" || value === "+" || value === "?" || value === "{";
}

function isAsciiWord(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const scalar = codePoint(value);
  return (
    (scalar >= 0x30 && scalar <= 0x39) ||
    (scalar >= 0x41 && scalar <= 0x5a) ||
    scalar === 0x5f ||
    (scalar >= 0x61 && scalar <= 0x7a)
  );
}
