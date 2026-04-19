/**
 * Approval System — Agent Federation Server
 *
 * Her sandbox değişikliği için insan onayı mekanizması.
 * İki mod: Manuel (default) ve Allow All.
 *
 * Manuel mod: Agent bir dosya değişikliği istediğinde dashboard'da onay kartı belirir.
 * Allow All mod: Tüm işlemler otomatik onaylanır (risk skoru >= 70 hariç).
 */

import * as crypto from 'crypto';
import { calculateRiskScore } from './sandbox-fs';
import type { SandboxActionType } from './sandbox-fs';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Onay modu */
export type ApprovalMode = 'manual' | 'allow_all';

/** Onay isteği durumu */
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'expired';

/** Bir onay isteği */
export interface ApprovalRequest {
  /** Benzersiz istek ID */
  id: string;
  /** Session ID */
  sessionId: string;
  /** İsteği yapan agent adı */
  agentName: string;
  /** Sandbox işlem tipi */
  action: SandboxActionType;
  /** Dosya/klasör yolu */
  filePath: string;
  /** İçerik (create/edit) */
  content?: string;
  /** Eski içerik (edit — diff için) */
  oldContent?: string;
  /** Edit payload tipi */
  editPayload?: { oldContent: string; newContent: string } | { fullContent: string };
  /** Risk skoru (0-100) */
  riskScore: number;
  /** Onay durumu */
  status: ApprovalRequestStatus;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Çözümlenme zamanı */
  resolvedAt?: Date;
  /** Çözümleyen (insan / auto) */
  resolvedBy?: string;
  /** İşlem sonucu mesajı */
  resultMessage?: string;
}

/** Risk eşiği — Allow All modunda bile onay gerektiren minimum skor */
const ALLOW_ALL_RISK_THRESHOLD = 70;

/** Onay isteği timeout süresi (ms) — 5 dakika */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Approval Manager ────────────────────────────────────────────────────────

/**
 * Onay kuyruğu ve yönetimi.
 * Her session için ayrı kuyruk tutar.
 */
export class ApprovalManager {
  /** Session ID → mevcut onay modu */
  private modes: Map<string, ApprovalMode> = new Map();
  /** Tüm onay istekleri (request ID → request) */
  private requests: Map<string, ApprovalRequest> = new Map();
  /** Session ID → bekleyen istekler listesi (sıralı) */
  private pendingQueues: Map<string, string[]> = new Map();
  /** Request ID → resolve callback (onay/red bekleyen promise'ler) */
  private waiters: Map<string, (approved: boolean) => void> = new Map();
  /** Timeout timer'ları */
  private timeouts: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Bir session için onay modunu ayarlar.
   */
  setMode(sessionId: string, mode: ApprovalMode): void {
    this.modes.set(sessionId, mode);
  }

  /**
   * Bir session'ın mevcut onay modunu döner.
   */
  getMode(sessionId: string): ApprovalMode {
    return this.modes.get(sessionId) ?? 'manual';
  }

  /**
   * Yeni bir onay isteği oluşturur.
   * Allow All modunda ve risk skoru düşükse otomatik onaylar.
   *
   * @returns [ApprovalRequest, needsHumanApproval]
   */
  createRequest(
    sessionId: string,
    agentName: string,
    action: SandboxActionType,
    filePath: string,
    content?: string,
    oldContent?: string,
    editPayload?: ApprovalRequest['editPayload']
  ): [ApprovalRequest, boolean] {
    const riskScore = calculateRiskScore(action, filePath, content);
    const mode = this.getMode(sessionId);

    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      sessionId,
      agentName,
      action,
      filePath,
      content,
      oldContent,
      editPayload,
      riskScore,
      status: 'pending',
      createdAt: new Date(),
    };

    this.requests.set(request.id, request);

    // Onay gerektirmeyen işlemler (file_read, file_list)
    if (action === 'file_read' || action === 'file_list') {
      request.status = 'auto_approved';
      request.resolvedAt = new Date();
      request.resolvedBy = 'system';
      return [request, false];
    }

    // Allow All modu — düşük riskli işlemleri otomatik onayla
    if (mode === 'allow_all' && riskScore < ALLOW_ALL_RISK_THRESHOLD) {
      request.status = 'auto_approved';
      request.resolvedAt = new Date();
      request.resolvedBy = 'auto_allow_all';
      return [request, false];
    }

    // Manuel onay gerekiyor
    const queue = this.pendingQueues.get(sessionId) ?? [];
    queue.push(request.id);
    this.pendingQueues.set(sessionId, queue);

    // Timeout ayarla
    const timeout = setTimeout(() => {
      this.expireRequest(request.id);
    }, APPROVAL_TIMEOUT_MS);
    this.timeouts.set(request.id, timeout);

    return [request, true];
  }

  /**
   * Onay isteğini onayla veya reddet.
   *
   * @param requestId - İstek ID
   * @param approved - Onay mı, red mi
   * @param resolvedBy - Kim tarafından (opsiyonel)
   * @returns Güncellenmiş istek
   */
  resolveRequest(
    requestId: string,
    approved: boolean,
    resolvedBy: string = 'human'
  ): ApprovalRequest {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Request ${requestId} is not pending (status: ${request.status})`);
    }

    request.status = approved ? 'approved' : 'rejected';
    request.resolvedAt = new Date();
    request.resolvedBy = resolvedBy;

    // Timeout temizle
    const timeout = this.timeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(requestId);
    }

    // Kuyruktan çıkar
    const queue = this.pendingQueues.get(request.sessionId);
    if (queue) {
      const idx = queue.indexOf(requestId);
      if (idx !== -1) queue.splice(idx, 1);
    }

    // Bekleyen promise'i çöz
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      waiter(approved);
      this.waiters.delete(requestId);
    }

    return request;
  }

  /**
   * Onay isteğini bekler (async).
   * Promise, onay/red geldiğinde veya timeout'ta çözülür.
   */
  waitForApproval(requestId: string): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request) {
      return Promise.reject(new Error(`Request not found: ${requestId}`));
    }

    // Zaten çözülmüşse hemen dön
    if (request.status === 'approved' || request.status === 'auto_approved') {
      return Promise.resolve(true);
    }
    if (request.status === 'rejected' || request.status === 'expired') {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      this.waiters.set(requestId, resolve);
    });
  }

  /**
   * Timeout'u geçen isteği expire eder.
   */
  private expireRequest(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return;

    request.status = 'expired';
    request.resolvedAt = new Date();
    request.resolvedBy = 'timeout';
    request.resultMessage = 'Approval request timed out';

    // Kuyruktan çıkar
    const queue = this.pendingQueues.get(request.sessionId);
    if (queue) {
      const idx = queue.indexOf(requestId);
      if (idx !== -1) queue.splice(idx, 1);
    }

    // Bekleyen promise'i çöz (red olarak)
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      waiter(false);
      this.waiters.delete(requestId);
    }

    this.timeouts.delete(requestId);
  }

  /**
   * Bir session'ın bekleyen onay isteklerini döner.
   */
  getPendingRequests(sessionId: string): ApprovalRequest[] {
    const queue = this.pendingQueues.get(sessionId) ?? [];
    return queue
      .map(id => this.requests.get(id))
      .filter((r): r is ApprovalRequest => r !== undefined && r.status === 'pending');
  }

  /**
   * Bir isteğin detaylarını döner.
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Bir session'ın tüm onay isteklerini döner (tamamlanmış dahil).
   */
  getAllRequests(sessionId: string): ApprovalRequest[] {
    return Array.from(this.requests.values())
      .filter(r => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Bir session'ın bekleyen istek sayısını döner.
   */
  getPendingCount(sessionId: string): number {
    return (this.pendingQueues.get(sessionId) ?? []).length;
  }

  /**
   * Session'ın tüm bekleyen isteklerini temizler (session sonu).
   */
  cleanupSession(sessionId: string): void {
    const queue = this.pendingQueues.get(sessionId) ?? [];
    for (const requestId of queue) {
      const timeout = this.timeouts.get(requestId);
      if (timeout) {
        clearTimeout(timeout);
        this.timeouts.delete(requestId);
      }
      const waiter = this.waiters.get(requestId);
      if (waiter) {
        waiter(false);
        this.waiters.delete(requestId);
      }
    }
    this.pendingQueues.delete(sessionId);
    this.modes.delete(sessionId);

    // İstekleri sil
    for (const [id, req] of this.requests) {
      if (req.sessionId === sessionId) {
        this.requests.delete(id);
      }
    }
  }

  /**
   * Tüm verileri temizler (test için).
   */
  clear(): void {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    for (const waiter of this.waiters.values()) {
      waiter(false);
    }
    this.waiters.clear();
    this.requests.clear();
    this.pendingQueues.clear();
    this.modes.clear();
  }

  /**
   * Onay istatistikleri.
   */
  getStats(sessionId: string): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    autoApproved: number;
    expired: number;
    mode: ApprovalMode;
  } {
    const all = this.getAllRequests(sessionId);
    return {
      total: all.length,
      pending: all.filter(r => r.status === 'pending').length,
      approved: all.filter(r => r.status === 'approved').length,
      rejected: all.filter(r => r.status === 'rejected').length,
      autoApproved: all.filter(r => r.status === 'auto_approved').length,
      expired: all.filter(r => r.status === 'expired').length,
      mode: this.getMode(sessionId),
    };
  }
}
