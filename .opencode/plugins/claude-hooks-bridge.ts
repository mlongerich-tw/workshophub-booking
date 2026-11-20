// Claude Code hooks → OpenCode bridge.
//
// Runs the PreToolUse / PostToolUse command hooks declared in .claude/settings.json
// inside OpenCode, using the SAME shell scripts and the SAME stdin JSON contract
// Claude Code uses. settings.json is re-read on every tool call, so adding or
// changing a Claude hook applies to OpenCode immediately; nothing to keep in sync.
//
// Contract mapping (verified against OpenCode v2.3.2 event shapes):
//   OpenCode tool  → Claude tool_name   input mapping
//   shell {command}                     → Bash  {command}
//   read  {path}                        → Read  {file_path}
//   write {path, content}               → Write {file_path, content}
//   edit  {path, oldString, newString}  → Edit  {file_path, old_string, new_string}
//   patch (multi-file diff)             → Write/Edit per touched file {file_path}
//   grep / glob {pattern, path}         → Grep / Glob {pattern, path}
//   event.agent                         → agent_type
// Exit 2 from a PreToolUse hook blocks the call (thrown as an error the model sees).
// Exit 2 from a PostToolUse hook appends its stderr to the tool result.
// Other non-zero exits are logged and ignored, as in Claude Code.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

type HookCommand = { type: string; command: string; timeout?: number }
type HookGroup = { matcher?: string; hooks: HookCommand[] }
type ClaudeSettings = { hooks?: Partial<Record<'PreToolUse' | 'PostToolUse', HookGroup[]>> }
type ClaudeCall = { tool_name: string; tool_input: Record<string, unknown> }

type ToolEvent = {
  tool: string
  agent?: string
  sessionID?: string
  input: Record<string, unknown>
  status?: 'completed' | 'error'
  result?: { content?: Array<{ type: string; text?: string }> }
}

type PluginContext = {
  location?: { directory?: string }
  tool: { hook: (name: string, cb: (event: ToolEvent) => void | Promise<void>) => Promise<void> }
}

const TOOL_NAMES: Record<string, string> = {
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  question: 'AskUserQuestion',
  skill: 'Skill',
  subagent: 'Agent',
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function toClaudeCalls(event: ToolEvent, root: string): ClaudeCall[] {
  const abs = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : isAbsolute(p) ? p : join(root, p)
  const i = event.input ?? {}
  switch (event.tool) {
    case 'shell':
      return [{ tool_name: 'Bash', tool_input: { command: str(i.command) ?? '' } }]
    case 'read':
      return [{ tool_name: 'Read', tool_input: { file_path: abs(str(i.path)) } }]
    case 'write':
      return [
        { tool_name: 'Write', tool_input: { file_path: abs(str(i.path)), content: i.content } },
      ]
    case 'edit':
      return [
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: abs(str(i.path)),
            old_string: i.oldString,
            new_string: i.newString,
          },
        },
      ]
    case 'patch': {
      // Every file header in the patch envelope becomes one Write/Edit call.
      const text = Object.values(i).filter((v): v is string => typeof v === 'string').join('\n')
      const calls: ClaudeCall[] = []
      for (const m of text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
        const file = abs(m[2].trim())
        calls.push({ tool_name: m[1] === 'Add' ? 'Write' : 'Edit', tool_input: { file_path: file } })
      }
      return calls.length > 0 ? calls : [{ tool_name: 'Edit', tool_input: {} }]
    }
    case 'grep':
    case 'glob':
      return [
        {
          tool_name: TOOL_NAMES[event.tool],
          tool_input: { ...i, pattern: i.pattern, path: abs(str(i.path)) },
        },
      ]
    default:
      return [{ tool_name: TOOL_NAMES[event.tool] ?? event.tool, tool_input: { ...i } }]
  }
}

function loadHooks(root: string, phase: 'PreToolUse' | 'PostToolUse'): HookGroup[] {
  try {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
    ) as ClaudeSettings
    return settings.hooks?.[phase] ?? []
  } catch {
    return []
  }
}

function matches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    return matcher === toolName
  }
}

type HookOutcome = { blocked: boolean; message: string }

function runHooks(
  root: string,
  phase: 'PreToolUse' | 'PostToolUse',
  event: ToolEvent,
  call: ClaudeCall
): HookOutcome {
  const payload = JSON.stringify({
    hook_event_name: phase,
    session_id: event.sessionID,
    cwd: root,
    agent_type: event.agent,
    tool_name: call.tool_name,
    tool_input: call.tool_input,
    source: 'opencode',
  })
  const messages: string[] = []
  for (const group of loadHooks(root, phase)) {
    if (!matches(group.matcher, call.tool_name)) continue
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command') continue
      const res = spawnSync('bash', ['-c', hook.command], {
        input: payload,
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        encoding: 'utf8',
        timeout: (hook.timeout ?? 60) * 1000,
      })
      if (res.status === 2) {
        const msg = (res.stderr ?? '').trim() || `${phase} hook blocked ${call.tool_name}`
        if (phase === 'PreToolUse') return { blocked: true, message: msg }
        messages.push(msg)
      } else if (res.status !== 0) {
        console.warn(`[claude-hooks-bridge] ${phase} hook exited ${String(res.status)}: ${hook.command}`)
      }
    }
  }
  return { blocked: false, message: messages.join('\n') }
}

export default {
  id: 'claude-hooks-bridge',
  async setup(ctx: PluginContext) {
    const root = ctx.location?.directory ?? process.cwd()

    await ctx.tool.hook('execute.before', (event) => {
      for (const call of toClaudeCalls(event, root)) {
        const outcome = runHooks(root, 'PreToolUse', event, call)
        if (outcome.blocked) throw new Error(outcome.message)
      }
    })

    await ctx.tool.hook('execute.after', (event) => {
      if (event.status !== 'completed') return
      const notes = toClaudeCalls(event, root)
        .map((call) => runHooks(root, 'PostToolUse', event, call).message)
        .filter((m) => m !== '')
      if (notes.length === 0 || !event.result) return
      event.result.content = [
        ...(event.result.content ?? []),
        { type: 'text', text: `\n[PostToolUse hook feedback]\n${notes.join('\n')}` },
      ]
    })
  },
}
