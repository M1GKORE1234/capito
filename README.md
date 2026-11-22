<div align="center">

# 🧠 Capito

**Your AI writes the code. Does anyone understand it?**

Capito is a GitHub Action that measures and pays down *comprehension debt* in AI-written code.<br>
It asks 60-second questions about the code your agents write, **with answers verified by running your own tests**,<br>
and keeps a map of which parts of your repo a human has actually understood.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands) · [The comprehension map](#the-comprehension-map) · [Configuration](#configuration) · [Italiano 🇮🇹](README.it.md)

</div>

---

## The problem

AI agents now write a large share of the code that gets merged, and the code usually *works*. What quietly disappears is the human understanding of it: **comprehension debt**, the gap between how much code a system contains and how much of it anyone genuinely understands ([Addy Osmani](https://addyosmani.com/blog/comprehension-debt/)).

- In a randomized controlled trial by Anthropic, developers who coded with AI assistance scored **50% vs 67%** on a comprehension quiz about the code they had just written, with the biggest gap in *debugging* ([Anthropic, 2026](https://www.anthropic.com/research/AI-assistance-coding-skills)).
- In the same study, people who **generated code and then asked questions to understand it** scored **86%**, higher than people who wrote the code by hand.
- None of the usual engineering dashboards (velocity, DORA, coverage) can see this debt. It shows up later, as the incident nobody can debug.

Capito turns that "generate, then understand" pattern into a habit your whole team gets for free, right where the code lands.

## What it looks like

When a pull request contains AI-written commits, Capito changes the new code in a few small, realistic ways, **runs your test suite against each version**, and posts a question:

> ### 🧠 Capito? A 60-second check on the code in this PR
> This PR contains AI-written code (detected: `Co-Authored-By: Claude`). I changed the code in 3 small ways and **ran your tests** on each version.
>
> **Which of these changes make your tests fail?**
>
> **A** · `src/cart.js:17` — The variable is updated the opposite way: "+=" becomes "-=".
> ```diff
> - subtotal += item.price * item.qty * (1 - bulkDiscount(item.qty));
> + subtotal -= item.price * item.qty * (1 - bulkDiscount(item.qty));
> ```
> **B** · `src/cart.js:10` — The comparison becomes stricter: when both values are equal, it now gives the opposite answer.
> ```diff
> - if (subtotal >= FREE_SHIPPING_THRESHOLD || isMember) return 0;
> + if (subtotal > FREE_SHIPPING_THRESHOLD || isMember) return 0;
> ```
> **C** · `src/cart.js:23` — The comparison becomes looser: when both values are equal, it now gives the opposite answer.
> ```diff
> - return items.length > 0 && !!user && !user.banned;
> + return items.length >= 0 && !!user && !user.banned;
> ```
> **Answer** with a comment: `/capito A C` or `/capito none`.

Anyone on the team answers with a comment. Capito replies with what really happens, and flags the **holes in your tests** it found along the way:

> 🟡 @ada **1/3.** Here is what really happens:
>
> | | Change | You said | What really happens |
> |---|---|---|---|
> | ❌ **A** | `src/cart.js:17` `+=` → `-=` | tests still pass | 🔴 tests fail |
> | ❌ **B** | `src/cart.js:10` `>=` → `>` | tests fail | 🟢 tests still pass |
> | ✔️ **C** | `src/cart.js:23` `>` → `>=` | tests fail | 🔴 tests fail |
>
> 🕳️ **Gap in your tests:** **B** (`src/cart.js:10`) survives: no test notices. A test for that behaviour would make this code safer, for you and for the next AI agent that edits it.

Every answer feeds the **comprehension map** of your repository, and every Monday Capito opens a **5-minute review** on the darkest corners of your AI-written code.

## Why it is different

There are already "PR quiz" bots that block the merge until you answer LLM-generated questions. Capito is built around three different choices:

| | Typical PR quiz | Capito |
|---|---|---|
| Who knows the right answer? | An LLM (which may itself misunderstand the code) | **Your test suite.** Each answer is computed by actually running the mutated code |
| Does it block you? | Yes, merge gate | **Never.** Nothing to game, nothing to bypass |
| What is left after the PR? | Nothing | A **comprehension map** with decay, dark zones and a weekly review |
| Extra value | — | Every quiz is also a small **mutation test**: it finds untested behaviour |
| Cost | LLM API calls | **Zero.** No AI, no external service, no API key. Runs in your own Actions |

## Quick start

**1. Add the workflow.** Copy [`examples/workflows/capito.yml`](examples/workflows/capito.yml) to `.github/workflows/capito.yml` in your repository:

```yaml
name: Capito
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created]
  issues:
    types: [opened]
  schedule:
    - cron: '17 8 * * 1' # weekly review, Monday morning (UTC)
  workflow_dispatch:

permissions:
  contents: write # store answers on the capito-data branch
  pull-requests: write
  issues: write

jobs:
  capito:
    if: github.event_name != 'issue_comment' || contains(github.event.comment.body, '/capito')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # Capito uses git blame to find AI-written lines
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - if: github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || contains(github.event.comment.body, '/capito quiz')
        run: npm ci
      - uses: M1GKORE1234/capito@v1
        with:
          test-command: npm test
          lang: en # or: it
          secret: ${{ secrets.CAPITO_SECRET }} # optional
```

**2. (Optional) add a secret.** Create a repository secret named `CAPITO_SECRET` with any random string. It encrypts the correct answers so nobody can read them from the page source. Without it Capito still works.

**3. Open a pull request** with code written by Claude Code, Copilot, Codex, Cursor, Devin, Jules, Aider, Lovable... Capito recognizes their commit signatures automatically.

> **Requirement:** your tests must pass on the pull request (Capito needs a green baseline to know what "fails" means). JavaScript and TypeScript are supported today, with any test runner (Jest, Vitest, Mocha, `node --test`, Playwright...).

## How it works

```mermaid
flowchart LR
    A[PR with AI commits] --> B[Find changed JS/TS lines]
    B --> C[Create small mutants<br/>flip a comparison, swap && and ‖, off-by-one...]
    C --> D[Run your tests<br/>on each mutant]
    D --> E[Question: which changes<br/>make the tests fail?]
    E --> F[/capito A C/]
    F --> G[Grade + show test gaps]
    G --> H[(Ledger on<br/>capito-data branch)]
    H --> I[Comprehension map<br/>+ weekly review]
```

1. **Detect AI-written code.** Commit trailers (`Co-Authored-By: Claude`, `Copilot`, `Codex`...), "Generated with" footers and agent bot accounts. Add your own patterns with `ai-markers`, or use `treat-all-as-ai` for code from tools that leave no trace.
2. **Mutate.** Capito parses the changed files (Babel parser, JS/TS/JSX/TSX) and creates realistic one-token changes on the changed lines: stricter or looser comparisons, inverted equality, `&&` ↔ `||`, removed `!`, swapped arithmetic, flipped booleans, off-by-one numbers. Strings, comments, types and enums are never touched.
3. **Run your tests** once on the untouched code (it must pass), then once per mutant. Each mutant is either **caught** (tests fail) or **survives** (tests still pass). The original file is always restored.
4. **Ask.** It picks 2-4 changes on different lines, mixing caught and surviving ones so the answer is never obvious, and explains each change in plain language. The correct answers are encrypted (AES-256-GCM) inside the comment.
5. **Grade and learn.** `/capito A C` gets an instant, exact grade, an explanation of each change, and a list of test gaps.
6. **Remember.** Answers go to `ledger.json` on a dedicated `capito-data` branch (no database, no external service). The map is rebuilt from it.

## Commands

Write these in any pull request or issue comment:

| Command | What it does |
|---|---|
| `/capito A C` | Answer the latest quiz in the thread (letters of the changes that make the tests fail). Italian works too: `/capito A e C` |
| `/capito none` | No change makes the tests fail (`/capito nessuna`) |
| `/capito quiz` | New quiz on the code of this pull request* |
| `/capito quiz src/billing.ts` | Quiz on a specific file* |
| `/capito map` | Reply with the comprehension map (`/capito mappa`) |
| `/capito` | Help |

\* On-demand quizzes run code, so they are only available to people with write access, and only on branches of the same repository (never forks).

## The comprehension map

Capito keeps `CAPITO.md` up to date on the `capito-data` branch:

- **AI lines per file**, from `git blame` and the AI detection above.
- **Proofs**: every answer is worth up to one proof for each file it was about, scaled by how many options were right. Proofs **halve every 90 days**, because understanding fades.
- **Score** = `100 × proofs / ⌈AI lines ÷ 40⌉`, capped at 100. One recent, fully correct answer covers 40 AI-written lines.
- **Dark zone**: a file with at least 10 AI lines and a score below 30.
- **Comprehension index**: the average score weighted by AI lines.
- **Who understands it**: people whose proofs on that file are still worth something. This is your *bus factor of understanding*.

The map drives two more features:

- **Weekly review** (schedule): a single issue with a quiz on the darkest files, prioritizing files mentioned in open issues. Last week's review is closed automatically.
- **Dark zone alerts**: when a new issue mentions a file nobody has shown they understand (`src/cart.js:23` in a stack trace is enough), Capito says so, lists the related tests and suggests `/capito quiz` *before* someone, or some agent, starts fixing it.

All thresholds are configurable.

## Configuration

| Input | Default | Description |
|---|---|---|
| `test-command` | `npm test` | Command that runs your tests. Must pass on the current code. |
| `lang` | `en` | Language of the comments: `en` or `it`. |
| `secret` | | Key that makes the encrypted answers undecodable (use `secrets.CAPITO_SECRET`). |
| `max-mutants` | `8` | Changes tested per quiz (2-20). Each runs your test suite once. |
| `options` | `3` | Options per question (2-4). |
| `timeout-seconds` | auto | Timeout per test run. Default: 3× the baseline run, at least 30 s. |
| `ai-only` | `true` | Only ask about pull requests with AI-written commits. |
| `ai-markers` | | Extra regexes (one per line) that mark a commit message as AI-written. |
| `treat-all-as-ai` | `false` | Count every line as AI-written. |
| `include` | all JS/TS | Globs of source files to consider. |
| `exclude` | | Extra globs to ignore. Tests, `dist`, `build`, `node_modules`, `*.d.ts` and config files are always ignored. |
| `review-files` | `2` | Files covered by the weekly review (1-5). |
| `alert-on-issues` | `true` | Comment on new issues that touch dark zones. |
| `include-drafts` | `false` | Also ask on draft pull requests. |
| `anonymous` | `false` | Store pseudonyms instead of usernames. |
| `data-branch` | `capito-data` | Where the ledger and the map live. |
| `half-life-days` | `90` | Days after which a proof is worth half. |
| `lines-per-proof` | `40` | AI lines covered by one proof. |
| `min-ai-lines` | `10` | Smaller files are never dark zones. |
| `dark-threshold` | `30` | Score below which a file is a dark zone. |
| `mode` | `auto` | `auto` reacts to the event; `review` runs the weekly review now; `map` only updates the map. |

**Outputs:** `outcome`, `quiz-id`, `comprehension-index`, `dark-zones`. Use them to fail a nightly job if the index drops, post to Slack, and so on.

## Security and privacy

- **Nothing leaves GitHub.** No AI calls, no telemetry, no external service: the action runs in your runner with your token.
- **Untrusted code is never run with write access.** Capito refuses `pull_request_target`. Pull requests from forks run with GitHub's read-only token: the quiz goes to the job summary instead of a comment. On-demand quizzes (`/capito quiz`) only run for users with write access and only on branches of the same repository.
- **Answers are encrypted** with AES-256-GCM. With `CAPITO_SECRET` only the workflow can decrypt them, and the quiz cannot be edited (changing a file or line name invalidates it). Without it the key is derived from the repository name, which is fine for a tool that never blocks anything.
- **Personal access tokens:** if you pass a PAT as `github-token`, quizzes are posted under a user account; set `CAPITO_SECRET` so Capito can trust them (public-key quizzes are only trusted when posted by a bot).
- **What is stored:** for each answer, the username, the quiz id, the files/lines it was about and whether each option was right. In public repositories this branch is public; set `anonymous: true` to store pseudonyms. Delete the `capito-data` branch to reset everything.
- **Your files are always restored** after mutation testing, even if a test run crashes or times out.

## Use it locally

The same engine works from the terminal, no GitHub needed:

```bash
npx github:M1GKORE1234/capito quiz                    # quiz on what you changed since main
npx github:M1GKORE1234/capito quiz --file src/cart.ts # quiz on one file
npx github:M1GKORE1234/capito map                     # your comprehension map
```

Options: `--test "<cmd>"`, `--lang it`, `--base <ref>`, `--max-mutants <n>`, `--answer "A C"`. Local answers are stored in `.capito/ledger.json`.

## FAQ

**Does it slow down my pull requests?** It runs in its own job and never blocks merging. With `max-mutants: 8` it runs your tests 9 times; with a fast unit suite that is under a minute. Point `test-command` at your fastest suite.

**What if my tests are slow or flaky?** Use a faster `test-command` (e.g. unit tests only), lower `max-mutants`, or set `timeout-seconds`. Mutants that time out are never used in questions.

**My repo has no tests.** Then every change "survives" and Capito cannot ask a meaningful question; it tells you so. That is a finding in itself.

**Can people cheat?** Nothing is gated, so there is little reason to. Each person's first answer is the only one that counts.

**Why not let an LLM write the questions?** Because an LLM can be confidently wrong about the code, which is the very problem. Capito's answers come from execution, so they are always right for the code as it is.

**Which languages?** JavaScript and TypeScript (including JSX/TSX) today. Python is next on the roadmap.

## Capito checks itself

Capito was written with an AI agent, so we ran Capito on Capito (the workflow is in [`examples/workflows/capito-self-check.yml`](examples/workflows/capito-self-check.yml)). The first time it ran on `src/core/map.ts`, all three changes it tried **survived**: no test checked the exact colour boundaries of the map, the "at least 10 AI lines" rule, or that half-understood files are reviewed too. Those tests now exist ([`test/core.test.ts`](test/core.test.ts)), and the same mutants are caught.

## Roadmap

- [ ] Python support (`ast` mutations, `pytest`)
- [ ] "Predict the output" questions (run a function on example inputs)
- [ ] Optional GitHub App with a hosted dashboard for organizations
- [ ] Slack / Discord digest
- [ ] Per-team maps for monorepos (`CODEOWNERS`)

## Development

```bash
npm ci
npm test          # unit tests, GitHub flows on a fake API, and the bundled action end to end
npm run build     # bundles dist/index.js (action) and dist/cli.js (CLI)
```

`dist/` is committed because GitHub Actions run it directly. Try the demo (a tiny shop with deliberately incomplete tests):

```bash
cd examples/demo-shop && node ../../dist/cli.js quiz --file src/cart.js
```

## License

[MIT](LICENSE) © 2026 Alessio Kore
