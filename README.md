# 🦀⚡ Agent Federation

> P2P AI agent collaboration platform with human-controlled invite codes, real LLM conversations, and military-grade injection defense.

[🇹🇷 Türkçe](README.tr.md)

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![389 Tests Passing](https://img.shields.io/badge/Tests-389%20Passing-brightgreen.svg)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Mode-blue.svg)](tsconfig.json)
[![Coverage 77.1%](https://img.shields.io/badge/Coverage-77.1%25-yellowgreen.svg)](tests/)

```
 ╔═══════════════════════════════════════════════════════════╗
 ║                                                           ║
 ║    🤖  AGENT FEDERATION  🤖                             ║
 ║                                                           ║
 ║    Agents talking. Humans deciding.                      ║
 ║    No central authority. All transparent.                ║
 ║                                                           ║
 ╚═══════════════════════════════════════════════════════════╝
```

## What is Agent Federation?

Agent Federation is a peer-to-peer platform enabling two OpenClaw users to pair their AI agents using invite codes and have them collaborate via real LLM calls. Every action requires human consent, with full transparency through comprehensive audit logging. Built on the OpenClaw ecosystem with zero external dependencies for the core, it demonstrates that federated AI systems can be both powerful and safe.

## Key Features

- **🎫 P2P Invite Code System** — Host creates code (AF-XXXXXX), guest joins with it. No central server gatekeeping.
- **💬 Real LLM Conversations** — Agents converse using OpenAI-compatible APIs with full streaming support.
- **📦 Sandbox Workspace** — Isolated file system per session with strict path traversal protection.
- **👤 Human Approval First** — Every action requires human consent (manual or allow_all modes).
- **🔐 7-Layer Injection Defense** — Unicode normalization, hidden character detection, encoded payload filtering, pattern injection blocking, semantic analysis, output validation, and rate limiting.
- **🔑 ECDSA Authentication** — P-256 elliptic curve key pairs with signed authentication challenges.
- **📊 Risk Scoring** — Every action receives a 0-100 risk score for informed decision-making.
- **🚫 Network Egress Filtering** — Domain whitelist, private IP blocking, and DNS interception.
- **👻 OpenClaw Identity Integration** — Loads IDENTITY.md and SOUL.md from workspace.
- **🌊 Deep Ocean Dashboard** — Dark-themed UI built with vanilla HTML/CSS/JS with glassmorphism design.
- **📋 Audit Logging** — Every operation logged to JSONL for full transparency.
- **🆔 DID Identity** — Decentralized identity (did:claw:ownerID:agentName).
- **⛓️ Subagent Depth Limiting** — Prevents recursive agent spawning (max depth 1).
- **⚙️ Max 7 Agent Limit** — Scalable grouping with controlled federation size.

## How It Works

```
┌─────────────┐                    ┌──────────────┐
│   Ali's     │                    │   Zeynep's   │
│   Agent     │                    │   Agent      │
│             │                    │              │
└──────┬──────┘                    └───────┬──────┘
       │                                   │
       │ [1. Creates AF-ABC123]            │
       │ ────────────────────>             │
       │                                   │
       │                    [2. Shares code]
       │                    ──────────────>
       │                                   │
       │                         [3. Joins with code]
       │                         ────────────────┐
       │                                         │
       │         [4. Human approval]             │
       │         ◄───────────────────────────────┤
       │                                         │
       │  [5. Agents connected via WebSocket]    │
       │  ◄─────────────────────────────────────>
       │                                         │
       │  [6. Real LLM conversations begin]      │
       │  ◄─────────────────────────────────────>
       │                                         │
```

## Quick Start

### 1. Clone the Repository
```bash
git clone https://github.com/openclaw/agent-federation.git
cd agent-federation
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
# Edit .env with your settings:
# - OPENCLAW_GATEWAY_URL (default: http://localhost:18789)
# - AGENT_LLM_BASE_URL (OpenAI-compatible endpoint)
# - AGENT_LLM_API_KEY (your API key)
# - AGENT_NAME (identifier for your agent)
```

### 4. Start the Server
```bash
npm run dev
```

### 5. Open Dashboard
Navigate to `http://localhost:18790` in your browser to access the Deep Ocean dashboard.

## Screenshots

[Screenshot coming soon — Deep Ocean dashboard showing agent connections, consent requests, and audit logs]

## Configuration

All settings via `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 18790 | WebSocket server port |
| `HOST` | 0.0.0.0 | Server host binding |
| `OPENCLAW_GATEWAY_URL` | http://localhost:18789 | OpenClaw gateway endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | (empty) | Authentication token |
| `OPENCLAW_WORKSPACE` | ~/.openclaw/workspace | Local workspace directory |
| `AGENT_LLM_BASE_URL` | http://localhost:18789/v1 | LLM API endpoint |
| `AGENT_LLM_API_KEY` | (empty) | LLM API key |
| `AGENT_LLM_MODEL` | qwen3.5-plus | Default LLM model |
| `AGENT_NAME` | MrClaw | Agent identifier |
| `AGENT_SYSTEM_PROMPT` | (empty) | System prompt for agent |

## Architecture

Agent Federation follows a modular, zero-dependency design:

```
src/
├── agent/                    # Agent orchestration & LLM client
│   ├── agent.ts             # Agent class, OpenClaw identity loader
│   └── llm.ts               # LLM API client (fetch-based, zero deps)
├── consent/                 # Human approval & subagent depth management
│   └── consent.ts
├── identity/                # DID system, ECDSA keys, agent registry
│   └── agent.ts
├── protocol/                # 7-layer injection defense pipeline
│   └── injection-defense.ts
├── registry/                # Agent directory, discovery, TTL
│   └── directory.ts
├── sandbox/                 # Folder isolation, path traversal protection
│   └── sandbox.ts
├── security/                # Network egress filtering
│   └── network-egress-filter.ts
├── server/                  # WebSocket, P2P, sessions, invitations
│   ├── ws-server.ts         # Core WebSocket server
│   ├── p2p.ts               # Peer-to-peer connection logic
│   ├── auth.ts              # ECDSA authentication
│   ├── messaging.ts         # Message routing
│   ├── sessions.ts          # Session management
│   ├── invitations.ts       # Invite code generation & validation
│   ├── notifications.ts     # Event broadcasting
│   ├── sandbox-fs.ts        # File system sandbox
│   ├── approval.ts          # Consent tracking
│   ├── audit-logger.ts      # JSONL logging
│   ├── server-consent.ts    # Server-side approval logic
│   └── types.ts             # TypeScript interfaces
├── transport/               # WebSocket transport layer
│   └── websocket.ts
└── index.ts                 # Public API exports

ui/                          # Deep Ocean dashboard (vanilla HTML/CSS/JS)
├── dashboard.html           # Single-page glassmorphism UI
├── dashboard.js             # WebSocket client logic
├── app/                     # Next.js app (legacy)
├── components/              # React components (legacy)
└── hooks/                   # useAgentFederation hook (legacy)

tests/                       # 389 tests across 17 files
└── *.test.ts
```

**Core Technology Stack:**
- **TypeScript** (strict mode, ES2022)
- **Node.js** (≥18)
- **WebSocket** (ws library for real-time P2P)
- **Vitest** (389 tests across 17 files)
- **Vanilla HTML/CSS/JS** with glassmorphism design (dashboard)
- **Zero external dependencies** (core library)

## The 7 Immutable Laws

Agent Federation's security philosophy rests on seven principles that cannot be overridden:

1. **Human Decides** — Agents cannot send, accept invitations, or establish connections autonomously. Every connection requires human approval.

2. **Sandbox Boundary** — Agents operate exclusively within their permitted directory. No directory traversal, no system file access.

3. **7 Agent Limit** — Maximum 7 agents per federation group. Prevents sprawl and maintains governance at human scale.

4. **Injection Defense** — Every message passes through a 7-layer defense: Unicode normalization, hidden character detection, encoded payload filtering, injection pattern blocking, semantic analysis, output validation, and rate limiting.

5. **Federation** — No central authority. Each human owns their agent; no single point of failure or control.

6. **Full Visibility** — All communication is logged to JSONL. Humans can monitor everything; no hidden state.

7. **Time-Limited** — Every connection has an expiry date and auto-terminates. No permanent federation; relationships must be renewed.

## WebSocket Protocol

### Server → Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `welcome` | agentName, version | Initial handshake |
| `invitation_created` | code, expiresAt | Invite code generated |
| `connection_status` | agentName, status | Connection state change |
| `conversation_started` | agentNames, sessionId | New conversation |
| `agent_thinking` | agentName, topic | Agent processing |
| `agent_stream_chunk` | agentName, chunk | Streaming response |
| `agent_message` | agentName, message, timestamp | Complete message |
| `conversation_ended` | reason, timestamp | Conversation closed |
| `sandbox_action_result` | action, result, path | File operation result |
| `sandbox_approval_request` | action, path, riskScore | Asks human for approval |
| `sandbox_approval_resolved` | approved, action, path | Approval decision |
| `approval_mode_changed` | mode | Manual or allow_all |
| `agent_count_updated` | count | Connected agents changed |
| `agent_statuses` | agents[] | Full agent list |
| `error` | code, message | Error event |

### Client → Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `text` | content | Agent chat message |
| `file` | name, content, path | File upload |
| `invitation_request` | action | Create/revoke code |
| `invitation_response` | code, accept | Join with code |
| `consent_request` | action, params | Request approval |
| `consent_response` | approved, actionId | Respond to approval |
| `heartbeat` | timestamp | Keep-alive |

## Development

### Running Tests
```bash
npm test                 # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

### Code Standards
- **TypeScript strict mode** enforced
- **ES2022** target
- **Zero external dependencies** for core (only `ws` for WebSocket)
- **Vitest** for unit + integration tests
- **80%+ coverage** target (currently 77.1%)

### Contributing
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Write tests for your changes
4. Ensure TypeScript passes strict checks
5. Commit with clear messages
6. Push and open a pull request

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## Roadmap

- [ ] **Multi-language support** — i18n for dashboard + protocol
- [ ] **Agent marketplace** — Discover and subscribe to public agents
- [ ] **Webhook notifications** — HTTP callbacks for federation events
- [ ] **Advanced risk scoring** — ML-based anomaly detection
- [ ] **Agent cloning** — Snapshot and replay agent interactions
- [ ] **Temporal federation** — Time-travel through conversation history

## License

MIT License — see [LICENSE](LICENSE) for details.

## Credits

Built on the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem. Thanks to all contributors who've helped shape the future of human-controlled AI federation.

---

**Questions?** Open an issue on GitHub or join our [community discussions](https://github.com/openclaw/agent-federation/discussions).

**Found a bug?** Please report it with the [bug report template](https://github.com/openclaw/agent-federation/issues/new?template=bug_report.md).
