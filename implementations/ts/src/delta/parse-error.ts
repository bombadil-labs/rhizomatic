/** Stable diagnosis for the JSON Term and Pred authoring profile. The message is human text. */
export type ParseErrorKind = "unknown-op" | "unknown-key" | "invalid-shape";

const nodes = new WeakMap<ParseError, unknown>();

export class ParseError extends Error {
  readonly kind: ParseErrorKind;
  /** RFC 6901 JSON Pointer into the input; the empty string names the root. */
  readonly path: string;
  /** The offending field, when the error is tied to an object key. */
  readonly field: string | undefined;
  constructor(kind: ParseErrorKind, message: string, node: unknown, field?: string, path = "") {
    super(message);
    this.name = "ParseError";
    this.kind = kind;
    this.path = path;
    this.field = field;
    nodes.set(this, node);
  }
}

function pointerTo(
  root: unknown,
  target: unknown,
  path = "",
  seen = new WeakSet<object>(),
): string | undefined {
  // Primitive identity is value equality: two equal strings are not the same location.
  // The root is a truthful fallback for malformed primitives.
  if (typeof target !== "object" || target === null) return undefined;
  if (root === target) return path;
  if (typeof root !== "object" || root === null) return undefined;
  if (seen.has(root)) return undefined;
  seen.add(root);
  for (const [key, value] of Object.entries(root)) {
    const segment = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const found = pointerTo(value, target, `${path}/${segment}`, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Decorate a parser failure at the public entry point. Existing messages stay unchanged. */
export function withParseError<T>(raw: unknown, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    if (cause instanceof ParseError) {
      const base = pointerTo(raw, nodes.get(cause));
      const path =
        base === undefined
          ? ""
          : cause.field === undefined
            ? base
            : `${base}/${cause.field.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      throw new ParseError(cause.kind, cause.message, nodes.get(cause), cause.field, path);
    }
    if (cause instanceof Error) throw new ParseError("invalid-shape", cause.message, raw);
    throw cause;
  }
}
