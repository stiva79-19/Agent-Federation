/**
 * Audit Logger — Güvenlik Olaylarını Loglar
 * 
 * Tüm güvenlik olaylarını (auth, rate limit, blocked messages) loglar.
 * Production'da remote SIEM sistemine gönderilebilir.
 */

import * as fs from 'fs';
import * as path from 'path';

export type AuditEventType =
  | 'auth_success'
  | 'auth_failure'
  | 'message_blocked'
  | 'rate_limit_exceeded'
  | 'connection_hijack_attempt'
  | 'output_blocked'
  | 'session_expired'
  | 'signature_invalid'
  | 'consent_requested'
  | 'consent_auto_rejected'
  | 'network_access_requested'
  | 'network_access_blocked'
  | 'network_access_success'
  | 'network_access_error';

export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AuditLogEntry {
  /** Timestamp */
  timestamp: Date;
  /** Olay tipi */
  eventType: AuditEventType;
  /** Agent DID */
  agentDid?: string;
  /** IP adresi */
  ipAddress?: string;
  /** Detaylar */
  details: Record<string, unknown>;
  /** Severity */
  severity: AuditSeverity;
  /** Session ID */
  sessionId?: string;
}

export class AuditLogger {
  private logPath: string;
  private queue: AuditLogEntry[] = [];
  private readonly maxQueueSize = 100;
  private readonly logFile = 'audit-log.jsonl';

  constructor(logDir: string = './logs') {
    this.logPath = path.join(logDir, this.logFile);
    
    // Log dizinini oluştur
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Audit log entry ekler
   */
  async log(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
    const logEntry: AuditLogEntry = {
      ...entry,
      timestamp: new Date(),
    };

    // Console log (development)
    this.consoleLog(logEntry);

    // Queue'ya ekle
    this.queue.push(logEntry);

    // Queue dolarsa flush et
    if (this.queue.length >= this.maxQueueSize) {
      await this.flush();
    }

    // Critical olayları hemen flush et
    if (logEntry.severity === 'critical') {
      await this.flush();
      // Alert gönder (future: webhook, email, Slack)
      this.sendAlert(logEntry);
    }
  }

  /**
   * Queue'daki tüm logları dosyaya yazar
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const lines = this.queue.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    
    try {
      fs.appendFileSync(this.logPath, lines);
      this.queue = [];
    } catch (error) {
      console.error('[AuditLogger] Failed to write logs:', error);
    }
  }

  /**
   * Console log (development için)
   */
  private consoleLog(entry: AuditLogEntry): void {
    const severityEmoji = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };

    console.log(
      `${severityEmoji[entry.severity]} [AUDIT] ${entry.eventType} - ${entry.agentDid || 'unknown'} - ${JSON.stringify(entry.details)}`
    );
  }

  /**
   * Alert gönder (critical olaylar için)
   */
  private sendAlert(entry: AuditLogEntry): void {
    // TODO: Webhook, email, Slack alert
    console.warn(`🚨 CRITICAL ALERT: ${entry.eventType} - ${entry.agentDid}`);
  }

  /**
   * Logları okur
   */
  readLogs(limit: number = 100): AuditLogEntry[] {
    if (!fs.existsSync(this.logPath)) return [];

    const content = fs.readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    return lines
      .slice(-limit)
      .map(line => JSON.parse(line) as AuditLogEntry);
  }

  /**
   * Belirli bir event tipini arar
   */
  searchByEvent(eventType: AuditEventType, limit: number = 50): AuditLogEntry[] {
    const allLogs = this.readLogs(1000);
    return allLogs
      .filter(log => log.eventType === eventType)
      .slice(-limit);
  }

  /**
   * Belirli bir agent'ın loglarını arar
   */
  searchByAgent(did: string, limit: number = 50): AuditLogEntry[] {
    const allLogs = this.readLogs(1000);
    return allLogs
      .filter(log => log.agentDid === did)
      .slice(-limit);
  }

  /**
   * Eski logları temizler (rotation)
   */
  rotate(maxAgeDays: number = 7): void {
    if (!fs.existsSync(this.logPath)) return;

    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const content = fs.readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    const filtered = lines.filter(line => {
      try {
        const log = JSON.parse(line) as AuditLogEntry;
        return log.timestamp.getTime() > cutoff;
      } catch {
        return false;
      }
    });

    fs.writeFileSync(this.logPath, filtered.join('\n') + '\n');
  }
}

/**
 * Singleton instance
 */
export const auditLogger = new AuditLogger();
