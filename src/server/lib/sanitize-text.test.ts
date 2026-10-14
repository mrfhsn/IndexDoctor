import { describe, it, expect } from 'vitest';

import { sanitizeText, TEXT_LIMITS } from './sanitize-text.js';

describe('Free Text Sanitizer (lib/sanitize-text.ts)', () => {
  it('strips URLs and replaces them with [link removed]', () => {
    const raw = 'Check this out at https://evil.com/phish and http://internal.net/secret';
    const clean = sanitizeText(raw);
    expect(clean).toBe('Check this out at [link removed] and [link removed]');
    expect(clean).not.toContain('https://');
    expect(clean).not.toContain('http://');
  });

  it('strips Markdown links preserving label with [link removed]', () => {
    const raw = 'Read the [Postgres Docs](https://postgresql.org/docs) for details.';
    const clean = sanitizeText(raw);
    expect(clean).toBe('Read the Postgres Docs [link removed] for details.');
  });

  it('strips HTML tags completely', () => {
    const raw = 'Hello <script>alert(1)</script> <b>world</b> <img src=x onerror=alert(2) />';
    const clean = sanitizeText(raw);
    expect(clean).toBe('Hello alert(1) world');
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('<b>');
  });

  it('strips ASCII control characters', () => {
    const raw = 'Line with null \x00, bell \x07, and backspace \x08 preserved.';
    const clean = sanitizeText(raw);
    expect(clean).toBe('Line with null , bell , and backspace preserved.');
  });

  it('collapses multiple spaces and limits text length', () => {
    const raw = '   This   is   a   spaced    text with multiple    words.   ';
    const clean = sanitizeText(raw, 20);
    expect(clean).toBe('This is a spaced tex');
    expect(clean.length).toBeLessThanOrEqual(20);
  });

  it('respects exact TEXT_LIMITS constants', () => {
    const longString = 'a'.repeat(1000);
    expect(sanitizeText(longString, TEXT_LIMITS.HEADLINE).length).toBe(120);
    expect(sanitizeText(longString, TEXT_LIMITS.EXPLANATION).length).toBe(600);
    expect(sanitizeText(longString, TEXT_LIMITS.ANTI_PATTERN).length).toBe(160);
    expect(sanitizeText(longString, TEXT_LIMITS.REASON).length).toBe(160);
  });
});
