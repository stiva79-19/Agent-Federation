## Summary

Adds a new Gateway RPC method `agent.identity.full` that exposes the local OpenClaw agent's full identity (parsed frontmatter plus raw IDENTITY.md + SOUL.md content) to authenticated Gateway clients.

**Why:** Downstream tools that need the agent identity — such as [agent-federation](https://github.com/stiva79-19/Agent-Federation), a Hyperswarm-based P2P federation layer — currently read `~/.openclaw/workspace/IDENTITY.md` and `SOUL.md` directly from the filesystem. That makes the workspace a de-facto shared public surface and prevents OpenClaw from mediating access in the future (consent prompts, scoped tokens, audit logging).

With `agent.identity.full`, external clients go through the Gateway and OpenClaw becomes the single gatekeeper. This is the first step of a broader migration documented in agent-federation's `docs/openclaw-pr-draft/README.md`.

## Why a new method vs. extending `agent.identity.get`

The existing `agent.identity.get` (in `agent.ts`) returns the UI-facing subset — `agentId`, `name`, `avatar`, `emoji`. That surface is intentionally minimal for UI clients.

External federation clients need more: the raw `IDENTITY.md` body (for system prompts), `SOUL.md` (personality), and additional frontmatter fields like `did`, `creature`, `vibe`. Keeping the UI-facing surface narrow while offering a separate `full` method avoids accidentally leaking prompt-building content to UI callers and lets each concern evolve independently.

## Contract

- **Method:** `agent.identity.full`
- **Params:** none
- **Scope:** `READ_SCOPE` (registered in `method-scopes.ts`)
- **Success payload:**
  ```ts
  {
    available: true;
    workspacePath: string;
    name?: string;
    did?: string;
    emoji?: string;
    creature?: string;
    vibe?: string;
    identityRaw: string;  // full IDENTITY.md
    soulRaw: string;      // full SOUL.md, "" if missing
  }
  ```
- **Graceful failure:** `{ available: false, reason: "no_workspace" | "no_identity_md" | ... }` — not treated as an RPC error so clients can degrade cleanly.

## Implementation notes

- Workspace path resolution: `OPENCLAW_WORKSPACE` env → `~/.openclaw/workspace`.
- Minimal built-in YAML frontmatter parser to avoid introducing a new dependency in the Gateway hot path.
- `SOUL.md` is optional; missing file returns `soulRaw: ""` rather than erroring.
- Handler follows the same shape as `healthHandlers` / `cronHandlers`.

## Files changed

New:
- `src/gateway/server-methods/identity.ts` — handler + YAML frontmatter parser + workspace resolver.
- `src/gateway/server-methods/identity.test.ts` — 5 unit tests.

Registry:
- `src/gateway/server-methods.ts` — import + spread `identityHandlers` alongside other core handlers.
- `src/gateway/server-methods-list.ts` — add `"agent.identity.full"` to `BASE_METHODS`.
- `src/gateway/method-scopes.ts` — add `"agent.identity.full"` to the `READ_SCOPE` group.

## Test plan

- [x] Unit tests cover: missing workspace, missing IDENTITY.md, full happy path with frontmatter + SOUL, missing SOUL, IDENTITY.md without frontmatter.
- [ ] Manual: `openclaw gateway call agent.identity.full --json`
- [ ] Manual: `openclaw gateway call agent.identity.full --json` with `OPENCLAW_WORKSPACE=/tmp/empty` returns `available: false`

> Local-dev note: tests were not runnable in the contributor's environment because `openclaw`'s Vitest config hit a `tinypool` `minThreads/maxThreads` conflict under Node 22.22 + vitest 1.6.1 via the nested `agent-federation/node_modules/vitest` resolution chain. The test file follows the same structure as other gateway method tests; CI should exercise it cleanly.

## Follow-ups (not in this PR)

- `llm.chat` method with streaming events so LLM API keys stay behind the Gateway (Phase 1b) — this will let agent-federation stop reading `~/.openclaw/credentials/` entirely.
- `auth.grant` method wrapping `exec.approval.*` for per-session scoped tokens (Phase 2) — consent-based access for external federation clients.
