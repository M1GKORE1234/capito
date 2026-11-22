# Changelog

## 1.0.1 — 2026-11-22

- Published on the GitHub Marketplace.
- Development workflows moved to `examples/workflows/` (Marketplace actions cannot contain workflow files). No changes to the action itself.

## 1.0.0 — 2026-11-22

First release.

- Pull request quizzes on AI-written code, with answers verified by running the project's tests (mutation testing).
- Grading with `/capito A C`, plain-language explanations, and test-gap detection.
- Ledger on a dedicated `capito-data` branch; comprehension map (`CAPITO.md`, `map.json`) with decay, dark zones and "who understands it".
- Weekly review issue, dark-zone alerts on new issues, on-demand quizzes (`/capito quiz [file]`), `/capito map`.
- AI detection for Claude Code, Copilot, Codex, Cursor, Devin, Jules, Aider, Lovable and more; custom markers.
- English and Italian.
- Local CLI: `capito quiz`, `capito map`.
