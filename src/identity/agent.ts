/**
 * Agent Identity System
 * Her agent'ın benzersiz kimliği ve doğrulama mekanizması
 */

import * as crypto from 'crypto';

export interface AgentIdentity {
  /** Decentralized Identifier (DID) */
  did: string;
  /** Agent adı */
  name: string;
  /** Emoji */
  emoji: string;
  /** Sahip insan kullanıcının adı */
  ownerName: string;
  /** Sahip kullanıcı ID */
  ownerId: string;
  /** Yetenekler / Skills */
  capabilities: string[];
  /** Public key (imza doğrulama için) */
  publicKey: string;
  /** Oluşturulma tarihi */
  createdAt: Date;
  /** Son aktif zamanı */
  lastSeen: Date;
  /** Subagent spawn derinliği (0 = root agent) */
  spawnDepth?: number;
  /** Bu agent'ı spawn eden parent DID (varsa) */
  spawnedBy?: string;
  /** En üstteki root agent DID */
  rootDid?: string;
}

export interface AgentInvitation {
  id: string;
  /** Gönderen agent DID */
  fromDid: string;
  /** Alıcı agent DID veya kullanıcı adı */
  toIdentifier: string;
  /** Amaç */
  purpose: string;
  /** Sandbox path */
  sandboxPath: string;
  /** İzinler */
  permissions: Permission[];
  /** Süre (saat) */
  durationHours: number;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Son kullanım zamanı */
  expiresAt: Date;
  /** Durum */
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}

export type Permission = 
  | 'read'
  | 'write'
  | 'execute'
  | 'share'
  | 'invite';

export const MAX_AGENTS_PER_GROUP = 7;

/**
 * Yeni agent DID oluşturur
 * Format: did:claw:<ownerId>:<agentName>
 */
export function generateAgentDID(ownerId: string, agentName: string): string {
  const sanitized = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
  return `did:claw:${ownerId}:${sanitized}`;
}

/**
 * DID parse eder
 */
export function parseDID(did: string): { ownerId: string; agentName: string } | null {
  const match = did.match(/^did:claw:([^:]+):([^:]+)$/);
  if (!match) return null;
  return { ownerId: match[1], agentName: match[2] };
}

/**
 * Davetiye oluşturur (SADECE insan kullanıcı çağırabilir)
 */
export function createInvitation(
  ownerName: string,
  toIdentifier: string,
  purpose: string,
  sandboxPath: string,
  permissions: Permission[],
  durationHours: number = 168 // 7 gün default
): AgentInvitation {
  const id = crypto.randomUUID();
  const now = new Date();
  return {
    id,
    fromDid: generateAgentDID(ownerName, 'pending'),
    toIdentifier,
    purpose,
    sandboxPath,
    permissions,
    durationHours,
    createdAt: now,
    expiresAt: new Date(now.getTime() + durationHours * 60 * 60 * 1000),
    status: 'pending',
  };
}

/**
 * ECDSA key pair oluşturur (P-256 curve)
 * Returns: { privateKey, publicKey }
 */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: {
      type: 'spki',
      format: 'der',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'der',
    },
  });

  return {
    privateKey: privateKey.toString('base64'),
    publicKey: publicKey.toString('base64'),
  };
}

/**
 * Mesajı ECDSA ile imzalar
 */
export function signMessage(privateKey: string, message: string): string {
  const privateKeyBuffer = Buffer.from(privateKey, 'base64');
  const signer = crypto.createSign('SHA256');
  signer.write(message);
  signer.end();
  
  const signature = signer.sign({
    key: privateKeyBuffer,
    format: 'der',
    type: 'pkcs8',
  });
  
  return signature.toString('base64');
}

/**
 * Auth challenge'ı imzalar (DID + nonce)
 */
export function signAuthChallenge(did: string, nonce: string, privateKey: string): string {
  const data = `${did}:${nonce}`;
  return signMessage(privateKey, data);
}

/**
 * SubagentSpawnManager'ı import eder
 */
import {
  SubagentDepthManager,
  SubagentSpawnContext,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from '../consent/consent';

/**
 * Agent Registry - Tüm agent'ları ve spawn chain'lerini takip eder
 */
export class AgentRegistry {
  private agents: Map<string, AgentIdentity> = new Map();
  private depthManager: SubagentDepthManager;

  constructor(maxSpawnDepth: number = DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH) {
    this.depthManager = new SubagentDepthManager(maxSpawnDepth);
  }

  /**
   * Yeni agent kayıt eder
   */
  register(identity: AgentIdentity): void {
    this.agents.set(identity.did, identity);
  }

  /**
   * Agent bulur
   */
  get(did: string): AgentIdentity | undefined {
    return this.agents.get(did);
  }

  /**
   * Subagent spawn eder
   * @throws Error eğer depth limit aşılmışsa
   */
  spawnSubagent(
    parentDid: string,
    childIdentity: AgentIdentity,
    _task: string,
    _label?: string
  ): { child: AgentIdentity; context: SubagentSpawnContext } {
    const parent = this.agents.get(parentDid);
    if (!parent) {
      throw new Error(`Parent agent not found: ${parentDid}`);
    }

    // Parent'ın spawn context'ini oluştur veya kullan
    let parentContext: SubagentSpawnContext;
    if (parent.spawnDepth !== undefined && parent.rootDid) {
      parentContext = {
        currentDepth: parent.spawnDepth,
        maxDepth: this.depthManager.getMaxDepth(),
        parentDid: parent.spawnedBy || parentDid,
        rootDid: parent.rootDid,
      };
    } else {
      // Root agent ilk defa spawn yapıyor
      parentContext = this.depthManager.createRootContext(parentDid);
    }

    // Depth limit kontrolü
    if (!this.depthManager.canSpawn(parentContext)) {
      throw new Error(
        `Subagent spawn depth limit aşıldı: current=${parentContext.currentDepth}, max=${parentContext.maxDepth}. ` +
        `Security: Subagent → subagent spawn chain engellendi.`
      );
    }

    // Child context oluştur
    const childContext = this.depthManager.createChildContext(parentContext, childIdentity.did);

    // Child agent'ın metadata'sını güncelle
    childIdentity.spawnDepth = childContext.currentDepth;
    childIdentity.spawnedBy = parentDid;
    childIdentity.rootDid = childContext.rootDid;

    // Child'ı kayıt et
    this.agents.set(childIdentity.did, childIdentity);

    return { child: childIdentity, context: childContext };
  }

  /**
   * Spawn chain bilgisini döndürür
   */
  getSpawnChain(did: string): AgentIdentity[] {
    const chain: AgentIdentity[] = [];
    let current = this.agents.get(did);

    while (current) {
      chain.unshift(current);
      if (!current.spawnedBy) break;
      current = this.agents.get(current.spawnedBy);
    }

    return chain;
  }

  /**
   * Bir agent'ın depth bilgisini döndürür
   */
  getDepth(did: string): number {
    const agent = this.agents.get(did);
    return agent?.spawnDepth ?? 0;
  }
}
