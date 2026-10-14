/**
 * Sanitizes model-generated free text to protect the UI against injection,
 * malicious URLs, control characters, and length inflation.
 * (architecture.md §11.6)
 */

const URL_REGEX = /https?:\/\/[^\s<>()"']+/gi;
const HTML_TAG_REGEX = /<[^>]*>/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\([^)]+\)/g;
// Strip non-printable ASCII control characters except newline and tab
// oxlint-disable-next-line eslint/no-control-regex -- control character regex is required to strip malicious control characters per architecture §11.6
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export const TEXT_LIMITS = {
  HEADLINE: 120,
  EXPLANATION: 600,
  ANTI_PATTERN: 160,
  REASON: 160,
} as const;

/**
 * Sanitizes a single string:
 * 1. Replaces Markdown links with `[text] [link removed]`
 * 2. Replaces URLs with `[link removed]`
 * 3. Removes HTML tags
 * 4. Strips control characters
 * 5. Normalizes whitespace
 * 6. Truncates to maxChars if specified
 */
export function sanitizeText(input: string, maxChars?: number): string {
  if (!input) return '';

  let text = input;

  // 1. Markdown links: [link text](http://...) -> link text [link removed]
  text = text.replace(MARKDOWN_LINK_REGEX, '$1 [link removed]');

  // 2. Raw URLs -> [link removed]
  text = text.replace(URL_REGEX, '[link removed]');

  // 3. HTML tags -> removed
  text = text.replace(HTML_TAG_REGEX, '');

  // 4. Control characters
  text = text.replace(CONTROL_CHARS_REGEX, '');

  // 5. Collapse consecutive spaces/tabs to a single space, collapse multiple newlines
  text = text.replace(/[^\S\r\n]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.trim();

  // 6. Truncate if maxChars specified
  if (maxChars !== undefined && maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
  }

  return text;
}
