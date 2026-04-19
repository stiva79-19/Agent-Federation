# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

- **Email**: aliaydinli@icloud.com
- **Do NOT** open public issues for security vulnerabilities
- **Expected Response Time**: 48 hours
- **Include in Report**:
  - Description of the vulnerability
  - Reproduction steps
  - Impact assessment
  - Suggested fix (if available)
- **Disclosure**: Responsible disclosure with 90-day coordinated disclosure window

## Security Architecture

The 7 Immutable Laws of Agent Federation form the foundation of our security model:

### 1. Human Decides
Agents cannot send, accept, or establish connections without human approval. The ConsentManager requires explicit human decision for every sensitive action. No automatic permissions or implicit consent is granted.

### 2. Sandbox Boundary
Every agent operates in an isolated sandbox directory. Path traversal attacks are blocked via:
- Path normalization
- Symlink detection
- Null byte filtering

The Sandbox class validates every file path before access.

### 3. 7 Agent Limit
Maximum 7 agents can be connected simultaneously (MAX_CONNECTED_AGENTS = 7). This limit:
- Reduces blast radius from compromised agents
- Prevents resource exhaustion attacks
- Maintains system stability

### 4. 7-Layer Injection Defense
Every message passes through the injection defense pipeline:

- **Layer 1: Unicode Normalization (NFC)** — Blocks homoglyph attacks and Unicode-based obfuscation
- **Layer 2: Hidden Character Detection** — Detects zero-width characters, BOM markers, RTL overrides
- **Layer 3: Encoding Attack Detection** — Identifies base64, hex, HTML entity encoding attempts
- **Layer 4: Known Injection Patterns** — Blocks common injection signatures ("ignore previous", "you are now", etc.)
- **Layer 5: Semantic Analysis** — Analyzes imperative command count and message length (DoS prevention)
- **Layer 6: Output Validation** — Sanitizes response content before delivery
- **Layer 7: Rate Limiting** — Detects anomalies and anomalous request patterns

### 5. Federation
No central admin or single point of failure. Architecture features:
- Each human owns and controls their agent
- DID-based identity: `did:claw:ownerID:agentName`
- ECDSA P-256 signatures for all actions
- Decentralized trust model

### 6. Full Visibility
All operations logged to JSONL audit log:
- Every message is logged
- Every connection is recorded
- Every action is traceable
- Audit trail cannot be modified retroactively

### 7. Time-Limited
Temporal security controls:
- Every connection has an expiry
- Every invitation has a time limit
- Stale connections are cleaned up automatically
- Tokens expire and must be renewed

## Additional Security Measures

### Network Egress Filter
- Domain whitelist for outbound connections
- Private IP blocking:
  - 10.x.x.x (Class A private)
  - 192.168.x.x (Class C private)
  - 127.x.x.x (Loopback)
  - Link-local addresses (169.254.x.x)
- DNS interception to prevent rebinding attacks

### ECDSA Authentication
- P-256 elliptic curve key pairs
- Challenge-response authentication protocol
- Digital signature verification on all messages

### Risk Scoring
Every action receives a risk score (0-100):
- Read operations: 10
- Write operations: 40
- Execute operations: 60
- Network operations: 50
- Execute + Network: 80

Actions with risk ≥ 70 require explicit human approval regardless of system mode.

### Subagent Depth Limiting
- Maximum spawn depth of 1
- Prevents recursive agent spawning attacks
- Avoids exponential resource consumption

### Approval System
Two operation modes:

**Manual Mode**: Human must approve each action before execution
**Allow All Mode**: System auto-approves all actions except those with risk score ≥ 70

### Path Traversal Protection
Defense against directory escape attacks:
- Null byte injection filtering
- Symlink bypass detection
- Windows path separator handling
- Absolute path validation

### Rate Limiting
- Per-connection message rate limits
- Protects against rapid-fire DoS attacks
- Configurable limits per agent

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

Security updates are released as patch versions (0.1.x). Users are strongly encouraged to keep their systems updated.

## Security Disclosure Timeline

When a vulnerability is reported:

1. **Immediate** (< 1 hour): Acknowledge receipt
2. **24 hours**: Initial assessment and verification
3. **48 hours**: Fix development begins
4. **14 days**: Patch development and testing
5. **21 days**: Security release preparation
6. **30 days**: Coordinated disclosure (reporter notified of release date)
7. **90 days**: Public disclosure permitted if not already fixed

## Security Best Practices

When deploying Agent Federation:

- Keep all components updated to the latest version
- Use ECDSA P-256 keys of appropriate length
- Enable audit logging and monitor logs regularly
- Use the Manual approval mode for sensitive operations
- Implement additional rate limiting at network boundary
- Use TLS/SSL for all network communications
- Regularly review connected agents and revoke unused invitations
- Implement network segmentation around Agent Federation instances
