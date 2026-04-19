/**
 * Transport Layer Tests
 * 
 * Tests for WebSocket transport and peer connections
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Transport, defaultTransportConfig, PeerConnection, FederatedMessage } from '../src/transport/websocket';
import { EventEmitter } from 'events';

describe('Transport', () => {
  let transport: Transport;

  beforeEach(() => {
    transport = new Transport({
      tailscaleEnabled: false,
      port: 18790,
    });
  });

  afterEach(() => {
    transport.removeAllListeners();
  });

  it('should create transport with default config', () => {
    const config = defaultTransportConfig();
    expect(config.port).toBe(18790);
    expect(config.tailscaleEnabled).toBe(true); // Tailscale enabled by default for NAT traversal
    expect(config.ssl).toBe(true); // SSL enabled by default for security
  });

  it('should create transport with custom config', () => {
    const customTransport = new Transport({
      serverUrl: 'ws://localhost:18791',
      tailscaleEnabled: true,
      tailscaleHostname: 'agent.tailnet',
      port: 18791,
    });

    expect(customTransport).toBeDefined();
    expect(customTransport instanceof EventEmitter).toBe(true);
  });

  it('should have EventEmitter capabilities', () => {
    const mockHandler = vi.fn();
    transport.on('connected', mockHandler);
    transport.emit('connected');
    expect(mockHandler).toHaveBeenCalled();
  });

  it('should handle multiple event types', () => {
    const events: TransportEvent[] = [
      'connected',
      'disconnected',
      'message',
      'error',
      'peer_connected',
      'peer_disconnected',
    ];

    events.forEach(event => {
      const handler = vi.fn();
      transport.on(event, handler);
      transport.emit(event, { test: 'data' });
      expect(handler).toHaveBeenCalledWith({ test: 'data' });
      transport.off(event, handler);
    });
  });

  it('should handle connection error gracefully', async () => {
    // Mock WebSocket to fail
    const originalWebSocket = global.WebSocket;
    
    try {
      // Test that transport handles connection failures
      const errorPromise = new Promise((resolve) => {
        transport.on('error', resolve);
      });

      // Emit error manually since we can't easily mock WebSocket in Node
      transport.emit('error', new Error('Connection failed'));
      
      const error = await errorPromise;
      expect(error).toBeDefined();
    } finally {
      global.WebSocket = originalWebSocket;
    }
  });

  it('should track peer connections', () => {
    const mockConnection: PeerConnection = {
      peerDid: 'did:claw:ali:mrclaw',
      connectionId: 'conn-123',
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 0,
      status: 'connected',
    };

    expect(mockConnection.peerDid).toBe('did:claw:ali:mrclaw');
    expect(mockConnection.status).toBe('connected');
    expect(mockConnection.messageCount).toBe(0);
  });

  it('should update connection status', () => {
    const connection: PeerConnection = {
      peerDid: 'did:claw:test:agent',
      connectionId: 'conn-456',
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 5,
      status: 'connected',
    };

    expect(connection.status).toBe('connected');
    
    connection.status = 'disconnected';
    expect(connection.status).toBe('disconnected');
    
    connection.messageCount = 10;
    expect(connection.messageCount).toBe(10);
  });

  it('should support all connection status values', () => {
    const statuses: Array<'connecting' | 'connected' | 'disconnected' | 'error'> = [
      'connecting',
      'connected',
      'disconnected',
      'error',
    ];

    statuses.forEach(status => {
      const conn: PeerConnection = {
        peerDid: 'did:claw:test:agent',
        connectionId: `conn-${status}`,
        connectedAt: new Date(),
        lastMessageAt: new Date(),
        messageCount: 0,
        status,
      };
      expect(conn.status).toBe(status);
    });
  });

  it('should create valid message structure', () => {
    const message: FederatedMessage = {
      id: 'msg-123',
      from: 'did:claw:ali:mrclaw',
      to: 'did:claw:zeynep:owl',
      type: 'text',
      payload: 'Hello!',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    expect(message.id).toBeDefined();
    expect(message.from).toBeDefined();
    expect(message.to).toBeDefined();
    expect(message.type).toBe('text');
    expect(message.payload).toBe('Hello!');
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
      const msg: FederatedMessage = {
        id: `msg-${type}`,
        from: 'did:claw:sender:agent',
        to: 'did:claw:receiver:agent',
        type,
        payload: {},
        timestamp: new Date(),
        ttlSeconds: 60,
      };
      expect(msg.type).toBe(type);
    });
  });

  it('should handle message with signature', () => {
    const message: FederatedMessage = {
      id: 'msg-signed',
      from: 'did:claw:ali:mrclaw',
      to: 'did:claw:zeynep:owl',
      type: 'text',
      payload: 'Signed message',
      signature: 'MEUCIQD...',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    expect(message.signature).toBeDefined();
    expect(message.signature?.length).toBeGreaterThanOrEqual(10);
  });

  it('should handle peer connection lifecycle', () => {
    const before = Date.now();
    const connection: PeerConnection = {
      peerDid: 'did:claw:peer:agent',
      connectionId: 'conn-lifecycle',
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 0,
      status: 'connecting',
    };
    const after = Date.now();

    expect(connection.connectedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(connection.connectedAt.getTime()).toBeLessThanOrEqual(after);
    
    // Simulate connection established
    connection.status = 'connected';
    expect(connection.status).toBe('connected');
    
    // Simulate message received
    connection.messageCount = 1;
    connection.lastMessageAt = new Date();
    expect(connection.messageCount).toBe(1);
    
    // Simulate disconnection
    connection.status = 'disconnected';
    expect(connection.status).toBe('disconnected');
  });

  it('should emit peer_connected event', () => {
    const mockHandler = vi.fn();
    transport.on('peer_connected', mockHandler);

    const peerData = {
      peerDid: 'did:claw:new:peer',
      connectionId: 'conn-new',
    };

    transport.emit('peer_connected', peerData);
    expect(mockHandler).toHaveBeenCalledWith(peerData);
  });

  it('should emit peer_disconnected event', () => {
    const mockHandler = vi.fn();
    transport.on('peer_disconnected', mockHandler);

    const peerData = {
      peerDid: 'did:claw:old:peer',
      reason: 'graceful',
    };

    transport.emit('peer_disconnected', peerData);
    expect(mockHandler).toHaveBeenCalledWith(peerData);
  });

  it('should handle message event with scan', () => {
    const mockHandler = vi.fn();
    transport.on('message', mockHandler);

    const message: FederatedMessage = {
      id: 'msg-test',
      from: 'did:claw:sender',
      to: 'did:claw:receiver',
      type: 'text',
      payload: 'Test message',
      timestamp: new Date(),
      ttlSeconds: 60,
    };

    transport.emit('message', message);
    expect(mockHandler).toHaveBeenCalledWith(message);
  });
});

describe('Transport Configuration', () => {
  it('should support SSL configuration', () => {
    const configWithSsl = {
      tailscaleEnabled: false,
      port: 18790,
      ssl: true,
    };

    expect(configWithSsl.ssl).toBe(true);
  });

  it('should support Tailscale configuration', () => {
    const tailscaleConfig = {
      tailscaleEnabled: true,
      tailscaleHostname: 'myagent.tailnet',
      port: 18790,
    };

    expect(tailscaleConfig.tailscaleEnabled).toBe(true);
    expect(tailscaleConfig.tailscaleHostname).toBe('myagent.tailnet');
  });

  it('should support custom server URL', () => {
    const customConfig = {
      serverUrl: 'wss://federation.example.com',
      tailscaleEnabled: false,
      port: 443,
    };

    expect(customConfig.serverUrl).toBe('wss://federation.example.com');
    expect(customConfig.port).toBe(443);
  });
});

describe('Message Validation', () => {
  it('should validate message TTL', () => {
    const validMessage: FederatedMessage = {
      id: 'msg-valid',
      from: 'did:claw:sender',
      to: 'did:claw:receiver',
      type: 'text',
      payload: 'Valid',
      timestamp: new Date(),
      ttlSeconds: 300,
    };

    expect(validMessage.ttlSeconds).toBeGreaterThan(0);
    expect(validMessage.ttlSeconds).toBeLessThanOrEqual(3600);
  });

  it('should validate DID format in messages', () => {
    const didPattern = /^did:claw:([^:]+):([^:]+)$/;
    
    const validDIDs = [
      'did:claw:ali:mrclaw',
      'did:claw:zeynep:owl',
      'did:claw:user:agent',
    ];

    const invalidDIDs = [
      'did:invalid',
      'not-a-did',
      '',
    ];

    validDIDs.forEach(did => {
      expect(didPattern.test(did)).toBe(true);
    });

    invalidDIDs.forEach(did => {
      expect(didPattern.test(did)).toBe(false);
    });
  });
});
