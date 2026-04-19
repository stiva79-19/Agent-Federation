/**
 * P2P Connection Module — Agent Federation
 *
 * Basit davet kodu sistemi ile iki kullanıcıyı eşleştirir.
 * Host bir davet kodu oluşturur, guest bu kodu girerek host'a bağlanır.
 * Bağlantı kurulduktan sonra her iki taraf birbirine mesaj gönderebilir.
 */

import * as crypto from 'crypto';

/**
 * Davet kodu durumları.
 */
export type InviteCodeStatus = 'waiting' | 'connected' | 'expired' | 'used';

/**
 * Bir P2P davet kodu kaydı.
 */
export interface InviteCode {
  /** Davet kodu (örn: AF-7K3M9X) */
  code: string;
  /** Oluşturan host'un client ID'si */
  hostClientId: string;
  /** Host agent adı */
  hostAgentName: string;
  /** Bağlanan guest'in client ID'si (bağlanınca dolar) */
  guestClientId: string | null;
  /** Guest agent adı */
  guestAgentName: string | null;
  /** Durum */
  status: InviteCodeStatus;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Son kullanım zamanı (5 dakika) */
  expiresAt: Date;
}

/**
 * P2P eşleşme sonucu.
 */
export interface P2PMatch {
  code: string;
  hostClientId: string;
  hostAgentName: string;
  guestClientId: string;
  guestAgentName: string;
  matchedAt: Date;
}

/**
 * P2P bağlantı yöneticisi.
 * Davet kodları üretir, doğrular ve eşleştirme yapar.
 */
export class P2PManager {
  private inviteCodes: Map<string, InviteCode> = new Map();
  /** Aktif P2P eşleşmeleri (code → match) */
  private matches: Map<string, P2PMatch> = new Map();
  /** Client ID → eşleşme kodu mapping */
  private clientToMatch: Map<string, string> = new Map();
  /** Temizleme timer'ı */
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Davet kodu geçerlilik süresi (ms) */
  private readonly codeTTL: number;

  constructor(options?: { codeTTLMinutes?: number }) {
    this.codeTTL = (options?.codeTTLMinutes ?? 5) * 60_000;
  }

  /**
   * 6 haneli alfanumerik davet kodu üretir.
   * Format: AF-XXXXXX (büyük harf + rakam)
   */
  generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Karışıklık yaratan karakterler çıkarıldı: 0/O, 1/I/L
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return `AF-${code}`;
  }

  /**
   * Yeni davet kodu oluşturur.
   *
   * @param hostClientId - Host'un WebSocket client ID'si
   * @param hostAgentName - Host'un agent adı
   * @returns Oluşturulan davet kodu
   */
  createInvitation(hostClientId: string, hostAgentName: string): InviteCode {
    // Aynı host'un önceki bekleyen kodlarını iptal et
    for (const [code, invite] of this.inviteCodes.entries()) {
      if (invite.hostClientId === hostClientId && invite.status === 'waiting') {
        invite.status = 'expired';
        this.inviteCodes.delete(code);
      }
    }

    const code = this.generateCode();
    const now = new Date();

    const invite: InviteCode = {
      code,
      hostClientId,
      hostAgentName,
      guestClientId: null,
      guestAgentName: null,
      status: 'waiting',
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.codeTTL),
    };

    this.inviteCodes.set(code, invite);
    return invite;
  }

  /**
   * Guest davet kodunu kullanarak bağlanır.
   *
   * @param code - Davet kodu
   * @param guestClientId - Guest'in WebSocket client ID'si
   * @param guestAgentName - Guest'in agent adı
   * @returns Eşleşme bilgisi
   * @throws Kod geçersiz, expired veya zaten kullanılmışsa
   */
  joinInvitation(code: string, guestClientId: string, guestAgentName: string): P2PMatch {
    const normalizedCode = code.toUpperCase().trim();
    const invite = this.inviteCodes.get(normalizedCode);

    if (!invite) {
      throw new Error('Geçersiz davet kodu');
    }

    if (invite.status !== 'waiting') {
      throw new Error(`Davet kodu zaten ${invite.status === 'used' ? 'kullanılmış' : 'süresi dolmuş'}`);
    }

    if (Date.now() >= invite.expiresAt.getTime()) {
      invite.status = 'expired';
      throw new Error('Davet kodunun süresi dolmuş');
    }

    if (invite.hostClientId === guestClientId) {
      throw new Error('Kendi davet kodunuza katılamazsınız');
    }

    // Eşleştirme yap
    invite.status = 'used';
    invite.guestClientId = guestClientId;
    invite.guestAgentName = guestAgentName;

    const match: P2PMatch = {
      code: normalizedCode,
      hostClientId: invite.hostClientId,
      hostAgentName: invite.hostAgentName,
      guestClientId,
      guestAgentName,
      matchedAt: new Date(),
    };

    this.matches.set(normalizedCode, match);
    this.clientToMatch.set(invite.hostClientId, normalizedCode);
    this.clientToMatch.set(guestClientId, normalizedCode);

    return match;
  }

  /**
   * Client ID'den eşleşme bilgisini getirir.
   */
  getMatchByClient(clientId: string): P2PMatch | undefined {
    const code = this.clientToMatch.get(clientId);
    if (!code) return undefined;
    return this.matches.get(code);
  }

  /**
   * Bir client'ın eşleştiği karşı tarafın client ID'sini döner.
   */
  getPeerId(clientId: string): string | undefined {
    const match = this.getMatchByClient(clientId);
    if (!match) return undefined;
    return match.hostClientId === clientId ? match.guestClientId : match.hostClientId;
  }

  /**
   * Client'ın host mu guest mi olduğunu döner.
   */
  getRole(clientId: string): 'host' | 'guest' | null {
    const match = this.getMatchByClient(clientId);
    if (!match) return null;
    if (match.hostClientId === clientId) return 'host';
    if (match.guestClientId === clientId) return 'guest';
    return null;
  }

  /**
   * Eşleşmeyi sonlandırır.
   */
  disconnectClient(clientId: string): P2PMatch | undefined {
    const code = this.clientToMatch.get(clientId);
    if (!code) return undefined;

    const match = this.matches.get(code);
    if (!match) return undefined;

    // Her iki tarafın mapping'ini temizle
    this.clientToMatch.delete(match.hostClientId);
    this.clientToMatch.delete(match.guestClientId);
    this.matches.delete(code);
    this.inviteCodes.delete(code);

    return match;
  }

  /**
   * Davet kodunu getirir (durum kontrolü için).
   */
  getInviteCode(code: string): InviteCode | undefined {
    return this.inviteCodes.get(code.toUpperCase().trim());
  }

  /**
   * Süresi dolmuş kodları temizler.
   */
  expireStale(): number {
    let count = 0;
    const now = Date.now();
    for (const [code, invite] of this.inviteCodes.entries()) {
      if (invite.status === 'waiting' && now >= invite.expiresAt.getTime()) {
        invite.status = 'expired';
        this.inviteCodes.delete(code);
        count++;
      }
    }
    return count;
  }

  /**
   * Periyodik temizleme başlatır.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.expireStale();
    }, 30_000);
  }

  /**
   * Periyodik temizlemeyi durdurur.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Aktif bekleyen davet kodlarını döner (debug için).
   */
  getActiveCodes(): string[] {
    const active: string[] = [];
    for (const [code, invite] of this.inviteCodes.entries()) {
      if (invite.status === 'waiting' && Date.now() < invite.expiresAt.getTime()) {
        active.push(code);
      }
    }
    return active;
  }

  /**
   * İstatistikler.
   */
  getStats(): { activeInvites: number; activeMatches: number } {
    let activeInvites = 0;
    for (const invite of this.inviteCodes.values()) {
      if (invite.status === 'waiting') activeInvites++;
    }
    return {
      activeInvites,
      activeMatches: this.matches.size,
    };
  }

  /**
   * Tüm verileri temizler (test için).
   */
  clear(): void {
    this.inviteCodes.clear();
    this.matches.clear();
    this.clientToMatch.clear();
  }
}
