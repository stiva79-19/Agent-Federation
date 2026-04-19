# Subagent Spawn Depth Limit

## Overview

Security feature to prevent infinite subagent → subagent spawn chains by enforcing a maximum spawn depth limit.

## Implementation Details

### Files Modified

1. **`src/consent/consent.ts`**
   - Added `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1` constant
   - Added `SubagentSpawnContext` interface for tracking spawn depth
   - Added `SubagentSpawnRequest` interface
   - Added `SubagentDepthManager` class for depth limit enforcement

2. **`src/identity/agent.ts`**
   - Extended `AgentIdentity` with spawn tracking fields:
     - `spawnDepth?: number` - Current depth in spawn chain
     - `spawnedBy?: string` - Parent agent DID
     - `rootDid?: string` - Root agent DID
   - Added `AgentRegistry` class with spawn management

3. **`tests/security/subagent-depth-limit.test.ts`**
   - 14 comprehensive tests covering:
     - Depth limit enforcement
     - Spawn chain tracking
     - Root DID preservation
     - Error handling
     - Security scenarios

## Key Features

### 1. Max Depth Constant (Default: 1)

```typescript
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
```

This means:
- Root agent (depth 0) can spawn subagents (depth 1)
- Subagents (depth 1) **cannot** spawn further subagents
- Prevents infinite spawn chains

### 2. Depth Increment on Spawn

```typescript
createChildContext(parent: SubagentSpawnContext, childDid: string): SubagentSpawnContext {
  return {
    currentDepth: parent.currentDepth + 1,
    maxDepth: this.maxDepth,
    parentDid: parent.parentDid,
    rootDid: parent.rootDid,
  };
}
```

### 3. Spawn Blocking When Max Depth Exceeded

```typescript
canSpawn(context?: SubagentSpawnContext): boolean {
  if (!context) return true; // Root level
  return context.currentDepth < this.maxDepth;
}
```

When depth limit is exceeded:
```
Error: Subagent spawn depth limit aşıldı: current=1, max=1. 
Subagent → subagent spawn chain engellendi.
```

### 4. Parent Agent Tracking

Each agent tracks:
- `spawnedBy`: DID of the agent that spawned it
- `spawnDepth`: Current depth in the chain
- `rootDid`: DID of the root agent (origin of chain)

### 5. Spawn Chain Visualization

```
Root Agent (depth 0)
  └── Child Agent (depth 1)
      └── [BLOCKED] Grandchild would be depth 2
```

## Usage Example

```typescript
import { AgentRegistry } from './identity/agent';

// Create registry with max depth 1 (default)
const registry = new AgentRegistry(1);

// Register root agent
registry.register(rootAgent);

// Root can spawn child (depth 0 → 1)
registry.spawnSubagent(rootDid, childAgent, 'Task');

// Child CANNOT spawn grandchild (depth 1 >= max 1)
try {
  registry.spawnSubagent(childDid, grandchildAgent, 'Task');
} catch (error) {
  // Error: Subagent spawn depth limit aşıldı
}
```

## Security Benefits

1. **Prevents Infinite Loops**: Stops runaway subagent creation
2. **Resource Protection**: Limits compute and memory usage
3. **Attack Surface Reduction**: Prevents deep nesting attacks
4. **Clear Audit Trail**: Full spawn chain tracking via `rootDid` and `spawnedBy`
5. **Configurable**: Max depth can be adjusted per deployment needs

## Test Coverage

All tests pass (14/14):

- ✅ Depth manager basic operations
- ✅ Max depth enforcement
- ✅ Error throwing on limit exceeded
- ✅ Configurable max depth
- ✅ Root DID preservation through chain
- ✅ Default depth value
- ✅ Consent request enrichment
- ✅ AgentRegistry spawn operations
- ✅ Spawn chain tracking
- ✅ Depth queries
- ✅ Parent validation
- ✅ Infinite loop prevention
- ✅ Security error messages

## Configuration

To change the max spawn depth:

```typescript
const registry = new AgentRegistry(3); // Allow up to 3 levels
```

Or update the default:

```typescript
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 2; // Change from 1 to 2
```

## Integration with Consent Layer

The depth manager integrates with the consent system:

```typescript
const enrichedRequest = depthManager.enrichConsentRequest(
  consentRequest,
  spawnContext
);

// Adds metadata:
// - subagentDepth
// - subagentMaxDepth
// - subagentRootDid
// - subagentParentDid
```

This ensures all spawn operations are tracked and can require human consent based on depth.
