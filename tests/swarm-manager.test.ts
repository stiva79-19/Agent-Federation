/**
 * SwarmManager Tests — Agent Federation
 *
 * Session oluşturma/katılma, key validasyonu, max peer limiti, config testleri.
 * Not: Gerçek Hyperswarm bağlantı testleri DHT gerektirir ve ayrı integration
 * test'lerinde yapılır. Burada unit testler ve mock-free logic testleri var.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SwarmManager, defaultSwarmConfig } from '../src/swarm/swarm-manager';
import type { SwarmConfig } from '../src/swarm/swarm-manager';
import { createSwarmMessage } from '../src/swarm/protocol';

describe('SwarmManager', () => {
  let manager: SwarmManager;
  const testConfig: Partial<SwarmConfig> = {
    agentName: 'TestAgent',
    agentDid: 'did:claw:test',
    maxPeers: 7,
  };

  beforeEach(() => {
    manager = new SwarmManager(testConfig);
  });

  afterEach(async () => {
    await manager.destroy();
  }, 30_000); // Hyperswarm destroy can be slow when DHT topics are joined

  // ─── Default Config ─────────────────────────────────────────────

  describe('defaultSwarmConfig', () => {
    it('should return sensible defaults', () => {
      const config = defaultSwarmConfig();
      expect(config.agentName).toBeDefined();
      expect(config.agentDid).toBeDefined();
      expect(config.maxPeers).toBe(7);
    });
  });

  // ─── Getters ────────────────────────────────────────────────────

  describe('getters', () => {
    it('should return agent name and DID from config', () => {
      expect(manager.agentName).toBe('TestAgent');
      expect(manager.agentDid).toBe('did:claw:test');
    });

    it('should return maxPeers from config', () => {
      expect(manager.maxPeers).toBe(7);
    });

    it('should report no session initially', () => {
      expect(manager.hasSession).toBe(false);
      expect(manager.sessionKey).toBeNull();
      expect(manager.peerCount).toBe(0);
    });

    it('should return empty peer list when no session', () => {
      expect(manager.getPeers()).toEqual([]);
    });

    it('should return null session info when no session', () => {
      const info = manager.getSessionInfo();
      expect(info.sessionKey).toBeNull();
      expect(info.peerCount).toBe(0);
      expect(info.peers).toEqual([]);
      expect(info.createdAt).toBeNull();
    });
  });

  // ─── Session Creation ───────────────────────────────────────────

  describe('createSession', () => {
    it('should create a session with a valid hex key', () => {
      const { sessionKey } = manager.createSession();

      expect(sessionKey).toBeDefined();
      expect(sessionKey).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(/^[0-9a-f]{64}$/.test(sessionKey)).toBe(true);
    });

    it('should mark session as active', () => {
      manager.createSession();
      expect(manager.hasSession).toBe(true);
    });

    it('should set sessionKey', () => {
      const { sessionKey } = manager.createSession();
      expect(manager.sessionKey).toBe(sessionKey);
    });

    it('should set peerCount to 0 (no peers yet)', () => {
      manager.createSession();
      expect(manager.peerCount).toBe(0);
    });

    it('should return session info with createdAt', () => {
      manager.createSession();
      const info = manager.getSessionInfo();
      expect(info.createdAt).toBeDefined();
      expect(info.sessionKey).toBeDefined();
    });

    it('should throw if already in a session', () => {
      manager.createSession();
      expect(() => manager.createSession()).toThrow('Already in a session');
    });

    it('should emit session_created event', () => {
      let emittedKey: string | null = null;
      manager.on('session_created', (key: string) => { emittedKey = key; });

      const { sessionKey } = manager.createSession();
      expect(emittedKey).toBe(sessionKey);
    });
  });

  // ─── Session Join ───────────────────────────────────────────────

  describe('joinSession', () => {
    it('should join with a valid 64-char hex key', () => {
      const key = 'a'.repeat(64);
      manager.joinSession(key);

      expect(manager.hasSession).toBe(true);
      expect(manager.sessionKey).toBe(key);
    });

    it('should throw on invalid key format (too short)', () => {
      expect(() => manager.joinSession('abc')).toThrow('Invalid session key');
    });

    it('should throw on invalid key format (non-hex)', () => {
      expect(() => manager.joinSession('g'.repeat(64))).toThrow('Invalid session key');
    });

    it('should throw on empty key', () => {
      expect(() => manager.joinSession('')).toThrow('Invalid session key');
    });

    it('should throw if already in a session', () => {
      manager.createSession();
      expect(() => manager.joinSession('b'.repeat(64))).toThrow('Already in a session');
    });

    it('should emit session_joined event', () => {
      let emittedKey: string | null = null;
      manager.on('session_joined', (key: string) => { emittedKey = key; });

      const key = 'c'.repeat(64);
      manager.joinSession(key);
      expect(emittedKey).toBe(key);
    });
  });

  // ─── Leave Session ──────────────────────────────────────────────

  describe('leaveSession', () => {
    it('should clear session state', () => {
      manager.createSession();
      expect(manager.hasSession).toBe(true);

      manager.leaveSession();
      expect(manager.hasSession).toBe(false);
      expect(manager.sessionKey).toBeNull();
      expect(manager.peerCount).toBe(0);
    });

    it('should emit session_closed event', () => {
      manager.createSession();
      let closed = false;
      manager.on('session_closed', () => { closed = true; });

      manager.leaveSession();
      expect(closed).toBe(true);
    });

    it('should be safe to call without a session', () => {
      expect(() => manager.leaveSession()).not.toThrow();
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────

  describe('destroy', () => {
    it('should clean up session on destroy', async () => {
      manager.createSession();
      await manager.destroy();
      expect(manager.hasSession).toBe(false);
    });

    it('should be safe to call twice', async () => {
      await manager.destroy();
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });

  // ─── Broadcast / SendToPeer without peers ──────────────────────

  describe('broadcast without peers', () => {
    it('should not throw when broadcasting without session', () => {
      const msg = createSwarmMessage('agent_message', { agentName: 'Test', agentDid: 'did:test' }, {});
      expect(() => manager.broadcast(msg)).not.toThrow();
    });

    it('should not throw when broadcasting with session but no peers', () => {
      manager.createSession();
      const msg = createSwarmMessage('agent_message', { agentName: 'Test', agentDid: 'did:test' }, {});
      expect(() => manager.broadcast(msg)).not.toThrow();
    });
  });

  describe('sendToPeer without peers', () => {
    it('should not throw when sending to nonexistent peer', () => {
      manager.createSession();
      const msg = createSwarmMessage('agent_message', { agentName: 'Test', agentDid: 'did:test' }, {});
      expect(() => manager.sendToPeer('nonexistent', msg)).not.toThrow();
    });
  });

  // ─── Custom maxPeers ───────────────────────────────────────────

  describe('custom maxPeers', () => {
    it('should respect maxPeers from config', async () => {
      const custom = new SwarmManager({ ...testConfig, maxPeers: 3 });
      expect(custom.maxPeers).toBe(3);
      await custom.destroy();
    });
  });
});
