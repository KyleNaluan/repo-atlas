/**
 * A minimal TOML reader for exactly what a manifest declares: table headers
 * and the string / string-array values that hold dependency names.
 *
 * Not a general TOML parser. No `web-tree-sitter` grammar exists for TOML and
 * #5 refuses a multi-toolchain overreach, so `pyproject.toml` is read the same
 * way `pom.xml` and Gradle already are here: structurally, but by a hand-rolled
 * reader scoped to the subset the manifest actually needs - dotted table
 * headers, basic and literal strings (single- and triple-quoted), arrays,
 * inline tables, and comments. Numbers, booleans, and dates are recognised
 * just far enough to skip past them; their values are never needed by a
 * dependency reader and are returned as `null`, never mistaken for a name.
 *
 * A file this reader cannot parse returns `null` rather than a best-effort
 * partial tree - the same "unrecognized, not empty" rule `declaredIn` applies
 * to a Gradle file whose declaration syntax it does not know (manifests.ts).
 */

export type TomlValue = string | TomlValue[] | TomlTable | null;
export interface TomlTable {
  [key: string]: TomlValue;
}

export const isTomlTable = (v: TomlValue | undefined): v is TomlTable =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const BARE_KEY = /[A-Za-z0-9_-]/;

class ParseError extends Error {}

class Reader {
  private i = 0;
  constructor(private readonly text: string) {}

  private get eof(): boolean {
    return this.i >= this.text.length;
  }
  private peek(): string {
    return this.text[this.i] ?? "";
  }

  /** Spaces and tabs only - what may separate tokens on one logical line. */
  private skipInline(): void {
    while (!this.eof && (this.peek() === " " || this.peek() === "\t")) this.i += 1;
  }

  /** Whitespace, newlines and comments - what separates elements inside arrays and inline tables. */
  private skipAny(): void {
    for (;;) {
      while (!this.eof && /[ \t\r\n]/.test(this.peek())) this.i += 1;
      if (this.peek() === "#") {
        while (!this.eof && this.peek() !== "\n") this.i += 1;
        continue;
      }
      break;
    }
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) throw new ParseError(`expected '${ch}' at offset ${this.i}`);
    this.i += 1;
  }

  private parseBasicString(): string {
    // text[i] === '"'
    if (this.text.slice(this.i, this.i + 3) === '"""') {
      this.i += 3;
      if (this.peek() === "\n") this.i += 1;
      else if (this.text.slice(this.i, this.i + 2) === "\r\n") this.i += 2;
      const close = this.text.indexOf('"""', this.i);
      if (close === -1) throw new ParseError("unterminated triple-quoted string");
      const raw = this.text.slice(this.i, close);
      this.i = close + 3;
      return raw;
    }
    this.i += 1;
    let out = "";
    for (;;) {
      if (this.eof) throw new ParseError("unterminated string");
      const c = this.text[this.i]!;
      if (c === '"') {
        this.i += 1;
        return out;
      }
      if (c === "\n" || c === "\r") throw new ParseError("newline in basic string");
      if (c === "\\") {
        this.i += 1;
        const e = this.text[this.i];
        switch (e) {
          case '"':
          case "\\":
            out += e;
            this.i += 1;
            break;
          case "b":
            out += "\b";
            this.i += 1;
            break;
          case "f":
            out += "\f";
            this.i += 1;
            break;
          case "n":
            out += "\n";
            this.i += 1;
            break;
          case "r":
            out += "\r";
            this.i += 1;
            break;
          case "t":
            out += "\t";
            this.i += 1;
            break;
          case "u":
            out += this.readUnicodeEscape(4);
            break;
          case "U":
            out += this.readUnicodeEscape(8);
            break;
          default:
            throw new ParseError(`bad escape at offset ${this.i}`);
        }
        continue;
      }
      out += c;
      this.i += 1;
    }
  }

  /**
   * `this.i` is at the `u`/`U` escape letter; read `width` hex digits after it.
   * A missing digit, a non-hex digit, or a scalar value outside Unicode's range
   * is unreadable TOML and throws `ParseError`, the same "unrecognized, not
   * empty" outcome every other malformed construct here yields.
   */
  private readUnicodeEscape(width: number): string {
    const hex = this.text.slice(this.i + 1, this.i + 1 + width);
    if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) {
      throw new ParseError(`bad unicode escape at offset ${this.i}`);
    }
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      throw new ParseError(`unicode escape out of range at offset ${this.i}`);
    }
    this.i += 1 + width;
    return String.fromCodePoint(cp);
  }

  private parseLiteralString(): string {
    // text[i] === "'"
    if (this.text.slice(this.i, this.i + 3) === "'''") {
      this.i += 3;
      if (this.peek() === "\n") this.i += 1;
      else if (this.text.slice(this.i, this.i + 2) === "\r\n") this.i += 2;
      const close = this.text.indexOf("'''", this.i);
      if (close === -1) throw new ParseError("unterminated triple-quoted literal string");
      const raw = this.text.slice(this.i, close);
      this.i = close + 3;
      return raw;
    }
    this.i += 1;
    const close = this.text.indexOf("'", this.i);
    if (close === -1 || this.text.slice(this.i, close).includes("\n")) {
      throw new ParseError("unterminated literal string");
    }
    const raw = this.text.slice(this.i, close);
    this.i = close + 1;
    return raw;
  }

  private parseOneKey(): string {
    if (this.peek() === '"') return this.parseBasicString();
    if (this.peek() === "'") return this.parseLiteralString();
    const start = this.i;
    while (!this.eof && BARE_KEY.test(this.peek())) this.i += 1;
    if (this.i === start) throw new ParseError(`expected a key at offset ${this.i}`);
    return this.text.slice(start, this.i);
  }

  private parseDottedKeys(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipInline();
      parts.push(this.parseOneKey());
      this.skipInline();
      if (this.peek() === ".") {
        this.i += 1;
        continue;
      }
      break;
    }
    return parts;
  }

  private parseArray(): TomlValue[] {
    this.i += 1; // consume '['
    const out: TomlValue[] = [];
    for (;;) {
      this.skipAny();
      if (this.peek() === "]") {
        this.i += 1;
        return out;
      }
      if (this.eof) throw new ParseError("unterminated array");
      out.push(this.parseValue());
      this.skipAny();
      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }
      if (this.peek() === "]") {
        this.i += 1;
        return out;
      }
      throw new ParseError(`expected ',' or ']' at offset ${this.i}`);
    }
  }

  // Lenient beyond spec: real TOML forbids a bare newline inside an inline
  // table. Tolerating one costs nothing here - this reader only needs to skip
  // an inline table's contents correctly, never validate them - and a stray
  // reformatted `{...}` should not read the whole manifest as unrecognized.
  private parseInlineTable(): TomlTable {
    this.i += 1; // consume '{'
    const out: TomlTable = {};
    this.skipAny();
    if (this.peek() === "}") {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.skipAny();
      const path = this.parseDottedKeys();
      this.skipAny();
      this.expect("=");
      this.skipAny();
      setKeyPath(out, path, this.parseValue());
      this.skipAny();
      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }
      if (this.peek() === "}") {
        this.i += 1;
        return out;
      }
      throw new ParseError(`expected ',' or '}' at offset ${this.i}`);
    }
  }

  /** A number, boolean or date: skipped past, never a dependency name. */
  private parseBareScalar(): null {
    const start = this.i;
    while (!this.eof && !",]}#\n\r \t".includes(this.peek())) this.i += 1;
    if (this.i === start) throw new ParseError(`expected a value at offset ${this.i}`);
    return null;
  }

  private parseValue(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseInlineTable();
    return this.parseBareScalar();
  }

  private parseHeader(root: TomlTable): TomlTable {
    this.i += 1; // consume first '['
    let isArrayTable = false;
    if (this.peek() === "[") {
      isArrayTable = true;
      this.i += 1;
    }
    this.skipInline();
    const path = this.parseDottedKeys();
    this.skipInline();
    this.expect("]");
    if (isArrayTable) this.expect("]");
    this.skipInline();
    if (!(this.peek() === "#" || this.peek() === "\n" || this.peek() === "\r" || this.eof)) {
      throw new ParseError(`unexpected content after table header at offset ${this.i}`);
    }
    return ensureTableForHeader(root, path, isArrayTable);
  }

  parse(): TomlTable {
    const root: TomlTable = {};
    let current: TomlTable = root;
    for (;;) {
      this.skipAny();
      if (this.eof) break;
      if (this.peek() === "[") {
        current = this.parseHeader(root);
        continue;
      }
      const path = this.parseDottedKeys();
      this.skipInline();
      this.expect("=");
      this.skipInline();
      const value = this.parseValue();
      setKeyPath(current, path, value);
      this.skipInline();
      if (!(this.peek() === "#" || this.peek() === "\n" || this.peek() === "\r" || this.eof)) {
        throw new ParseError(`unexpected content after value at offset ${this.i}`);
      }
    }
    return root;
  }
}

/** Descend `path`, creating intermediate tables, and set the leaf to `value`. */
const setKeyPath = (node: TomlTable, path: string[], value: TomlValue): void => {
  let cur = node;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx]!;
    let next = cur[key];
    if (next === undefined) {
      next = {};
      cur[key] = next;
    }
    if (!isTomlTable(next)) throw new ParseError(`'${key}' is redefined as a table`);
    cur = next;
  }
  cur[path[path.length - 1]!] = value;
};

/** Descend/create the table (or array-of-tables element) a `[header]` opens. */
const ensureTableForHeader = (root: TomlTable, path: string[], isArrayTable: boolean): TomlTable => {
  let node = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx]!;
    let next = node[key];
    if (next === undefined) {
      next = {};
      node[key] = next;
    }
    if (Array.isArray(next)) {
      const last = next[next.length - 1];
      if (!isTomlTable(last)) throw new ParseError(`'${key}' array-of-tables holds no table to open into`);
      next = last;
    }
    if (!isTomlTable(next)) throw new ParseError(`'${key}' is redefined as a table`);
    node = next;
  }
  const last = path[path.length - 1]!;
  if (isArrayTable) {
    let arr = node[last];
    if (arr === undefined) {
      arr = [];
      node[last] = arr;
    }
    if (!Array.isArray(arr)) throw new ParseError(`'${last}' is redefined as an array of tables`);
    const t: TomlTable = {};
    arr.push(t);
    return t;
  }
  let t = node[last];
  if (t === undefined) {
    t = {};
    node[last] = t;
  }
  if (Array.isArray(t)) {
    const el = t[t.length - 1];
    if (!isTomlTable(el)) throw new ParseError(`'${last}' array-of-tables holds no table to reopen`);
    return el;
  }
  if (!isTomlTable(t)) throw new ParseError(`'${last}' is redefined as a table`);
  return t;
};

/** Parse `text` as TOML, or `null` if it is not valid TOML this reader understands. */
export const parseToml = (text: string): TomlTable | null => {
  try {
    return new Reader(text).parse();
  } catch {
    return null;
  }
};
