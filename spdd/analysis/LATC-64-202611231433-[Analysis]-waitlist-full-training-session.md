# SPDD Analysis: Waitlist When a Training Session Is Full

## Original Business Requirement

**Jira:** LATC-64 — "[Michael Longerich] Waitlist when a training session is full" (Story, In Progress; cloned from LATC-3)

Copied from LATC-3 for kickoff

_Migrated from WH-3_

### Context

After WH-2 is implemented, a session can fill up. When a session reaches capacity, subsequent employees who want to attend should be placed on a waitlist rather than being turned away. This ensures demand is captured and can be fulfilled if a registered employee cancels (WH-4 → WH-5).

This is a **trainee exercise story**. It is not implemented in the baseline template.

### Description

As an employee, I want to join a waitlist for a full training session so that I can attend if a place becomes available.

When a session is full, an employee can join the waitlist. The system records their position and informs them they are waitlisted, not confirmed.

### Acceptance Criteria

- When `registered >= capacity`, new registrations are added to the waitlist
- The waitlisted employee sees a message confirming they are waitlisted (not confirmed)
- The session card shows a "Join Waitlist" option when the session is full
- `POST /api/training-sessions/:id/registrations` returns HTTP 202 with `{ status: "waitlisted", position: N }` when full
- Waitlisted registrations have status `waitlisted` in the database
- Confirmed registrations have status `confirmed`

### Out of Scope

- Promotion from waitlist (WH-5)
- Cancellation (WH-4)
- Email notification (WH-8)
- Maximum waitlist size

### Suggested Tests

- `POST` when session is full → 202 with `status: "waitlisted"`
- `POST` when session has space → 201 with `status: "confirmed"`
- Waitlisted count is tracked separately from registered count
- Position in waitlist is correct (1st, 2nd, etc.)

### Data Model Hint

The `Registration` model should include a `status` field: `confirmed | waitlisted | cancelled`.

---

## Domain Concept Identification

### Existing Concepts (from codebase)

- **TrainingSession**: a bookable session with a fixed `capacity` and a denormalised `registered` counter (`api/prisma/schema.prisma`). It owns its Registrations (cascade delete). Today `registered` counts every Registration row, because every registration is a confirmed seat.
- **Registration**: an employee's booking (name, email, createdAt) tied to one TrainingSession. Its `id` is the employee's identity (no auth). It has **no status today**: existence implies "confirmed".
- **Seat claim (registration service)**: `registerForSession` in `api/src/services/registrationService.ts` claims a seat with a conditional increment (`registered < capacity`) inside one Prisma transaction, serialised per process by an in-memory queue to avoid SQLite busy-wait starvation. When the claim fails it distinguishes `not_found` from `full`. The waitlist branch has to be added exactly here.
- **Registration result union**: the service returns a discriminated union (`created | not_found | full`) that the route maps to status codes with an exhaustive `never` check. The waitlist adds or replaces a variant.
- **SessionAvailability**: the `{ id, capacity, registered }` snapshot returned after a booking and used by the frontend to update a card in place without a refetch.
- **Session card / registration form** (`app/src/components/TrainingSessionCard.tsx`, `RegistrationForm.tsx`): shows a "Full" badge and a disabled "Session full" button when `registered >= capacity`. On a 409 it marks the session full locally. These are the UI surfaces the waitlist changes.
- **Shared API types** (`app/src/types/index.ts`): hand-written mirrors of API responses (`Registration`, `RegistrationResponse`, `SessionAvailability`), narrowed at runtime by type guards in the form.

### New Concepts Required

- **Registration status**: the lifecycle state of a Registration: `confirmed`, `waitlisted` or `cancelled`. Only `confirmed` and `waitlisted` are produced by this story. `cancelled` is named by the data-model hint for WH-4, so the type should allow for it, but nothing sets it yet.
- **Waitlist**: not a separate entity. It is the ordered set of a session's Registrations whose status is `waitlisted`. Order is arrival order.
- **Waitlist position**: a waitlisted Registration's 1-based rank in its session's waitlist, returned to the employee when they join. It's a derived value, not a stored attribute (see design decisions).
- **Waitlisted count**: how many employees are waiting for a session, tracked separately from `registered`, as the Suggested Tests require. `registered` keeps meaning "confirmed seats".
- **Waitlist outcome (API)**: a second success shape for the same endpoint: HTTP 202 with `status: "waitlisted"` and `position`, alongside the existing HTTP 201 outcome, which now also carries `status: "confirmed"`.

### Key Business Rules

- **Capacity invariant**: confirmed registrations for a session never exceed `capacity`, under concurrency. `registered` must always equal the number of `confirmed` Registrations. Governs: TrainingSession, Registration status.
- **Overflow goes to waitlist**: when no seat can be claimed (`registered >= capacity`, including capacity 0), the request creates a `waitlisted` Registration instead of being rejected. Governs: seat claim, Registration.
- **Waitlisted registrations don't consume seats**: they never change `registered`. Governs: TrainingSession counters.
- **Position is arrival order**: the Nth employee to join a session's waitlist gets position N. Two concurrent joins must not receive the same position. Governs: Waitlist position.
- **Status is explicit for every registration**: new confirmed registrations are stored as `confirmed`. Rows created before this story (no status) must also read as `confirmed`. Governs: Registration status, schema migration.
- **Not-found still wins**: a missing session is a 404, never a waitlist entry. Validation (400) still happens before any write. Governs: route, service.
- **Implicit, no max waitlist**: the waitlist is unbounded (explicitly out of scope). Governs: Waitlist.
- **Implicit, no duplicate prevention**: the same email can register or waitlist more than once (out of scope since LATC-44; not reintroduced here). Governs: Registration.

---

## Strategic Approach

### Solution Direction

- Extend the existing registration flow rather than adding a new endpoint: `POST /api/training-sessions/:id/registrations` stays the single entry point. The service decides "confirmed or waitlisted" inside the same transaction that tries to claim a seat.
- Data flow: route (parse and validate) → `registerForSession` (serialised transaction: try conditional seat claim → on failure, check existence → create a `waitlisted` Registration and compute its position) → result union → route maps `confirmed` to 201 and `waitlisted` to 202.
- Schema: add a status to Registration (defaulting to `confirmed`, so existing rows and seed data stay valid) and a way to report the waitlisted count (see decisions). This is a Prisma schema change, applied with `make reset-db`, and needs the user's approval under AGENT_BOUNDARY.
- Frontend: the full-session card stops showing a disabled "Session full" button and offers "Join Waitlist" using the same name and email form. A 202 response shows a distinct "you're waitlisted, position N, not confirmed" message and doesn't change `registered`.
- Keep all conventions: Prisma only in services, a discriminated result union with an exhaustive switch in the route, `{ error }` bodies for errors, no `any`, and type guards on the frontend for the new response shape.

### Key Design Decisions

- **Waitlisted count: stored counter vs computed**: a `waitlisted` column on TrainingSession mirrors `registered` and is cheap to read on the session list. But it is a second denormalised counter that must stay in sync in the same transaction (and later on cancel and promote). Counting `waitlisted` Registrations is always correct but costs a query per read. → **Recommend a stored counter, incremented in the same transaction.** This matches the existing `registered` pattern and the "tracked separately" test, and gives the next position directly (`position = waitlisted after increment`). Revisit when WH-4/WH-5 add decrements.
- **Position: stored vs derived at read time**: storing a position on the row freezes it, so it goes stale when promotions (WH-5) remove earlier entries. Deriving it by rank (count of earlier waitlisted rows for the session, by id or createdAt) is always correct. → **Recommend returning the position computed inside the creating transaction and not persisting it.** Order by `id` rather than `createdAt`, because autoincrement ids are strictly ordered while timestamps can tie.
- **Status representation: string vs enum**: SQLite with Prisma 5 doesn't support native `enum`. Existing fields (`status`, `deliveryMode` on TrainingSession) are plain strings. → **Recommend a string column defaulting to `confirmed`, with a TypeScript union type (`'confirmed' | 'waitlisted' | 'cancelled'`) as the contract.** Validate at the service boundary and never accept status from the client.
- **HTTP contract change, 409 → 202**: LATC-44's AC said "409 if full", and its tests and UI depend on that. This story replaces it with 202 waitlisted. → **Recommend dropping the `full` outcome entirely.** Update the LATC-44 409 integration tests and the frontend 409 handling to the new behaviour, because the stories supersede each other (LATC-44 explicitly said "see WH-3 for waitlist").
- **201 response shape**: the AC requires `status: "confirmed"` on the 201 path. → **Recommend adding `status` to the returned registration (or at the top level, matching the 202 body) without removing the existing `registration` and `session` fields**, so the current UI keeps working. Settle the exact shape in the REASONS Canvas.
- **202 response body**: the AC fixes `{ status: "waitlisted", position: N }` as the minimum. The waitlisted employee also needs a registration ID, because it's their identity for a later cancellation (WH-4). → **Recommend including the registration id (and session availability) alongside status and position.**
- **Concurrency**: the in-process serial queue plus the transaction already give strict ordering on SQLite. → **Recommend doing the waitlist path inside the same serialised transaction**, so the counter increment and position are race-free without new locking. Prove it with a concurrency test (parallel joins on a full session get positions 1..N with no duplicates, and `registered` is unchanged).

### Alternatives Considered

- **Separate `Waitlist` table or entity**: rejected. The data-model hint puts status on Registration, a single table keeps the employee's ID stable through promotion (WH-5), and a second table doubles the cascade and transaction surface.
- **Separate endpoint (`POST …/waitlist`)**: rejected. The AC requires the existing endpoint to return 202 when full, and a client can't reliably know "full" ahead of time under concurrency.
- **Client opts in to the waitlist (flag in the body)**: rejected. The AC says new registrations "are added to the waitlist" automatically when full. The "Join Waitlist" button is only a UI affordance over the same request.
- **Computing `registered` from rows instead of the counter**: rejected for this story. It would rework LATC-44's proven capacity mechanism, which is out of scope.

---

## Risk & Gap Analysis

### Requirement Ambiguities

- **201 body shape**: the AC only says confirmed registrations "have status `confirmed`" in the DB and the suggested test expects `status: "confirmed"` in the 201 response. Where `status` sits relative to the existing `registration` and `session` fields isn't specified. Decide in the Canvas, keeping backward compatibility for the UI.
- **202 body completeness**: only `status` and `position` are specified. Whether to return the registration id is unspecified, but the id is the employee's identity, so omitting it would block WH-4 cancellation for waitlisted employees.
- **Where the waitlisted count is visible**: "tracked separately" doesn't say whether the session list (GET) or the card should show it. The minimum is that it's tracked (DB or service). Exposing it on GET and the card is optional and should be confirmed.
- **"Message confirming they are waitlisted"**: the wording is free. It should mention the position and that the place is not confirmed.
- **`cancelled` status**: listed in the hint, but cancellation is out of scope. Assume the type allows it and nothing writes it.

### Edge Cases

- **Capacity 0 session**: every request is waitlisted at position 1, 2, …. The existing 409 zero-capacity test must change to expect 202.
- **Session not found while "full"**: the claim fails for both reasons. The existence check must still return 404 and never create an orphan waitlist row.
- **Concurrent joins on a full session**: positions must be unique and contiguous.
- **Last seat contested**: of N parallel requests for one remaining seat, exactly 1 gets 201 confirmed and N−1 get 202 with positions 1..N−1. The existing concurrency test, which expects 409s, must be rewritten.
- **Existing rows without status**: rows from LATC-44 dev/test data must read as `confirmed`. Covered by the column default, and `make reset-db` reseeds anyway.
- **Stale UI**: a card that thinks it has seats can still get a 202. The form must handle 202 regardless of the button that was shown.
- **Same person waitlisting twice**: allowed (duplicate prevention out of scope). Each entry gets its own position.

### Technical Risks

- **Schema change requires approval**: adding `status` (and a `waitlisted` counter) to the schema plus `make reset-db` are AGENT_BOUNDARY actions. Get approval before applying, and confirm the seed still runs.
- **Breaking the LATC-44 contract**: existing integration and unit tests assert 409 and the `full` variant. These must be deliberately updated, not weakened. The route's exhaustive `never` switch will flag a missing case at compile time, which helps.
- **SQLite concurrency**: the per-process serial queue is the anti-starvation measure. Any new query in the waitlist path must stay inside the serialised transaction, or the busy-wait starvation seen in LATC-44 can come back.
- **Counter drift**: a stored `waitlisted` counter can diverge from row counts if a future story (WH-4/5) changes status without updating it. Mitigate by keeping every status change and counter update in one transaction and adding an invariant test (counter equals row count).
- **Frontend type drift**: types in `app/src/types` are hand-mirrored. The new `status` and `position` fields and the 202 shape must be added there with type guards, or the UI silently misreads responses.
- **Integration tests share the dev DB**: new tests must create their own sessions (as the LATC-44 tests do with `createSession`) and clean up their waitlisted rows.

### Acceptance Criteria Coverage

| AC# | Description | Addressable? | Gaps/Notes |
|-----|-------------|--------------|------------|
| 1 | When `registered >= capacity`, new registrations are added to the waitlist | Yes | Service: on a failed seat claim with an existing session, create a `waitlisted` Registration in the same serialised transaction. Includes capacity 0. |
| 2 | The waitlisted employee sees a message confirming they are waitlisted (not confirmed) | Yes | Form handles 202 with a distinct message that includes the position. Wording is free. |
| 3 | The session card shows a "Join Waitlist" option when the session is full | Yes | Replace the disabled "Session full" button with "Join Waitlist" that opens the same name and email form. Keep the "Full" badge. |
| 4 | `POST …/registrations` returns HTTP 202 with `{ status: "waitlisted", position: N }` when full | Yes | Replaces LATC-44's 409. Recommend also returning the registration id. Existing 409 tests are rewritten. |
| 5 | Waitlisted registrations have status `waitlisted` in the database | Yes | Requires a schema change (approval and `make reset-db`). |
| 6 | Confirmed registrations have status `confirmed` | Yes | Column default `confirmed` plus explicit set on the confirmed path. The 201 response should also expose `status: "confirmed"` per Suggested Tests. Exact shape to be settled in the Canvas. |
