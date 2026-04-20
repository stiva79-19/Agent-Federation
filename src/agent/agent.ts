/**
 * Agent Module — Agent Federation
 *
 * Her agent'ın bir system prompt'u, conversation history'si ve LLM bağlantısı var.
 * Gelen mesajı alır → LLM'e gönderir → cevabı karşı agent'a iletir.
 * Kullanıcı ilk görevi verir, sonra agent'lar kendi aralarında devam eder.
 *
 * OpenClaw entegrasyonu: IDENTITY.md + SOUL.md dosyaları yüklenip
 * agent kimliği ve system prompt otomatik oluşturulur.
 */

import { LLMClient, type ChatMessage, type LLMConfig, type TokenUsage } from './llm';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Agent yapılandırması.
 */
export interface AgentConfig {
  /** Agent adı */
  name: string;
  /** System prompt — agent'ın kim olduğu ve ne yapacağı */
  systemPrompt: string;
  /** Maksimum konuşma turu (varsayılan: 20) */
  maxTurns: number;
  /** LLM yapılandırması */
  llmConfig?: Partial<LLMConfig>;
  /** OpenClaw kimliği (IDENTITY.md + SOUL.md'den) — opsiyonel */
  openclawIdentity?: OpenClawIdentity | null;
}

/**
 * Konuşma mesajı (iç kayıt).
 */
export interface ConversationMessage {
  /** Mesajın sahibi: 'self' (bu agent) veya 'peer' (karşı agent) */
  role: 'self' | 'peer' | 'user';
  /** Mesaj içeriği */
  content: string;
  /** Zaman damgası */
  timestamp: Date;
}

/**
 * Agent durumu.
 */
export type AgentStatus = 'idle' | 'thinking' | 'responding' | 'waiting' | 'stopped' | 'error';

/**
 * Konuşma olay callback'i.
 */
export type ConversationEventType =
  | 'message_sent'
  | 'message_received'
  | 'stream_chunk'
  | 'turn_complete'
  | 'conversation_started'
  | 'conversation_stopped'
  | 'error';

export interface ConversationEvent {
  type: ConversationEventType;
  agentName: string;
  content?: string;
  turn?: number;
  error?: string;
  timestamp: Date;
}

export type ConversationListener = (event: ConversationEvent) => void;

/**
 * AI Agent — LLM tabanlı konuşma agent'ı.
 * Her agent bağımsız bir LLM client'a sahiptir ve conversation history tutar.
 */
export class Agent {
  private config: AgentConfig;
  private llm: LLMClient;
  private history: ConversationMessage[] = [];
  private currentTurn = 0;
  private _status: AgentStatus = 'idle';
  private listeners: ConversationListener[] = [];
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig) {
    this.config = {
      ...config,
      maxTurns: config.maxTurns ?? 20,
    };
    this.llm = new LLMClient(config.llmConfig);
  }

  /** Agent adı */
  get name(): string {
    return this.config.name;
  }

  /** Mevcut durum */
  get status(): AgentStatus {
    return this._status;
  }

  /** Mevcut tur sayısı */
  get turn(): number {
    return this.currentTurn;
  }

  /** Maksimum tur sayısı */
  get maxTurns(): number {
    return this.config.maxTurns;
  }

  /** System prompt */
  get systemPrompt(): string {
    return this.config.systemPrompt;
  }

  /** Conversation history (kopyası) */
  get conversationHistory(): ConversationMessage[] {
    return [...this.history];
  }

  /** Token kullanım istatistikleri */
  get tokenUsage(): TokenUsage {
    return this.llm.getUsage();
  }

  /** LLM yapılandırılmış mı */
  get isLLMConfigured(): boolean {
    return this.llm.isConfigured();
  }

  /** OpenClaw workspace'inden kimlik yüklenmiş mi */
  get isOpenClawConfigured(): boolean {
    const identity = this.config.openclawIdentity;
    if (!identity) return false;
    // IDENTITY.md ve SOUL.md en azından birinin içeriği olmalı
    return !!(identity.identityRaw || identity.soulRaw);
  }

  /** OpenClaw kimlik bilgileri (varsa) */
  get openclawIdentity(): OpenClawIdentity | null {
    return this.config.openclawIdentity ?? null;
  }

  /**
   * System prompt'u günceller.
   */
  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  /**
   * Agent adını günceller.
   */
  setName(name: string): void {
    this.config.name = name;
  }

  /**
   * LLM yapılandırmasını günceller.
   */
  updateLLMConfig(updates: Partial<LLMConfig>): void {
    this.llm.updateConfig(updates);
  }

  /**
   * Event listener ekler.
   */
  on(listener: ConversationListener): void {
    this.listeners.push(listener);
  }

  /**
   * Event listener kaldırır.
   */
  off(listener: ConversationListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  /**
   * Event yayınlar.
   */
  private emit(event: Omit<ConversationEvent, 'timestamp'>): void {
    const fullEvent: ConversationEvent = { ...event, timestamp: new Date() };
    for (const listener of this.listeners) {
      try {
        listener(fullEvent);
      } catch {
        // Listener hataları sessizce yutulur
      }
    }
  }

  /**
   * Conversation history'yi LLM formatına çevirir.
   */
  private buildMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
    ];

    for (const msg of this.history) {
      if (msg.role === 'self') {
        messages.push({ role: 'assistant', content: msg.content });
      } else {
        // 'peer' ve 'user' mesajları LLM'e 'user' olarak gider
        messages.push({ role: 'user', content: msg.content });
      }
    }

    return messages;
  }

  /**
   * Karşı agent'tan veya kullanıcıdan gelen mesajı işler ve LLM ile cevap üretir.
   *
   * @param content - Gelen mesaj
   * @param fromRole - Mesajın geldiği kaynak
   * @returns LLM'in ürettiği cevap
   */
  async processMessage(content: string, fromRole: 'peer' | 'user' = 'peer'): Promise<string> {
    // Mesajı history'ye ekle
    this.history.push({
      role: fromRole,
      content,
      timestamp: new Date(),
    });

    this.emit({
      type: 'message_received',
      agentName: this.name,
      content,
    });

    // LLM'e gönder
    this._status = 'thinking';

    try {
      const messages = this.buildMessages();
      const response = await this.llm.chat(messages);

      // Cevabı history'ye ekle
      this.history.push({
        role: 'self',
        content: response,
        timestamp: new Date(),
      });

      this.currentTurn++;
      this._status = 'idle';

      this.emit({
        type: 'message_sent',
        agentName: this.name,
        content: response,
        turn: this.currentTurn,
      });

      this.emit({
        type: 'turn_complete',
        agentName: this.name,
        turn: this.currentTurn,
      });

      return response;
    } catch (error) {
      this._status = 'error';
      const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
      this.emit({
        type: 'error',
        agentName: this.name,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Streaming olarak mesaj işler. Her chunk geldiğinde callback çağrılır.
   *
   * @param content - Gelen mesaj
   * @param onChunk - Her chunk için callback
   * @param fromRole - Mesajın geldiği kaynak
   * @returns Tam cevap
   */
  async processMessageStream(
    content: string,
    onChunk: (chunk: string) => void,
    fromRole: 'peer' | 'user' = 'peer'
  ): Promise<string> {
    this.history.push({
      role: fromRole,
      content,
      timestamp: new Date(),
    });

    this.emit({
      type: 'message_received',
      agentName: this.name,
      content,
    });

    this._status = 'responding';

    try {
      const messages = this.buildMessages();
      let fullResponse = '';

      for await (const chunk of this.llm.chatStream(messages)) {
        fullResponse += chunk;
        onChunk(chunk);
        this.emit({
          type: 'stream_chunk',
          agentName: this.name,
          content: chunk,
        });
      }

      // Tam cevabı history'ye ekle
      this.history.push({
        role: 'self',
        content: fullResponse,
        timestamp: new Date(),
      });

      this.currentTurn++;
      this._status = 'idle';

      this.emit({
        type: 'message_sent',
        agentName: this.name,
        content: fullResponse,
        turn: this.currentTurn,
      });

      this.emit({
        type: 'turn_complete',
        agentName: this.name,
        turn: this.currentTurn,
      });

      return fullResponse;
    } catch (error) {
      this._status = 'error';
      const errorMessage = error instanceof Error ? error.message : 'Bilinmeyen hata';
      this.emit({
        type: 'error',
        agentName: this.name,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Konuşma devam edebilir mi kontrol eder.
   */
  canContinue(): boolean {
    return this._status !== 'stopped' && this.currentTurn < this.config.maxTurns;
  }

  /**
   * Konuşmayı durdurur.
   */
  stop(): void {
    this._status = 'stopped';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.emit({
      type: 'conversation_stopped',
      agentName: this.name,
      turn: this.currentTurn,
    });
  }

  /**
   * Konuşma state'ini sıfırlar.
   */
  reset(): void {
    this.history = [];
    this.currentTurn = 0;
    this._status = 'idle';
    this.abortController = null;
  }

  /**
   * Konuşma istatistikleri.
   */
  getStats(): {
    name: string;
    status: AgentStatus;
    turn: number;
    maxTurns: number;
    messageCount: number;
    tokenUsage: TokenUsage;
    openclawConfigured: boolean;
    llmConfigured: boolean;
  } {
    return {
      name: this.name,
      status: this._status,
      turn: this.currentTurn,
      maxTurns: this.config.maxTurns,
      messageCount: this.history.length,
      tokenUsage: this.tokenUsage,
      openclawConfigured: this.isOpenClawConfigured,
      llmConfigured: this.isLLMConfigured,
    };
  }
}

/**
 * OpenClaw workspace'den yüklenen agent kimlik bilgileri.
 */
export interface OpenClawIdentity {
  /** Agent adı (IDENTITY.md'den) */
  name: string;
  /** Emoji (IDENTITY.md'den) */
  emoji: string;
  /** Kısa tanım */
  creature: string;
  /** Vibe */
  vibe: string;
  /** IDENTITY.md ham içeriği */
  identityRaw: string;
  /** SOUL.md ham içeriği */
  soulRaw: string;
  /** MEMORY.md ham içeriği (opsiyonel) */
  memoryRaw: string;
}

/**
 * Bir markdown dosyasını güvenle okur.
 * Dosya bulunamazsa boş string döner.
 */
function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * IDENTITY.md'den anahtar-değer bilgilerini parse eder.
 */
function parseIdentity(raw: string): { name: string; emoji: string; creature: string; vibe: string } {
  const defaults = { name: 'MrClaw', emoji: '🦀', creature: 'AI familiar', vibe: 'Sharp, warm, resourceful' };
  if (!raw) return defaults;

  const nameMatch = raw.match(/\*\*Name:\*\*\s*(.+)/);
  const emojiMatch = raw.match(/\*\*Emoji:\*\*\s*(.+)/);
  const creatureMatch = raw.match(/\*\*Creature:\*\*\s*(.+)/);
  const vibeMatch = raw.match(/\*\*Vibe:\*\*\s*(.+)/);

  return {
    name: nameMatch?.[1]?.trim() || defaults.name,
    emoji: emojiMatch?.[1]?.trim() || defaults.emoji,
    creature: creatureMatch?.[1]?.trim() || defaults.creature,
    vibe: vibeMatch?.[1]?.trim() || defaults.vibe,
  };
}

/**
 * OpenClaw workspace'den IDENTITY.md + SOUL.md + MEMORY.md yükler.
 *
 * @param workspacePath - OpenClaw workspace dizini (varsayılan: OPENCLAW_WORKSPACE env veya ~/.openclaw/workspace)
 * @returns OpenClawIdentity veya null (dosyalar bulunamazsa)
 */
export function loadOpenClawIdentity(workspacePath?: string): OpenClawIdentity | null {
  const workspace = workspacePath
    ?? process.env['OPENCLAW_WORKSPACE']?.replace(/^~/, process.env['HOME'] ?? '')
    ?? path.join(process.env['HOME'] ?? '', '.openclaw', 'workspace');

  const identityPath = path.join(workspace, 'IDENTITY.md');
  const soulPath = path.join(workspace, 'SOUL.md');
  const memoryPath = path.join(workspace, 'MEMORY.md');

  const identityRaw = readFileSafe(identityPath);
  const soulRaw = readFileSafe(soulPath);
  const memoryRaw = readFileSafe(memoryPath);

  // En az IDENTITY.md olmalı
  if (!identityRaw) return null;

  const parsed = parseIdentity(identityRaw);

  return {
    ...parsed,
    identityRaw,
    soulRaw,
    memoryRaw,
  };
}

/**
 * OpenClaw kimliğinden system prompt oluşturur.
 * IDENTITY + SOUL birleştirilir, ek talimat varsa eklenir.
 */
export function buildSystemPrompt(identity: OpenClawIdentity, additionalInstructions?: string): string {
  const parts: string[] = [];

  parts.push(`# Kim Olduğun`);
  parts.push(`Sen ${identity.name} ${identity.emoji} — ${identity.creature}.`);
  parts.push(`Tarz: ${identity.vibe}`);
  parts.push('');

  if (identity.soulRaw) {
    parts.push('# Kişiliğin');
    parts.push(identity.soulRaw.replace(/^# SOUL\.md.*\n*/m, '').trim());
    parts.push('');
  }

  parts.push('# Görev Bağlamı');
  parts.push('Başka bir AI agent ile işbirliği yapıyorsun. Kısa, yapıcı ve görev odaklı ol.');
  parts.push('Karşı agent\'ın mesajlarına cevap verirken MrClaw kimliğinle konuş.');

  if (additionalInstructions) {
    parts.push('');
    parts.push('# Ek Talimatlar');
    parts.push(additionalInstructions);
  }

  return parts.join('\n');
}

/**
 * Env var'lardan ve OpenClaw workspace'den agent yapılandırması oluşturur.
 *
 * Öncelik sırası:
 * 1. override parametreleri
 * 2. Env var'lar (AGENT_NAME, AGENT_SYSTEM_PROMPT)
 * 3. OpenClaw workspace (IDENTITY.md + SOUL.md)
 * 4. Varsayılanlar
 */
export function loadAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  // OpenClaw kimliğini yüklemeyi dene
  const identity = loadOpenClawIdentity();

  let defaultName = 'MrClaw';
  let defaultPrompt = 'You are a helpful AI agent collaborating with another agent. Be concise, constructive, and focused on the task at hand.';

  if (identity) {
    defaultName = identity.name;
    defaultPrompt = buildSystemPrompt(identity);
  }

  return {
    name: overrides?.name ?? process.env['AGENT_NAME'] ?? defaultName,
    systemPrompt: overrides?.systemPrompt ?? process.env['AGENT_SYSTEM_PROMPT'] ?? defaultPrompt,
    maxTurns: overrides?.maxTurns ?? 20,
    llmConfig: overrides?.llmConfig,
    openclawIdentity: overrides?.openclawIdentity !== undefined ? overrides.openclawIdentity : identity,
  };
}
