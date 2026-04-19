/**
 * Sessions Module — Agent Federation Server
 *
 * Collaboration session lifecycle. Kabul edilen bir davetiye sonrası otomatik olarak
 * bir session oluşturulur, agent'lar gruba eklenir, izinler kaydedilir.
 * Her iki sahip de oturumu sonlandırabilir. Timeout mekanizması vardır.
 */

import * as crypto from 'crypto';
import type { Permission } from '../identity/agent';
import type { Invitation } from './invitations';

/**
 * Session durumları.
 */
export type SessionStatus = 'active' | 'ended' | 'expired';

/**
 * Session sonlandırma nedeni.
 */
export type EndReason = 'owner_ended' | 'timeout' | 'server_shutdown' | 'error';

/**
 * Session'daki bir katılımcı agent.
 */
export interface SessionParticipant {
  did: string;
  ownerName: string;
  permissions: Permission[];
  joinedAt: Date;
}

/**
 * Session aktivite kaydı.
 */
export interface SessionActivity {
  timestamp: Date;
  agentDid: string;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * Collaboration session. İki veya daha fazla agent'ın belirli izinler dahilinde
 * birlikte çalıştığı geçici oturum.
 */
export interface CollaborationSession {
  /** Benzersiz session ID */
  id: string;
  /** Session'ı tetikleyen davetiye ID */
  invitationId: string;
  /** Katılımcı agent'lar */
  participants: SessionParticipant[];
  /** Session durumu */
  status: SessionStatus;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Bitiş zamanı (aktifse undefined) */
  endedAt?: Date;
  /** Otomatik timeout zamanı */
  expiresAt: Date;
  /** Sonlandırma nedeni */
  endReason?: EndReason;
  /** Toplam gönderilen mesaj sayısı */
  messageCount: number;
  /** Aktivite logu */
  activityLog: SessionActivity[];
}

/**
 * Session oluşturma parametreleri.
 */
export interface CreateSessionParams {
  invitation: Invitation;
  /** Session süresi (dakika, varsayılan: 60) */
  timeoutMinutes?: number;
}

/**
 * Collaboration session yöneticisi.
 * Session oluşturma, sonlandırma, timeout ve aktivite loglama.
 */
export class SessionManager {
  private sessions: Map<string, CollaborationSession> = new Map();
  /** Varsayılan session süresi (dakika) */
  private readonly defaultTimeoutMinutes: number;
  /** Expired session temizleme timer'ı */
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Session event callback'leri */
  private onSessionEndCallbacks: Array<(session: CollaborationSession) => void> = [];

  constructor(options?: { defaultTimeoutMinutes?: number }) {
    this.defaultTimeoutMinutes = options?.defaultTimeoutMinutes ?? 60;
  }

  /**
   * Temizleme timer'ını başlatır.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.expireStale();
    }, 30_000);
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
   * Session sonlanma callback'i kaydeder.
   */
  onSessionEnd(callback: (session: CollaborationSession) => void): void {
    this.onSessionEndCallbacks.push(callback);
  }

  /**
   * Kabul edilen davetiyeden yeni session oluşturur.
   * Her iki agent otomatik olarak katılımcı olarak eklenir.
   *
   * @param params - Session parametreleri
   * @returns Oluşturulan session
   * @throws Davetiye accepted değilse
   */
  createFromInvitation(params: CreateSessionParams): CollaborationSession {
    const { invitation } = params;

    if (invitation.status !== 'accepted') {
      throw new Error(`Cannot create session from non-accepted invitation (status: ${invitation.status})`);
    }

    // Aynı davetiyeden zaten aktif session var mı?
    const existing = this.getByInvitation(invitation.id);
    if (existing && existing.status === 'active') {
      throw new Error(`Active session already exists for invitation ${invitation.id}`);
    }

    const timeoutMinutes = params.timeoutMinutes ?? this.defaultTimeoutMinutes;

    const session: CollaborationSession = {
      id: crypto.randomUUID(),
      invitationId: invitation.id,
      participants: [
        {
          did: invitation.fromDid,
          ownerName: invitation.fromOwner,
          permissions: [...invitation.permissions],
          joinedAt: new Date(),
        },
        {
          did: invitation.toDid,
          ownerName: invitation.toOwner,
          permissions: [...invitation.permissions],
          joinedAt: new Date(),
        },
      ],
      status: 'active',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + timeoutMinutes * 60_000),
      messageCount: 0,
      activityLog: [
        {
          timestamp: new Date(),
          agentDid: 'system',
          action: 'session_created',
          details: {
            invitationId: invitation.id,
            participants: [invitation.fromDid, invitation.toDid],
          },
        },
      ],
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Session'ı sonlandırır.
   *
   * @param sessionId - Session ID
   * @param reason - Sonlandırma nedeni
   * @param endedBy - Sonlandıran agent veya sahip DID'si (opsiyonel)
   * @returns Sonlandırılan session
   */
  endSession(sessionId: string, reason: EndReason, endedBy?: string): CollaborationSession {
    const session = this.getOrThrow(sessionId);

    if (session.status !== 'active') {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }

    session.status = 'ended';
    session.endedAt = new Date();
    session.endReason = reason;
    session.activityLog.push({
      timestamp: new Date(),
      agentDid: endedBy ?? 'system',
      action: 'session_ended',
      details: { reason },
    });

    // Callback'leri çağır
    for (const cb of this.onSessionEndCallbacks) {
      try { cb(session); } catch { /* ignore callback errors */ }
    }

    return session;
  }

  /**
   * Session'a mesaj kaydı ekler (sayaç artırma + log).
   */
  recordMessage(sessionId: string, fromDid: string, summary?: string): void {
    const session = this.getOrThrow(sessionId);

    if (session.status !== 'active') {
      throw new Error(`Cannot record message in inactive session ${sessionId}`);
    }

    session.messageCount++;
    session.activityLog.push({
      timestamp: new Date(),
      agentDid: fromDid,
      action: 'message_sent',
      details: summary ? { summary } : undefined,
    });
  }

  /**
   * Bir agent'ın belirli bir session'da belirli bir izne sahip olup olmadığını kontrol eder.
   */
  hasPermission(sessionId: string, agentDid: string, permission: Permission): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;

    const participant = session.participants.find(p => p.did === agentDid);
    if (!participant) return false;

    return participant.permissions.includes(permission);
  }

  /**
   * Session'ı ID ile getirir.
   */
  get(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Davetiye ID ile session'ı getirir.
   */
  getByInvitation(invitationId: string): CollaborationSession | undefined {
    return Array.from(this.sessions.values()).find(s => s.invitationId === invitationId);
  }

  /**
   * Bir agent'ın aktif session'larını listeler.
   */
  getActiveForAgent(agentDid: string): CollaborationSession[] {
    return Array.from(this.sessions.values()).filter(
      s =>
        s.status === 'active' &&
        s.participants.some(p => p.did === agentDid)
    );
  }

  /**
   * Bir sahibin aktif session'larını listeler.
   */
  getActiveForOwner(ownerName: string): CollaborationSession[] {
    return Array.from(this.sessions.values()).filter(
      s =>
        s.status === 'active' &&
        s.participants.some(p => p.ownerName === ownerName)
    );
  }

  /**
   * Tüm aktif session'ları listeler.
   */
  getActiveSessions(): CollaborationSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }

  /**
   * Tüm session'ları sonlandırır (server shutdown).
   */
  endAll(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'active') {
        session.status = 'ended';
        session.endedAt = new Date();
        session.endReason = 'server_shutdown';
      }
    }
  }

  /**
   * Süresi dolmuş session'ları expire eder.
   * @returns Expire edilen session sayısı
   */
  expireStale(): number {
    let count = 0;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status === 'active' && now >= session.expiresAt.getTime()) {
        session.status = 'expired';
        session.endedAt = new Date();
        session.endReason = 'timeout';
        session.activityLog.push({
          timestamp: new Date(),
          agentDid: 'system',
          action: 'session_expired',
          details: { expiresAt: session.expiresAt.toISOString() },
        });
        count++;

        for (const cb of this.onSessionEndCallbacks) {
          try { cb(session); } catch { /* ignore */ }
        }
      }
    }
    return count;
  }

  /**
   * Session istatistikleri.
   */
  getStats(): { total: number; active: number; ended: number; expired: number; totalMessages: number } {
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      active: all.filter(s => s.status === 'active').length,
      ended: all.filter(s => s.status === 'ended').length,
      expired: all.filter(s => s.status === 'expired').length,
      totalMessages: all.reduce((sum, s) => sum + s.messageCount, 0),
    };
  }

  /**
   * Tüm session'ları temizler (test için).
   */
  clear(): void {
    this.sessions.clear();
  }

  /** Session'ı getir, yoksa hata fırlat. */
  private getOrThrow(sessionId: string): CollaborationSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
