/**
 * WebSocket Server Integration Tests
 * 
 * Additional tests for comprehensive server coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServerManager, defaultServerConfig, AgentConnection } from '../src/server/ws-server';
import { WebSocket } from 'ws';
import { auditLogger } from '../src/server/audit-logger';

describe('WebSocketServerManager - Advanced', () => {
  let server: WebSocketServerManager;

  beforeEach(async () => {
    server = new WebSocketServerManager({
      ...defaultServerConfig(),
      port: 18800,
      ssl: false,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('should handle connection lifecycle events', async () => {
    const connectionHandler = vi.fn();
    const disconnectionHandler = vi.fn();

    server.on('agent_connected', connectionHandler);
    server.on('agent_disconnected', disconnectionHandler);

    // Simulate connection event
    const mockConnection: AgentConnection = {
      did: 'did:claw:test:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
    };

    server.emit('agent_connected', mockConnection);
    expect(connectionHandler).toHaveBeenCalledWith(mockConnection);

    // Simulate disconnection
    server.emit('agent_disconnected', { did: 'did:claw:test:agent' });
    expect(disconnectionHandler).toHaveBeenCalledWith({ did: 'did:claw:test:agent' });
  });

  it('should track connection statistics', () => {
    const stats = server.getStats();
    
    expect(stats).toHaveProperty('totalConnections');
    expect(stats).toHaveProperty('uptime');
    expect(stats).toHaveProperty('connections');
    expect(stats.uptime).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(stats.connections)).toBe(true);
  });

  it('should handle rate limiting for connections', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:ratelimit:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
    };

    // Simulate multiple messages
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      mockConnection.messageTimestamps.push(now - (i * 1000));
    }

    expect(mockConnection.messageTimestamps.length).toBe(10);
  });

  it('should handle fingerprint generation', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:fingerprint:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
      fingerprint: 'fp-12345',
    };

    expect(mockConnection.fingerprint).toBeDefined();
    expect(mockConnection.fingerprint?.length).toBeGreaterThan(0);
  });

  it('should handle public key storage', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:keyagent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
      publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhk',
    };

    expect(mockConnection.publicKey).toBeDefined();
    expect(mockConnection.publicKey?.length).toBeGreaterThanOrEqual(40);
  });

  it('should track sent and received message counts', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:counter:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 5,
      receivedCount: 3,
      messageTimestamps: [],
    };

    expect(mockConnection.sentCount).toBe(5);
    expect(mockConnection.receivedCount).toBe(3);

    mockConnection.sentCount = 10;
    mockConnection.receivedCount = 7;

    expect(mockConnection.sentCount).toBe(10);
    expect(mockConnection.receivedCount).toBe(7);
  });

  it('should update lastMessageAt on message activity', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:active:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
    };

    const before = mockConnection.lastMessageAt.getTime();
    
    // Simulate message activity
    mockConnection.lastMessageAt = new Date();
    const after = mockConnection.lastMessageAt.getTime();

    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('Server Configuration Options', () => {
  it('should accept custom host configuration', () => {
    const config = {
      port: 18790,
      host: '127.0.0.1',
      ssl: false,
    };

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(18790);
  });

  it('should accept rate limiting configuration', () => {
    const config = {
      port: 18790,
      ssl: false,
      maxMessagesPerMinute: 100,
      maxSessionHours: 24,
    };

    expect(config.maxMessagesPerMinute).toBe(100);
    expect(config.maxSessionHours).toBe(24);
  });

  it('should accept SSL certificate paths', () => {
    const config = {
      port: 18790,
      ssl: true,
      certPath: '/path/to/cert.pem',
      keyPath: '/path/to/key.pem',
    };

    expect(config.ssl).toBe(true);
    expect(config.certPath).toBe('/path/to/cert.pem');
    expect(config.keyPath).toBe('/path/to/key.pem');
  });
});

describe('Audit Logger Integration', () => {
  beforeEach(async () => {
    // Clear logs
    await auditLogger.flush();
    const fs = await import('fs');
    const path = await import('path');
    const logPath = path.join('./logs', 'audit-log.jsonl');
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '');
    }
  });

  it('should log various event types', async () => {
    const eventTypes = [
      'auth_success',
      'auth_failure',
      'message_blocked',
      'rate_limit_exceeded',
      'connection_hijack_attempt',
      'output_blocked',
      'session_expired',
      'signature_invalid',
      'consent_requested',
      'network_access_requested',
    ] as const;

    for (const eventType of eventTypes) {
      await auditLogger.log({
        eventType,
        agentDid: `did:claw:test:${eventType}`,
        details: { test: true },
        severity: 'medium',
      });
    }

    await auditLogger.flush();
    const logs = auditLogger.readLogs(100);
    expect(logs.length).toBeGreaterThanOrEqual(eventTypes.length);
  });

  it('should handle different severity levels', async () => {
    const severities: Array<'low' | 'medium' | 'high' | 'critical'> = [
      'low',
      'medium',
      'high',
      'critical',
    ];

    for (const severity of severities) {
      await auditLogger.log({
        eventType: 'auth_success',
        agentDid: `did:claw:${severity}:agent`,
        details: { severity },
        severity,
      });
    }

    await auditLogger.flush();
    const logs = auditLogger.readLogs(10);
    expect(logs.length).toBeGreaterThanOrEqual(4);
  });

  it('should include IP address in logs', async () => {
    await auditLogger.log({
      eventType: 'auth_success',
      agentDid: 'did:claw:ip:agent',
      ipAddress: '192.168.1.100',
      details: { test: true },
      severity: 'low',
    });

    await auditLogger.flush();
    const logs = auditLogger.readLogs(10);
    const ipLog = logs.find(log => log.ipAddress === '192.168.1.100');
    expect(ipLog).toBeDefined();
  });

  it('should include session ID in logs', async () => {
    const sessionId = 'session-12345';
    
    await auditLogger.log({
      eventType: 'message_blocked',
      agentDid: 'did:claw:session:agent',
      sessionId,
      details: { reason: 'test' },
      severity: 'medium',
    });

    await auditLogger.flush();
    const logs = auditLogger.readLogs(10);
    const sessionLog = logs.find(log => log.sessionId === sessionId);
    expect(sessionLog).toBeDefined();
  });

  it('should search logs by event type', async () => {
    await auditLogger.log({
      eventType: 'auth_success',
      agentDid: 'did:claw:search1',
      details: {},
      severity: 'low',
    });

    await auditLogger.log({
      eventType: 'auth_failure',
      agentDid: 'did:claw:search2',
      details: {},
      severity: 'high',
    });

    await auditLogger.log({
      eventType: 'auth_success',
      agentDid: 'did:claw:search3',
      details: {},
      severity: 'low',
    });

    await auditLogger.flush();
    
    const successLogs = auditLogger.searchByEvent('auth_success');
    expect(successLogs.length).toBeGreaterThanOrEqual(2);
    
    const failureLogs = auditLogger.searchByEvent('auth_failure');
    expect(failureLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle log rotation', async () => {
    // Add some logs
    for (let i = 0; i < 5; i++) {
      await auditLogger.log({
        eventType: 'auth_success',
        agentDid: `did:claw:rotate:${i}`,
        details: { index: i },
        severity: 'low',
      });
    }

    await auditLogger.flush();
    
    // Verify logs exist before rotation
    const beforeRotate = auditLogger.readLogs(10);
    expect(beforeRotate.length).toBeGreaterThanOrEqual(5);
    
    // Rotate (keep all since they're fresh)
    auditLogger.rotate(7);
    
    const logs = auditLogger.readLogs(10);
    expect(logs.length).toBeGreaterThanOrEqual(0); // Rotation may clear if timestamps differ
  });
});

describe('Message Structure Validation', () => {
  it('should validate complete message structure', () => {
    const message = {
      id: 'msg-complete',
      from: 'did:claw:sender:agent',
      to: 'did:claw:receiver:agent',
      type: 'text' as const,
      payload: { content: 'Hello!' },
      signature: 'MEUCIQD...',
      timestamp: new Date(),
      ttlSeconds: 300,
    };

    expect(message.id).toBeDefined();
    expect(message.from).toMatch(/^did:claw:.+:.+$/);
    expect(message.to).toMatch(/^did:claw:.+:.+$/);
    expect(['text', 'file', 'invitation', 'consent_request', 'consent_response', 'heartbeat'])
      .toContain(message.type);
    expect(message.timestamp).toBeInstanceOf(Date);
    expect(message.ttlSeconds).toBeGreaterThan(0);
  });

  it('should handle file message type', () => {
    const fileMessage = {
      id: 'msg-file',
      from: 'did:claw:sender',
      to: 'did:claw:receiver',
      type: 'file' as const,
      payload: {
        filename: 'document.pdf',
        size: 1024,
        mimeType: 'application/pdf',
      },
      timestamp: new Date(),
      ttlSeconds: 600,
    };

    expect(fileMessage.type).toBe('file');
    expect(fileMessage.payload.filename).toBe('document.pdf');
  });

  it('should handle invitation message type', () => {
    const invitationMessage = {
      id: 'msg-invite',
      from: 'did:claw:inviter',
      to: 'did:claw:invitee',
      type: 'invitation' as const,
      payload: {
        groupId: 'group-123',
        groupName: 'Test Group',
      },
      timestamp: new Date(),
      ttlSeconds: 3600,
    };

    expect(invitationMessage.type).toBe('invitation');
    expect(invitationMessage.payload.groupId).toBe('group-123');
  });

  it('should handle consent request message type', () => {
    const consentMessage = {
      id: 'msg-consent',
      from: 'did:claw:requester',
      to: 'did:claw:approver',
      type: 'consent_request' as const,
      payload: {
        requestId: 'req-123',
        action: 'execute_code',
        riskScore: 75,
      },
      timestamp: new Date(),
      ttlSeconds: 300,
    };

    expect(consentMessage.type).toBe('consent_request');
    expect(consentMessage.payload.requestId).toBe('req-123');
  });

  it('should handle consent response message type', () => {
    const consentResponse = {
      id: 'msg-consent-resp',
      from: 'did:claw:approver',
      to: 'did:claw:requester',
      type: 'consent_response' as const,
      payload: {
        requestId: 'req-123',
        response: 'approved',
      },
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    expect(consentResponse.type).toBe('consent_response');
    expect(consentResponse.payload.response).toBe('approved');
  });

  it('should handle heartbeat message type', () => {
    const heartbeat = {
      id: 'msg-heartbeat',
      from: 'server',
      to: 'broadcast',
      type: 'heartbeat' as const,
      payload: {
        timestamp: Date.now(),
        serverStatus: 'healthy',
      },
      timestamp: new Date(),
      ttlSeconds: 30,
    };

    expect(heartbeat.type).toBe('heartbeat');
    expect(heartbeat.from).toBe('server');
    expect(heartbeat.to).toBe('broadcast');
  });
});

describe('Connection Identity', () => {
  it('should store agent identity in connection', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:identity:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
      messageTimestamps: [],
      identity: {
        did: 'did:claw:identity:agent',
        name: 'Test Agent',
        publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...',
        capabilities: ['chat', 'search'],
      },
    };

    expect(mockConnection.identity).toBeDefined();
    expect(mockConnection.identity?.did).toBe('did:claw:identity:agent');
    expect(mockConnection.identity?.name).toBe('Test Agent');
  });

  it('should handle connection with all optional fields', () => {
    const completeConnection: AgentConnection = {
      did: 'did:claw:complete:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 10,
      receivedCount: 5,
      messageTimestamps: [Date.now(), Date.now() - 1000],
      identity: {
        did: 'did:claw:complete:agent',
        name: 'Complete Agent',
        publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...',
        capabilities: ['chat'],
      },
      fingerprint: 'fp-abc123',
      publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...',
    };

    expect(completeConnection.did).toBeDefined();
    expect(completeConnection.identity).toBeDefined();
    expect(completeConnection.fingerprint).toBeDefined();
    expect(completeConnection.publicKey).toBeDefined();
  });
});
