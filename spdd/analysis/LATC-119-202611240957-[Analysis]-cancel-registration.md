# SPDD Analysis: Cancel Registration

## Original Business Requirement

# LATC-119: [Michael Longerich] Cancel registration

- **Copy of:** LATC-4
- **Status:** In Progress (board column: In Development)
- **Type:** Story
- **Jira:** https://thoughtworks.atlassian.net/browse/LATC-119

## Description

*Migrated from WH-4*

### Context

An employee may need to cancel their confirmed registration. This frees up a seat that can be offered to the first person on the waitlist (WH-5). Cancellation should update the `registered` count and trigger waitlist promotion.

This is a **trainee exercise story**. It is not implemented in the baseline template.

### Description

As a registered employee, I want to cancel my registration so that I can release my place for someone else.

The employee cancels using their registration ID. The system marks the registration as cancelled, decrements the registered count, and shows the updated state in the UI.

### Acceptance Criteria

**User interactions:**

- A "Cancel Registration" button is visible on the session card or registration confirmation page for an employee who has a confirmed registration
- Clicking "Cancel" shows a confirmation prompt: "Are you sure you want to cancel your registration for [Session Title]?"
- After confirming, the page shows a success message: "Your registration has been cancelled"
- The session card updates to reflect the new registered/capacity count (e.g., "11 / 20 registered (9 spots left)")
- If the employee has already cancelled, the Cancel button is not shown (or is disabled with label "Cancelled")

**API behaviour:**

- `DELETE /api/training-sessions/:id/registrations/:registrationId` returns HTTP 200 with `{ status: "cancelled" }`
- On cancellation, the registration status changes to `cancelled` in the database
- On cancellation, the session's `registered` count decrements by 1
- Returns HTTP 404 if the registration does not exist
- Returns HTTP 409 if the registration is already cancelled
- After cancellation, waitlist promotion (WH-5) is triggered

### Out of Scope

- Email confirmation of cancellation (WH-8)
- Cancellation by organiser
- Authentication — the registration ID serves as the identity token for training simplicity

### Suggested Tests

- `DELETE /api/.../registrations/1` → 200, status "cancelled"
- `DELETE /api/.../registrations/999` → 404
- `DELETE` already-cancelled registration → 409
- `registered` count decrements after cancellation
- Waitlist promotion triggered after cancellation

---

## Domain Concept Identification

### Existing Concepts (from codebase)

- **TrainingSession**: a bookable training session with a fixed seat capacity and two denormalised counters (`registered` for confirmed seats and `waitlisted` for queued demand). It owns its registrations via a one-to-many relationship with cascade delete.
- **Registration**: an employee's booking record (name, email, status, creation timestamp) belonging to a single `TrainingSession`. Its identifier serves as the employee's sole identity token in the absence of authentication.
- **Registration Status**: an existing domain lifecycle state already modelled in the database and shared TypeScript contracts across both API and frontend, with three valid states: `confirmed`, `waitlisted`, and `cancelled`. Today only `confirmed` and `waitlisted` are written; `cancelled` is reserved for this story.
- **Registration Service & Serialised Transaction Boundary**: the service layer owns all database access for registrations and runs multi-step seat-claim and waitlisting writes inside a single Prisma transaction serialised through a per-process queue to prevent SQLite busy-wait starvation under concurrency.
- **Registrations API Route & Result Mapping**: an Express sub-router mounted under `/api/training-sessions/:id/registrations` that parses request parameters, delegates to the registration service, maps discriminated result unions to HTTP status codes via exhaustive switching, and returns uniform `{ error }` error bodies.
- **SessionAvailability Snapshot**: a lightweight availability view of a session's capacity, registered count, and waitlisted count returned by registration writes so the frontend can update session cards in place without refetching the full session list.
- **Session Card & Registration Form**: React UI components on the single-page sessions list that render capacity/waitlist counts and let employees submit registrations. Currently, the form displays the newly issued registration ID in a transient confirmation message and discards it once dismissed or reloaded.

### New Concepts Required

- **Cancellation Lifecycle Transition**: the state transition of an active `Registration` to `cancelled`, coupled atomically with releasing its corresponding capacity or waitlist slot on the owning `TrainingSession`. Cancelled registrations remain persisted (soft status change rather than deletion) so repeat cancellation attempts can be detected and rejected.
- **Waitlist Promotion Trigger Seam**: an explicit post-cancellation extension point inside the cancellation transaction boundary where automatic waitlist promotion (WH-5 / LATC-5) attaches once a confirmed seat is vacated.
- **Cancellation Outcome**: a service-level result representing the possible outcomes of a cancellation request (cancelled, not found, already cancelled) that the route maps to HTTP 200, 404, and 409 respectively.
- **Client-Side Registration Tracking & Confirmation Flow**: frontend awareness of an employee's active registration(s) for a session so the session card can surface a "Cancel Registration" action, present a confirmation prompt naming the session, invoke cancellation with the stored registration ID, and transition the card to a cancelled state.

### Key Business Rules

- **Soft-cancellation preservation**: cancelling a registration transitions its status to `cancelled` rather than deleting the row, preserving auditability and enabling idempotency/conflict detection. Governs: Registration, Cancellation Lifecycle Transition.
- **Counter-to-row invariant**: a session's `registered` count must always equal the number of its `confirmed` registrations (and `waitlisted` must equal the number of its `waitlisted` registrations), never dropping below zero or drifting under concurrent requests. Governs: TrainingSession, Registration.
- **Session ownership boundary**: a registration can only be cancelled through the session it belongs to; a registration ID belonging to a different session must be treated as not found rather than cancelling across sessions. Governs: TrainingSession, Registration.
- **Single-transition idempotency / conflict rule**: an already-cancelled registration cannot be cancelled again and must produce HTTP 409 without modifying session counters. Governs: Registration, Cancellation Outcome.
- **Atomic cancellation and promotion seam**: status transition, counter adjustment, and the waitlist promotion trigger (when a confirmed seat is released) must execute within a single database transaction so no intermediate state is visible to concurrent bookings. Governs: Registration Service, Waitlist Promotion Trigger Seam.
- **Identity without authentication**: any caller holding the registration ID for a session is authorised to cancel that registration; organiser-only cancellation and email notifications remain out of scope. Governs: Registration, API Route.
- **Implicit rule — waitlisted cancellation semantics**: because `Registration` supports both `confirmed` and `waitlisted` active states, cancelling a `waitlisted` registration must not decrement `registered` and must not trigger waitlist promotion. Governs: TrainingSession counters, Registration Status.

---

## Strategic Approach

### Solution Direction

- **Backend**: Extend the existing registrations sub-router (`DELETE /api/training-sessions/:id/registrations/:registrationId`) and `registrationService` without any Prisma schema changes (the `status` column, `'cancelled'` union member, indexes, and counters are already in place). Follow the established architectural flow: route parses and validates path identifiers → service executes cancellation inside the same serialised single-transaction queue used by registration creation → discriminated outcome union maps to HTTP 200 / 404 / 409.
- **Waitlist promotion seam**: Keep WH-5's full promotion logic out of scope unless explicitly requested, while exposing a clean transactional trigger seam inside the cancellation transaction so cancellation invokes the promotion hook whenever a confirmed registration is cancelled and WH-5 can plug in atomically without restructuring cancellation.
- **Frontend**: Keep the single-page architecture (no router needed). Extend the session card / registration interaction area to retain the employee's registration identity per session after registering, render a "Cancel Registration" control for confirmed registrations, show an explicit confirmation prompt with the session title, display the required cancellation confirmation text on success, update the session's registered/spots-left display via the existing `onAvailabilityChange` callback, and hide or disable the cancel control once cancelled.
- **Consistency with project norms**: Keep all Prisma access inside services, enforce strict TypeScript typing with zero `any`, mirror response contracts in `app/src/types` with runtime type guards, and cover unit, integration (including all status codes), and concurrency behaviour with tests.

### Key Design Decisions

- **Scope boundary with Waitlist Promotion (WH-5 / LATC-5)**:
  - *Trade-offs*: LATC-4's AC states "After cancellation, waitlist promotion (WH-5) is triggered" while also stating "the session's `registered` count decrements by 1". However, WH-5 (LATC-5) is a separate canonical story that owns promoting the first waitlisted employee, keeping `registered` unchanged (net zero) when promotion happens, and adding `promotedRegistrationId` to the cancellation response. Implementing WH-5 inside LATC-119 violates the story scope boundary and directly contradicts the LATC-4 AC that `registered` decrements by 1 on cancellation whenever a waitlist exists; conversely, ignoring promotion completely leaves the "waitlist promotion (WH-5) is triggered" AC unaddressed.
  - *Recommendation*: Introduce an injectable/default transactional promotion hook invoked inside the cancellation transaction whenever a confirmed registration is cancelled (defaulting to a no-op until WH-5 provides the promotion implementation), and unit-test that cancellation triggers it on confirmed cancellation and skips it on error/409/non-confirmed cases. Confirm with the user before REASONS Canvas whether they prefer this seam-only approach (strictly scoped to LATC-4) or want WH-5's promotion behaviour pulled into this story.
- **Cancelling a `waitlisted` registration**:
  - *Trade-offs*: The story narrative discusses confirmed registrations, yet LATC-64 already introduced `waitlisted` registrations in the same table with a separate `waitlisted` counter. Rejecting waitlisted cancellations forces a new unspecified error code, whereas decrementing `registered` would corrupt the counter invariant.
  - *Recommendation*: Support cancelling a `waitlisted` registration cleanly by marking it `cancelled`, decrementing `waitlisted` (not `registered`), and not firing waitlist promotion. This preserves counter invariants for every active registration state without inventing unrequested error codes.
- **Frontend tracking of the employee's confirmed registration (no auth)**:
  - *Trade-offs*: Keeping registration state only in React component state is simplest, but refreshing the page loses the registration ID and hides the Cancel button (which would also hamper WH-5's page-refresh scenario). Persisting a lightweight map of session registrations in browser `localStorage` survives refreshes and still needs no backend auth, though it only reflects bookings made in that browser. Adding a manual "Cancel by registration ID" fallback covers cross-browser use at the cost of extra UI clutter.
  - *Recommendation*: Persist the employee's registration state per session in browser `localStorage` alongside React state so the "Cancel Registration" button remains available across reloads on the session card, and clearly transitions to the cancelled state after confirmation. Decide in REASONS Canvas whether an optional manual registration-ID input is also desired.
- **HTTP 200 cancellation response payload and UI refresh**:
  - *Trade-offs*: Returning strictly `{ status: "cancelled" }` matches the minimum AC but forces the frontend either to decrement counts optimistically (risking stale data once WH-5 keeps `registered` unchanged on promotion) or to issue a second `GET` request. Returning `{ status: "cancelled", session: SessionAvailability }` is backward-compatible with `{ status: "cancelled" }` checks and aligns directly with `POST /registrations` and `onAvailabilityChange`.
  - *Recommendation*: Return `{ status: "cancelled" }` together with the updated `session` availability snapshot so the UI updates counts authoritatively in one round-trip, staying compatible with both LATC-4 assertions and future WH-5 promotion.
- **Confirmation prompt pattern in the UI**:
  - *Trade-offs*: `window.confirm(...)` is one line of code, but native browser dialogs can be suppressed, cannot be styled, and are awkward to verify consistently. An inline confirmation state inside the session card (displaying `"Are you sure you want to cancel your registration for [Session Title]?"` with Confirm / Keep Registration actions) matches the existing expandable form pattern in `RegistrationForm`, is accessible, and behaves identically across browsers.
  - *Recommendation*: Use an inline in-card confirmation prompt with the exact required wording.
- **Concurrency and SQLite transaction serialisation**:
  - *Trade-offs*: Running cancellations outside the existing per-process serialisation queue in `registrationService` risks SQLite lock contention and busy-wait starvation when registrations and cancellations happen concurrently.
  - *Recommendation*: Share the single serialised transaction queue between registration creation and cancellation, and perform a guarded state check/update inside one Prisma transaction so parallel cancellations of the same registration produce exactly one 200 and one 409 with no double-decrement.

### Alternatives Considered

- **Hard-deleting the `Registration` row on cancellation**: Rejected. The AC explicitly requires changing the status to `cancelled` in the database and returning HTTP 409 if the registration is already cancelled; hard deletion would turn a repeat cancellation into a 404 and destroy audit history needed for later stories.
- **Using a `POST` or `PATCH` endpoint (e.g., `POST .../cancel`)**: Rejected. The AC specifies `DELETE /api/training-sessions/:id/registrations/:registrationId`.
- **Adding a separate Registration Confirmation page / client-side router**: Rejected. The frontend currently has no router library, adding dependencies requires approval, and the AC explicitly allows the Cancel Registration button directly on the session card.
- **Re-fetching the entire session list after every cancellation**: Rejected as unnecessary when the cancellation response can carry the updated `SessionAvailability` snapshot, matching how `POST` updates individual cards today.

---

## Risk & Gap Analysis

### Requirement Ambiguities

- **Waitlist promotion (WH-5) expectation in this story**: LATC-4's AC says both "the session's `registered` count decrements by 1" and "After cancellation, waitlist promotion (WH-5) is triggered", while LATC-5 (WH-5) is a distinct story where promotion leaves `registered` unchanged. Clarification is needed before REASONS Canvas on whether LATC-119 should stop at a tested transactional promotion hook/seam (strictly LATC-4 scope) or implement promotion itself.
- **Waitlisted registration cancellation**: The story only describes cancelling a confirmed registration and does not state what should happen if a waitlisted registration ID is sent to `DELETE`, or whether the Cancel button should appear for waitlisted registrations in the UI.
- **Multiple registrations for the same session in one browser**: Because duplicate registration prevention is not yet implemented, an employee could register twice on the same session card in the same browser. The requirement does not specify how the UI should behave if a user registers multiple times on one card (e.g., track the most recent registration vs. list each registration ID).
- **Exact UI state after cancellation**: The AC allows either hiding the Cancel button or showing it disabled with label `"Cancelled"`, and does not specify whether the user should immediately be able to register again on the same card after cancelling.
- **Error response wording and invalid ID handling**: The AC specifies 404 and 409 but does not specify status code or wording for malformed (non-integer) `:id` or `:registrationId` path parameters (expected to follow existing `400` convention).

### Edge Cases

- **Concurrent double-cancellation**: Two simultaneous `DELETE` requests for the same registration ID must result in one HTTP 200 and one HTTP 409, and `registered` must decrement only once.
- **Concurrent cancellation and new booking on a full session**: A booking arriving concurrently with a cancellation must observe consistent session counts and never exceed capacity or corrupt the `registered` counter.
- **Registration ID belonging to a different session**: Calling `DELETE /api/training-sessions/A/registrations/R` where `R` belongs to session `B` must return 404 and leave both sessions untouched.
- **Non-existent session ID**: Calling `DELETE` for a session ID that does not exist (with any registration ID) must return 404.
- **Malformed path parameters**: Non-numeric or non-positive `:id` or `:registrationId` (e.g., `abc`) must return 400 with `{ error }` rather than causing a 500 or Prisma type error.
- **Cancelling a waitlisted registration**: Must decrement `waitlisted` (not `registered`), must not let `registered` drop below confirmed count, and must not trigger waitlist promotion.
- **Counter floor protection**: Even if legacy/seed data ever had `registered` at 0 (or inconsistent), cancellation must not produce a negative `registered` count.
- **Stale client state**: If a registration was already cancelled externally (e.g., via another tab or API call) and the user clicks Cancel in the UI, the UI receives HTTP 409 and should reflect the cancelled state gracefully rather than leaving a broken button.
- **Page reload after registration**: Without client-side persistence, reloading the page loses the registration ID and makes the Cancel button disappear even though the employee's registration is still confirmed.

### Technical Risks

- **Scope creep into WH-5**: Implementing full promotion inside LATC-119 risks pulling LATC-5 work into this branch and breaking LATC-4's decrement assertion when a waitlist is present. *Mitigation*: confirm the seam-only boundary before REASONS Canvas.
- **Counter drift between `TrainingSession` and `Registration`**: Updating `Registration.status` without updating the matching session counter in the exact same transaction (or decrementing `registered` for a `waitlisted` row) breaks the capacity invariant. *Mitigation*: single serialised Prisma transaction plus invariant assertions in integration tests.
- **SQLite lock starvation under parallel requests**: Adding a second write path (`DELETE`) outside the per-process serialisation queue in `registrationService` can reintroduce Prisma SQLite busy-wait timeouts under concurrency tests. *Mitigation*: route all registration mutations through the shared serialisation queue.
- **Frontend/backend contract drift**: Hand-maintained types in `app/src/types/index.ts` can drift from API responses if the `DELETE` response shape is not mirrored with runtime type guards. *Mitigation*: add explicit cancellation response types and guards alongside existing registration types.
- **Shared SQLite database in integration tests**: Integration tests run against the real SQLite database used by `make dev`; tests must create isolated sessions/registrations and clean them up unconditionally without relying on seed data or hardcoded IDs like `/registrations/1`. *Mitigation*: follow the existing `createSession` + `afterEach` cleanup pattern in `api/tests/integration/registrations.test.ts`.
- **No frontend automated test harness yet**: `app/package.json` has build, lint, and format checks but no frontend unit test runner; UI behaviour must be verified via TypeScript strict build, lint, and manual/browser verification unless adding a test framework is explicitly approved (out of scope / AGENT_BOUNDARY).

### Acceptance Criteria Coverage

| AC# | Description | Addressable? | Gaps/Notes |
|-----|-------------|--------------|------------|
| 1 | A "Cancel Registration" button is visible on the session card or registration confirmation page for an employee who has a confirmed registration | Yes | Requires storing the employee's registration identity in the frontend (currently discarded after submit); recommend persisting per-session state in `localStorage` + React state. |
| 2 | Clicking "Cancel" shows a confirmation prompt: "Are you sure you want to cancel your registration for [Session Title]?" | Yes | Inline confirmation prompt inside the session card displaying the exact message with the session's title. |
| 3 | After confirming, the page shows a success message: "Your registration has been cancelled" | Yes | Rendered in the card's status message area upon HTTP 200. |
| 4 | The session card updates to reflect the new registered/capacity count (e.g., "11 / 20 registered (9 spots left)") | Yes | `TrainingSessionCard` already formats `{registered} / {capacity} registered ({spotsLeft} spots left)` and updates via `onAvailabilityChange`; including `session` availability in the 200 response updates it in place. |
| 5 | If the employee has already cancelled, the Cancel button is not shown (or is disabled with label "Cancelled") | Yes | Driven by local cancelled state after 200 (and gracefully on 409); pick one of the two options in REASONS Canvas (and confirm whether re-registering is offered). |
| 6 | `DELETE /api/training-sessions/:id/registrations/:registrationId` returns HTTP 200 with `{ status: "cancelled" }` | Yes | Add `DELETE /:registrationId` handler on existing registrations router; recommend returning `{ status: "cancelled", session }` as a backward-compatible superset. |
| 7 | On cancellation, the registration status changes to `cancelled` in the database | Yes | `Registration.status` already exists and supports `'cancelled'`; no schema migration needed. |
| 8 | On cancellation, the session's `registered` count decrements by 1 | Yes | Decremented atomically in the same transaction for confirmed registrations (and `waitlisted` decremented if cancelling a waitlisted registration). Note tension with WH-5 if promotion runs in the same story. |
| 9 | Returns HTTP 404 if the registration does not exist | Yes | Also covers registration belonging to a different session ID or a non-existent session ID. |
| 10 | Returns HTTP 409 if the registration is already cancelled | Yes | Checked atomically inside the serialised transaction so concurrent duplicate cancellations return one 200 and one 409. |
| 11 | After cancellation, waitlist promotion (WH-5) is triggered | Partial | WH-5 (`LATC-5`) is a separate story with its own promotion & net-zero counter ACs. Addressable via an explicit transactional promotion trigger seam invoked on confirmed cancellation (tested via unit tests), with actual promotion implemented in WH-5 — needs user confirmation before REASONS Canvas. |
