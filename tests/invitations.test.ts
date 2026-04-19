/**
 * Invitation Flow Tests — Agent Federation
 *
 * Davetiye sistemi, session lifecycle, notification testleri.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InvitationManager } from '../src/server/invitations';
import type { Invitation, CreateInvitationParams } from '../src/server/invitations';
import { SessionManager } from '../src/server/sessions';
import type { CollaborationSession } from '../src/server/sessions';
import { NotificationManager } from '../src/server/notifications';
import { WebSocket } from 'ws';

// ─── InvitationManager Tests ────────────────────────────────────────────

describe('InvitationManager', () => {
  let manager: InvitationManager;

  const baseParams: CreateInvitationParams = {
    fromDid: 'did:claw:ali:mrclaw',
    fromOwner: 'ali',
    toDid: 'did:claw:zeynep:owl',
    toOwner: 'zeynep',
    purpose: 'code review collaboration',
    permissions: ['read', 'write'],
  };

  beforeEach(() => {
    manager = new InvitationManager();
  });

  afterEach(() => {
    manager.stopCleanup();
  });

  describe('create', () => {
    it('should create a pending invitation with correct fields', () => {
      const inv = manager.create(baseParams);

      expect(inv.id).toBeDefined();
      expect(inv.status).toBe('pending');
      expect(inv.fromDid).toBe(baseParams.fromDid);
      expect(inv.toDid).toBe(baseParams.toDid);
      expect(inv.fromOwner).toBe('ali');
      expect(inv.toOwner).toBe('zeynep');
      expect(inv.purpose).toBe('code review collaboration');
      expect(inv.permissions).toEqual(['read', 'write']);
      expect(inv.createdAt).toBeInstanceOf(Date);
      expect(inv.expiresAt).toBeInstanceOf(Date);
      expect(inv.expiresAt.getTime()).toBeGreaterThan(inv.createdAt.getTime());
    });

    it('should reject self-invitation', () => {
      expect(() =>
        manager.create({ ...baseParams, toDid: baseParams.fromDid })
      ).toThrow('Cannot send invitation to self');
    });

    it('should reject too many pending invitations between same pair', () => {
      const mgr = new InvitationManager({ maxPendingPerPair: 2 });
      mgr.create(baseParams);
      mgr.create({ ...baseParams, purpose: 'second' });

      expect(() => mgr.create({ ...baseParams, purpose: 'third' })).toThrow(
        'Too many pending invitations'
      );
    });

    it('should use custom expiration time', () => {
      const inv = manager.create({ ...baseParams, expirationMinutes: 5 });
      const expectedExpiry = inv.createdAt.getTime() + 5 * 60_000;
      // Allow 1 second tolerance
      expect(Math.abs(inv.expiresAt.getTime() - expectedExpiry)).toBeLessThan(1000);
    });
  });

  describe('accept', () => {
    it('should accept a pending invitation', () => {
      const inv = manager.create(baseParams);
      const accepted = manager.accept(inv.id);

      expect(accepted.status).toBe('accepted');
      expect(accepted.respondedAt).toBeInstanceOf(Date);
    });

    it('should throw on non-existent invitation', () => {
      expect(() => manager.accept('nonexistent')).toThrow('Invitation not found');
    });

    it('should throw if already accepted', () => {
      const inv = manager.create(baseParams);
      manager.accept(inv.id);
      expect(() => manager.accept(inv.id)).toThrow('not pending');
    });

    it('should throw if invitation expired', () => {
      const mgr = new InvitationManager({ defaultExpirationMinutes: 0 });
      // expirationMinutes: 0 means expires immediately
      const inv = mgr.create({ ...baseParams, expirationMinutes: 0 });
      // Wait a tick for expiration
      expect(() => mgr.accept(inv.id)).toThrow('expired');
    });
  });

  describe('decline', () => {
    it('should decline a pending invitation', () => {
      const inv = manager.create(baseParams);
      const declined = manager.decline(inv.id, 'Not interested');

      expect(declined.status).toBe('declined');
      expect(declined.declineReason).toBe('Not interested');
      expect(declined.respondedAt).toBeInstanceOf(Date);
    });

    it('should decline without reason', () => {
      const inv = manager.create(baseParams);
      const declined = manager.decline(inv.id);

      expect(declined.status).toBe('declined');
      expect(declined.declineReason).toBeUndefined();
    });
  });

  describe('queries', () => {
    it('should get invitation by id', () => {
      const inv = manager.create(baseParams);
      expect(manager.get(inv.id)).toBeDefined();
      expect(manager.get(inv.id)!.id).toBe(inv.id);
    });

    it('should return undefined for unknown id', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });

    it('should list pending invitations for agent', () => {
      manager.create(baseParams);
      manager.create({
        ...baseParams,
        fromDid: 'did:claw:mehmet:bot',
        fromOwner: 'mehmet',
        purpose: 'different',
      });

      const pending = manager.getPendingForAgent('did:claw:zeynep:owl');
      expect(pending.length).toBe(2);
    });

    it('should list pending invitations for owner', () => {
      manager.create(baseParams);
      const pending = manager.getPendingForOwner('zeynep');
      expect(pending.length).toBe(1);
    });

    it('should filter by status', () => {
      const inv1 = manager.create(baseParams);
      manager.create({
        ...baseParams,
        fromDid: 'did:claw:mehmet:bot',
        fromOwner: 'mehmet',
        purpose: 'other',
      });

      manager.accept(inv1.id);

      expect(manager.list({ status: 'accepted' }).length).toBe(1);
      expect(manager.list({ status: 'pending' }).length).toBe(1);
    });
  });

  describe('expireStale', () => {
    it('should expire stale invitations', () => {
      const mgr = new InvitationManager();
      const inv = mgr.create({ ...baseParams, expirationMinutes: 0 });

      const count = mgr.expireStale();
      expect(count).toBe(1);

      const updated = mgr.get(inv.id);
      expect(updated!.status).toBe('expired');
    });
  });

  describe('stats', () => {
    it('should return correct stats', () => {
      const inv1 = manager.create(baseParams);
      manager.create({
        ...baseParams,
        fromDid: 'did:claw:mehmet:bot',
        fromOwner: 'mehmet',
        purpose: 'other',
      });

      manager.accept(inv1.id);

      const stats = manager.getStats();
      expect(stats.total).toBe(2);
      expect(stats.accepted).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });
});

// ─── SessionManager Tests ───────────────────────────────────────────────

describe('SessionManager', () => {
  let sessionMgr: SessionManager;
  let invMgr: InvitationManager;

  const baseParams: CreateInvitationParams = {
    fromDid: 'did:claw:ali:mrclaw',
    fromOwner: 'ali',
    toDid: 'did:claw:zeynep:owl',
    toOwner: 'zeynep',
    purpose: 'code review',
    permissions: ['read', 'write'],
  };

  function createAcceptedInvitation(): Invitation {
    const inv = invMgr.create(baseParams);
    invMgr.accept(inv.id);
    return invMgr.get(inv.id)!;
  }

  beforeEach(() => {
    invMgr = new InvitationManager();
    sessionMgr = new SessionManager();
  });

  afterEach(() => {
    sessionMgr.stopCleanup();
  });

  describe('createFromInvitation', () => {
    it('should create an active session from accepted invitation', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });

      expect(session.id).toBeDefined();
      expect(session.status).toBe('active');
      expect(session.invitationId).toBe(invitation.id);
      expect(session.participants.length).toBe(2);
      expect(session.participants[0].did).toBe('did:claw:ali:mrclaw');
      expect(session.participants[1].did).toBe('did:claw:zeynep:owl');
      expect(session.messageCount).toBe(0);
      expect(session.activityLog.length).toBe(1);
      expect(session.activityLog[0].action).toBe('session_created');
    });

    it('should throw if invitation is not accepted', () => {
      const inv = invMgr.create(baseParams);
      expect(() => sessionMgr.createFromInvitation({ invitation: inv })).toThrow(
        'non-accepted'
      );
    });

    it('should throw if active session already exists for invitation', () => {
      const invitation = createAcceptedInvitation();
      sessionMgr.createFromInvitation({ invitation });

      expect(() => sessionMgr.createFromInvitation({ invitation })).toThrow(
        'Active session already exists'
      );
    });

    it('should respect custom timeout', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({
        invitation,
        timeoutMinutes: 30,
      });

      const expectedExpiry = session.createdAt.getTime() + 30 * 60_000;
      expect(Math.abs(session.expiresAt.getTime() - expectedExpiry)).toBeLessThan(1000);
    });
  });

  describe('endSession', () => {
    it('should end an active session', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });
      const ended = sessionMgr.endSession(session.id, 'owner_ended', 'did:claw:ali:mrclaw');

      expect(ended.status).toBe('ended');
      expect(ended.endReason).toBe('owner_ended');
      expect(ended.endedAt).toBeInstanceOf(Date);
    });

    it('should throw if session not active', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });
      sessionMgr.endSession(session.id, 'owner_ended');

      expect(() => sessionMgr.endSession(session.id, 'owner_ended')).toThrow(
        'not active'
      );
    });

    it('should call onSessionEnd callbacks', () => {
      const callback = vi.fn();
      sessionMgr.onSessionEnd(callback);

      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });
      sessionMgr.endSession(session.id, 'owner_ended');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
    });
  });

  describe('recordMessage', () => {
    it('should increment message count and log activity', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });

      sessionMgr.recordMessage(session.id, 'did:claw:ali:mrclaw', 'Hello');
      sessionMgr.recordMessage(session.id, 'did:claw:zeynep:owl', 'Hi back');

      const updated = sessionMgr.get(session.id)!;
      expect(updated.messageCount).toBe(2);
      expect(updated.activityLog.length).toBe(3); // 1 session_created + 2 messages
    });

    it('should throw if session not active', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });
      sessionMgr.endSession(session.id, 'owner_ended');

      expect(() =>
        sessionMgr.recordMessage(session.id, 'did:claw:ali:mrclaw')
      ).toThrow('inactive');
    });
  });

  describe('hasPermission', () => {
    it('should return true for granted permission', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });

      expect(sessionMgr.hasPermission(session.id, 'did:claw:ali:mrclaw', 'read')).toBe(true);
      expect(sessionMgr.hasPermission(session.id, 'did:claw:ali:mrclaw', 'write')).toBe(true);
    });

    it('should return false for non-granted permission', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });

      expect(sessionMgr.hasPermission(session.id, 'did:claw:ali:mrclaw', 'execute')).toBe(false);
    });

    it('should return false for unknown agent', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({ invitation });

      expect(sessionMgr.hasPermission(session.id, 'did:claw:unknown:agent', 'read')).toBe(false);
    });
  });

  describe('queries', () => {
    it('should get active sessions for agent', () => {
      const invitation = createAcceptedInvitation();
      sessionMgr.createFromInvitation({ invitation });

      const active = sessionMgr.getActiveForAgent('did:claw:ali:mrclaw');
      expect(active.length).toBe(1);
    });

    it('should get active sessions for owner', () => {
      const invitation = createAcceptedInvitation();
      sessionMgr.createFromInvitation({ invitation });

      expect(sessionMgr.getActiveForOwner('ali').length).toBe(1);
      expect(sessionMgr.getActiveForOwner('zeynep').length).toBe(1);
      expect(sessionMgr.getActiveForOwner('unknown').length).toBe(0);
    });

    it('should list all active sessions', () => {
      const invitation = createAcceptedInvitation();
      sessionMgr.createFromInvitation({ invitation });

      expect(sessionMgr.getActiveSessions().length).toBe(1);
    });
  });

  describe('expireStale', () => {
    it('should expire timed-out sessions', () => {
      const invitation = createAcceptedInvitation();
      const session = sessionMgr.createFromInvitation({
        invitation,
        timeoutMinutes: 0,
      });

      const count = sessionMgr.expireStale();
      expect(count).toBe(1);

      const updated = sessionMgr.get(session.id)!;
      expect(updated.status).toBe('expired');
      expect(updated.endReason).toBe('timeout');
    });
  });

  describe('endAll', () => {
    it('should end all active sessions on shutdown', () => {
      const invitation = createAcceptedInvitation();
      sessionMgr.createFromInvitation({ invitation });

      sessionMgr.endAll();

      expect(sessionMgr.getActiveSessions().length).toBe(0);
    });
  });

  describe('stats', () => {
    it('should return correct session stats', () => {
      const inv1 = createAcceptedInvitation();
      const s1 = sessionMgr.createFromInvitation({ invitation: inv1 });
      sessionMgr.recordMessage(s1.id, 'did:claw:ali:mrclaw');
      sessionMgr.recordMessage(s1.id, 'did:claw:zeynep:owl');

      const stats = sessionMgr.getStats();
      expect(stats.total).toBe(1);
      expect(stats.active).toBe(1);
      expect(stats.totalMessages).toBe(2);
    });
  });
});

// ─── NotificationManager Tests ──────────────────────────────────────────

describe('NotificationManager', () => {
  let notifMgr: NotificationManager;

  const mockInvitation: Invitation = {
    id: 'inv-123',
    fromDid: 'did:claw:ali:mrclaw',
    fromOwner: 'ali',
    toDid: 'did:claw:zeynep:owl',
    toOwner: 'zeynep',
    purpose: 'code review',
    permissions: ['read'],
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  };

  beforeEach(() => {
    notifMgr = new NotificationManager();
  });

  describe('send', () => {
    it('should create a notification with correct fields', () => {
      const notif = notifMgr.send({
        type: 'activity_alert',
        targetOwner: 'ali',
        title: 'Test',
        message: 'Test message',
        data: {},
        priority: 'low',
      });

      expect(notif.id).toBeDefined();
      expect(notif.type).toBe('activity_alert');
      expect(notif.targetOwner).toBe('ali');
      expect(notif.read).toBe(false);
      expect(notif.createdAt).toBeInstanceOf(Date);
    });

    it('should maintain history up to max limit', () => {
      const mgr = new NotificationManager({ maxHistory: 5 });
      for (let i = 0; i < 10; i++) {
        mgr.send({
          type: 'activity_alert',
          targetOwner: 'ali',
          title: `Notif ${i}`,
          message: `Message ${i}`,
          data: {},
          priority: 'low',
        });
      }

      const stats = mgr.getStats();
      expect(stats.total).toBe(5);
    });
  });

  describe('invitation notifications', () => {
    it('should notify invitation received', () => {
      const notif = notifMgr.notifyInvitationReceived(mockInvitation);

      expect(notif.type).toBe('invitation_received');
      expect(notif.targetOwner).toBe('zeynep');
      expect(notif.priority).toBe('high');
      expect(notif.data.invitationId).toBe('inv-123');
    });

    it('should notify invitation accepted', () => {
      const accepted = { ...mockInvitation, status: 'accepted' as const };
      const notif = notifMgr.notifyInvitationAccepted(accepted);

      expect(notif.type).toBe('invitation_accepted');
      expect(notif.targetOwner).toBe('ali');
    });

    it('should notify invitation declined', () => {
      const declined = {
        ...mockInvitation,
        status: 'declined' as const,
        declineReason: 'Busy',
      };
      const notif = notifMgr.notifyInvitationDeclined(declined);

      expect(notif.type).toBe('invitation_declined');
      expect(notif.targetOwner).toBe('ali');
      expect(notif.message).toContain('Busy');
    });
  });

  describe('session notifications', () => {
    it('should notify session started to all owners', () => {
      const session: CollaborationSession = {
        id: 'session-1',
        invitationId: 'inv-123',
        participants: [
          {
            did: 'did:claw:ali:mrclaw',
            ownerName: 'ali',
            permissions: ['read'],
            joinedAt: new Date(),
          },
          {
            did: 'did:claw:zeynep:owl',
            ownerName: 'zeynep',
            permissions: ['read'],
            joinedAt: new Date(),
          },
        ],
        status: 'active',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        messageCount: 0,
        activityLog: [],
      };

      const notifs = notifMgr.notifySessionStarted(session);
      expect(notifs.length).toBe(2);
      expect(notifs[0].type).toBe('session_started');
      expect(notifs.map(n => n.targetOwner).sort()).toEqual(['ali', 'zeynep']);
    });

    it('should notify session ended to all owners', () => {
      const session: CollaborationSession = {
        id: 'session-1',
        invitationId: 'inv-123',
        participants: [
          {
            did: 'did:claw:ali:mrclaw',
            ownerName: 'ali',
            permissions: ['read'],
            joinedAt: new Date(),
          },
          {
            did: 'did:claw:zeynep:owl',
            ownerName: 'zeynep',
            permissions: ['read'],
            joinedAt: new Date(),
          },
        ],
        status: 'ended',
        createdAt: new Date(),
        endedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        endReason: 'owner_ended',
        messageCount: 5,
        activityLog: [],
      };

      const notifs = notifMgr.notifySessionEnded(session);
      expect(notifs.length).toBe(2);
      expect(notifs[0].message).toContain('5');
    });
  });

  describe('owner queries', () => {
    it('should get notifications for owner', () => {
      notifMgr.notifyInvitationReceived(mockInvitation);
      notifMgr.send({
        type: 'activity_alert',
        targetOwner: 'ali',
        title: 'Other',
        message: 'Other',
        data: {},
        priority: 'low',
      });

      expect(notifMgr.getForOwner('zeynep').length).toBe(1);
      expect(notifMgr.getForOwner('ali').length).toBe(1);
    });

    it('should filter unread only', () => {
      const notif = notifMgr.notifyInvitationReceived(mockInvitation);
      notifMgr.markAsRead(notif.id);

      expect(notifMgr.getForOwner('zeynep', { unreadOnly: true }).length).toBe(0);
      expect(notifMgr.getForOwner('zeynep').length).toBe(1);
    });
  });

  describe('markAsRead', () => {
    it('should mark notification as read', () => {
      const notif = notifMgr.send({
        type: 'activity_alert',
        targetOwner: 'ali',
        title: 'Test',
        message: 'Test',
        data: {},
        priority: 'low',
      });

      expect(notifMgr.markAsRead(notif.id)).toBe(true);
      expect(notifMgr.getForOwner('ali')[0].read).toBe(true);
    });

    it('should return false for unknown notification', () => {
      expect(notifMgr.markAsRead('nonexistent')).toBe(false);
    });
  });

  describe('stats', () => {
    it('should return correct notification stats', () => {
      notifMgr.notifyInvitationReceived(mockInvitation);
      const notif = notifMgr.send({
        type: 'activity_alert',
        targetOwner: 'ali',
        title: 'Other',
        message: 'Other',
        data: {},
        priority: 'low',
      });
      notifMgr.markAsRead(notif.id);

      const stats = notifMgr.getStats();
      expect(stats.total).toBe(2);
      expect(stats.unread).toBe(1);
      expect(stats.byType['invitation_received']).toBe(1);
      expect(stats.byType['activity_alert']).toBe(1);
    });
  });

  describe('WebSocket delivery', () => {
    it('should track owner connections', () => {
      // We can't easily create real WebSocket connections in unit tests,
      // but we can test the connection tracking logic
      expect(notifMgr.isOwnerConnected('ali')).toBe(false);
    });
  });
});

// ─── Integration: Invitation → Session → Notification Flow ─────────────

describe('Invitation Flow Integration', () => {
  let invMgr: InvitationManager;
  let sessionMgr: SessionManager;
  let notifMgr: NotificationManager;

  beforeEach(() => {
    invMgr = new InvitationManager();
    sessionMgr = new SessionManager();
    notifMgr = new NotificationManager();
  });

  afterEach(() => {
    invMgr.stopCleanup();
    sessionMgr.stopCleanup();
  });

  it('should complete full invitation → accept → session flow', () => {
    // 1. Create invitation
    const invitation = invMgr.create({
      fromDid: 'did:claw:ali:mrclaw',
      fromOwner: 'ali',
      toDid: 'did:claw:zeynep:owl',
      toOwner: 'zeynep',
      purpose: 'code review',
      permissions: ['read', 'write'],
    });

    // 2. Notify owner
    const receivedNotif = notifMgr.notifyInvitationReceived(invitation);
    expect(receivedNotif.targetOwner).toBe('zeynep');

    // 3. Accept invitation
    const accepted = invMgr.accept(invitation.id);
    expect(accepted.status).toBe('accepted');

    // 4. Create session
    const session = sessionMgr.createFromInvitation({ invitation: accepted });
    expect(session.status).toBe('active');
    expect(session.participants.length).toBe(2);

    // 5. Notify both owners
    const startNotifs = notifMgr.notifySessionStarted(session);
    expect(startNotifs.length).toBe(2);
    const acceptNotif = notifMgr.notifyInvitationAccepted(accepted);
    expect(acceptNotif.targetOwner).toBe('ali');

    // 6. Record some messages
    sessionMgr.recordMessage(session.id, 'did:claw:ali:mrclaw', 'Hello');
    sessionMgr.recordMessage(session.id, 'did:claw:zeynep:owl', 'Hi');

    // 7. End session
    const ended = sessionMgr.endSession(session.id, 'owner_ended', 'did:claw:zeynep:owl');
    expect(ended.messageCount).toBe(2);
    expect(ended.status).toBe('ended');
  });

  it('should complete full invitation → decline flow', () => {
    const invitation = invMgr.create({
      fromDid: 'did:claw:ali:mrclaw',
      fromOwner: 'ali',
      toDid: 'did:claw:zeynep:owl',
      toOwner: 'zeynep',
      purpose: 'code review',
      permissions: ['read'],
    });

    // Notify
    notifMgr.notifyInvitationReceived(invitation);

    // Decline
    const declined = invMgr.decline(invitation.id, 'Too busy right now');
    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('Too busy right now');

    // Notify sender
    const notif = notifMgr.notifyInvitationDeclined(declined);
    expect(notif.targetOwner).toBe('ali');
    expect(notif.message).toContain('Too busy');

    // No session should be created
    expect(sessionMgr.getActiveSessions().length).toBe(0);
  });

  it('should handle timeout flow correctly', () => {
    const invitation = invMgr.create({
      fromDid: 'did:claw:ali:mrclaw',
      fromOwner: 'ali',
      toDid: 'did:claw:zeynep:owl',
      toOwner: 'zeynep',
      purpose: 'code review',
      permissions: ['read'],
    });
    invMgr.accept(invitation.id);

    const session = sessionMgr.createFromInvitation({
      invitation: invMgr.get(invitation.id)!,
      timeoutMinutes: 0, // Immediate timeout
    });

    const expiredCount = sessionMgr.expireStale();
    expect(expiredCount).toBe(1);

    const updated = sessionMgr.get(session.id)!;
    expect(updated.status).toBe('expired');
    expect(updated.endReason).toBe('timeout');
  });
});
