---
name: /spdd-generate
id: spdd-generate
category: Development
description: Generate code from a structured SPDD prompt file following the REASONS Canvas methodology
---

Generate implementation code from a structured SPDD (Structured Prompt-Driven Development) prompt file, strictly following the Operations sequence and coding norms defined in the prompt.

**Input**: The argument after `/spdd-generate` is the path to the structured prompt file (e.g., `@spdd/prompt/GGQPA-XXX-202602271430-[Feat]-api-create-agent-endpoint.md`).

**Steps**

1. **If no input provided, ask for the prompt file**

   Use the **AskUserQuestion tool** to ask:
   > "Please provide the path to the structured prompt file (e.g., `@spdd/prompt/xxx.md`)."

   **IMPORTANT**: Do NOT proceed without a valid prompt file path.

2. **Read and parse the structured prompt file**

   Read the prompt file and extract the REASONS Canvas sections:
   
   | Section | Purpose | Usage |
   |---------|---------|-------|
   | **R** - Requirements | Overall goal and DoD | Understand the business context |
   | **E** - Entities | Domain model and relationships | Reference for class design |
   | **A** - Approach | Implementation strategy | Guide architectural decisions |
   | **S** - Structure | Components and dependencies | Verify layering and relationships |
   | **O** - Operations | Concrete implementation tasks | **Execute in defined order** |
   | **N** - Norms | Engineering standards | Apply to all generated code |
   | **S** - Safeguards | Non-negotiable constraints | Enforce strictly |

   **IMPORTANT**: Read the ENTIRE file carefully. Each section provides critical guidance.

3. **Analyze project context**

   Before generating code:
   - Identify the project's technology stack (e.g., Spring Boot, Java version)
   - Locate existing similar patterns in the codebase for reference
   - Identify the correct package structure and directory layout
   - Check for existing base classes, utilities, or configurations to reuse

   **IMPORTANT**: Generated code MUST align with existing project conventions.

4. **Validate the Operations sequence**

   Review the **Operations** section to verify:
   
   a. **Dependency order is correct**:
      - Classes with no dependencies come first (enums, constants)
      - Classes depend only on previously defined classes
      - No circular dependencies exist
   
   b. **Task decomposition is complete**:
      - Each operation is atomic and testable
      - No logical gaps between operations
      - All components mentioned in Structure are covered
   
   c. **Consistency with Structure section**:
      - Inheritance relationships match
      - Dependencies match
      - Layered architecture is respected

   d. **Operations are grouped into TDD slices**:
      - Operations start with an optional `### Slice 0 - Setup` (schema, seed, config) and then one `### Slice <n> - <AC>` per acceptance criterion, each with **Tests (RED)**, **API implementation (GREEN)** and, if needed, **Frontend** parts (see `/spdd-reasons-canvas`)
      - Every AC is covered by exactly one slice
      - Slice order respects dependencies (a slice only relies on earlier slices)
      - **Legacy canvas** (Operations grouped by file, not by slice) → stop and use AskUserQuestion: "Regroup with `/spdd-prompt-update` (Recommended)" or "Cancel". Don't regroup it yourself inside this command, and don't fall back to writing everything inline.

   **If issues are found**: Report to user and suggest prompt modifications before proceeding.
   
   **IMPORTANT**: Do NOT re-plan the sequence. The Operations order is the designed execution order from the Abstraction phase.

5. **Generate code slice by slice through the TDD agents**

   You are the orchestrator. API tests come only from the **`test-writer`** agent and API source only from the **`implementer`** agent. Do NOT write or edit files under `api/tests/` or `api/src/` yourself, not even to "help". The per-slice loop reuses steps 2–6 of `.claude/skills/tdd/SKILL.md`; read that file first and follow it, with the overrides below.

   a. **Slice 0 - Setup (you, in the main session)**:
      - Apply the setup Operations yourself (e.g. `api/prisma/schema.prisma`, `api/prisma/seed.ts`).
      - Anything on CLAUDE.md's AGENT_BOUNDARY list (schema change, `make reset-db`, new dependency, CI/Makefile/hooks) needs the user's explicit yes via AskUserQuestion before you do it.
      - Run `make test` to confirm the existing suite still passes before slice 1.

   b. **For each slice, in order** (follow tdd steps 2–6):
      1. **Packet** (tdd step 2): the slice's AC text and its Tests/API parts verbatim, plus the canvas excerpts that apply to it: the related Requirements, Entities, Approach, Structure, Norms and Safeguards. Add the story's Out of Scope items and the later slices' ACs as "do NOT build or test". Show the packet to the user.
      2. **RED** (tdd steps 3–4): launch `test-writer` with the packet. If its report starts with `GUARD INACTIVE`, stop the whole run. Run `make test`, show the failures, then **pause** with AskUserQuestion: "RED confirmed, implement" / "Revise tests" / "Stop".
      3. **GREEN** (tdd steps 5–6): launch `implementer` with the packet, the failing test names and the `make test` output. If it asks for an AGENT_BOUNDARY action, take it to the user. Then run `make test`, `make lint` and `make format-check` yourself and show the results.
      4. **Frontend part** (you, in the main session): no agent covers `app/`, so apply the slice's Frontend operations yourself, following Norms and Safeguards. Then run `make lint`, `make format-check` and `make build`.
      5. **Pause between slices**: report the slice result (tests added, files changed, gate results), then ask with AskUserQuestion: "Next slice (<n+1>: <AC>)" / "Commit first with `/workshophub-commit`" / "Stop". Never start the next slice without a yes.

   c. **Overrides to the tdd skill inside this command**:
      - The slice text comes from the canvas, not from asking the user. The canvas is the navigator's input.
      - "ONE slice per run, then stop" becomes "one slice at a time, with the pause in b.5".
      - If a slice turns out wrong mid-run (a test or the implementer exposes a spec gap), stop, fix the canvas with `/spdd-prompt-update`, then rerun that slice. Don't patch around the spec.

   **IMPORTANT**:
   - Do NOT deviate from the specifications in Operations
   - Do NOT add features or methods not specified
   - Do NOT change error messages from Safeguards
   - Do NOT write API tests or API source yourself; delegate to the agents
   - DO reference existing project patterns for consistency

6. **Batch validation after generation**

   After ALL slices are done, perform unified validation (`make test`, `make lint`, `make format-check`, `make build`):

   a. **Compilation check**:
      - Run linter to check for syntax errors
      - Verify all imports are correct
      - Fix any type mismatches

   b. **Acceptance Criteria verification**:
      - Cross-check with the **Acceptance Criteria Traceability** table (if present)
      - Ensure each AC is addressed by the implementation
      - Verify error codes, HTTP status codes, and messages match exactly

   c. **Structure verification**:
      - Verify layered architecture is respected
      - Confirm dependency injection is correct
      - Check interface/implementation relationships

   d. **Fix any issues found**:
      - Fix compilation errors
      - Correct import statements
      - Ensure code follows project formatting standards

7. **Report generation summary**

   Provide a summary to the user:
   - Each slice: the AC, the tests test-writer added, the files the implementer changed, and the frontend files you changed
   - List of created files with their responsibilities
   - Any deviations or assumptions made
   - Validation results (pass/fail for each check)

**Review & Iteration Loop**

If issues are discovered after generation (during testing or code review), follow the SPDD principle:

> **"When reality diverges, fix the prompt first — then update the code."**

1. **Identify the issue**: What behavior is incorrect or missing?

2. **Trace to prompt section**: Which part of the prompt caused this?
   - Wrong requirement interpretation → Update **Requirements**
   - Missing entity/relationship → Update **Entities**
   - Flawed strategy → Update **Approach**
   - Incorrect component design → Update **Structure**
   - Wrong implementation detail → Update **Operations**
   - Missing standard → Update **Norms**
   - Missing constraint → Update **Safeguards**

3. **Update the prompt first**: Modify the relevant section in the prompt file

4. **Regenerate affected code**: Only regenerate the components affected by the prompt change

5. **Commit together**: Commit the updated prompt and code together to maintain traceability

**Example iteration**:
```
Issue: "AgentService interface shouldn't contain business logic"

1. Trace: Operations section defines AgentService with logic
2. Update prompt: Move logic to AgentServiceImpl in Operations
3. Regenerate: Only regenerate AgentService and AgentServiceImpl
4. Commit: Commit prompt change + code change together
```

**Output**

- All generated source files following the project structure, built one TDD slice at a time
- Summary of created files and their responsibilities
- Validation results
- Any issues requiring prompt modification

**Guardrails**

- Do NOT generate code without first reading the entire prompt file
- Do NOT re-plan the Operations sequence — execute in the defined order
- Do NOT write API tests or API source yourself — `test-writer` writes RED, `implementer` writes GREEN
- Do NOT implement a slice before the user confirms RED, and do NOT start the next slice without a yes
- Stop the run if `test-writer` reports `GUARD INACTIVE`
- Do NOT skip any operation defined in the Operations section
- Do NOT change method signatures, field names, or error messages from the specification
- Do NOT add extra features, endpoints, or fields not specified
- Do NOT patch code directly when issues are found — update prompt first
- Always use the exact error messages from Safeguards
- Always follow Norms for coding style and patterns
- Always verify against Acceptance Criteria after generation
- Always check for and fix linter errors after batch generation
- Always commit prompt and code changes together

**Integration with /spdd-analysis and /spdd-reasons-canvas**

This command is the third phase of the SPDD workflow:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SPDD Workflow                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Phase 1: /spdd-analysis                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Requirement → Alignment → Abstraction → Enriched Context       │    │
│  │                                                                 │    │
│  │ Output: Strategic context (business + domain + risks)          │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                              │                                          │
│                              ▼                                          │
│  Phase 2: /spdd-reasons-canvas                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Enriched Context → REASONS Canvas → Structured Prompt          │    │
│  │                                                                 │    │
│  │ Output: spdd/prompt/GGQPA-XXX-*.md (REASONS Canvas)           │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                              │                                          │
│                              ▼                                          │
│  Phase 3: /spdd-generate                                               │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Structured Prompt → Validate → Generate → Verify → Code        │    │
│  │                                                                 │    │
│  │ Output: Implementation code following Operations sequence       │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                              │                                          │
│                              ▼                                          │
│  Phase 4: Review & Iteration                                            │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Issue Found → Update Prompt → Regenerate → Commit Together     │    │
│  │                                                                 │    │
│  │ Principle: "Fix prompt first, then update code"                │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

The structured prompt serves as the **contract** between design and implementation, and must stay in sync with the code throughout the lifecycle.
