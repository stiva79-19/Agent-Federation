/**
 * Agent Federation Network
 * 
 * 🤝 Federated AI Agent Collaboration Platform
 * İnsan onaylı, güvenli, sandbox'lı agent iletişimi.
 */

// Identity
export { generateAgentDID, parseDID, createInvitation, generateKeyPair, signMessage, signAuthChallenge } from './identity/agent';
export type { AgentIdentity, AgentInvitation, Permission } from './identity/agent';

// Consent
export { ConsentManager } from './consent/consent';
export type { ConsentRequest, ConsentDecision, ConsentAction, ConsentResponse } from './consent/consent';

// Sandbox
export { Sandbox, defaultSandbox } from './sandbox/sandbox';
export type { SandboxConfig } from './sandbox/sandbox';

// Security
export { scanMessage } from './protocol/injection-defense';
export type { MessageScanResult } from './protocol/injection-defense';

// Network Egress Filter
export { NetworkEgressFilter, secureConfig, defaultAllowlist } from './security/network-egress-filter';
export type { NetworkEgressConfig, NetworkRequest, NetworkResponse } from './security/network-egress-filter';

// Transport
export { Transport, defaultTransportConfig } from './transport/websocket';
export type { TransportConfig, PeerConnection, FederatedMessage, TransportEvent } from './transport/websocket';

// Server
export { WebSocketServerManager, MAX_CONNECTED_AGENTS } from './server/ws-server';
export { auditLogger, AuditLogger } from './server/audit-logger';
export type { AuditLogEntry, AuditEventType, AuditSeverity } from './server/audit-logger';

// Sandbox File System
export { SandboxFS, validateSandboxPath, calculateRiskScore } from './server/sandbox-fs';
export type { SandboxAction, SandboxActionType, SandboxFileInfo, SandboxFSConfig } from './server/sandbox-fs';

// Approval System
export { ApprovalManager } from './server/approval';
export type { ApprovalRequest, ApprovalMode, ApprovalRequestStatus } from './server/approval';

// Types — new additions
export type { DashboardAgentStatus } from './server/types';

// Invitations & Sessions
export { InvitationManager } from './server/invitations';
export type { Invitation, InvitationStatus, CreateInvitationParams } from './server/invitations';
export { SessionManager } from './server/sessions';
export type { CollaborationSession, SessionStatus, SessionParticipant } from './server/sessions';
export { NotificationManager } from './server/notifications';
export type { Notification, NotificationType } from './server/notifications';

// Registry
export { AgentDirectory, DEFAULT_TTL_SECONDS } from './registry/directory';
export type { AgentEntry, DirectoryQuery } from './registry/directory';

// P2P
export { P2PManager } from './server/p2p';
export type { InviteCode, P2PMatch } from './server/p2p';

// Agent & LLM
export { Agent, loadAgentConfig, loadOpenClawIdentity, buildSystemPrompt } from './agent/agent';
export type { AgentConfig, ConversationMessage, AgentStatus, ConversationEvent, OpenClawIdentity } from './agent/agent';
export { LLMClient, loadLLMConfig } from './agent/llm';
export type { ChatMessage, LLMConfig, TokenUsage } from './agent/llm';

// Constants
export const MAX_AGENTS_PER_GROUP = 7;
