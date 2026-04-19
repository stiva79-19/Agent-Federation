/**
 * Swarm Protocol — Agent Federation
 *
 * Hyperswarm üzerinden gönderilen mesajların tip tanımları ve yardımcı fonksiyonları.
 * Tüm mesajlar newline-delimited JSON olarak serialize edilir.
 *
 * Wire format: JSON.stringify(message) + '\n'
 */

// ─── Message Types ──────────────────────────────────────────────────────────

/**
 * Hyperswarm üzerinden gönderilen mesaj tipleri.
 */
export type SwarmMessageType =
  | 'handshake'           // İlk bağlantıda kimlik değişimi
  | 'handshake_ack'       // Handshake onayı
  | 'agent_message'       // Agent'lar arası mesaj (LLM cevabı dahil)
  | 'agent_thinking'      // Agent düşünüyor bildirimi
  | 'agent_stream_chunk'  // Streaming mesaj parçası
  | 'sandbox_action'      // Dosya işlemi isteği
  | 'sandbox_result'      // Dosya işlemi sonucu
  | 'approval_request'    // Onay isteği
  | 'approval_response'   // Onay cevabı
  | 'session_info'        // Session bilgisi (peer listesi vs.)
  | 'peer_joined'         // Yeni peer katıldı bildirimi
  | 'peer_left'           // Peer ayrıldı bildirimi
  | 'ping'                // Heartbeat
  | 'pong'                // Heartbeat cevap
  | 'error';              // Hata mesajı

// ─── Message Interfaces ─────────────────────────────────────────────────────

/**
 * Temel swarm mesaj yapısı.
 * Tüm mesajlar bu arayüzü genişletir.
 */
export interface SwarmMessage {
  /** Mesaj tipi */
  type: SwarmMessageType;
  /** Gönderen bilgileri */
  from: {
    agentName: string;
    agentDid: string;
  };
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Mesaj içeriği — tipe göre değişir */
  payload: unknown;
}

/**
 * Handshake mesajı — ilk bağlantıda kimlik değişimi.
 */
export interface HandshakeMessage extends SwarmMessage {
  type: 'handshake';
  payload: {
    /** Protokol versiyonu */
    protocolVersion: string;
    /** Agent adı */
    agentName: string;
    /** Agent DID */
    agentDid: string;
    /** Desteklenen mesaj tipleri (opsiyonel, ileride genişleme için) */
    capabilities?: string[];
  };
}

/**
 * Handshake onay mesajı.
 */
export interface HandshakeAckMessage extends SwarmMessage {
  type: 'handshake_ack';
  payload: {
    /** Kabul edildi mi */
    accepted: boolean;
    /** Red nedeni (kabul edilmediyse) */
    reason?: string;
    /** Mevcut peer listesi */
    peers: Array<{ agentName: string; agentDid: string }>;
    /** Session key (hex) */
    sessionKey: string;
  };
}

/**
 * Agent mesajı — LLM cevabı dahil tüm agent'lar arası iletişim.
 */
export interface AgentMessagePayload {
  /** Mesaj içeriği */
  content: string;
  /** Gönderenin rolü */
  role: 'host' | 'guest' | 'peer';
  /** Tur numarası */
  turn?: number;
  /** Maksimum tur */
  maxTurns?: number;
  /** İstatistikler (opsiyonel) */
  stats?: Record<string, unknown>;
}

/**
 * Agent düşünüyor bildirimi.
 */
export interface AgentThinkingPayload {
  /** Agent adı */
  agentName: string;
  /** Tur numarası */
  turn: number;
}

/**
 * Streaming mesaj parçası.
 */
export interface AgentStreamChunkPayload {
  /** Agent adı */
  agentName: string;
  /** Metin parçası */
  chunk: string;
  /** Gönderenin rolü */
  role: 'host' | 'guest' | 'peer';
}

/**
 * Sandbox dosya işlemi isteği.
 */
export interface SandboxActionPayload {
  /** İşlem ID'si */
  actionId: string;
  /** İşlem tipi */
  action: 'file_create' | 'file_edit' | 'file_delete' | 'file_read' | 'file_list' | 'dir_create';
  /** Dosya yolu */
  path: string;
  /** Dosya içeriği (create/edit için) */
  content?: string;
  /** Eski içerik (edit için) */
  oldContent?: string;
  /** Yeni içerik (edit için) */
  newContent?: string;
}

/**
 * Sandbox işlem sonucu.
 */
export interface SandboxResultPayload {
  /** İşlem ID'si */
  actionId: string;
  /** Başarılı mı */
  success: boolean;
  /** Sonuç verisi */
  data?: Record<string, unknown>;
  /** Hata mesajı */
  error?: string;
}

/**
 * Onay isteği — yüksek riskli işlemler için insan onayı.
 */
export interface ApprovalRequestPayload {
  /** İstek ID'si */
  requestId: string;
  /** Agent adı */
  agentName: string;
  /** İşlem tipi */
  action: string;
  /** Dosya yolu */
  path: string;
  /** Önizleme */
  preview?: string;
  /** Risk skoru (0-100) */
  riskScore: number;
}

/**
 * Onay cevabı.
 */
export interface ApprovalResponsePayload {
  /** İstek ID'si */
  requestId: string;
  /** Onaylandı mı */
  approved: boolean;
  /** Onaylayan */
  approvedBy: string;
}

/**
 * Session bilgisi — peer listesi ve session durumu.
 */
export interface SessionInfoPayload {
  /** Session key (hex) */
  sessionKey: string;
  /** Bağlı peer'lar */
  peers: Array<{
    agentName: string;
    agentDid: string;
    connectedAt: string;
  }>;
  /** Session oluşturulma zamanı */
  createdAt: string;
}

/**
 * Peer katıldı bildirimi.
 */
export interface PeerJoinedPayload {
  /** Katılan peer'ın agent adı */
  agentName: string;
  /** Katılan peer'ın DID'i */
  agentDid: string;
  /** Toplam peer sayısı */
  peerCount: number;
  /** Maksimum peer sayısı */
  maxPeers: number;
}

/**
 * Peer ayrıldı bildirimi.
 */
export interface PeerLeftPayload {
  /** Ayrılan peer'ın agent adı */
  agentName: string;
  /** Ayrılan peer'ın DID'i */
  agentDid: string;
  /** Kalan peer sayısı */
  peerCount: number;
}

/**
 * Hata mesajı.
 */
export interface ErrorPayload {
  /** Hata kodu */
  code: string;
  /** Hata mesajı */
  message: string;
}

// ─── Protocol Constants ─────────────────────────────────────────────────────

/** Protokol versiyonu */
export const PROTOCOL_VERSION = '1.0.0';

/** Mesaj ayırıcı — newline */
export const MESSAGE_DELIMITER = '\n';

/** Maksimum mesaj boyutu (bytes) — 1MB */
export const MAX_MESSAGE_SIZE = 1024 * 1024;

/** Heartbeat aralığı (ms) — 15 saniye */
export const HEARTBEAT_INTERVAL = 15_000;

/** Heartbeat timeout (ms) — 45 saniye (3 heartbeat kaçırılırsa) */
export const HEARTBEAT_TIMEOUT = 45_000;

/** Handshake timeout (ms) — 10 saniye */
export const HANDSHAKE_TIMEOUT = 10_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * SwarmMessage oluşturur.
 */
export function createSwarmMessage(
  type: SwarmMessageType,
  from: { agentName: string; agentDid: string },
  payload: unknown,
): SwarmMessage {
  return {
    type,
    from,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Mesajı wire format'a serialize eder (newline-delimited JSON).
 */
export function serializeMessage(message: SwarmMessage): string {
  return JSON.stringify(message) + MESSAGE_DELIMITER;
}

/**
 * Wire format'tan mesajı deserialize eder.
 * @throws Geçersiz JSON veya mesaj yapısı
 */
export function deserializeMessage(line: string): SwarmMessage {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('Empty message');
  }

  if (trimmed.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${trimmed.length} bytes (max ${MAX_MESSAGE_SIZE})`);
  }

  const parsed = JSON.parse(trimmed);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid message: not an object');
  }

  if (!parsed.type || typeof parsed.type !== 'string') {
    throw new Error('Invalid message: missing or invalid type');
  }

  if (!parsed.from || typeof parsed.from !== 'object') {
    throw new Error('Invalid message: missing or invalid from');
  }

  if (!parsed.timestamp || typeof parsed.timestamp !== 'string') {
    throw new Error('Invalid message: missing or invalid timestamp');
  }

  return parsed as SwarmMessage;
}

/**
 * Buffer'dan satırları parse eder.
 * Dönen değer: [parsedMessages, remainingBuffer]
 */
export function parseBuffer(buffer: string): [SwarmMessage[], string] {
  const messages: SwarmMessage[] = [];
  const lines = buffer.split(MESSAGE_DELIMITER);
  const remaining = lines.pop() || ''; // Son satır tam olmayabilir

  for (const line of lines) {
    if (line.trim()) {
      try {
        messages.push(deserializeMessage(line));
      } catch {
        // Geçersiz mesajları sessizce atla
      }
    }
  }

  return [messages, remaining];
}

/**
 * Handshake mesajı oluşturur.
 */
export function createHandshake(
  agentName: string,
  agentDid: string,
): HandshakeMessage {
  return {
    type: 'handshake',
    from: { agentName, agentDid },
    timestamp: new Date().toISOString(),
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      agentName,
      agentDid,
    },
  };
}

/**
 * Handshake ACK mesajı oluşturur.
 */
export function createHandshakeAck(
  from: { agentName: string; agentDid: string },
  accepted: boolean,
  sessionKey: string,
  peers: Array<{ agentName: string; agentDid: string }>,
  reason?: string,
): HandshakeAckMessage {
  return {
    type: 'handshake_ack',
    from,
    timestamp: new Date().toISOString(),
    payload: {
      accepted,
      reason,
      peers,
      sessionKey,
    },
  };
}

/**
 * Ping mesajı oluşturur.
 */
export function createPing(from: { agentName: string; agentDid: string }): SwarmMessage {
  return createSwarmMessage('ping', from, { sentAt: Date.now() });
}

/**
 * Pong mesajı oluşturur.
 */
export function createPong(from: { agentName: string; agentDid: string }): SwarmMessage {
  return createSwarmMessage('pong', from, { sentAt: Date.now() });
}

/**
 * Error mesajı oluşturur.
 */
export function createError(
  from: { agentName: string; agentDid: string },
  code: string,
  message: string,
): SwarmMessage {
  return createSwarmMessage('error', from, { code, message } satisfies ErrorPayload);
}
