/**
 * P2P Manager Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { P2PManager } from '../src/server/p2p';

describe('P2PManager', () => {
  let p2p: P2PManager;

  beforeEach(() => {
    p2p = new P2PManager({ codeTTLMinutes: 5 });
  });

  describe('generateCode', () => {
    it('generates code in AF-XXXXXX format', () => {
      const code = p2p.generateCode();
      expect(code).toMatch(/^AF-[A-Z2-9]{6}$/);
    });

    it('generates unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(p2p.generateCode());
      }
      // 100 kodun en az 95'i unique olmalı
      expect(codes.size).toBeGreaterThan(95);
    });
  });

  describe('createInvitation', () => {
    it('creates invitation with correct fields', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      expect(invite.code).toMatch(/^AF-/);
      expect(invite.hostClientId).toBe('host-1');
      expect(invite.hostAgentName).toBe('HostAgent');
      expect(invite.status).toBe('waiting');
      expect(invite.guestClientId).toBeNull();
    });

    it('cancels previous waiting invitations from same host', () => {
      const invite1 = p2p.createInvitation('host-1', 'HostAgent');
      const invite2 = p2p.createInvitation('host-1', 'HostAgent');
      expect(invite2.code).not.toBe(invite1.code);
      const old = p2p.getInviteCode(invite1.code);
      expect(old).toBeUndefined(); // deleted after replacement
    });
  });

  describe('joinInvitation', () => {
    it('matches host and guest correctly', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      const match = p2p.joinInvitation(invite.code, 'guest-1', 'GuestAgent');

      expect(match.hostClientId).toBe('host-1');
      expect(match.guestClientId).toBe('guest-1');
      expect(match.hostAgentName).toBe('HostAgent');
      expect(match.guestAgentName).toBe('GuestAgent');
    });

    it('throws on invalid code', () => {
      expect(() => p2p.joinInvitation('AF-INVALID', 'guest-1', 'Agent')).toThrow('Geçersiz davet kodu');
    });

    it('throws on already used code', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      p2p.joinInvitation(invite.code, 'guest-1', 'GuestAgent');
      expect(() => p2p.joinInvitation(invite.code, 'guest-2', 'Agent2')).toThrow();
    });

    it('throws when joining own invitation', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      expect(() => p2p.joinInvitation(invite.code, 'host-1', 'HostAgent')).toThrow('Kendi davet kodunuza');
    });

    it('normalizes code to uppercase', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      const match = p2p.joinInvitation(invite.code.toLowerCase(), 'guest-1', 'GuestAgent');
      expect(match.hostClientId).toBe('host-1');
    });
  });

  describe('peer lookup', () => {
    it('returns peer ID correctly', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      p2p.joinInvitation(invite.code, 'guest-1', 'GuestAgent');

      expect(p2p.getPeerId('host-1')).toBe('guest-1');
      expect(p2p.getPeerId('guest-1')).toBe('host-1');
    });

    it('returns correct roles', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      p2p.joinInvitation(invite.code, 'guest-1', 'GuestAgent');

      expect(p2p.getRole('host-1')).toBe('host');
      expect(p2p.getRole('guest-1')).toBe('guest');
    });

    it('returns null for unmatched clients', () => {
      expect(p2p.getPeerId('unknown')).toBeUndefined();
      expect(p2p.getRole('unknown')).toBeNull();
    });
  });

  describe('disconnectClient', () => {
    it('cleans up both sides', () => {
      const invite = p2p.createInvitation('host-1', 'HostAgent');
      p2p.joinInvitation(invite.code, 'guest-1', 'GuestAgent');

      const match = p2p.disconnectClient('host-1');
      expect(match).toBeDefined();
      expect(match!.hostClientId).toBe('host-1');

      expect(p2p.getPeerId('host-1')).toBeUndefined();
      expect(p2p.getPeerId('guest-1')).toBeUndefined();
    });
  });

  describe('expireStale', () => {
    it('expires old invitations', () => {
      // Short TTL for testing
      const shortP2P = new P2PManager({ codeTTLMinutes: 0 }); // 0 = immediately expired
      shortP2P.createInvitation('host-1', 'Agent');
      const count = shortP2P.expireStale();
      expect(count).toBe(1);
    });
  });

  describe('stats', () => {
    it('returns correct counts', () => {
      p2p.createInvitation('host-1', 'Agent1');

      const stats1 = p2p.getStats();
      expect(stats1.activeInvites).toBe(1);
      expect(stats1.activeMatches).toBe(0);

      const invite = p2p.createInvitation('host-2', 'Agent2');
      p2p.joinInvitation(invite.code, 'guest-2', 'Agent3');

      const stats2 = p2p.getStats();
      expect(stats2.activeInvites).toBe(1); // host-1's invite still waiting
      expect(stats2.activeMatches).toBe(1);
    });
  });
});
