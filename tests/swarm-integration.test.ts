/**
 * Swarm Integration Tests — Agent Federation
 *
 * İki gerçek SwarmManager'ı aynı topic'e bağlayıp handshake + mesaj alışverişi testi.
 *
 * NOT: Bu testler gerçek Hyperswarm DHT kullanır (UDP + bootstrap nodes).
 * - Lokal geliştirmede network olan makinede çalışır.
 * - CI / sandbox ortamlarında UDP kısıtlıysa skip edilir.
 * - Çalıştırmak için: SWARM_INTEGRATION=1 npx vitest run tests/swarm-integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SwarmManager } from '../src/swarm/swarm-manager';
import type { PeerConnection } from '../src/swarm/swarm-manager';
import type { SwarmMessage } from '../src/swarm/protocol';

// DHT'nin bootstrap olması birkaç saniye sürebilir
const DHT_TIMEOUT = 60_000;

/**
 * Helper: peer_connected event'i bekler.
 */
function waitForPeer(manager: SwarmManager, timeoutMs = DHT_TIMEOUT): Promise<PeerConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitForPeer timeout after ${timeoutMs}ms`)), timeoutMs);
    manager.once('peer_connected', (peer: PeerConnection) => {
      clearTimeout(timer);
      resolve(peer);
    });
  });
}

/**
 * Helper: belirli tipte mesaj bekler.
 */
function waitForMessage(manager: SwarmManager, type: string, timeoutMs = DHT_TIMEOUT): Promise<SwarmMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitForMessage(${type}) timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (_peerId: string, msg: SwarmMessage) => {
      if (msg.type === type) {
        clearTimeout(timer);
        manager.off('message', handler);
        resolve(msg);
      }
    };
    manager.on('message', handler);
  });
}

// Integration testleri varsayılan olarak skip — gerçek DHT bootstrap gerektirir.
// Çalıştırmak için: SWARM_INTEGRATION=1 npx vitest run tests/swarm-integration.test.ts
const runIntegration = process.env['SWARM_INTEGRATION'] === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('Swarm Integration (real DHT)', () => {
  let host: SwarmManager;
  let guest: SwarmManager;

  beforeEach(() => {
    host = new SwarmManager({ agentName: 'Host', agentDid: 'did:claw:host', maxPeers: 7 });
    guest = new SwarmManager({ agentName: 'Guest', agentDid: 'did:claw:guest', maxPeers: 7 });
  });

  afterEach(async () => {
    await Promise.all([host.destroy(), guest.destroy()]);
  }, 30_000);

  it(
    'two peers should discover each other via DHT and complete handshake',
    async () => {
      const { sessionKey } = host.createSession();

      // Paralel: host peer bekler, guest join yapar
      const hostPeerPromise = waitForPeer(host);
      const guestPeerPromise = waitForPeer(guest);

      guest.joinSession(sessionKey);

      const [hostPeer, guestPeer] = await Promise.all([hostPeerPromise, guestPeerPromise]);

      // Her iki taraf da karşı agent bilgilerini almış olmalı
      expect(hostPeer.agentName).toBe('Guest');
      expect(hostPeer.agentDid).toBe('did:claw:guest');
      expect(hostPeer.handshakeComplete).toBe(true);

      expect(guestPeer.agentName).toBe('Host');
      expect(guestPeer.agentDid).toBe('did:claw:host');
      expect(guestPeer.handshakeComplete).toBe(true);

      // Her iki manager da 1 peer saymalı
      expect(host.peerCount).toBe(1);
      expect(guest.peerCount).toBe(1);
    },
    DHT_TIMEOUT + 10_000,
  );

  it(
    'peers should exchange agent_message payloads',
    async () => {
      const { sessionKey } = host.createSession();

      const hostPeerPromise = waitForPeer(host);
      const guestPeerPromise = waitForPeer(guest);
      guest.joinSession(sessionKey);

      await Promise.all([hostPeerPromise, guestPeerPromise]);

      // Guest'te agent_message beklerken host broadcast eder
      const guestMsgPromise = waitForMessage(guest, 'agent_message');

      host.broadcastPayload('agent_message', {
        content: 'Merhaba dünya',
        role: 'host',
        turn: 1,
        maxTurns: 20,
      });

      const received = await guestMsgPromise;
      expect(received.type).toBe('agent_message');
      expect(received.from.agentName).toBe('Host');
      const payload = received.payload as { content: string; role: string };
      expect(payload.content).toBe('Merhaba dünya');
      expect(payload.role).toBe('host');
    },
    DHT_TIMEOUT + 10_000,
  );

  it(
    'sendToPeer should deliver only to target peer',
    async () => {
      const { sessionKey } = host.createSession();

      let hostTargetPeerId = '';
      host.once('peer_connected', (peer) => {
        // Capture peer id from session (we need the map key)
        const peers = host.getPeers();
        if (peers.length > 0) hostTargetPeerId = peers[0].peerId;
        void peer; // suppress unused
      });

      const hostPeerPromise = waitForPeer(host);
      const guestPeerPromise = waitForPeer(guest);
      guest.joinSession(sessionKey);
      await Promise.all([hostPeerPromise, guestPeerPromise]);

      // Guest'te mesaj bekler
      const guestMsgPromise = waitForMessage(guest, 'agent_message');

      // peer_connected callback'i peerId'i set etmiş olmalı; yoksa getPeers()'dan çek
      if (!hostTargetPeerId) {
        const peers = host.getPeers();
        hostTargetPeerId = peers[0]?.peerId || '';
      }

      expect(hostTargetPeerId).toBeTruthy();

      // sendToPeer ile mesaj yolla
      const { createSwarmMessage } = await import('../src/swarm/protocol');
      const msg = createSwarmMessage(
        'agent_message',
        { agentName: 'Host', agentDid: 'did:claw:host' },
        { content: 'directed message', role: 'host' },
      );
      host.sendToPeer(hostTargetPeerId, msg);

      const received = await guestMsgPromise;
      const payload = received.payload as { content: string };
      expect(payload.content).toBe('directed message');
    },
    DHT_TIMEOUT + 10_000,
  );

  it(
    'leaveSession should disconnect peers',
    async () => {
      const { sessionKey } = host.createSession();
      const hostPeerPromise = waitForPeer(host);
      const guestPeerPromise = waitForPeer(guest);
      guest.joinSession(sessionKey);
      await Promise.all([hostPeerPromise, guestPeerPromise]);

      expect(host.peerCount).toBe(1);
      expect(guest.peerCount).toBe(1);

      // Guest disconnect bekler
      const guestDisconnectPromise = new Promise<void>((resolve) => {
        guest.once('peer_disconnected', () => resolve());
      });

      host.leaveSession();
      expect(host.hasSession).toBe(false);

      // Guest tarafta da peer disconnect olmalı (socket kapanacak)
      await guestDisconnectPromise;
      expect(guest.peerCount).toBe(0);
    },
    DHT_TIMEOUT + 10_000,
  );
});
