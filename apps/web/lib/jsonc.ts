/**
 * Minimal JSONC support. Zed's `settings.json` and `keymap.json` are JSON with
 * comments and trailing commas, so the control plane stores them verbatim as
 * text (the supervisor writes them out unchanged, D18) and only validates that
 * they parse.
 */

/** Removes `//` and block comments and trailing commas, leaving string contents untouched. */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (input[i] === "\\") {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += input.slice(start, i);
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < n && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === ",") {
      // Look ahead past whitespace: a comma before `}` or `]` is a trailing comma.
      let j = i + 1;
      while (j < n && /\s/.test(input[j])) j += 1;
      if (input[j] === "}" || input[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Parses JSONC. Throws `SyntaxError` exactly like `JSON.parse` when the text is invalid. */
export function parseJsonc(input: string): unknown {
  const stripped = stripJsonc(input).trim();
  if (stripped === "") return undefined;
  return JSON.parse(stripped);
}

/** True when `input` is empty or parses as JSONC. */
export function isJsonc(input: string): boolean {
  try {
    parseJsonc(input);
    return true;
  } catch {
    return false;
  }
}
