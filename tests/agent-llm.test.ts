/**
 * Agent & LLM Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Agent, loadAgentConfig, loadOpenClawIdentity, buildSystemPrompt } from '../src/agent/agent';
import { LLMClient, loadLLMConfig } from '../src/agent/llm';
import type { ConversationEvent, OpenClawIdentity } from '../src/agent/agent';

describe('LLMClient', () => {
  describe('loadLLMConfig', () => {
    it('returns defaults when no env vars (OpenClaw Gateway)', () => {
      const config = loadLLMConfig();
      expect(config.baseUrl).toBe('http://localhost:18789/v1');
      expect(config.model).toBe('qwen3.5-plus');
      expect(config.maxTokens).toBe(1024);
      expect(config.temperature).toBe(0.7);
    });

    it('accepts overrides', () => {
      const config = loadLLMConfig({ model: 'gpt-4', maxTokens: 2048 });
      expect(config.model).toBe('gpt-4');
      expect(config.maxTokens).toBe(2048);
    });
  });

  describe('LLMClient', () => {
    // Remote (non-local) baseUrl — local-fallback devreye girmez, boş apiKey "not configured" kalır.
    const REMOTE = 'https://api.example.com/v1';

    it('reports not configured when no API key (remote baseUrl)', () => {
      const client = new LLMClient({ apiKey: '', baseUrl: REMOTE });
      expect(client.isConfigured()).toBe(false);
    });

    it('reports configured when API key is set', () => {
      const client = new LLMClient({ apiKey: 'test-key' });
      expect(client.isConfigured()).toBe(true);
    });

    it('auto-fills sentinel apiKey when baseUrl is local and apiKey empty', () => {
      const client = new LLMClient({ apiKey: '', baseUrl: 'http://localhost:18789/v1' });
      // Local gateway'ler auth istemediği için otomatik yapılandırılmış sayılır.
      expect(client.isConfigured()).toBe(true);
    });

    it('returns model name', () => {
      const client = new LLMClient({ model: 'gpt-4o' });
      expect(client.getModel()).toBe('gpt-4o');
    });

    it('tracks usage', () => {
      const client = new LLMClient();
      const usage = client.getUsage();
      expect(usage.totalTokens).toBe(0);
      expect(usage.promptTokens).toBe(0);
      expect(usage.completionTokens).toBe(0);
    });

    it('throws on chat without API key (remote baseUrl)', async () => {
      const client = new LLMClient({ apiKey: '', baseUrl: REMOTE });
      await expect(client.chat([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('API key');
    });

    it('updates config', () => {
      const client = new LLMClient({ model: 'gpt-3.5' });
      expect(client.getModel()).toBe('gpt-3.5');
      client.updateConfig({ model: 'gpt-4' });
      expect(client.getModel()).toBe('gpt-4');
    });
  });
});

describe('Agent', () => {
  let agent: Agent;

  beforeEach(() => {
    agent = new Agent({
      name: 'TestAgent',
      systemPrompt: 'You are a test agent.',
      maxTurns: 10,
      // Non-local baseUrl + empty apiKey → local-fallback devreye girmez,
      // "not configured" davranışı korunur.
      llmConfig: { apiKey: '', baseUrl: 'https://api.example.com/v1' },
    });
  });

  describe('basic properties', () => {
    it('has correct name', () => {
      expect(agent.name).toBe('TestAgent');
    });

    it('has correct status', () => {
      expect(agent.status).toBe('idle');
    });

    it('has zero turns initially', () => {
      expect(agent.turn).toBe(0);
    });

    it('has correct maxTurns', () => {
      expect(agent.maxTurns).toBe(10);
    });

    it('has correct system prompt', () => {
      expect(agent.systemPrompt).toBe('You are a test agent.');
    });

    it('has empty conversation history', () => {
      expect(agent.conversationHistory).toHaveLength(0);
    });

    it('reports LLM not configured', () => {
      expect(agent.isLLMConfigured).toBe(false);
    });
  });

  describe('configuration updates', () => {
    it('updates name', () => {
      agent.setName('NewName');
      expect(agent.name).toBe('NewName');
    });

    it('updates system prompt', () => {
      agent.setSystemPrompt('New prompt');
      expect(agent.systemPrompt).toBe('New prompt');
    });

    it('updates LLM config', () => {
      agent.updateLLMConfig({ apiKey: 'test-key' });
      expect(agent.isLLMConfigured).toBe(true);
    });
  });

  describe('conversation flow', () => {
    it('canContinue returns true initially', () => {
      expect(agent.canContinue()).toBe(true);
    });

    it('canContinue returns false after stop', () => {
      agent.stop();
      expect(agent.canContinue()).toBe(false);
      expect(agent.status).toBe('stopped');
    });

    it('reset clears state', () => {
      agent.stop();
      agent.reset();
      expect(agent.status).toBe('idle');
      expect(agent.turn).toBe(0);
      expect(agent.conversationHistory).toHaveLength(0);
    });

    it('rejects processMessage without LLM key', async () => {
      await expect(agent.processMessage('hello'))
        .rejects.toThrow('API key');
    });
  });

  describe('events', () => {
    it('emits stop event', () => {
      const events: ConversationEvent[] = [];
      agent.on((e) => events.push(e));
      agent.stop();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('conversation_stopped');
      expect(events[0].agentName).toBe('TestAgent');
    });

    it('can remove listener', () => {
      const events: ConversationEvent[] = [];
      const listener = (e: ConversationEvent) => events.push(e);
      agent.on(listener);
      agent.off(listener);
      agent.stop();
      expect(events).toHaveLength(0);
    });
  });

  describe('stats', () => {
    it('returns correct stats', () => {
      const stats = agent.getStats();
      expect(stats.name).toBe('TestAgent');
      expect(stats.status).toBe('idle');
      expect(stats.turn).toBe(0);
      expect(stats.maxTurns).toBe(10);
      expect(stats.messageCount).toBe(0);
      expect(stats.tokenUsage.totalTokens).toBe(0);
    });
  });

  describe('loadAgentConfig', () => {
    it('returns defaults (with or without OpenClaw workspace)', () => {
      const config = loadAgentConfig();
      // Name should be MrClaw whether from OpenClaw or defaults
      expect(config.name).toContain('Claw');
      expect(config.maxTurns).toBe(20);
      expect(config.systemPrompt.length).toBeGreaterThan(0);
    });

    it('accepts overrides', () => {
      const config = loadAgentConfig({ name: 'Custom', maxTurns: 5 });
      expect(config.name).toBe('Custom');
      expect(config.maxTurns).toBe(5);
    });
  });
});

describe('OpenClaw Integration', () => {
  describe('loadOpenClawIdentity', () => {
    it('returns null for non-existent workspace', () => {
      const identity = loadOpenClawIdentity('/tmp/non-existent-openclaw-workspace');
      expect(identity).toBeNull();
    });

    it('loads identity from valid workspace', () => {
      // Bu test OpenClaw workspace erişilebilirse çalışır
      const identity = loadOpenClawIdentity();
      if (identity) {
        expect(identity.name).toBeTruthy();
        expect(identity.emoji).toBeTruthy();
        expect(identity.identityRaw).toContain('IDENTITY');
        expect(identity.soulRaw.length).toBeGreaterThan(0);
      }
    });
  });

  describe('buildSystemPrompt', () => {
    const mockIdentity: OpenClawIdentity = {
      name: 'Mr Claw',
      emoji: '🦀',
      creature: 'AI familiar — part assistant, part co-conspirator',
      vibe: 'Sharp, warm, resourceful',
      identityRaw: '# IDENTITY.md\n**Name:** Mr Claw',
      soulRaw: '# SOUL.md - Who You Are\n\n## Core Truths\nBe genuinely helpful.',
      memoryRaw: '',
    };

    it('builds prompt with identity info', () => {
      const prompt = buildSystemPrompt(mockIdentity);
      expect(prompt).toContain('Mr Claw');
      expect(prompt).toContain('🦀');
      expect(prompt).toContain('AI familiar');
      expect(prompt).toContain('Sharp, warm, resourceful');
    });

    it('includes soul content', () => {
      const prompt = buildSystemPrompt(mockIdentity);
      expect(prompt).toContain('Core Truths');
      expect(prompt).toContain('genuinely helpful');
    });

    it('includes collaboration context', () => {
      const prompt = buildSystemPrompt(mockIdentity);
      expect(prompt).toContain('işbirliği');
      expect(prompt).toContain('MrClaw');
    });

    it('appends additional instructions', () => {
      const prompt = buildSystemPrompt(mockIdentity, 'Türkçe cevap ver.');
      expect(prompt).toContain('Türkçe cevap ver.');
      expect(prompt).toContain('Ek Talimatlar');
    });

    it('works without soul content', () => {
      const noSoul = { ...mockIdentity, soulRaw: '' };
      const prompt = buildSystemPrompt(noSoul);
      expect(prompt).toContain('Mr Claw');
      expect(prompt).not.toContain('Kişiliğin');
    });
  });

  describe('LLM Config with Gateway', () => {
    it('respects OPENCLAW_GATEWAY_URL env', () => {
      const original = process.env['OPENCLAW_GATEWAY_URL'];
      const originalBase = process.env['AGENT_LLM_BASE_URL'];
      try {
        process.env['OPENCLAW_GATEWAY_URL'] = 'http://my-gateway:9999';
        delete process.env['AGENT_LLM_BASE_URL'];
        const config = loadLLMConfig();
        expect(config.baseUrl).toBe('http://my-gateway:9999/v1');
      } finally {
        if (original !== undefined) process.env['OPENCLAW_GATEWAY_URL'] = original;
        else delete process.env['OPENCLAW_GATEWAY_URL'];
        if (originalBase !== undefined) process.env['AGENT_LLM_BASE_URL'] = originalBase;
        else delete process.env['AGENT_LLM_BASE_URL'];
      }
    });

    it('AGENT_LLM_BASE_URL overrides gateway', () => {
      const originalGw = process.env['OPENCLAW_GATEWAY_URL'];
      const originalBase = process.env['AGENT_LLM_BASE_URL'];
      try {
        process.env['OPENCLAW_GATEWAY_URL'] = 'http://gateway:9999';
        process.env['AGENT_LLM_BASE_URL'] = 'http://custom-api:8080/v1';
        const config = loadLLMConfig();
        expect(config.baseUrl).toBe('http://custom-api:8080/v1');
      } finally {
        if (originalGw !== undefined) process.env['OPENCLAW_GATEWAY_URL'] = originalGw;
        else delete process.env['OPENCLAW_GATEWAY_URL'];
        if (originalBase !== undefined) process.env['AGENT_LLM_BASE_URL'] = originalBase;
        else delete process.env['AGENT_LLM_BASE_URL'];
      }
    });

    it('strips trailing slash from gateway URL', () => {
      const original = process.env['OPENCLAW_GATEWAY_URL'];
      const originalBase = process.env['AGENT_LLM_BASE_URL'];
      try {
        process.env['OPENCLAW_GATEWAY_URL'] = 'http://localhost:18789/';
        delete process.env['AGENT_LLM_BASE_URL'];
        const config = loadLLMConfig();
        expect(config.baseUrl).toBe('http://localhost:18789/v1');
      } finally {
        if (original !== undefined) process.env['OPENCLAW_GATEWAY_URL'] = original;
        else delete process.env['OPENCLAW_GATEWAY_URL'];
        if (originalBase !== undefined) process.env['AGENT_LLM_BASE_URL'] = originalBase;
        else delete process.env['AGENT_LLM_BASE_URL'];
      }
    });
  });
});
