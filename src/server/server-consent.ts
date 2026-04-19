/**
 * Server Consent Module — Agent Federation Server
 *
 * Server tarafındaki consent akışı: kod çalıştırma onayı, network erişim onayı,
 * güvenli network request'leri. ConsentManager ve NetworkEgressFilter'ı birleştirir.
 */

import * as crypto from 'crypto';
import { auditLogger } from './audit-logger';
import { NetworkEgressFilter } from '../security/network-egress-filter';
import { ConsentManager, ConsentAction } from '../consent/consent';

/**
 * Kod çalıştırma consent isteği seçenekleri.
 */
export interface ExecuteCodeConsentOptions {
  requiresNetwork?: boolean;
  networkUrls?: string[];
}

/**
 * Consent isteği sonucu.
 */
export interface ConsentRequestResult {
  consentRequired: boolean;
  requestId?: string;
  riskScore: number;
}

/**
 * Güvenli network request seçenekleri.
 */
export interface SecureNetworkRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Düşük riskli istekler için consent atla */
  skipConsent?: boolean;
  timeout?: number;
}

/**
 * Server tarafında consent ve network güvenliğini yöneten sınıf.
 * ConsentManager ile risk skorlama, NetworkEgressFilter ile URL doğrulama yapar.
 */
export class ServerConsentHandler {
  private networkFilter: NetworkEgressFilter;
  private consentManager: ConsentManager;

  constructor(networkFilter: NetworkEgressFilter, consentManager: ConsentManager) {
    this.networkFilter = networkFilter;
    this.consentManager = consentManager;
  }

  /**
   * Network egress filter instance'ını döner.
   */
  getNetworkFilter(): NetworkEgressFilter {
    return this.networkFilter;
  }

  /**
   * Consent manager instance'ını döner.
   */
  getConsentManager(): ConsentManager {
    return this.consentManager;
  }

  /**
   * Execute code action için onay talebi oluşturur.
   * Network erişimi gerekiyorsa URL'ler ayrıca doğrulanır.
   *
   * @param agentDid - İsteği yapan agent'ın DID'si
   * @param code - Çalıştırılacak kod
   * @param options - Ek seçenekler (network gereklilikleri)
   * @returns Consent sonucu
   */
  async requestExecuteCodeConsent(
    agentDid: string,
    code: string,
    options?: ExecuteCodeConsentOptions
  ): Promise<ConsentRequestResult> {
    const requiresNetwork = options?.requiresNetwork || false;
    const action: ConsentAction = requiresNetwork ? 'execute_code_with_network' : 'execute_code';

    const details: Record<string, unknown> = {
      code,
      codeHash: crypto.createHash('sha256').update(code).digest('hex').slice(0, 16),
    };

    if (requiresNetwork && options?.networkUrls) {
      details.network = {
        urls: options.networkUrls,
        method: 'GET',
        hasBody: false,
      };

      // URL'leri validate et
      for (const url of options.networkUrls) {
        const validation = this.networkFilter.validateUrl(url);
        if (!validation.allowed) {
          throw new Error(`Network access blocked: ${validation.reason}`);
        }
      }
    }

    const riskScore = ConsentManager.calculateRisk(action, details);

    // Risk skoru çok yüksekse otomatik reddet
    if (riskScore >= 90) {
      auditLogger.log({
        eventType: 'consent_auto_rejected',
        agentDid,
        details: { action, riskScore, reason: 'Risk score too high' },
        severity: 'high',
      });

      return { consentRequired: true, riskScore };
    }

    // Consent request oluştur
    const consentRequest = this.consentManager.request({
      requesterDid: agentDid,
      action,
      details,
      riskScore,
      timeoutSeconds: 300, // 5 dakika
    });

    auditLogger.log({
      eventType: 'consent_requested',
      agentDid,
      details: { action, riskScore, requestId: consentRequest.id },
      severity: 'medium',
    });

    return {
      consentRequired: true,
      requestId: consentRequest.id,
      riskScore,
    };
  }

  /**
   * Network request için onay talebi oluşturur.
   * URL önce whitelist'e karşı doğrulanır, sonra risk skoru hesaplanır.
   *
   * @param agentDid - İsteği yapan agent'ın DID'si
   * @param url - Erişilecek URL
   * @param method - HTTP method (varsayılan: GET)
   * @param hasBody - Request body var mı
   * @returns Consent sonucu
   */
  async requestNetworkAccessConsent(
    agentDid: string,
    url: string,
    method: string = 'GET',
    hasBody: boolean = false
  ): Promise<ConsentRequestResult> {
    // URL validate
    const validation = this.networkFilter.validateUrl(url);
    if (!validation.allowed) {
      throw new Error(`Network access blocked: ${validation.reason}`);
    }

    const action: ConsentAction = 'network_request';
    const details = {
      url,
      method,
      hasBody,
      network: {
        urls: [url],
        method,
        hasBody,
      },
    };

    const riskScore = ConsentManager.calculateRisk(action, details);

    const consentRequest = this.consentManager.request({
      requesterDid: agentDid,
      action,
      details,
      riskScore,
      timeoutSeconds: 120, // 2 dakika
    });

    auditLogger.log({
      eventType: 'network_access_requested',
      agentDid,
      details: { url, method, riskScore, requestId: consentRequest.id },
      severity: 'medium',
    });

    return {
      consentRequired: true,
      requestId: consentRequest.id,
      riskScore,
    };
  }

  /**
   * Güvenli network request yapar (whitelist + consent kontrolü ile).
   * Önce URL doğrulanır, consent kontrol edilir, sonra istek yapılır.
   *
   * @param agentDid - İsteği yapan agent'ın DID'si
   * @param url - Hedef URL
   * @param options - Request seçenekleri
   * @returns Response
   */
  async secureNetworkRequest(
    agentDid: string,
    url: string,
    options?: SecureNetworkRequestOptions
  ): Promise<Record<string, unknown>> {
    // Önce whitelist kontrolü
    const validation = this.networkFilter.validateUrl(url);
    if (!validation.allowed) {
      auditLogger.log({
        eventType: 'network_access_blocked',
        agentDid,
        details: { url, reason: validation.reason },
        severity: 'high',
      });
      throw new Error(`Network egress blocked: ${validation.reason}`);
    }

    // Consent kontrolü (skipConsent=false ise)
    if (!options?.skipConsent) {
      const consentResult = await this.requestNetworkAccessConsent(
        agentDid,
        url,
        options?.method || 'GET',
        !!options?.body
      );

      // Consent durumunu kontrol et
      const status = this.consentManager.getStatus(consentResult.requestId!);
      if (status === 'pending' || status === 'expired') {
        throw new Error('Consent pending or expired');
      }
      if (status && typeof status !== 'string') {
        if (status.response !== 'approved') {
          throw new Error('Network access denied by consent');
        }
      }
    }

    // Güvenli request yap
    try {
      const response = await this.networkFilter.fetch(url, {
        method: options?.method,
        headers: options?.headers,
        body: options?.body,
        timeout: options?.timeout,
      });

      auditLogger.log({
        eventType: 'network_access_success',
        agentDid,
        details: { url, statusCode: response.statusCode },
        severity: 'low',
      });

      return response as unknown as Record<string, unknown>;
    } catch (error) {
      auditLogger.log({
        eventType: 'network_access_error',
        agentDid,
        details: { url, error: error instanceof Error ? error.message : 'Unknown error' },
        severity: 'medium',
      });
      throw error;
    }
  }
}
