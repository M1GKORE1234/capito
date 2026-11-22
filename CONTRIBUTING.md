# Contributing

Thanks for helping! Capito is small on purpose: no runtime dependencies besides the Babel parser, no external services.

```bash
npm ci
npm run typecheck
npm test        # unit tests + GitHub flows on a fake API + the bundled action end to end
npm run build   # always commit the updated dist/
```

- `src/core/` — everything that does not know about GitHub: mutations, test runs, quizzes, ledger, map, texts (`i18n.ts`).
- `src/github/` — the Action: event handling (`run.ts`), REST client (`api.ts`), data branch (`store.ts`).
- `src/cli/` — the local command-line tool.

Good first contributions: new mutation operators (with a plain-language explanation in both languages), new AI agent signatures in `ai-detect.ts`, translations, Python support.

If you use an AI agent to contribute, great: Capito will ask you about it. 🙂
