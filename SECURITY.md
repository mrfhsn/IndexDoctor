# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in IndexDoctor, please do **not** open a public issue. Instead, report it privately:

1. **GitHub Security Advisory**: Go to [Security Advisories](https://github.com/mrfhsn/IndexDoctor/security/advisories/new) and submit a private report.
2. **Email**: Alternatively, contact the maintainer directly at `mrfhsn253@gmail.com`.

## Scope

In-scope security topics:

- SQL Gate bypasses leading to execution of untrusted statements
- WASM Sandbox breakout or memory leak exhaustion
- Sensitive data or API key disclosure in HTTP responses or log output
- Unhandled Denial of Service vectors against the public API

## Response Timeline

- **Initial acknowledgment**: within 48 hours.
- **Triage & fix verification**: within 7 days.
- **Public advisory disclosure**: coordinated after fix release.
