/**
 * Approval System Tests
 *
 * ApprovalManager'ın onay kuyruğu, risk skorlama, Allow All modu
 * ve timeout mekanizmalarını test eder.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApprovalManager } from '../src/server/approval';

describe('ApprovalManager', () => {
  let manager: ApprovalManager;
  const sessionId = 'test-session';
  const agentName = 'TestAgent';

  beforeEach(() => {
    manager = new ApprovalManager();
  });

  afterEach(() => {
    manager.clear();
  });

  // ─── Mode Management ───────────────────────────────────────────────────

  describe('Mode Management', () => {
    it('should default to manual mode', () => {
      expect(manager.getMode(sessionId)).toBe('manual');
    });

    it('should switch to allow_all mode', () => {
      manager.setMode(sessionId, 'allow_all');
      expect(manager.getMode(sessionId)).toBe('allow_all');
    });

    it('should switch back to manual mode', () => {
      manager.setMode(sessionId, 'allow_all');
      manager.setMode(sessionId, 'manual');
      expect(manager.getMode(sessionId)).toBe('manual');
    });
  });

  // ─── Request Creation ──────────────────────────────────────────────────

  describe('Request Creation', () => {
    it('should auto-approve file_read without human approval', () => {
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_read', 'readme.md'
      );
      expect(needsHuman).toBe(false);
      expect(request.status).toBe('auto_approved');
    });

    it('should auto-approve file_list without human approval', () => {
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_list', '.'
      );
      expect(needsHuman).toBe(false);
      expect(request.status).toBe('auto_approved');
    });

    it('should require human approval for file_create in manual mode', () => {
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_create', 'src/new.ts', 'export {}',
      );
      expect(needsHuman).toBe(true);
      expect(request.status).toBe('pending');
    });

    it('should require human approval for file_delete in manual mode', () => {
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_delete', 'old-file.ts',
      );
      expect(needsHuman).toBe(true);
      expect(request.status).toBe('pending');
    });

    it('should auto-approve low-risk actions in allow_all mode', () => {
      manager.setMode(sessionId, 'allow_all');
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_create', 'src/utils.ts', 'export const x = 1;',
      );
      expect(needsHuman).toBe(false);
      expect(request.status).toBe('auto_approved');
      expect(request.resolvedBy).toBe('auto_allow_all');
    });

    it('should still require human approval for high-risk actions in allow_all mode', () => {
      manager.setMode(sessionId, 'allow_all');
      const [request, needsHuman] = manager.createRequest(
        sessionId, agentName, 'file_create', '.env', 'SECRET_KEY=abc123',
      );
      expect(needsHuman).toBe(true);
      expect(request.status).toBe('pending');
      expect(request.riskScore).toBeGreaterThanOrEqual(70);
    });

    it('should calculate risk score correctly', () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'deploy.sh', '#!/bin/bash\necho hello',
      );
      expect(request.riskScore).toBeGreaterThanOrEqual(50);
    });

    it('should add to pending queue', () => {
      manager.createRequest(sessionId, agentName, 'file_create', 'a.ts', 'content');
      manager.createRequest(sessionId, agentName, 'file_create', 'b.ts', 'content');
      expect(manager.getPendingCount(sessionId)).toBe(2);
    });
  });

  // ─── Request Resolution ────────────────────────────────────────────────

  describe('Request Resolution', () => {
    it('should approve a pending request', () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'approved.ts', 'content',
      );
      const resolved = manager.resolveRequest(request.id, true);
      expect(resolved.status).toBe('approved');
      expect(resolved.resolvedBy).toBe('human');
      expect(resolved.resolvedAt).toBeInstanceOf(Date);
    });

    it('should reject a pending request', () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'rejected.ts', 'content',
      );
      const resolved = manager.resolveRequest(request.id, false);
      expect(resolved.status).toBe('rejected');
    });

    it('should remove from pending queue after resolution', () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'test.ts', 'content',
      );
      expect(manager.getPendingCount(sessionId)).toBe(1);

      manager.resolveRequest(request.id, true);
      expect(manager.getPendingCount(sessionId)).toBe(0);
    });

    it('should throw for non-existent request', () => {
      expect(() => manager.resolveRequest('nonexistent', true)).toThrow('not found');
    });

    it('should throw for already resolved request', () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'double.ts', 'content',
      );
      manager.resolveRequest(request.id, true);
      expect(() => manager.resolveRequest(request.id, false)).toThrow('not pending');
    });
  });

  // ─── Async Approval Waiting ────────────────────────────────────────────

  describe('waitForApproval', () => {
    it('should resolve with true when approved', async () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'async-test.ts', 'content',
      );

      // Simulate async approval
      const promise = manager.waitForApproval(request.id);
      manager.resolveRequest(request.id, true);
      const result = await promise;
      expect(result).toBe(true);
    });

    it('should resolve with false when rejected', async () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'async-reject.ts', 'content',
      );

      const promise = manager.waitForApproval(request.id);
      manager.resolveRequest(request.id, false);
      const result = await promise;
      expect(result).toBe(false);
    });

    it('should return true immediately for auto-approved', async () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_read', 'test.txt',
      );
      const result = await manager.waitForApproval(request.id);
      expect(result).toBe(true);
    });

    it('should reject for non-existent request', async () => {
      await expect(manager.waitForApproval('nonexistent')).rejects.toThrow('not found');
    });
  });

  // ─── Pending Queue ─────────────────────────────────────────────────────

  describe('Pending Queue', () => {
    it('should return pending requests in order', () => {
      manager.createRequest(sessionId, agentName, 'file_create', 'first.ts', 'a');
      manager.createRequest(sessionId, agentName, 'file_create', 'second.ts', 'b');
      manager.createRequest(sessionId, agentName, 'file_create', 'third.ts', 'c');

      const pending = manager.getPendingRequests(sessionId);
      expect(pending.length).toBe(3);
      expect(pending[0].filePath).toBe('first.ts');
      expect(pending[2].filePath).toBe('third.ts');
    });

    it('should return empty array for no pending requests', () => {
      expect(manager.getPendingRequests(sessionId)).toEqual([]);
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────

  describe('Stats', () => {
    it('should provide correct statistics', () => {
      const [r1] = manager.createRequest(sessionId, agentName, 'file_read', 'a.txt');
      const [r2] = manager.createRequest(sessionId, agentName, 'file_create', 'b.ts', 'x');
      const [r3] = manager.createRequest(sessionId, agentName, 'file_create', 'c.ts', 'y');
      manager.resolveRequest(r2.id, true);
      manager.resolveRequest(r3.id, false);

      const stats = manager.getStats(sessionId);
      expect(stats.total).toBe(3);
      expect(stats.autoApproved).toBe(1); // file_read
      expect(stats.approved).toBe(1);     // r2
      expect(stats.rejected).toBe(1);     // r3
      expect(stats.pending).toBe(0);
      expect(stats.mode).toBe('manual');
    });
  });

  // ─── Session Cleanup ───────────────────────────────────────────────────

  describe('Session Cleanup', () => {
    it('should clean up all pending requests on session cleanup', async () => {
      const [request] = manager.createRequest(
        sessionId, agentName, 'file_create', 'cleanup.ts', 'content',
      );

      const promise = manager.waitForApproval(request.id);
      manager.cleanupSession(sessionId);

      // Promise should resolve with false (rejected)
      const result = await promise;
      expect(result).toBe(false);
      expect(manager.getPendingCount(sessionId)).toBe(0);
    });
  });
});
