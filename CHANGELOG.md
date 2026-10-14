# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

### Added

- Initial project scaffolding with Node 24 LTS and TypeScript strict configuration.
- Hono HTTP server with security headers, body limits, and request-id tracking.
- Health probe endpoints (`/api/health` and `/api/health/live`).
- In-memory WASM Postgres simulation validation via PGlite 0.5.9.
- AST SQL gate analysis via `libpg-query` 18.1.5.
- Multi-model LLM diagnosis probe for Gemini 3.1 Flash Lite and Gemma MoE.
- Multi-stage Dockerfile optimized for Google Cloud Run.
