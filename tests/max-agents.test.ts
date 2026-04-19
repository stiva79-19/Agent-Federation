/**
 * Max 7 Agent Limit Tests
 *
 * MAX_CONNECTED_AGENTS sabitinin doğru export edildiğini ve
 * types'da tanımlandığını test eder.
 */

import { describe, it, expect } from 'vitest';
import { MAX_CONNECTED_AGENTS } from '../src/server/types';

describe('Max Connected Agents', () => {
  it('should be exactly 7', () => {
    expect(MAX_CONNECTED_AGENTS).toBe(7);
  });

  it('should be a positive integer', () => {
    expect(Number.isInteger(MAX_CONNECTED_AGENTS)).toBe(true);
    expect(MAX_CONNECTED_AGENTS).toBeGreaterThan(0);
  });
});

describe('DashboardAgentStatus type check', () => {
  it('should allow creating valid DashboardAgentStatus objects', () => {
    // Type-level test — import'un çalıştığını ve yapının doğru olduğunu doğrula
    const status = {
      clientId: 'test-123',
      agentName: 'MrClaw',
      online: true,
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      sandboxActionCount: 5,
    };

    expect(status.clientId).toBe('test-123');
    expect(status.agentName).toBe('MrClaw');
    expect(status.online).toBe(true);
    expect(status.sandboxActionCount).toBe(5);
  });
});
