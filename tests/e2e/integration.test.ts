/**
 * E2E Integration Tests — Agent Federation
 * 
 * End-to-end tests for WebSocket server with Ali-MrClaw and Zeynep-Owl agents.
 * 
 * Test Scenarios:
 * 1. Connection + Authentication
 * 2. Peer-to-peer message sending
 * 3. Broadcast message
 * 4. Heartbeat mechanism
 * 5. Disconnect + Reconnect
 * 6. Server clean shutdown
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServerManager } from '../../src/server/ws-server';
import { WebSocket } from 'ws';
import { generateKeyPair, generateAgentDID, signAuthChallenge } from '../../src/identity/agent';

const TEST_PORT = 18999;
const TEST_HOST = 'localhost';

// Test agent identities with ECDSA key pairs
const ALI_MRCLAW_KEYS = generateKeyPair();
const ALI_MRCLAW = {
  did: generateAgentDID('ali', 'mrclaw'),
  name: 'MrClaw',
  emoji: '🦀',
  ownerName: 'Ali',
  ownerId: 'ali',
  capabilities: ['test'],
  publicKey: ALI_MRCLAW_KEYS.publicKey,
  privateKey: ALI_MRCLAW_KEYS.privateKey,
  createdAt: new Date(),
  lastSeen: new Date(),
};

const ZEYNEP_OWL_KEYS = generateKeyPair();
const ZEYNEP_OWL = {
  did: generateAgentDID('zeynep', 'owl'),
  name: 'Owl',
  emoji: '🦉',
  ownerName: 'Zeynep',
  ownerId: 'zeynep',
  capabilities: ['test'],
  publicKey: ZEYNEP_OWL_KEYS.publicKey,
  privateKey: ZEYNEP_OWL_KEYS.privateKey,
  createdAt: new Date(),
  lastSeen: new Date(),
};

describe('E2E Integration Tests - Agent Federation', () => {
  let server: WebSocketServerManager;

  beforeEach(async () => {
    server = new WebSocketServerManager({
      port: TEST_PORT,
      host: TEST_HOST,
      ssl: false,
    });
    await server.start();
  });

  afterEach(() => {
    server.stop();
  });

  /**
   * Helper: Wait for auth challenge and respond with ECDSA signature
   */
  function waitForAuthChallenge(ws: WebSocket, identity: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error('Auth timeout'));
      }, 5000);

      const handler = (data: any) => {
        try {
          const str = data.toString();
          const msg = JSON.parse(str);
          if (msg.type === 'auth_challenge') {
            const nonce = msg.nonce;
            // Sign the auth challenge with ECDSA
            const signature = signAuthChallenge(identity.did, nonce, identity.privateKey);
            
            ws.send(JSON.stringify({
              type: 'auth_response',
              did: identity.did,
              publicKey: identity.publicKey,
              signature: signature,
              identity,
            }));
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {
          // Ignore
        }
      };
      ws.on('message', handler);
    });
  }

  /**
   * Helper: Authenticate an agent (setup handler then connect)
   */
  async function authenticate(ws: WebSocket, identity: any): Promise<void> {
    // Message handler must be set BEFORE connection completes
    const authPromise = waitForAuthChallenge(ws, identity);
    return authPromise;
  }

  it('1. Connection + Authentication: Ali-MrClaw and Zeynep-Owl connect', async () => {
    const ws1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const ws2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);

    // Set up auth handlers BEFORE waiting for open
    const auth1 = authenticate(ws1, ALI_MRCLAW);
    const auth2 = authenticate(ws2, ZEYNEP_OWL);
    
    try {
      // Wait for connections to open
      await Promise.all([
        new Promise<void>(resolve => ws1.on('open', resolve)),
        new Promise<void>(resolve => ws2.on('open', resolve)),
      ]);

      // Wait for authentication to complete
      await Promise.all([auth1, auth2]);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(server.getConnectionByDid(ALI_MRCLAW.did)).toBeDefined();
      expect(server.getConnectionByDid(ZEYNEP_OWL.did)).toBeDefined();
      expect(server.getConnectionCount()).toBe(2);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('2. Peer-to-Peer: Ali-MrClaw sends message to Zeynep-Owl', async () => {
    const ws1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const ws2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);

    // Setup auth before connecting
    const auth1 = authenticate(ws1, ALI_MRCLAW);
    const auth2 = authenticate(ws2, ZEYNEP_OWL);

    try {
      await Promise.all([
        new Promise<void>(resolve => ws1.on('open', resolve)),
        new Promise<void>(resolve => ws2.on('open', resolve)),
      ]);

      await Promise.all([auth1, auth2]);
      await new Promise(resolve => setTimeout(resolve, 200));

      const message = {
        id: crypto.randomUUID(),
        from: ALI_MRCLAW.did,
        to: ZEYNEP_OWL.did,
        type: 'text' as const,
        payload: 'Hello Zeynep! - Ali',
        timestamp: new Date().toISOString(),
        ttlSeconds: 60,
      };

      let received: any = null;
      ws2.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === message.id) received = msg;
      });

      ws1.send(JSON.stringify(message));
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(received).toBeDefined();
      expect(received.from).toBe(ALI_MRCLAW.did);
      expect(received.payload).toBe('Hello Zeynep! - Ali');
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('3. Broadcast: Message sent to all agents', async () => {
    const ws1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const ws2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);

    const auth1 = authenticate(ws1, ALI_MRCLAW);
    const auth2 = authenticate(ws2, ZEYNEP_OWL);

    try {
      await Promise.all([
        new Promise<void>(resolve => ws1.on('open', resolve)),
        new Promise<void>(resolve => ws2.on('open', resolve)),
      ]);

      await Promise.all([auth1, auth2]);
      await new Promise(resolve => setTimeout(resolve, 200));

      const broadcast = {
        id: crypto.randomUUID(),
        from: ALI_MRCLAW.did,
        to: 'broadcast',
        type: 'text' as const,
        payload: 'Hello everyone!',
        timestamp: new Date().toISOString(),
        ttlSeconds: 60,
      };

      let receivedByZeynep: any = null;
      ws2.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === broadcast.id) receivedByZeynep = msg;
      });

      ws1.send(JSON.stringify(broadcast));
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(receivedByZeynep).toBeDefined();
      expect(receivedByZeynep.payload).toBe('Hello everyone!');
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it('4. Heartbeat: Server has heartbeat mechanism', async () => {
    const ws = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const auth = authenticate(ws, ALI_MRCLAW);

    try {
      await new Promise<void>(resolve => ws.on('open', resolve));
      await auth;
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(server.getConnectionByDid(ALI_MRCLAW.did)).toBeDefined();
      
      const stats = server.getStats();
      expect(stats.uptime).toBeGreaterThan(0);
      
      // Verify heartbeat method exists
      expect(typeof (server as any).sendHeartbeat).toBe('function');
    } finally {
      ws.close();
    }
  });

  it('5. Disconnect + Reconnect: Graceful handling', async () => {
    const ws1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const auth1 = authenticate(ws1, ALI_MRCLAW);

    try {
      await new Promise<void>(resolve => ws1.on('open', resolve));
      await auth1;
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify connected
      expect(server.getConnectionByDid(ALI_MRCLAW.did)).toBeDefined();
      const firstConnect = server.getConnectionByDid(ALI_MRCLAW.did)!.connectedAt.getTime();

      // Disconnect
      ws1.close(1000, 'Test');
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify disconnected
      expect(server.getConnectionByDid(ALI_MRCLAW.did)).toBeUndefined();

      // Reconnect
      const ws2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
      const auth2 = authenticate(ws2, ALI_MRCLAW);
      try {
        await new Promise<void>(resolve => ws2.on('open', resolve));
        await auth2;
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(server.getConnectionByDid(ALI_MRCLAW.did)).toBeDefined();
        expect(server.getConnectionByDid(ALI_MRCLAW.did)!.connectedAt.getTime())
          .toBeGreaterThanOrEqual(firstConnect);
      } finally {
        ws2.close();
      }
    } finally {
      if (ws1.readyState === WebSocket.OPEN) ws1.close();
    }
  });

  it('6. Server Clean Shutdown: All connections closed', async () => {
    const ws1 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);
    const ws2 = new WebSocket(`ws://${TEST_HOST}:${TEST_PORT}`);

    const auth1 = authenticate(ws1, ALI_MRCLAW);
    const auth2 = authenticate(ws2, ZEYNEP_OWL);

    try {
      await Promise.all([
        new Promise<void>(resolve => ws1.on('open', resolve)),
        new Promise<void>(resolve => ws2.on('open', resolve)),
      ]);

      await Promise.all([auth1, auth2]);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(server.getConnectionCount()).toBe(2);

      // Stop server
      server.stop();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify shutdown
      expect(server.getStats().totalConnections).toBe(0);
      expect(ws1.readyState).toBe(WebSocket.CLOSED);
      expect(ws2.readyState).toBe(WebSocket.CLOSED);
    } catch (error) {
      ws1.close();
      ws2.close();
      throw error;
    }
  });
});
