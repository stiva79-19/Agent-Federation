/**
 * Registry — Federated Agent Directory
 * 
 * Merkezi olmayan agent keşif sistemi.
 * Her node kendi agent'larını yayınlar, diğer node'lar keşfeder.
 */

import { EventEmitter } from 'events';
import type { AgentIdentity } from '../identity/agent';

export interface AgentEntry {
  /** Agent kimliği */
  identity: AgentIdentity;
  /** Erişim endpoint'i */
  endpoint: string;
  /** Tailscale hostname */
  tailscaleHostname?: string;
  /** Port */
  port: number;
  /** Yetenekler */
  capabilities: string[];
  /** Durum */
  status: 'online' | 'offline' | 'busy';
  /** Son görülme */
  lastSeen: Date;
  /** Yayınlanma zamanı */
  publishedAt: Date;
  /** TTL (saniye) */
  ttlSeconds: number;
}

export interface DirectoryQuery {
  /** Yetenek filtresi */
  capabilities?: string[];
  /** Durum filtresi */
  status?: AgentEntry['status'];
  /** Limit */
  limit?: number;
}

export interface DirectoryEventMap {
  'agent_published': AgentEntry;
  'agent_updated': AgentEntry;
  'agent_expired': AgentEntry;
  'discovered': AgentEntry;
  'query': { query: DirectoryQuery; results: AgentEntry[] };
}

export class AgentDirectory extends EventEmitter {
  /** Yerel agent'lar */
  private localAgents: Map<string, AgentEntry> = new Map();
  /** Keşfedilen agent'lar */
  private discoveredAgents: Map<string, AgentEntry> = new Map();
  /** TTL cleanup interval */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Broadcast interval */
  private broadcastInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanup();
  }

  /**
   * Yerel agent'ı yayınlar
   */
  publish(entry: Omit<AgentEntry, 'publishedAt' | 'lastSeen'>): AgentEntry {
    const now = new Date();
    const agentEntry: AgentEntry = {
      ...entry,
      publishedAt: now,
      lastSeen: now,
    };

    this.localAgents.set(entry.identity.did, agentEntry);
    console.log(`[Registry] Published agent: ${entry.identity.did}`);
    
    this.emit('agent_published', agentEntry);
    return agentEntry;
  }

  /**
   * Agent durumunu günceller
   */
  updateStatus(did: string, status: AgentEntry['status']): void {
    const entry = this.localAgents.get(did);
    if (entry) {
      entry.status = status;
      entry.lastSeen = new Date();
      this.emit('agent_updated', entry);
    }
  }

  /**
   * Keşfedilen agent'ı kaydeder
   */
  discover(entry: AgentEntry): void {
    // Kendimizi keşfetmeyelim
    if (this.localAgents.has(entry.identity.did)) {
      return;
    }

    this.discoveredAgents.set(entry.identity.did, entry);
    console.log(`[Registry] Discovered agent: ${entry.identity.did} at ${entry.endpoint}`);
    this.emit('discovered', entry);
  }

  /**
   * Agent arar
   */
  query(filters: DirectoryQuery = {}): AgentEntry[] {
    const allAgents = [
      ...Array.from(this.localAgents.values()),
      ...Array.from(this.discoveredAgents.values()),
    ];

    let results = allAgents.filter(agent => {
      // TTL kontrolü
      const age = Date.now() - agent.lastSeen.getTime();
      if (age > agent.ttlSeconds * 1000) {
        return false;
      }

      // Status filtresi
      if (filters.status && agent.status !== filters.status) {
        return false;
      }

      // Capability filtresi
      if (filters.capabilities?.length) {
        const hasAll = filters.capabilities.every(cap =>
          agent.capabilities.includes(cap)
        );
        if (!hasAll) return false;
      }

      return true;
    });

    // Limit
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }

    this.emit('query', { query: filters, results });
    return results;
  }

  /**
   * DID ile agent bulur
   */
  findByDid(did: string): AgentEntry | undefined {
    return this.localAgents.get(did) || this.discoveredAgents.get(did);
  }

  /**
   * Yeteneklere göre agent bulur
   */
  findByCapability(capability: string, limit = 5): AgentEntry[] {
    return this.query({
      capabilities: [capability],
      limit,
      status: 'online',
    });
  }

  /**
   * Yerel agent'ları listeler
   */
  getLocalAgents(): AgentEntry[] {
    return Array.from(this.localAgents.values());
  }

  /**
   * Keşfedilen agent'ları listeler
   */
  getDiscoveredAgents(): AgentEntry[] {
    return Array.from(this.discoveredAgents.values());
  }

  /**
   * Agent'ı kaldırır
   */
  remove(did: string): boolean {
    const removedLocal = this.localAgents.delete(did);
    const removedDiscovered = this.discoveredAgents.delete(did);
    return removedLocal || removedDiscovered;
  }

  /**
   * İstatistikler
   */
  getStats(): {
    localCount: number;
    discoveredCount: number;
    onlineCount: number;
    offlineCount: number;
    busyCount: number;
  } {
    const allAgents = [
      ...Array.from(this.localAgents.values()),
      ...Array.from(this.discoveredAgents.values()),
    ];

    return {
      localCount: this.localAgents.size,
      discoveredCount: this.discoveredAgents.size,
      onlineCount: allAgents.filter(a => a.status === 'online').length,
      offlineCount: allAgents.filter(a => a.status === 'offline').length,
      busyCount: allAgents.filter(a => a.status === 'busy').length,
    };
  }

  /**
   * TTL cleanup başlatır
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // Her dakika
  }

  /**
   * Süresi dolmuş agent'ları temizler
   */
  private cleanupExpired(): void {
    const now = Date.now();

    // Keşfedilen agent'ları temizle
    for (const [did, entry] of this.discoveredAgents.entries()) {
      const age = now - entry.lastSeen.getTime();
      if (age > entry.ttlSeconds * 1000) {
        this.discoveredAgents.delete(did);
        this.emit('agent_expired', entry);
        console.log(`[Registry] Expired agent: ${did}`);
      }
    }
  }

  /**
   * Broadcast başlatır (periyodik yayın)
   */
  startBroadcast(intervalMs = 30000): void {
    this.broadcastInterval = setInterval(() => {
      for (const entry of this.localAgents.values()) {
        entry.lastSeen = new Date();
        this.emit('agent_updated', entry);
      }
    }, intervalMs);
  }

  /**
   * Broadcast durdurur
   */
  stopBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  /**
   * Cleanup durdurur
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Durdurur
   */
  destroy(): void {
    this.stopCleanup();
    this.stopBroadcast();
    this.removeAllListeners();
  }
}

/**
 * Varsayılan TTL: 5 dakika
 */
export const DEFAULT_TTL_SECONDS = 300;
