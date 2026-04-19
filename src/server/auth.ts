/**
 * Authentication Module — Agent Federation Server
 *
 * ECDSA kimlik doğrulama, DID yönetimi, challenge-response auth flow.
 * Agent'lar bağlanırken nonce imzalayarak kimliklerini kanıtlar.
 */

import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import { parseDID } from '../identity/agent';
import { auditLogger } from './audit-logger';
import type { AgentConnection, AuthChallenge } from './types';

/**
 * Auth response mesajının beklenen yapısı.
 */
export interface AuthResponseMessage {
  type: 'auth_response';
  did: string;
  signature: string;
  publicKey?: string;
  identity?: Record<string, unknown>;
}

/**
 * Auth işleminin sonucu.
 */
export interface AuthResult {
  success: boolean;
  connection?: AgentConnection;
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Yeni bir auth challenge oluşturur.
 *
 * @param authTimeout - Challenge'ın geçerlilik süresi (ms)
 * @returns Oluşturulan AuthChallenge
 */
export function createAuthChallenge(authTimeout: number): AuthChallenge {
  return {
    challengeId: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + authTimeout),
  };
}

/**
 * ECDSA signature doğrulama.
 * Agent'ın public key'i ile `did:nonce` verisinin imzasını doğrular.
 *
 * @param did - Agent'ın DID'si
 * @param nonce - Challenge nonce
 * @param signature - Base64 encoded ECDSA signature
 * @param publicKey - Base64 encoded DER/SPKI public key
 * @returns İmza geçerli mi
 */
export function verifySignature(
  did: string,
  nonce: string,
  signature: string,
  publicKey?: string
): boolean {
  if (!signature || !publicKey) {
    console.warn('[WS Server] Missing signature or publicKey');
    return false;
  }

  try {
    const data = `${did}:${nonce}`;
    const signatureBuffer = Buffer.from(signature, 'base64');

    // ECDSA verify (P-256 curve)
    const verifier = crypto.createVerify('SHA256');
    verifier.write(data);
    verifier.end();

    const publicKeyBuffer = Buffer.from(publicKey, 'base64');
    const isValid = verifier.verify(
      { key: publicKeyBuffer, format: 'der', type: 'spki' },
      signatureBuffer
    );

    return isValid;
  } catch (error) {
    console.error('[WS Server] Signature verification failed:', error);
    return false;
  }
}

/**
 * Connection fingerprint oluşturur (IP + User-Agent hash).
 * Aynı client'tan gelen bağlantıları tanımlamak için kullanılır.
 *
 * @param _ws - WebSocket instance (kullanılmıyor ama imza uyumluluğu için)
 * @param req - HTTP request objesi
 * @returns 16 karakterlik hex fingerprint
 */
export function createFingerprint(_ws: WebSocket, req: Record<string, unknown>): string {
  const socket = req?.socket as Record<string, unknown> | undefined;
  const headers = req?.headers as Record<string, string> | undefined;
  const ip = (socket?.remoteAddress as string) || 'unknown';
  const ua = headers?.['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(`${ip}:${ua}`).digest('hex').slice(0, 16);
}

/**
 * WebSocket'ten ilişkili socket bilgisini çıkarır.
 *
 * @param ws - WebSocket instance
 * @returns Socket objesi veya undefined
 */
export function getSocketInfo(ws: WebSocket): Record<string, unknown> | undefined {
  return (ws as unknown as Record<string, unknown>)._socket as Record<string, unknown> | undefined;
}

/**
 * Auth response mesajını işler ve agent'ı doğrular.
 * DID format kontrolü, ECDSA signature doğrulama ve bağlantı oluşturma yapar.
 *
 * @param ws - WebSocket bağlantısı
 * @param message - Auth response mesajı
 * @param challenge - Gönderilen auth challenge
 * @param req - HTTP request bilgisi (fingerprint için)
 * @returns Auth sonucu
 */
export function handleAuthResponse(
  ws: WebSocket,
  message: AuthResponseMessage,
  challenge: AuthChallenge,
  req: Record<string, unknown> | undefined
): AuthResult {
  const { did, signature, identity } = message;

  // DID format kontrolü
  const parsed = parseDID(did);
  if (!parsed) {
    console.warn('[WS Server] Invalid DID format:', did);

    auditLogger.log({
      eventType: 'auth_failure',
      agentDid: did,
      ipAddress: (req?.socket as Record<string, unknown>)?.remoteAddress as string | undefined,
      details: { reason: 'invalid_did_format' },
      severity: 'medium',
    });

    ws.send(JSON.stringify({
      type: 'auth_error',
      message: 'Invalid DID format',
    }));
    ws.close(4002, 'Invalid DID');
    return { success: false, errorCode: 4002, errorMessage: 'Invalid DID' };
  }

  // ECDSA signature doğrulama
  const isValidSignature = verifySignature(did, challenge.nonce, signature, message.publicKey);

  if (!isValidSignature) {
    console.warn('[WS Server] Invalid signature for DID:', did);

    auditLogger.log({
      eventType: 'signature_invalid',
      agentDid: did,
      ipAddress: (req?.socket as Record<string, unknown>)?.remoteAddress as string | undefined,
      details: { challengeId: challenge.challengeId },
      severity: 'high',
    });

    ws.send(JSON.stringify({
      type: 'auth_error',
      message: 'Invalid signature',
    }));
    ws.close(4003, 'Invalid signature');
    return { success: false, errorCode: 4003, errorMessage: 'Invalid signature' };
  }

  // Auth başarılı — connection oluştur
  const fingerprint = createFingerprint(ws, req || {});

  const connection: AgentConnection = {
    did,
    ws,
    connectedAt: new Date(),
    lastMessageAt: new Date(),
    sentCount: 0,
    receivedCount: 0,
    identity: identity as AgentConnection['identity'],
    messageTimestamps: [],
    fingerprint,
    publicKey: message.publicKey,
  };

  console.log(`[WS Server] Agent authenticated: ${did}`);

  auditLogger.log({
    eventType: 'auth_success',
    agentDid: did,
    ipAddress: (req?.socket as Record<string, unknown>)?.remoteAddress as string | undefined,
    details: { fingerprint, hasPublicKey: !!message.publicKey },
    severity: 'low',
  });

  ws.send(JSON.stringify({
    type: 'auth_success',
    did,
    timestamp: new Date().toISOString(),
  }));

  return { success: true, connection };
}
