# WorkshopHub

## References (loaded at start)

@README.md
@api/prisma/schema.prisma

Requirements: Jira project **LATC** (via the `jira` MCP server). LATC-1 to LATC-9 are the canonical stories; LATC-1 (list sessions) is already built. Read the story before starting work.

## Project context

Internal training-session booking. Employees browse sessions, register, join waitlists and cancel; organisers view registrations and an audit trail. **No authentication:** a registration's ID is the employee's identity.

pnpm 9 monorepo, Node 24, all TypeScript 5.9:

| Package | Path | Stack |
|---|---|---|
| `@workshophub/api` | `api/` | Express 4.22, Prisma 5.22, SQLite, Jest 29 + Supertest |
| `@workshophub/app` | `app/` | React 18.3, Vite 5.4. No router or state library yet. |

Key directories:
- `api/src/routes/`: HTTP only (parse input, call a service, map to a response)
- `api/src/services/`: business logic and **all** Prisma access
- `api/src/lib/prisma.ts`: the single shared Prisma client
- `api/tests/unit/`, `api/tests/integration/`: service tests and API tests
- `app/src/pages/`, `app/src/components/`, `app/src/types/`

## Team norms

### Build / test
Always use the Makefile, never ad-hoc scripts: `make setup`, `make dev` (API on :3001), `make test`, `make test-unit`, `make lint`, `make format-check`, `make build`, `make reset-db`.

### Coding standards
- **No `any`.** Use precise types, `unknown` with narrowing, or generics. Types are the contract between `api/` and `app/`, so `any` hides breakage there.
- **No Prisma in routes.** Keeping data access in services makes the logic unit-testable and keeps transactions in one place.
- Multi-step writes (create a registration and update counts, cancel and promote) go in **one Prisma transaction**. Concurrent bookings must never exceed capacity.
- Errors are returned as `{ "error": "<message>" }` with the status codes the story specifies.
- Prettier settings live in `.prettierrc`. Don't hand-format against them.
- **All commits go through the `workshophub-commit` skill** (`/workshophub-commit`). It enforces the `LATC-<n> type(scope): summary` format, refuses commits on `main`, checks for secrets and never pushes. Don't use `caveman-commit` or any other commit skill in this project, and don't run `git commit` by hand outside the skill.

### Definition of Done
1. Every acceptance criterion in the Jira story is met.
2. Tests were written first, or alongside, for every behaviour change.
3. `make test`, `make lint` and `make format-check` all pass. The pre-push hook enforces them; never bypass it with `--no-verify`.
4. `make build` succeeds.
5. Schema changes are applied by `make reset-db`, and the seed still runs.

## Architecture

### Banned patterns
- `$queryRawUnsafe`, or any SQL built by string concatenation. Use Prisma queries or the tagged `$queryRaw`.
- `new PrismaClient()` outside `api/src/lib/prisma.ts`.
- Prisma imports in `api/src/routes/`.
- Returning `err.stack` or internal error detail in API responses.
- Reading or mutating registration counts outside a transaction.

The baseline already contains some of these (`/search`, `routes/admin.ts`, the global error handler) as deliberate exercises for later workshops. Don't copy them, and don't fix them unless a story asks.

### Test rules
- Services get unit tests in `tests/unit/` (no DB). Endpoints get integration tests in `tests/integration/` via Supertest.
- Integration tests use the real SQLite DB from `DATABASE_URL`, the same one as `make dev`. This is a deliberate choice for now, to be revisited later. Each test therefore sets up and cleans up its own data and must not depend on seed contents or test order.
- Every status code in a story's acceptance criteria gets a test, including errors (400/404/409/422).
- Capacity logic gets a concurrency test (parallel requests against the last seat).

## Claude Code / OpenCode parity

The project works the same in Claude Code and OpenCode. **The Claude setup is the single source of truth.** Edit only these:
- `CLAUDE.md`: OpenCode reads it natively. There is deliberately no `AGENTS.md`, because one would override this file. `@imports` become `opencode.json` `instructions`.
- `.claude/skills/*/SKILL.md`: OpenCode reads them natively as skills. Each one also gets a generated `/command`.
- `.claude/agents/*.md` and `.claude/hooks/<agent>-allowlist.txt`: these generate `.opencode/agents/*.md`, with tools and paths mapped to OpenCode permissions.
- `.claude/settings.json` hooks: run unchanged in OpenCode by `.opencode/plugins/claude-hooks-bridge.ts`.

Never hand-edit `.opencode/agents/`, `.opencode/commands/` or `opencode.json` `instructions`, because they are generated. Editing a source auto-regenerates them (PostToolUse hook). Otherwise run `make sync-opencode`. `make check-opencode`, the pre-push hook and CI fail on drift.

## MCP tools (authorized autonomous use)

- `jira`: read issues, comments and search in project LATC.
- `github`: read repos, issues, PRs and commits.

Anything that writes through an MCP server is listed under AGENT_BOUNDARY.

## AGENT_BOUNDARY (ask before doing)

- Any MCP write: Jira comments, transitions or edits; GitHub issues, PRs, branches, pushes or merges.
- `git push`, force-push, rebase of shared branches, or deleting branches.
- Adding, removing or upgrading dependencies.
- Prisma schema changes, `make reset-db`, or anything that deletes data.
- Editing CI/CD (`.github/`, `.circleci/`, `.gitlab-ci.yml`), `Dockerfile`, hooks or `Makefile`.
- Touching the deliberate security exercises listed above.
- Reading or writing `.env` or any file holding credentials.
- Work outside the current story's scope.
