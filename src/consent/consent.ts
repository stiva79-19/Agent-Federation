/**
 * Consent Layer — İnsan Onay Sistemi
 * 
 * Her işlem için insan onayı gerekir.
 * Agent hiçbir şeyi insan onayı olmadan yapamaz.
 */

import { NetworkEgressFilter } from '../security/network-egress-filter';

export type ConsentAction =
  | 'accept_invitation'
  | 'reject_invitation'
  | 'share_file'
  | 'read_file'
  | 'write_file'
  | 'execute_code'
  | 'execute_code_with_network'
  | 'send_message'
  | 'invite_agent'
  | 'extend_permission'
  | 'extend_duration'
  | 'terminate_connection'
  | 'network_request';

export type ConsentResponse = 'approved' | 'rejected' | 'modified' | 'timeout';

export interface NetworkAccessDetails {
  /** Erişim istenen URL'ler */
  urls?: string[];
  /** Erişim istenen domain'ler */
  domains?: string[];
  /** HTTP method */
  method?: string;
  /** Request body var mı */
  hasBody?: boolean;
  /** Network egress filter instance (opsiyonel) */
  filter?: NetworkEgressFilter;
}

export interface ConsentRequest {
  id: string;
  /** Hangi agent istiyor */
  requesterDid: string;
  /** Ne yapmak istiyor */
  action: ConsentAction;
  /** Detay */
  details: Record<string, unknown> & { network?: NetworkAccessDetails };
  /** Risk skoru (0-100) */
  riskScore: number;
  /** Zaman aşımı (saniye) */
  timeoutSeconds: number;
  /** Oluşturulma zamanı */
  createdAt: Date;
}

export interface ConsentDecision {
  requestId: string;
  response: ConsentResponse;
  /** İnsan tarafından eklenen not */
  note?: string;
  /** Değiştirilmiş parametreler (modified cevabı için) */
  modifications?: Record<string, unknown>;
  decidedAt: Date;
}

export interface ConsentState {
  /** Bekleyen talepler */
  pending: ConsentRequest[];
  /** Karar geçmişi */
  history: (ConsentRequest & { decision: ConsentDecision })[];
  /** Maksimum bekleyen talep sayısı */
  maxPending: number;
}

/**
 * Subagent spawn depth limit
 * Security: Subagent → subagent spawn chain'ini sınırla
 */
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

export interface SubagentSpawnContext {
  /** Mevcut spawn derinliği */
  currentDepth: number;
  /** Maksimum izin verilen derinlik */
  maxDepth: number;
  /** Parent agent DID (spawn eden agent) */
  parentDid: string;
  /** Root agent DID (en üstteki agent) */
  rootDid: string;
}

export interface SubagentSpawnRequest {
  /** Spawn edecek agent DID */
  requesterDid: string;
  /** Spawn edilecek task */
  task: string;
  /** Opsiyonel label */
  label?: string;
  /** Mevcut spawn context (parent'tan gelen) */
  parentContext?: SubagentSpawnContext;
}

export class ConsentManager {
  private state: ConsentState;

  constructor() {
    this.state = {
      pending: [],
      history: [],
      maxPending: 10,
    };
  }

  /**
   * Yeni onay talebi oluşturur
   * KURAL: Her işlem için onay gerekir
   */
  request(request: Omit<ConsentRequest, 'id' | 'createdAt'>): ConsentRequest {
    if (this.state.pending.length >= this.state.maxPending) {
      throw new Error('Max pending consent requests reached');
    }

    const consentRequest: ConsentRequest = {
      ...request,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };

    this.state.pending.push(consentRequest);
    return consentRequest;
  }

  /**
   * İnsan kararını işler
   */
  decide(decision: ConsentDecision): void {
    const idx = this.state.pending.findIndex(r => r.id === decision.requestId);
    if (idx === -1) {
      throw new Error('Consent request not found');
    }

    const [request] = this.state.pending.splice(idx, 1);
    this.state.history.push({
      ...request,
      decision,
    });
  }

  /**
   * Bir talebin durumunu kontrol eder
   */
  getStatus(requestId: string): ConsentDecision | 'pending' | 'expired' | null {
    const inHistory = this.state.history.find(h => h.id === requestId);
    if (inHistory) return inHistory.decision;

    const pending = this.state.pending.find(r => r.id === requestId);
    if (pending) {
      const isExpired = Date.now() - pending.createdAt.getTime() > pending.timeoutSeconds * 1000;
      return isExpired ? 'expired' : 'pending';
    }

    return null;
  }

  /**
   * Risk skoru hesaplar (network erişim dahil)
   */
  static calculateRisk(action: ConsentAction, details: Record<string, unknown> & { network?: NetworkAccessDetails }): number {
    let score = 0;

    switch (action) {
      case 'read_file':
        score = 10;
        break;
      case 'share_file':
        score = 25;
        break;
      case 'write_file':
        score = 40;
        break;
      case 'execute_code':
        score = 60;
        break;
      case 'execute_code_with_network':
        score = 80; // Network erişimi olan kod çalıştırma daha yüksek risk
        break;
      case 'network_request':
        score = 50;
        break;
      case 'invite_agent':
        score = 35;
        break;
      case 'extend_permission':
        score = 50;
        break;
      default:
        score = 20;
    }

    // Path traversal denemesi → yüksek risk
    const path = details.path as string;
    if (path?.includes('..') || path?.includes('~') || path?.startsWith('/')) {
      score += 40;
    }

    // Network erişim riskleri
    const network = details.network;
    if (network) {
      // POST/PUT/DELETE gibi write method'ları daha yüksek risk
      if (network.method && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(network.method)) {
        score += 15;
      }
      
      // Request body var mı
      if (network.hasBody) {
        score += 10;
      }
      
      // Çok sayıda URL isteği
      if (network.urls && network.urls.length > 5) {
        score += 20;
      }
      
      // Private IP erişim denemesi
      if (network.urls) {
        const privateIPPatterns = [
          /127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
          /10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
          /192\.168\.\d{1,3}\.\d{1,3}/,
          /172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}/,
        ];
        
        for (const url of network.urls) {
          for (const pattern of privateIPPatterns) {
            if (pattern.test(url)) {
              score += 30; // Private IP erişim denemesi
              break;
            }
          }
        }
      }
    }

    return Math.min(score, 100);
  }

  getState(): ConsentState {
    return { ...this.state };
  }
}

/**
 * Subagent Spawn Depth Manager
 * Subagent → subagent spawn zincirini sınırlar
 */
export class SubagentDepthManager {
  private maxDepth: number;

  constructor(maxDepth: number = DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH) {
    this.maxDepth = maxDepth;
  }

  /**
   * Spawn request'in depth limit'i aşıp aşmadığını kontrol eder
   * @returns true ise spawn edilebilir, false ise engellenmeli
   */
  canSpawn(context?: SubagentSpawnContext): boolean {
    if (!context) return true; // Root level, her zaman spawn edebilir
    return context.currentDepth < this.maxDepth;
  }

  /**
   * Yeni spawn için child context oluşturur
   * @throws Error eğer max depth aşılmışsa
   */
  createChildContext(parent: SubagentSpawnContext, _childDid: string): SubagentSpawnContext {
    if (!this.canSpawn(parent)) {
      throw new Error(
        `Subagent spawn depth limit aşıldı: current=${parent.currentDepth}, max=${this.maxDepth}. ` +
        `Subagent → subagent spawn chain engellendi.`
      );
    }

    return {
      currentDepth: parent.currentDepth + 1,
      maxDepth: this.maxDepth,
      parentDid: parent.parentDid,
      rootDid: parent.rootDid,
    };
  }

  /**
   * Root spawn context oluşturur (ilk spawn için)
   */
  createRootContext(rootDid: string): SubagentSpawnContext {
    return {
      currentDepth: 0,
      maxDepth: this.maxDepth,
      parentDid: rootDid,
      rootDid,
    };
  }

  /**
   * Spawn depth bilgilerini consent request'e ekler
   */
  enrichConsentRequest(
    request: Omit<ConsentRequest, 'id' | 'createdAt'>,
    context?: SubagentSpawnContext
  ): Omit<ConsentRequest, 'id' | 'createdAt'> {
    if (!context) return request;

    return {
      ...request,
      details: {
        ...request.details,
        subagentDepth: context.currentDepth,
        subagentMaxDepth: context.maxDepth,
        subagentRootDid: context.rootDid,
        subagentParentDid: context.parentDid,
      },
    };
  }

  getMaxDepth(): number {
    return this.maxDepth;
  }
}
