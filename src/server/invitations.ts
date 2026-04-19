/**
 * Invitation Module — Agent Federation Server
 *
 * Agent-to-agent davetiye sistemi. State machine: pending → accepted/declined/expired.
 * Agent A, Agent B'nin sahibine bir işbirliği daveti gönderir. Sahip onaylarsa
 * otomatik olarak bir collaboration session oluşturulur.
 */

import * as crypto from 'crypto';
import type { Permission } from '../identity/agent';

/**
 * Bir davetiyenin olası durumları.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/**
 * Davetiye mesaj tipi (WebSocket üzerinden gönderilen).
 */
export type InvitationMessageType =
  | 'invitation_request'
  | 'invitation_response'
  | 'invitation_expired';

/**
 * Agent-to-agent collaboration davetiyesi.
 * Bir agent başka bir agent'ın sahibine işbirliği talebi gönderir.
 */
export interface Invitation {
  /** Benzersiz davetiye ID */
  id: string;
  /** Gönderen agent DID */
  fromDid: string;
  /** Gönderen agent'ın sahibi */
  fromOwner: string;
  /** Alıcı agent DID */
  toDid: string;
  /** Alıcı agent'ın sahibi */
  toOwner: string;
  /** İşbirliği amacı */
  purpose: string;
  /** İstenen izinler */
  permissions: Permission[];
  /** Mevcut durum */
  status: InvitationStatus;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Son kullanım zamanı */
  expiresAt: Date;
  /** Yanıt zamanı (kabul veya red) */
  respondedAt?: Date;
  /** Red nedeni (opsiyonel) */
  declineReason?: string;
}

/**
 * Yeni davetiye oluşturma parametreleri.
 */
export interface CreateInvitationParams {
  fromDid: string;
  fromOwner: string;
  toDid: string;
  toOwner: string;
  purpose: string;
  permissions: Permission[];
  /** Davetiye geçerlilik süresi (dakika, varsayılan: 60) */
  expirationMinutes?: number;
}

/**
 * Davetiye yanıtı.
 */
export interface InvitationResponse {
  invitationId: string;
  accepted: boolean;
  declineReason?: string;
}

/**
 * Davetiye yöneticisi.
 * Davetiyeleri oluşturur, durum geçişlerini yönetir ve süresi dolan davetiyeleri temizler.
 */
export class InvitationManager {
  private invitations: Map<string, Invitation> = new Map();
  /** Varsayılan davetiye süresi (dakika) */
  private readonly defaultExpirationMinutes: number;
  /** Aynı çiftten maksimum bekleyen davetiye sayısı */
  private readonly maxPendingPerPair: number;
  /** Expired davetiye temizleme timer'ı */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: { defaultExpirationMinutes?: number; maxPendingPerPair?: number }) {
    this.defaultExpirationMinutes = options?.defaultExpirationMinutes ?? 60;
    this.maxPendingPerPair = options?.maxPendingPerPair ?? 3;
  }

  /**
   * Temizleme timer'ını başlatır. Her dakika süresi dolan davetiyeleri expire eder.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.expireStale();
    }, 60_000);
  }

  /**
   * Temizleme timer'ını durdurur.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Yeni davetiye oluşturur.
   *
   * @param params - Davetiye parametreleri
   * @returns Oluşturulan davetiye
   * @throws Aynı çift arasında çok fazla bekleyen davetiye varsa
   */
  create(params: CreateInvitationParams): Invitation {
    // Kendine davetiye gönderemez
    if (params.fromDid === params.toDid) {
      throw new Error('Cannot send invitation to self');
    }

    // Aynı çiftten max pending kontrol
    const pendingCount = this.getPendingBetween(params.fromDid, params.toDid).length;
    if (pendingCount >= this.maxPendingPerPair) {
      throw new Error(
        `Too many pending invitations between ${params.fromDid} and ${params.toDid} (max: ${this.maxPendingPerPair})`
      );
    }

    const expirationMinutes = params.expirationMinutes ?? this.defaultExpirationMinutes;

    const invitation: Invitation = {
      id: crypto.randomUUID(),
      fromDid: params.fromDid,
      fromOwner: params.fromOwner,
      toDid: params.toDid,
      toOwner: params.toOwner,
      purpose: params.purpose,
      permissions: [...params.permissions],
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + expirationMinutes * 60_000),
    };

    this.invitations.set(invitation.id, invitation);
    return invitation;
  }

  /**
   * Davetiyeyi kabul eder.
   *
   * @param invitationId - Davetiye ID
   * @returns Kabul edilen davetiye
   * @throws Davetiye bulunamazsa veya pending değilse
   */
  accept(invitationId: string): Invitation {
    const invitation = this.getOrThrow(invitationId);

    if (invitation.status !== 'pending') {
      throw new Error(`Invitation ${invitationId} is not pending (current: ${invitation.status})`);
    }

    if (this.isExpired(invitation)) {
      invitation.status = 'expired';
      throw new Error(`Invitation ${invitationId} has expired`);
    }

    invitation.status = 'accepted';
    invitation.respondedAt = new Date();
    return invitation;
  }

  /**
   * Davetiyeyi reddeder.
   *
   * @param invitationId - Davetiye ID
   * @param reason - Red nedeni (opsiyonel)
   * @returns Reddedilen davetiye
   * @throws Davetiye bulunamazsa veya pending değilse
   */
  decline(invitationId: string, reason?: string): Invitation {
    const invitation = this.getOrThrow(invitationId);

    if (invitation.status !== 'pending') {
      throw new Error(`Invitation ${invitationId} is not pending (current: ${invitation.status})`);
    }

    invitation.status = 'declined';
    invitation.respondedAt = new Date();
    invitation.declineReason = reason;
    return invitation;
  }

  /**
   * Davetiyeyi ID ile getirir.
   */
  get(invitationId: string): Invitation | undefined {
    return this.invitations.get(invitationId);
  }

  /**
   * Belirli bir agent'a gelen bekleyen davetiyeleri listeler.
   */
  getPendingForAgent(toDid: string): Invitation[] {
    return Array.from(this.invitations.values()).filter(
      inv => inv.toDid === toDid && inv.status === 'pending' && !this.isExpired(inv)
    );
  }

  /**
   * Belirli bir sahibe gelen bekleyen davetiyeleri listeler.
   */
  getPendingForOwner(ownerName: string): Invitation[] {
    return Array.from(this.invitations.values()).filter(
      inv => inv.toOwner === ownerName && inv.status === 'pending' && !this.isExpired(inv)
    );
  }

  /**
   * İki agent arasındaki bekleyen davetiyeleri listeler.
   */
  getPendingBetween(fromDid: string, toDid: string): Invitation[] {
    return Array.from(this.invitations.values()).filter(
      inv =>
        inv.fromDid === fromDid &&
        inv.toDid === toDid &&
        inv.status === 'pending' &&
        !this.isExpired(inv)
    );
  }

  /**
   * Tüm davetiyeleri listeler (opsiyonel filtre).
   */
  list(filter?: { status?: InvitationStatus; fromDid?: string; toDid?: string }): Invitation[] {
    let results = Array.from(this.invitations.values());

    if (filter?.status) {
      results = results.filter(inv => inv.status === filter.status);
    }
    if (filter?.fromDid) {
      results = results.filter(inv => inv.fromDid === filter.fromDid);
    }
    if (filter?.toDid) {
      results = results.filter(inv => inv.toDid === filter.toDid);
    }

    return results;
  }

  /**
   * Süresi dolmuş davetiyeleri expire eder.
   * @returns Expire edilen davetiye sayısı
   */
  expireStale(): number {
    let count = 0;
    for (const inv of this.invitations.values()) {
      if (inv.status === 'pending' && this.isExpired(inv)) {
        inv.status = 'expired';
        count++;
      }
    }
    return count;
  }

  /**
   * Toplam ve durum bazlı davetiye istatistikleri.
   */
  getStats(): { total: number; pending: number; accepted: number; declined: number; expired: number } {
    const all = Array.from(this.invitations.values());
    return {
      total: all.length,
      pending: all.filter(i => i.status === 'pending').length,
      accepted: all.filter(i => i.status === 'accepted').length,
      declined: all.filter(i => i.status === 'declined').length,
      expired: all.filter(i => i.status === 'expired').length,
    };
  }

  /**
   * Tüm davetiyeleri temizler (test için).
   */
  clear(): void {
    this.invitations.clear();
  }

  /** Davetiye süresi dolmuş mu kontrol eder. */
  private isExpired(invitation: Invitation): boolean {
    return Date.now() >= invitation.expiresAt.getTime();
  }

  /** Davetiyeyi getir, yoksa hata fırlat. */
  private getOrThrow(invitationId: string): Invitation {
    const inv = this.invitations.get(invitationId);
    if (!inv) {
      throw new Error(`Invitation not found: ${invitationId}`);
    }
    return inv;
  }
}
