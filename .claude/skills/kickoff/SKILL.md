---
name: kickoff
description: Start work on a WorkshopHub Jira story. Reads an LATC card, creates (or reuses) the user's personal copy in the In Development column, saves the story to ./stories, and checks out a latc-{id}-{desc} branch. Never edits, changes or moves the original card (the only exception is the "clones" link).
argument-hint: LATC-<n>
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash, Write
---

# Kickoff

Start work on one LATC story, then stop. Follow the steps in order.

Jira is reached through the Atlassian CLI, `acli` (site `thoughtworks.atlassian.net`). Reads run freely. Every write (`create`, `link create`, `transition`, `comment create`) is stopped by the `cli-write-guard` hook for the user's OK, on top of the confirmation in step 6. That double check is intended.

## Hard rules

- **NEVER edit, change, transition, comment on or otherwise write to the original card.** Every Jira write goes to the user's copy only. Before each write command, check that its `--key` (or `--out`) is not the original key. If it is, stop.
- **The only exception** is the `Cloners` issue link created in step 7. It is created from the copy, but Jira also shows it on the original ("is cloned by LATC-<m>"). It is the only allowed effect on the original. `link create` has no comment option; never add a comment to the original by any other means.
- Every write names exactly one work item with `--key LATC-<m>`. Never use `--jql`, `--filter` or a comma-separated key list on a write; the hook blocks them.
- Use only these write commands: `acli jira workitem create`, `acli jira workitem link create`, `acli jira workitem transition`, `acli jira workitem comment create`. Nothing else writes to Jira.
- Always pass `--json` to reads and parse the output; don't scrape the human-readable tables.
- Use AskUserQuestion for anything unclear. Don't guess card numbers, names or statuses.
- Never push, and never commit. This command ends with a checked-out branch.

## Board columns vs statuses

"In Development" is a **board column**, not a Jira status. On the LATC board (id 22687), the column maps to these statuses:

| Board column | Statuses |
|---|---|
| To Do | Backlog, In Analysis / Design |
| Ready for Development | READY FOR DEVELOPMENT |
| **In Development** | **In Progress**, Blocked / On Hold |
| In Review | In Review |
| Done | Done |

- A card is "in In Development" if its status is `In Progress` or `Blocked / On Hold`.
- "Move to In Development" means transitioning to the status **`In Progress`**.
- If the mapping looks wrong (for example, no transition to `In Progress` exists), recheck it. `acli` can't read board configuration, so use the read-only REST helper: `node scripts/jira-get.mjs /rest/agile/1.0/board/22687/configuration` and read `columnConfig.columns[].statuses[].id`; resolve status ids with `node scripts/jira-get.mjs /rest/api/3/status/<id>`. Ask if it is still unclear.

## Steps

### 1. Get the card key
Take the key from `$ARGUMENTS` (e.g. `LATC-2`, `latc-2` or `2`) and write it uppercase as `LATC-<n>`.
- Missing or unparseable → ask with AskUserQuestion.

### 2. Preflight
- If `node scripts/jira-get.mjs` is needed later and reports no Keychain item, ask the user to store the token (the message shows the command). Never read the Keychain yourself.
- Run `acli jira auth status`. Not logged in → tell the user to run `! acli jira auth login --web` (choose the `thoughtworks.atlassian.net` site), then stop. Don't run `auth login` yourself; it's interactive.
- Run `git status --short`. Uncommitted changes → ask whether to stop, or to carry the changes onto the new branch. Don't stash or discard anything without a yes.

### 3. Read the original card
```bash
acli jira workitem view LATC-<n> --fields 'summary,issuetype,status,description,labels,issuelinks' --json
```
Note the summary, issue type, status, description (ADF JSON), labels and issue links. If the card has acceptance criteria in a separate custom field, rerun with `--fields '*all'` to find it.
- Not found → tell the user and stop.
- The card is itself a copy (summary starts with `[`, description starts with `Copied from LATC-`, or it has a "clones" link) → ask whether they meant the original it was copied from.

### 4. Identify the user
`acli` has no "who am I" command, so use the REST helper:
```bash
node scripts/jira-get.mjs /rest/api/3/myself
```
Take `displayName` as `<Name>`.
- Helper unavailable (no Keychain item) → fall back to `acli jira workitem search --jql 'reporter = currentUser() ORDER BY created DESC' --fields 'key,reporter' --limit 1 --json` and take `fields.reporter.displayName`.
- Still nothing → ask with AskUserQuestion.

### 5. Find an existing copy
```bash
acli jira workitem search --jql 'project = LATC AND (issue in linkedIssues(LATC-<n>) OR description ~ "\"Copied from LATC-<n>\"") ORDER BY created DESC' --fields 'key,summary,status' --paginate --json
```
Search can't return `issuelinks` ("field 'issuelinks' is not allowed"), so ask only for key, summary and status. Keep only results whose summary is exactly `[<Name>] <original summary>`. Exclude the original key. For each kept copy, read its links:
```bash
acli jira workitem view LATC-<m> --fields issuelinks --json
```
It already has the link if an entry has `type.name` `Cloners` and `outwardIssue.key` LATC-<n>.
- More than one match → ask which copy to use.

### 6. Confirm the Jira writes
CLAUDE.md says to ask before any Jira write, so confirm with AskUserQuestion before writing. List every write that will happen:
- "create copy `[<Name>] <summary>`"
- "link it as cloning LATC-<n> (the link also shows on LATC-<n>)", if the copy has no link yet
- "move copy LATC-<m> to In Progress (In Development column)"
- or "comment on copy LATC-<m>"

Options: proceed or cancel. The hook then asks again for each write command; that is expected.

### 7. Copy or comment
**A. No copy exists:**
1. Write the description to a temp file as ADF: the original's description document with one paragraph inserted at the start of its `content` array:
   ```json
   { "type": "paragraph", "content": [{ "type": "text", "text": "Copied from LATC-<n> for kickoff" }] }
   ```
   If the original has no description, the document is just that paragraph (`{ "type": "doc", "version": 1, "content": [ ... ] }`). Then create the copy:
   ```bash
   acli jira workitem create --project LATC --type '<issue type>' \
     --summary '[<Name>] <original summary>' \
     --label '<label1>,<label2>' \
     --description-file "$tmp" --json
   ```
   Omit `--label` if the original has none. Take the new key `LATC-<m>` from the JSON output.
2. Link the copy to the original:
   ```bash
   acli jira workitem link create --out LATC-<m> --in LATC-<n> --type clones --yes
   ```
   `--type` takes the link type's outward description; for `Cloners` that is `clones`, so this reads "LATC-<m> clones LATC-<n>". Check it with `acli jira workitem link list --key LATC-<m> --json`: expect an entry with `typeName` `Cloners` and `outwardIssueKey` LATC-<n>. If the link fails, report the failure and continue; the copy is still usable.
3. Move the **copy** to In Development. First list the copy's transitions with `node scripts/jira-get.mjs /rest/api/3/issue/LATC-<m>/transitions` and check that one has `to.name` `In Progress`. None available → ask. Then:
   ```bash
   acli jira workitem transition --key LATC-<m> --status 'In Progress' --yes --json
   ```
   Then confirm with `acli jira workitem view LATC-<m> --fields status --json` that the status is `In Progress`. Transition fails → ask.

**B. Copy exists and its status is not in the In Development column:** run A.2 (only if it has no `Cloners` link yet), then A.3 on the copy.

**C. Copy exists and is already in the In Development column (`In Progress` or `Blocked / On Hold`):** don't transition anything. Run A.2 if the link is missing. Add a comment to the **copy**:
```bash
acli jira workitem comment create --key LATC-<m> --body 'Kickoff re-run by <Name> on <YYYY-MM-DD>. Branch: latc-<m>-<desc>.'
```

From here on, `<m>` is the copy's number.

### 8. Save the story
Write `./stories/LATC-<m>.md` (create `stories/` if missing). Overwrite only after asking. Render the ADF description as Markdown (headings, lists, code, links).
```markdown
# LATC-<m>: [<Name>] <original summary>

- **Copy of:** LATC-<n>
- **Status:** <copy's status> (board column: In Development)
- **Type:** <issue type>
- **Jira:** https://thoughtworks.atlassian.net/browse/LATC-<m>

## Description

<original description>

## Acceptance criteria

<acceptance criteria, if they're in a separate field; otherwise omit this section>
```

### 9. Create the branch
- `<desc>`: kebab-case slug of the original summary. Use lowercase a–z, 0–9 and hyphens only, drop filler words, and keep it to 5 words or fewer (e.g. `register-for-training-session`).
- Branch name: `latc-<m>-<desc>`.
- Start from an up-to-date main: `git switch main && git pull --ff-only`, then `git switch -c latc-<m>-<desc>`.
- Branch already exists → ask whether to check it out or choose another name.

### 10. Stop
Run `git branch --show-current` and report:
- the original key and the copy key, plus what was done in Jira (created / linked / moved / commented)
- the story file path
- the branch name

Then stop. Don't start implementing.
