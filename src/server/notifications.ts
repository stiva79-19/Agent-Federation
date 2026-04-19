/**
 * Notifications Module — Agent Federation Server
 *
 * Agent sahiplerine gerçek zamanlı bildirim gönderme.
 * WebSocket üzerinden davetiye bildirimleri, session eventleri, aktivite logları.
 */

import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import type { Invitation } from './invitations';
import type { CollaborationSession } from './sessions';

/**
 * Bildirim tipleri.
 */
export type NotificationType =
  | 'invitation_received'
  | 'invitation_accepted'
  | 'invitation_declined'
  | 'invitation_expired'
  | 'session_started'
  | 'session_ended'
  | 'session_expired'
  | 'activity_alert';

/**
 * Bildirim seviyesi.
 */
export type NotificationPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Bir bildirim mesajı.
 */
export interface Notification {
  /** Benzersiz bildirim ID */
  id: string;
  /** Bildirim tipi */
  type: NotificationType;
  /** Hedef sahip adı */
  targetOwner: string;
  /** Bildirim başlığı */
  title: string;
  /** Detaylı mesaj */
  message: string;
  /** Ek veri */
  data: Record<string, unknown>;
  /** Öncelik seviyesi */
  priority: NotificationPriority;
  /** Oluşturulma zamanı */
  createdAt: Date;
  /** Okundu mu */
  read: boolean;
}

/**
 * Sahip WebSocket bağlantısı.
 * Agent sahipleri bu bağlantı üzerinden bildirim alır.
 */
export interface OwnerConnection {
  ownerName: string;
  ws: WebSocket;
  connectedAt: Date;
}

/**
 * Bildirim yöneticisi.
 * Sahiplere gerçek zamanlı bildirim gönderir ve bildirim geçmişi tutar.
 */
export class NotificationManager {
  /** Sahip bağlantıları (ownerName → OwnerConnection) */
  private ownerConnections: Map<string, OwnerConnection> = new Map();
  /** Bildirim geçmişi (son 500) */
  private notifications: Notification[] = [];
  /** Maksimum bildirim geçmişi sayısı */
  private readonly maxHistory: number;

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 500;
  }

  /**
   * Sahip WebSocket bağlantısını kaydeder.
   */
  registerOwner(ownerName: string, ws: WebSocket): void {
    this.ownerConnections.set(ownerName, {
      ownerName,
      ws,
      connectedAt: new Date(),
    });
  }

  /**
   * Sahip bağlantısını kaldırır.
   */
  unregisterOwner(ownerName: string): void {
    this.ownerConnections.delete(ownerName);
  }

  /**
   * Sahibin bağlı olup olmadığını kontrol eder.
   */
  isOwnerConnected(ownerName: string): boolean {
    const conn = this.ownerConnections.get(ownerName);
    return !!conn && conn.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Yeni davetiye alındı bildirimi gönderir.
   */
  notifyInvitationReceived(invitation: Invitation): Notification {
    return this.send({
      type: 'invitation_received',
      targetOwner: invitation.toOwner,
      title: 'Yeni İşbirliği Daveti',
      message: `${invitation.fromOwner}'in ${invitation.fromDid} agent'ı, sizin ${invitation.toDid} agent'ınızla işbirliği yapmak istiyor. Amaç: ${invitation.purpose}`,
      data: {
        invitationId: invitation.id,
        fromDid: invitation.fromDid,
        fromOwner: invitation.fromOwner,
        toDid: invitation.toDid,
        purpose: invitation.purpose,
        permissions: invitation.permissions,
        expiresAt: invitation.expiresAt.toISOString(),
      },
      priority: 'high',
    });
  }

  /**
   * Davetiye kabul edildi bildirimi gönderir (gönderen sahibe).
   */
  notifyInvitationAccepted(invitation: Invitation): Notification {
    return this.send({
      type: 'invitation_accepted',
      targetOwner: invitation.fromOwner,
      title: 'Davetiye Kabul Edildi',
      message: `${invitation.toOwner}, ${invitation.toDid} agent'ı ile işbirliği davetinizi kabul etti.`,
      data: {
        invitationId: invitation.id,
        toDid: invitation.toDid,
        toOwner: invitation.toOwner,
      },
      priority: 'medium',
    });
  }

  /**
   * Davetiye reddedildi bildirimi gönderir (gönderen sahibe).
   */
  notifyInvitationDeclined(invitation: Invitation): Notification {
    return this.send({
      type: 'invitation_declined',
      targetOwner: invitation.fromOwner,
      title: 'Davetiye Reddedildi',
      message: `${invitation.toOwner}, işbirliği davetinizi reddetti.${invitation.declineReason ? ` Neden: ${invitation.declineReason}` : ''}`,
      data: {
        invitationId: invitation.id,
        toDid: invitation.toDid,
        toOwner: invitation.toOwner,
        reason: invitation.declineReason,
      },
      priority: 'medium',
    });
  }

  /**
   * Session başladı bildirimi gönderir (her iki sahibe).
   */
  notifySessionStarted(session: CollaborationSession): Notification[] {
    const owners = [...new Set(session.participants.map(p => p.ownerName))];
    return owners.map(owner =>
      this.send({
        type: 'session_started',
        targetOwner: owner,
        title: 'İşbirliği Oturumu Başladı',
        message: `Agent'larınız arasında bir işbirliği oturumu başladı. Katılımcılar: ${session.participants.map(p => p.did).join(', ')}`,
        data: {
          sessionId: session.id,
          invitationId: session.invitationId,
          participants: session.participants.map(p => ({
            did: p.did,
            owner: p.ownerName,
            permissions: p.permissions,
          })),
          expiresAt: session.expiresAt.toISOString(),
        },
        priority: 'high',
      })
    );
  }

  /**
   * Session sonlandı bildirimi gönderir (her iki sahibe).
   */
  notifySessionEnded(session: CollaborationSession): Notification[] {
    const owners = [...new Set(session.participants.map(p => p.ownerName))];
    return owners.map(owner =>
      this.send({
        type: 'session_ended',
        targetOwner: owner,
        title: 'İşbirliği Oturumu Sona Erdi',
        message: `İşbirliği oturumu sona erdi. Toplam ${session.messageCount} mesaj gönderildi. Neden: ${session.endReason}`,
        data: {
          sessionId: session.id,
          messageCount: session.messageCount,
          endReason: session.endReason,
          duration: session.endedAt
            ? session.endedAt.getTime() - session.createdAt.getTime()
            : undefined,
        },
        priority: 'medium',
      })
    );
  }

  /**
   * Genel bildirim gönderir.
   */
  send(params: Omit<Notification, 'id' | 'createdAt' | 'read'>): Notification {
    const notification: Notification = {
      ...params,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      read: false,
    };

    // Geçmişe ekle
    this.notifications.push(notification);
    if (this.notifications.length > this.maxHistory) {
      this.notifications = this.notifications.slice(-this.maxHistory);
    }

    // WebSocket ile gönder
    this.deliverToOwner(notification);

    return notification;
  }

  /**
   * Bildirimi okundu olarak işaretle.
   */
  markAsRead(notificationId: string): boolean {
    const notif = this.notifications.find(n => n.id === notificationId);
    if (notif) {
      notif.read = true;
      return true;
    }
    return false;
  }

  /**
   * Bir sahibin bildirimlerini listeler.
   */
  getForOwner(ownerName: string, options?: { unreadOnly?: boolean; limit?: number }): Notification[] {
    let results = this.notifications.filter(n => n.targetOwner === ownerName);

    if (options?.unreadOnly) {
      results = results.filter(n => !n.read);
    }

    const limit = options?.limit ?? 50;
    return results.slice(-limit);
  }

  /**
   * Toplam bildirim istatistikleri.
   */
  getStats(): { total: number; unread: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    let unread = 0;

    for (const n of this.notifications) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
      if (!n.read) unread++;
    }

    return {
      total: this.notifications.length,
      unread,
      byType,
    };
  }

  /**
   * Tüm bildirimleri ve bağlantıları temizler (test için).
   */
  clear(): void {
    this.notifications = [];
    this.ownerConnections.clear();
  }

  /**
   * Bildirimi WebSocket üzerinden sahibe iletir.
   */
  private deliverToOwner(notification: Notification): boolean {
    const conn = this.ownerConnections.get(notification.targetOwner);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      conn.ws.send(JSON.stringify({
        type: 'notification',
        notification,
      }));
      return true;
    } catch {
      return false;
    }
  }
}
