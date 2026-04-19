/**
 * Subagent Spawn Depth Limit Tests
 * Security: Subagent → subagent spawn chain'ini sınırla
 */

import { describe, it, expect } from 'vitest';
import {
  ConsentManager,
  SubagentDepthManager,
  SubagentSpawnContext,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from '../../src/consent/consent';
import { AgentRegistry, AgentIdentity, generateAgentDID, generateKeyPair } from '../../src/identity/agent';

describe('Subagent Depth Limit', () => {
  describe('SubagentDepthManager', () => {
    it('should allow spawn at depth 0 when maxDepth is 1', () => {
      const manager = new SubagentDepthManager(1);
      const rootContext = manager.createRootContext('did:claw:alice:root');
      
      expect(manager.canSpawn(rootContext)).toBe(true);
      expect(rootContext.currentDepth).toBe(0);
      expect(rootContext.maxDepth).toBe(1);
    });

    it('should block spawn when depth reaches maxDepth', () => {
      const manager = new SubagentDepthManager(1);
      const rootContext = manager.createRootContext('did:claw:alice:root');
      
      // First spawn (depth 0 → 1)
      const childContext = manager.createChildContext(rootContext, 'did:claw:alice:child1');
      expect(childContext.currentDepth).toBe(1);
      
      // Second spawn should be blocked (depth 1 >= maxDepth 1)
      expect(manager.canSpawn(childContext)).toBe(false);
    });

    it('should throw error when trying to create child context beyond max depth', () => {
      const manager = new SubagentDepthManager(1);
      const rootContext = manager.createRootContext('did:claw:alice:root');
      const childContext = manager.createChildContext(rootContext, 'did:claw:alice:child1');
      
      expect(() => {
        manager.createChildContext(childContext, 'did:claw:alice:grandchild');
      }).toThrow('Subagent spawn depth limit aşıldı');
    });

    it('should allow deeper chains with higher maxDepth', () => {
      const manager = new SubagentDepthManager(3);
      let context = manager.createRootContext('did:claw:alice:root');
      
      // Depth 0 → 1
      context = manager.createChildContext(context, 'did:claw:alice:child1');
      expect(context.currentDepth).toBe(1);
      expect(manager.canSpawn(context)).toBe(true);
      
      // Depth 1 → 2
      context = manager.createChildContext(context, 'did:claw:alice:child2');
      expect(context.currentDepth).toBe(2);
      expect(manager.canSpawn(context)).toBe(true);
      
      // Depth 2 → 3
      context = manager.createChildContext(context, 'did:claw:alice:child3');
      expect(context.currentDepth).toBe(3);
      expect(manager.canSpawn(context)).toBe(false);
    });

    it('should preserve rootDid through spawn chain', () => {
      const manager = new SubagentDepthManager(2);
      const rootContext = manager.createRootContext('did:claw:alice:root-agent');
      
      const child1 = manager.createChildContext(rootContext, 'did:claw:alice:child1');
      expect(child1.rootDid).toBe('did:claw:alice:root-agent');
      
      const child2 = manager.createChildContext(child1, 'did:claw:alice:child2');
      expect(child2.rootDid).toBe('did:claw:alice:root-agent');
    });

    it('should use DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH of 1 by default', () => {
      expect(DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH).toBe(1);
    });

    it('should enrich consent request with depth metadata', () => {
      const manager = new SubagentDepthManager(1);
      const context = manager.createRootContext('did:claw:alice:root');
      
      const consentRequest = manager.enrichConsentRequest(
        {
          requesterDid: 'did:claw:alice:root',
          action: 'execute_code',
          details: { code: 'console.log("test")' },
          riskScore: 60,
          timeoutSeconds: 300,
        },
        context
      );
      
      expect(consentRequest.details.subagentDepth).toBe(0);
      expect(consentRequest.details.subagentMaxDepth).toBe(1);
      expect(consentRequest.details.subagentRootDid).toBe('did:claw:alice:root');
    });
  });

  describe('AgentRegistry with Depth Limit', () => {
    it('should allow root agent to spawn first subagent', () => {
      const registry = new AgentRegistry(1);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      
      const childKeys = generateKeyPair();
      const childAgent: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child Agent',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: childKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      const result = registry.spawnSubagent(
        'did:claw:alice:root',
        childAgent,
        'Test task',
        'Test child'
      );
      
      expect(result.child.spawnDepth).toBe(1);
      expect(result.child.spawnedBy).toBe('did:claw:alice:root');
      expect(result.child.rootDid).toBe('did:claw:alice:root');
    });

    it('should block subagent from spawning another subagent (depth limit enforcement)', () => {
      const registry = new AgentRegistry(1);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      
      // Spawn first child
      const childKeys = generateKeyPair();
      const childAgent: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child Agent',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: childKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:root', childAgent, 'Task 1');
      
      // Try to spawn grandchild (should fail)
      const grandchildKeys = generateKeyPair();
      const grandchildAgent: AgentIdentity = {
        did: 'did:claw:alice:grandchild',
        name: 'Grandchild Agent',
        emoji: '👶',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: grandchildKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      expect(() => {
        registry.spawnSubagent(
          'did:claw:alice:child1',
          grandchildAgent,
          'Task 2',
          'Grandchild'
        );
      }).toThrow('Subagent spawn depth limit aşıldı');
      expect(() => {
        registry.spawnSubagent(
          'did:claw:alice:child1',
          grandchildAgent,
          'Task 2',
          'Grandchild'
        );
      }).toThrow('Subagent → subagent spawn chain engellendi');
    });

    it('should track spawn chain correctly', () => {
      const registry = new AgentRegistry(3);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      
      // Spawn chain: root → child1 → child2
      const child1Keys = generateKeyPair();
      const child1: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child 1',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: child1Keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:root', child1, 'Task 1');
      
      const child2Keys = generateKeyPair();
      const child2: AgentIdentity = {
        did: 'did:claw:alice:child2',
        name: 'Child 2',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: child2Keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:child1', child2, 'Task 2');
      
      const chain = registry.getSpawnChain('did:claw:alice:child2');
      expect(chain.length).toBe(3); // root, child1, child2
      expect(chain[0].did).toBe('did:claw:alice:root');
      expect(chain[1].did).toBe('did:claw:alice:child1');
      expect(chain[2].did).toBe('did:claw:alice:child2');
    });

    it('should return correct depth for each agent in chain', () => {
      const registry = new AgentRegistry(3);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      expect(registry.getDepth('did:claw:alice:root')).toBe(0);
      
      const child1Keys = generateKeyPair();
      const child1: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child 1',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: child1Keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:root', child1, 'Task 1');
      expect(registry.getDepth('did:claw:alice:child1')).toBe(1);
      
      const child2Keys = generateKeyPair();
      const child2: AgentIdentity = {
        did: 'did:claw:alice:child2',
        name: 'Child 2',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: child2Keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:child1', child2, 'Task 2');
      expect(registry.getDepth('did:claw:alice:child2')).toBe(2);
    });

    it('should throw error when spawning from non-existent parent', () => {
      const registry = new AgentRegistry(1);
      
      const childKeys = generateKeyPair();
      const childAgent: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child Agent',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: childKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      expect(() => {
        registry.spawnSubagent(
          'did:claw:alice:nonexistent',
          childAgent,
          'Task',
          'Child'
        );
      }).toThrow('Parent agent not found');
    });
  });

  describe('Security: Subagent → Subagent Spawn Chain Prevention', () => {
    it('should prevent infinite spawn loops', () => {
      const registry = new AgentRegistry(1);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      
      // Attempt to create a spawn chain deeper than allowed
      let currentDid = 'did:claw:alice:root';
      let depth = 0;
      
      while (depth < 5) {
        try {
          const childKeys = generateKeyPair();
          const childAgent: AgentIdentity = {
            did: `did:claw:alice:child${depth}`,
            name: `Child ${depth}`,
            emoji: '🤖',
            ownerName: 'Alice',
            ownerId: 'alice',
            capabilities: ['limited'],
            publicKey: childKeys.publicKey,
            createdAt: new Date(),
            lastSeen: new Date(),
          };
          
          registry.spawnSubagent(currentDid, childAgent, `Task ${depth}`);
          currentDid = childAgent.did;
          depth++;
        } catch (error) {
          // Expected to fail at depth 1
          expect((error as Error).message).toContain('Subagent spawn depth limit aşıldı');
          break;
        }
      }
      
      // Should have stopped at depth 1 (root + 1 child)
      expect(depth).toBe(1);
    });

    it('should include security context in error messages', () => {
      const registry = new AgentRegistry(1);
      const keys = generateKeyPair();
      
      const rootAgent: AgentIdentity = {
        did: 'did:claw:alice:root',
        name: 'Root Agent',
        emoji: '🦀',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['all'],
        publicKey: keys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.register(rootAgent);
      
      const childKeys = generateKeyPair();
      const childAgent: AgentIdentity = {
        did: 'did:claw:alice:child1',
        name: 'Child Agent',
        emoji: '🤖',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: childKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      registry.spawnSubagent('did:claw:alice:root', childAgent, 'Task 1');
      
      const grandchildKeys = generateKeyPair();
      const grandchildAgent: AgentIdentity = {
        did: 'did:claw:alice:grandchild',
        name: 'Grandchild Agent',
        emoji: '👶',
        ownerName: 'Alice',
        ownerId: 'alice',
        capabilities: ['limited'],
        publicKey: grandchildKeys.publicKey,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      
      try {
        registry.spawnSubagent('did:claw:alice:child1', grandchildAgent, 'Task 2');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('Subagent spawn depth limit aşıldı');
        expect(message).toContain('Subagent → subagent spawn chain engellendi');
        expect(message).toContain('current=1');
        expect(message).toContain('max=1');
      }
    });
  });
});
