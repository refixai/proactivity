# Contributing to Proactivity

Thanks for taking the time to contribute. `@refix/proactivity` is a small, deliberately layered SDK, and the contract with the outside world — adapters, stores, schedulers — is intentionally tiny, so there's a lot you can build on top without touching the core. Bug reports, docs fixes, new adapters, and design discussion are all welcome.

Be kind, assume good faith, and critique code rather than people.

## Ways to contribute

- **Report a bug** — open an issue with a minimal repro and what you expected.
- **Propose a feature or design change** — open an issue or a discussion *first* for anything non-trivial, so we can agree on the approach before you write code. See the [Roadmap](README.md#roadmap) for where things are headed and what's in/out of scope.
- **Write an adapter, store, or scheduler** — the highest-leverage contribution. The extension-point contracts are documented in [`PRIMITIVES.md`](PRIMITIVES.md).
- **Improve the docs** — the site lives in [`docs/`](docs) (Mintlify); the `README.md` and `PRIMITIVES.md` are the entry points.
- **Improve an example** — runnable, compile-checked reference agents live under [`examples/`](examples).

### Your first contribution

New here? Look for issues labelled [`good first issue`](https://github.com/refixai/proactivity/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). If none are open (or none fit), open an issue or a [Discussion](https://github.com/refixai/proactivity/discussions) and say what you'd like to work on — we'll help you scope it.

## Development setup

**Prerequisites**

- **Node.js ≥ 20** (CI runs on 22).
- **pnpm 10** — the repo uses a pnpm lockfile. Install with `npm install -g pnpm@10`, or via `corepack enable && corepack prepare pnpm@10 --activate`.

**Clone and build**

```bash
git clone https://github.com/refixai/proactivity
cd proactivity
pnpm install
pnpm build     # compiles src/ → dist/; the examples link against dist/
```

## Building, testing, typechecking

```bash
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # vitest, runs src/**/*.test.ts
pnpm test:watch  # vitest in watch mode
pnpm build       # rebuild dist/
```

CI runs `typecheck`, `test`, and `build`, and must be green to merge — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

There is **no linter or formatter** configured. `tsc` in strict mode is the gate; match the style of the surrounding code (ESM, no default exports in the public API, factory functions over classes).

**Tests that need Postgres or Redis.** Most of the suite runs entirely in-memory with zero dependencies. The **Postgres store** tests (`src/postgres`) connect to a local Postgres and **skip automatically** if one isn't running. The **BullMQ scheduler** tests (`src/bullmq`) expect a local Redis. To run those suites, bring up both with the same credentials CI uses:

```bash
docker run -d --name proactivity-pg \
  -e POSTGRES_USER=refix -e POSTGRES_PASSWORD=refix-password -e POSTGRES_DB=proactivity_test \
  -p 5432:5432 postgres:16
docker run -d --name proactivity-redis -p 6379:6379 redis:7
```

The Postgres tests use `postgresql://refix:refix-password@localhost:5432/proactivity_test`; the BullMQ tests use `localhost:6379`.

Tests are deterministic by design: fake adapters, scripted models, no real network and no wall-clock. Please keep new tests that way — if you need time or an LLM, inject a fake.

## Repository layout

| Path | What |
|------|------|
| `src/core` | The primitives: scheduler, heartbeat, goal store, governance, briefing, ledger, types |
| `src/proactive` | The `proactive()` wrapper — compiles down to the core primitives |
| `src/langgraph`, `src/anthropic`, `src/eve` | Framework adapters (published as subpaths) |
| `src/postgres`, `src/bullmq`, `src/timer` | Production store, scheduler, and dev scheduler |
| `src/prompts`, `src/memory` | Prompt builders; the in-memory (`createTestStore`) store |
| `examples/` | Runnable, compile-checked reference agents (`langgraph`, `anthropic`, `eve`) |
| `integrations/openclaw` | OpenClaw plugin (TypeScript, **npm** — not pnpm) |
| `integrations/hermes` | Hermes plugin (**Python 3.12**) |
| `docs/` | Mintlify documentation site |
| `migrations/` | SQL for the Postgres store |

The core has **zero runtime dependencies**; framework/database deps are declared as *optional peer dependencies* on their subpath. Please keep it that way — a new framework dependency belongs to its adapter, never to `src/core`.

### Running an example

```bash
cd examples/langgraph
pnpm install
pnpm typecheck
pnpm start        # runs the agent — needs a real API key (e.g. ANTHROPIC_API_KEY)
```

Examples call real LLMs, so `start` costs tokens; `typecheck` doesn't. CI typechecks every example against the real framework types ([`examples.yml`](.github/workflows/examples.yml)).

## Pull requests

1. For anything beyond a small fix, **open an issue or discussion first** and agree on the approach.
2. Fork, then branch from `main`.
3. Keep the PR **focused** — one concern per PR. Unrelated cleanups belong in their own PR.
4. **Add or update tests.** New behaviour needs coverage; a bug fix needs a test that would have caught it.
5. Make CI green locally: `pnpm typecheck && pnpm test && pnpm build`. If you touched an adapter or an example, typecheck that example too.
6. Write a clear description: what changed, why, and how to verify it.

**Commit messages.** Follow [Conventional Commits](https://www.conventionalcommits.org/) — it's the convention already in the history (`feat:`, `fix:`, `docs:`, `chore:`, with scopes like `feat(governance):` or `fix(openclaw):`). It's a request, not a bot-enforced gate; descriptive and scoped beats mechanical.

**You don't need to bump versions or add a changeset** — releases are cut by maintainers (see below).

### Adding an adapter, store, or scheduler

This is the main extension surface, and it's small. Read [`PRIMITIVES.md`](PRIMITIVES.md) first, then:

- **Framework adapter** — implement the adapter contract (`name`, `run(input) → Transcript`, plus `tools()`/`withTools()` if the framework calls tools). Add a shape test to [`src/integrations.test.ts`](src/integrations.test.ts) against a framework-shaped stand-in, and — for a framework adapter — a runnable, compile-checked example under `examples/`.
- **Store** — implement `ProactivityStore`. The in-memory store in `src/memory` is the reference; mirror its behaviour (especially idempotency on `idempotencyKey` and the goal status machine).
- **Scheduler** — implement `SchedulerAdapter`. The timer and BullMQ adapters are the references.

## AI-assisted contributions

Using AI tools to help write code or docs is fine — but you are responsible for everything you submit. Understand it, test it, and make sure it fits this codebase's conventions. PRs that are clearly unreviewed model output — wrong, untested, or ignoring the surrounding patterns — waste reviewer time and may be closed without detailed feedback.

## Releases

Releases are maintainer-run and tag-driven. Pushing a tag (`proactivity-v<version>` for the SDK, `proactivity-openclaw-v*` or `proactivity-hermes-v*` for the plugins) triggers CI to verify the tag matches the package version and publish to npm/PyPI with provenance ([`release.yml`](.github/workflows/release.yml)). Contributors don't touch version numbers in a PR.

## Reporting a security issue

Please **do not open a public issue** for a security vulnerability. Report it privately through GitHub's **Security → "Report a vulnerability"** on this repository, and we'll coordinate a fix and disclosure.

## Contribution licensing

This project is licensed under the **Apache License 2.0**. By submitting a pull request, you agree that your contribution is licensed under the project's Apache-2.0 license, and you represent that you have the right to submit it under those terms. This is the standard *inbound = outbound* norm (GitHub Terms of Service §D.6; Apache-2.0 §5) — **there is no CLA to sign.**

## Questions

Open a [Discussion](https://github.com/refixai/proactivity/discussions) or an issue. Thanks for contributing. 🪩
