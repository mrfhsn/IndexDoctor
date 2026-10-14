# Contributing to IndexDoctor

Thank you for your interest in contributing to IndexDoctor!

## Development Setup

Requirements:

- Node.js 24 LTS (see `.nvmrc`)
- npm 11+
- Docker (for local container verification)

```bash
# Clone and install dependencies with exact pins
npm ci

# Run development mode (concurrent client and server)
npm run dev

# Run full quality verification
npm run verify
```

## Quality Gates

Before opening a pull request, ensure `npm run verify` passes completely:

1. `npm run fmt:check` — Formatting via `oxfmt`
2. `npm run lint` — Type-aware linting via `oxlint`
3. `npm run typecheck` — TypeScript build solution check (`tsc -b`)
4. `npm run knip` — Unused code and dependency audit
5. `npm run check:forbidden` — Anti-pattern and invariant guard
6. `npm run test` — Test suite execution across unit, pglite, and integration projects
7. `npm run build` — Production build of client and server

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(module): ...`
- `fix(module): ...`
- `test(module): ...`
- `docs: ...`
- `chore: ...`

## Architectural Principles

1. Invariants I1–I12 in `architecture.md` are binding and automated by tests.
2. The server must never log query text, schema DDL, or secrets.
3. Every response uses the standardized contract schemas from `src/shared/contract.ts`.
