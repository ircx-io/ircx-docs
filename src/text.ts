// Log-safe text shared by every module that prints a message.

/**
 * Maps every UTF-16 unit outside 0x20-0x7e to `\xNN` (or `\uNNNN`), so text
 * taken from content can never start a new output line or a workflow command.
 */
export function safeText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (code <= 0xff) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      for (let i = 0; i < ch.length; i++) {
        out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
      }
    }
  }
  return out;
}

/** One check, scan or checker finding. */
export interface Finding {
  /** Repository-relative path, already charset-checked or passed through `safeText`. */
  readonly file: string;
  readonly line?: number;
  readonly rule: string;
  readonly message: string;
}

/** Formats a finding as `path:line: rule: message`, safe for a CI log. */
export function formatFinding(f: Finding): string {
  const where = f.line === undefined ? safeText(f.file) : `${safeText(f.file)}:${f.line}`;
  return `${where}: ${f.rule}: ${safeText(f.message)}`;
}
