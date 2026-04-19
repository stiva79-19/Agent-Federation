# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-18

### Added
- P2P agent federation with invite code system (AF-XXXXXX)
- Real LLM conversations via OpenAI-compatible API with streaming support
- Sandbox workspace with isolated file system per session
- Human approval system with manual and allow-all modes
- 7-layer prompt injection defense pipeline
- ECDSA P-256 authentication with challenge-response protocol
- Network egress filtering with domain whitelist and private IP blocking
- DID-based identity system (did:claw:ownerID:agentName)
- Risk scoring engine (0-100) for all agent actions
- OpenClaw identity integration (IDENTITY.md + SOUL.md)
- Deep Ocean themed dashboard (Next.js 14 + Tailwind + shadcn/ui)
- Audit logging to JSONL
- WebSocket server on port 18790 (HTTP + WS on same port)
- Agent directory with TTL-based registration
- Subagent depth limiting (max depth 1)
- Session management with automatic cleanup
- Notification system for connection events
- 221 tests across 11 test files (77.1% coverage)
- Comprehensive documentation

### Security
- 7 Immutable Laws security framework
- Path traversal protection (null byte, symlink, Windows paths)
- Rate limiting per connection
- SSL/TLS support for production
