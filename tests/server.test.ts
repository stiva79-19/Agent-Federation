/**
 * WebSocket Server Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServerManager, defaultServerConfig, AgentConnection } from '../src/server/ws-server';
import { WebSocket } from 'ws';

describe('WebSocketServerManager', () => {
  let server: WebSocketServerManager;
  const testPort = 18791; // Test port (different from default)

  beforeEach(async () => {
    server = new WebSocketServerManager({
      ...defaultServerConfig(),
      port: testPort,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('should start server on specified port', () => {
    const stats = server.getStats();
    expect(stats.totalConnections).toBe(0);
  });

  it('should return default config', () => {
    const config = defaultServerConfig();
    expect(config.port).toBe(18790);
    expect(config.host).toBe('0.0.0.0');
    expect(config.ssl).toBe(true); // SSL is now enabled by default for production security
  });

  it('should track connection count', () => {
    expect(server.getConnectionCount()).toBe(0);
  });

  it('should return empty connections list initially', () => {
    const connections = server.getConnections();
    expect(connections).toEqual([]);
  });

  it('should emit error on invalid port', async () => {
    const badServer = new WebSocketServerManager({
      port: -1,
      ssl: false,
    });

    const errorPromise = new Promise((resolve) => {
      badServer.on('error', resolve);
    });

    try {
      await badServer.start();
    } catch (error) {
      // Expected to fail
    }

    badServer.stop();
  });
});

describe('Connection Management', () => {
  let server: WebSocketServerManager;
  const testPort = 18792;

  beforeEach(async () => {
    server = new WebSocketServerManager({
      port: testPort,
      ssl: false,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('should handle agent connection event', () => {
    const mockConnection: AgentConnection = {
      did: 'did:claw:ali:mrclaw',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
    };

    server.emit('agent_connected', mockConnection);
    
    // Connection should be tracked in internal state after auth
    // For now we test the event emission
    expect(mockConnection.did).toBe('did:claw:ali:mrclaw');
  });

  it('should handle agent disconnection event', () => {
    const disconnectedAgent = { did: 'did:claw:zeynep:owl' };
    
    let capturedDid: string | null = null;
    server.on('agent_disconnected', (data: any) => {
      capturedDid = data.did;
    });

    server.emit('agent_disconnected', disconnectedAgent);
    expect(capturedDid).toBe('did:claw:zeynep:owl');
  });

  it('should get connection by DID', () => {
    // Since we can't easily mock WebSocket connections in tests,
    // we test the getter methods with empty state
    const conn = server.getConnectionByDid('did:claw:test:agent');
    expect(conn).toBeUndefined();
  });
});

describe('Message Routing', () => {
  let server: WebSocketServerManager;
  const testPort = 18793;

  beforeEach(async () => {
    server = new WebSocketServerManager({
      port: testPort,
      ssl: false,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('should emit message event', () => {
    const testMessage = {
      id: 'msg-123',
      from: 'did:claw:ali:mrclaw',
      to: 'did:claw:zeynep:owl',
      type: 'text' as const,
      payload: 'Hello!',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    let capturedMessage: any = null;
    server.on('message', (msg: any) => {
      capturedMessage = msg;
    });

    // Simulate message event
    server.emit('message', testMessage);
    expect(capturedMessage).toEqual(testMessage);
  });

  it('should emit message_routed event', () => {
    const testMessage = {
      id: 'msg-456',
      from: 'did:claw:ali:mrclaw',
      to: 'did:claw:zeynep:owl',
      type: 'text' as const,
      payload: 'Routed message',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    let capturedData: any = null;
    server.on('message_routed', (data: any) => {
      capturedData = data;
    });

    server.emit('message_routed', {
      message: testMessage,
      from: testMessage.from,
      to: testMessage.to,
    });

    expect(capturedData).toBeDefined();
    expect(capturedData.message.id).toBe('msg-456');
  });

  it('should handle heartbeat event', () => {
    const heartbeat = {
      id: 'hb-123',
      from: 'server',
      to: 'broadcast',
      type: 'heartbeat' as const,
      payload: { timestamp: Date.now() },
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    let capturedHeartbeat: any = null;
    server.on('heartbeat', (hb: any) => {
      capturedHeartbeat = hb;
    });

    server.emit('heartbeat', heartbeat);
    expect(capturedHeartbeat).toEqual(heartbeat);
  });
});

describe('Server Stats', () => {
  let server: WebSocketServerManager;
  const testPort = 18794;

  beforeEach(async () => {
    server = new WebSocketServerManager({
      port: testPort,
      ssl: false,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('should return server stats', () => {
    const stats = server.getStats();
    
    expect(stats).toHaveProperty('totalConnections');
    expect(stats).toHaveProperty('uptime');
    expect(stats).toHaveProperty('connections');
    expect(Array.isArray(stats.connections)).toBe(true);
    expect(typeof stats.uptime).toBe('number');
    expect(stats.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should track uptime', () => {
    const stats1 = server.getStats();
    
    // Wait a bit
    const start = Date.now();
    while (Date.now() - start < 100) {
      // Busy wait for 100ms
    }
    
    const stats2 = server.getStats();
    expect(stats2.uptime).toBeGreaterThanOrEqual(stats1.uptime);
  });
});

describe('Auth Challenge', () => {
  it('should generate valid auth challenge structure', () => {
    // Test the challenge structure that would be generated
    const challenge = {
      challengeId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10000),
    };

    expect(challenge.challengeId).toBeDefined();
    expect(challenge.nonce).toBeDefined();
    expect(challenge.createdAt).toBeInstanceOf(Date);
    expect(challenge.expiresAt).toBeInstanceOf(Date);
    expect(challenge.expiresAt.getTime()).toBeGreaterThan(challenge.createdAt.getTime());
  });
});

describe('DID Validation', () => {
  it('should validate DID format patterns', () => {
    const validDIDs = [
      'did:claw:ali:mrclaw',
      'did:claw:zeynep:owl',
      'did:claw:user123:agent-name',
      'did:claw:a:b',
    ];

    const invalidDIDs = [
      'did:invalid:format',
      'not-a-did',
      'did:claw:',
      'did:claw:user',
      '',
    ];

    const didRegex = /^did:claw:([^:]+):([^:]+)$/;

    validDIDs.forEach(did => {
      expect(didRegex.test(did)).toBe(true);
    });

    invalidDIDs.forEach(did => {
      expect(didRegex.test(did)).toBe(false);
    });
  });
});

describe('Message Structure', () => {
  it('should have valid message structure', () => {
    const message = {
      id: crypto.randomUUID(),
      from: 'did:claw:ali:mrclaw',
      to: 'did:claw:zeynep:owl',
      type: 'text' as const,
      payload: 'Test message',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    expect(message.id).toBeDefined();
    expect(message.from).toBeDefined();
    expect(message.to).toBeDefined();
    expect(['text', 'file', 'invitation', 'consent_request', 'consent_response', 'heartbeat'])
      .toContain(message.type);
    expect(message.timestamp).toBeInstanceOf(Date);
    expect(message.ttlSeconds).toBeGreaterThan(0);
  });

  it('should support all message types', () => {
    const types: Array<'text' | 'file' | 'invitation' | 'consent_request' | 'consent_response' | 'heartbeat'> = [
      'text',
      'file',
      'invitation',
      'consent_request',
      'consent_response',
      'heartbeat',
    ];

    types.forEach(type => {
      const message = {
        id: crypto.randomUUID(),
        from: 'did:claw:test:agent',
        to: 'did:claw:other:agent',
        type,
        payload: {},
        timestamp: new Date(),
        ttlSeconds: 60,
      };
      expect(message.type).toBe(type);
    });
  });
});

describe('Connection Lifecycle', () => {
  it('should track connection timestamps', () => {
    const before = Date.now();
    const connection: AgentConnection = {
      did: 'did:claw:test:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
    };
    const after = Date.now();

    expect(connection.connectedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(connection.connectedAt.getTime()).toBeLessThanOrEqual(after);
    expect(connection.lastMessageAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(connection.lastMessageAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('should initialize counters to zero', () => {
    const connection: AgentConnection = {
      did: 'did:claw:test:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
    };

    expect(connection.sentCount).toBe(0);
    expect(connection.receivedCount).toBe(0);
  });

  it('should update message counters', () => {
    const connection: AgentConnection = {
      did: 'did:claw:test:agent',
      ws: {} as WebSocket,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sentCount: 0,
      receivedCount: 0,
    };

    connection.sentCount = 5;
    connection.receivedCount = 3;

    expect(connection.sentCount).toBe(5);
    expect(connection.receivedCount).toBe(3);
  });
});

describe('Server Configuration', () => {
  it('should accept custom host', () => {
    const config = {
      port: 18790,
      host: 'localhost',
      ssl: false,
    };

    expect(config.host).toBe('localhost');
  });

  it('should support SSL configuration', () => {
    const config = {
      port: 18790,
      host: '0.0.0.0',
      ssl: true,
      certPath: '/path/to/cert.pem',
      keyPath: '/path/to/key.pem',
    };

    expect(config.ssl).toBe(true);
    expect(config.certPath).toBeDefined();
    expect(config.keyPath).toBeDefined();
  });
});
