# SPDD Analysis: Employee Registration for an Available Training Session

## Original Business Requirement

**Jira:** LATC-44 — "[Michael Longerich] Employee can register for an available training session" (Story, In Progress; cloned from LATC-2)

Copied from LATC-2 for kickoff

_Migrated from WH-2_

### Context

Employees can currently browse training sessions (WH-1). The next step is allowing them to register. Registration is the core transactional action of WorkshopHub — it increments the `registered` count on a session and records the employee's details.

This is a **trainee exercise story**. It is not implemented in the baseline template.

### Description

As an employee, I want to register for an available training session so that I can secure my place before it fills up.

An employee submits their name and email to register. The system confirms the registration and shows the updated capacity. If the session is full, the employee cannot register (see WH-3 for the waitlist).

### Acceptance Criteria

- A register button or form is visible on each session card (or session detail page)
- The employee provides their name and email to register
- On success, the `registered` count increments by 1
- On success, a confirmation message is shown to the employee
- If `registered >= capacity`, the register button is disabled or hidden
- `POST /api/training-sessions/:id/registrations` accepts `{ name, email }` and returns HTTP 201 with registration details
- Returns HTTP 400 if required fields are missing
- Returns HTTP 409 if the session is full (see WH-3 for waitlist)
- Returns HTTP 404 if the session does not exist

### Out of Scope

- Duplicate registration prevention
- Waitlist behaviour when full (WH-3)
- Cancellation (WH-4)
- Email notification (WH-8)
- Authentication or SSO

### Suggested Tests

- `POST /api/training-sessions/1/registrations { name, email }` → 201
- `POST /api/training-sessions/1/registrations {}` → 400, missing fields
- `POST /api/training-sessions/999/registrations` → 404
- `POST` when session is full → 409
- `registered` count increments after successful registration

### Notes

The `Registration` model will need to be added to the Prisma schema. Consider whether `registered` count is stored on the session row or computed from the registrations table.

Need to consider the race condition when creating a registration and incrementing the count.

---

## Domain Concept Identification

### Existing Concepts (from codebase)

- **TrainingSession**: a schedulable training event with a fixed `capacity` and a stored `registered` counter (default 0), plus `status` (seeded as `"active"`), `date`, `location` and `deliveryMode`. Persisted in the `training_sessions` table. It is the parent aggregate for registrations: every registration consumes one unit of its capacity.
- **Session availability (derived)**: the frontend session card already computes "spots left" (`capacity − registered`) and an "is full" state (`spotsLeft <= 0`), rendering a "Full" badge and greyed card. This is the existing UI notion that the register control must align with.
- **Session listing / lookup service**: `trainingSessionService` owns all session reads (list ordered by date, find by ID). The route layer translates "not found" into a 404 with `{ error }` and a non-numeric ID into a 400. Registration must reuse this "session exists?" semantics, not reimplement it.
- **Shared Prisma client** (`api/src/lib/prisma.ts`): the single data-access entry point that the new service will use, including for transactions.
- **Frontend session type** (`app/src/types/index.ts`): the hand-maintained API contract mirror for `TrainingSession`. No shared types package exists; the API and app contracts are kept in sync manually.

### New Concepts Required

- **Registration**: a record that an employee (identified only by name and email) has claimed a seat in a specific TrainingSession, with the time it was made. It belongs to exactly one session (many registrations per session). Per project context, the **registration's ID is the employee's identity** for all later flows (cancel in WH-4, waitlist promotion in WH-5, audit in LATC-9), so it must be stable and returned to the client.
- **Registrant details**: name and email supplied at registration time. Not a separate Employee entity — there is no authentication, so no employee table is introduced.
- **Capacity guard**: the business invariant that a registration may only be created when the session still has a free seat, and that seat consumption plus the record creation happen as one indivisible unit.
- **Registration confirmation (UI)**: the employee-facing success state on the session card that confirms the booking and reflects the updated capacity.
- **Registration form (UI)**: an inline name/email input on each session card (the app has no router, so a detail page is not the natural host).

### Key Business Rules

- **Capacity invariant** — `registered` must never exceed `capacity`, even under concurrent requests for the last seat. *(TrainingSession, Registration, Capacity guard)*
- **Count–record consistency** — every successful registration increments `registered` by exactly 1, and a failed registration changes nothing. The counter and the registration rows must never drift. *(TrainingSession, Registration)*
- **Required registrant details** — both name and email must be supplied, otherwise the request is rejected with 400. *(Registrant details)*
- **Session must exist** — registering against an unknown session ID returns 404. *(TrainingSession)*
- **Full means rejected, not queued** — when `registered >= capacity` the API returns 409. Waitlisting is explicitly deferred to WH-3. *(Capacity guard)*
- **Implicit: invalid session ID format** — a non-numeric `:id` should follow the existing GET convention (400 "Invalid session ID") rather than 404 or 500. *(TrainingSession)*
- **Implicit: duplicates are allowed for now** — the same email may register twice. Duplicate prevention is a later story, so no uniqueness rule should be introduced that would pre-empt it. *(Registration)*
- **Implicit: registration ID is an identity token** — because there is no authentication, the returned registration ID is what later stories use to act on "my" registration. It must be included in the 201 payload. *(Registration)*
- **Implicit: error shape** — all failures return `{ "error": "<message>" }`, and internal detail must never leak. *(All endpoints)*

---

## Strategic Approach

### Solution Direction

- Follow the established layering: **HTTP route (parse/validate input, map outcome to status) → registration service (business rules + the single transaction) → shared Prisma client → SQLite**.
- Add a nested sub-resource on the existing training-sessions router (`/:id/registrations`), keeping the URL shape from the AC. Prisma access stays out of the route.
- Introduce a `Registration` model related many-to-one to `TrainingSession`, and keep the existing stored `registered` counter as the source of truth for capacity display.
- The registration service performs **"claim a seat if one is free, then record the registration"** atomically inside one Prisma transaction, and reports a typed outcome (created / session not found / session full) that the route maps to 201 / 404 / 409.
- Frontend: extend the session card with an inline register form, a confirmation state, and disabled/hidden behaviour when full. On success, update the card's counts from the server response so the UI shows the updated capacity without a full page reload.

### Key Design Decisions

- **Stored counter vs computed count**: keeping `registered` on the session row is cheap to read, already used by the UI, seed and tests, and is what WH-3/WH-4 will mutate, but it creates a consistency obligation. Computing from the registrations table cannot drift, but needs a schema/API/UI contract change and still needs a guarded check to stop over-booking. → **Keep the stored counter**, updated in the same transaction as the registration insert. Least churn, matches the story's wording ("increments the `registered` count") and CLAUDE.md's "create a registration and update counts in one transaction".
- **How to enforce capacity under concurrency**: a read-check-then-write sequence inside a transaction is vulnerable to two requests both seeing one free seat, and on SQLite it can surface as lock/busy errors rather than clean 409s. An **atomic conditional increment** (increment only where `registered < capacity`, then inspect whether a row was affected) makes the database decide who gets the last seat. → **Use an atomic guarded increment as the first step of the transaction**, then create the registration. If no row was affected, distinguish "not found" from "full" with a read of the session. This gives deterministic 409s for losers of the race.
- **Shape of the 201 response**: the AC requires "registration details", and the description says the system "shows the updated capacity". Returning only the registration forces the UI to refetch; returning the registration plus the session's updated counts lets the card update in place. → **Return the created registration (including its ID) together with the updated session availability.** The exact shape is decided in the REASONS Canvas.
- **Validation depth for name/email**: the AC only mandates rejecting *missing* fields. Adding email-format validation is good hygiene but goes beyond the AC and has no status code specified. → **Require both as non-blank strings (trimmed). Treat format validation as an open question** (see Risk & Gap). If adopted, it would also map to 400.
- **Where the register UI lives**: no router exists. A detail page would require introducing routing (a dependency decision outside this story). → **Inline form on each session card**, which the AC explicitly allows.
- **Handling the stale-UI race on the frontend**: a card may show free seats that were taken by someone else. → The UI must treat a 409 as an expected outcome (show "session is now full", mark the card full) rather than a generic error.
- **Seed compatibility with the new relation**: the seed currently clears sessions only. With a child table, clearing sessions that have registrations will either fail on the foreign key or orphan rows. → **The seed must clear registrations before sessions (or the relation must cascade on delete)**, so `make reset-db` and `make seed` keep working (DoD item 5).

### Alternatives Considered

- **Compute `registered` from a COUNT of registrations (drop the stored column)**: rejected for this story. It changes the existing contract (UI type, seed, list/detail responses), doesn't remove the need for a race-safe check, and pre-empts the stored-vs-computed choice that WH-3/WH-4 build on.
- **Read-check-write in an interactive transaction without a conditional update**: rejected. On SQLite, concurrent deferred transactions can both read "one seat left", and the loser fails with a busy/lock error (500) instead of a 409. It also depends on isolation behaviour the team hasn't standardised.
- **Unique constraint on (session, email) now**: rejected. Duplicate prevention is explicitly out of scope and is its own later story. Adding it now would change behaviour ahead of that story's ACs (likely 409 vs 422 semantics).
- **Separate session detail page with routing**: rejected. It needs a new dependency (router), which is outside story scope and requires approval under AGENT_BOUNDARY.
- **Introduce an Employee entity**: rejected. There is no auth, the project explicitly uses the registration ID as identity, and nothing in the requirement needs employee-level aggregation.

---

## Risk & Gap Analysis

### Requirement Ambiguities

- **Email format validation**: the AC says 400 for *missing* fields only. Should a malformed email (e.g. `"abc"`) also be rejected with 400? Needs a product decision, otherwise the default is presence-only.
- **Blank vs missing**: is `{ "name": "  ", "email": "" }` "missing"? The recommended interpretation is that blank-after-trim counts as missing (400), but the story doesn't state it.
- **Wrong types**: should `{ name: 123 }` or an array be a 400? Implicitly yes (not a valid name), but unspecified.
- **"Registration details" content**: which fields the 201 must contain (ID, name, email, session ID, created time) and whether updated session counts are included is not defined.
- **"Shows the updated capacity"**: should this be the API returning updated counts, the UI refetching, or the confirmation message quoting remaining spots? Any of these satisfies the wording.
- **Session status**: sessions carry a `status` (seeded `"active"`). Can an employee register for a non-active (e.g. cancelled or draft) session? The story doesn't say. Default assumption: status is ignored in this story, but this should be confirmed.
- **Past sessions**: registering for a session whose date has passed is not addressed. The registration deadline is LATC-7, so it is assumed out of scope here.
- **After success, can the same browser register again?** With duplicates allowed, should the form reset and remain usable, or collapse into the confirmation state? This is a UX decision.
- **Story keys**: the story references WH-1..WH-8, while the canonical stories are LATC-1..LATC-9. The mapping is assumed to be WH-n ≈ LATC-n (e.g. WH-3 waitlist = LATC-3).

### Edge Cases

- **Last-seat contention**: two or more parallel requests for the final seat. Exactly one must get 201 and the rest 409, and `registered` must equal `capacity` afterwards. CLAUDE.md mandates a concurrency test for this.
- **Capacity 0 session**: must immediately return 409, and the UI must render it full/disabled.
- **Counter already over capacity** (data drift, manual edits): `registered > capacity` must be treated as full (`>=` comparison, not `==`).
- **Non-numeric session ID** (`/api/training-sessions/abc/registrations`): should match the existing 400 behaviour, not 404 or 500.
- **Missing or invalid JSON body / wrong content type**: Express's JSON parser yields an empty body or a parse error. The parse error currently falls to the global error handler, which leaks the stack (a deliberate security exercise). The registration route should avoid adding new leak paths.
- **Very long name/email strings**: no length limit is specified. SQLite will accept them, which may affect UI rendering.
- **Session deleted between UI load and submit**: returns 404. The UI should present this gracefully.
- **UI shows stale availability**: another employee filled the session, so the UI receives a 409 and must update the card to full.
- **Unknown extra fields in the body**: should be ignored, not persisted.

### Technical Risks

- **SQLite write locking under concurrency**: SQLite serialises writers. Parallel registration requests in tests (and in `make dev`) may hit `SQLITE_BUSY` or Prisma transaction timeouts, causing 500s instead of 409s. *Mitigation direction:* keep the transaction short and write-first (guarded increment), avoid interactive read-then-write, and verify with the mandated parallel test.
- **Integration tests share the dev database**: the concurrency and "full" tests need their own sessions with small capacity, created and cleaned up per test, and must not mutate seed sessions or depend on test order (CLAUDE.md test rules). Cleanup must delete registrations before sessions because of the foreign key.
- **Schema change needs `make reset-db`**: adding the `Registration` model and relation is a Prisma schema change, and `make reset-db` deletes data. Both are AGENT_BOUNDARY items that require explicit user approval before running.
- **Seed breakage**: the seed's session `deleteMany` will fail once registrations reference sessions, unless the seed clears registrations first or the relation cascades. This would break DoD item 5.
- **Contract drift between `api/` and `app/`**: there are no shared types, so the new Registration response type must be mirrored by hand in `app/src/types`, without `any`.
- **No frontend test tooling**: `app/` has no test runner (no Vitest or Testing Library). UI ACs (button visible, disabled when full, confirmation shown) can't be automated without adding dev dependencies, which is AGENT_BOUNDARY (ask first). Otherwise UI ACs are verified manually or via the browser.
- **Deliberate security exercises nearby**: the training-sessions router contains the `$queryRawUnsafe` `/search` route, and `app.ts` has the stack-leaking error handler. The new code must not copy these patterns and must not "fix" them (out of scope). The new route should catch its own errors and return a generic `{ error }` 500.
- **Unit-testing the transaction**: unit tests mock Prisma (existing pattern). A transactional service needs a mockable transaction boundary, so the true race-safety guarantee can only be proven by the integration concurrency test.

### Acceptance Criteria Coverage

| AC# | Description | Addressable? | Gaps/Notes |
|-----|-------------|--------------|------------|
| 1 | A register button or form is visible on each session card (or session detail page) | Yes | Inline form on card. No automated UI test without new dev dependencies; verify manually/browser. |
| 2 | The employee provides their name and email to register | Yes | Form collects both. Client-side required-field hinting is optional; server is the authority. |
| 3 | On success, the `registered` count increments by 1 | Yes | Atomic guarded increment in the same transaction as the insert. Covered by integration test (count before/after). |
| 4 | On success, a confirmation message is shown to the employee | Yes | Card confirmation state. Message wording is unspecified. Manual verification unless UI test tooling is approved. |
| 5 | If `registered >= capacity`, the register button is disabled or hidden | Yes | Reuses the card's existing `isFull` logic (`spotsLeft <= 0` ≡ `registered >= capacity`). It must also flip after a 409 or after taking the last seat. |
| 6 | `POST /api/training-sessions/:id/registrations` accepts `{ name, email }` and returns HTTP 201 with registration details | Partial | Addressable, but the content of "registration details" is undefined (see ambiguities). Recommend including the registration ID and updated session counts. |
| 7 | Returns HTTP 400 if required fields are missing | Partial | Missing is clear. Blank, wrong-type and malformed-email handling are unspecified. Recommend treating blank/wrong-type as missing; format check is pending a decision. Non-numeric `:id` → 400 by existing convention. |
| 8 | Returns HTTP 409 if the session is full (see WH-3 for waitlist) | Yes | Includes the concurrent last-seat case. Mandatory concurrency test. |
| 9 | Returns HTTP 404 if the session does not exist | Yes | Service distinguishes "not found" from "full" when the guarded increment affects no row. |

**Open questions to resolve before or during REASONS Canvas:**
1. Validate email format (400) or presence only?
2. Contents of the 201 payload: registration only, or registration plus updated session counts?
3. Should non-`active` or past sessions be registrable in this story?
4. Approve the Prisma schema change plus `make reset-db` (AGENT_BOUNDARY)?
5. Add frontend test tooling (dev dependency, AGENT_BOUNDARY), or verify UI ACs manually?
