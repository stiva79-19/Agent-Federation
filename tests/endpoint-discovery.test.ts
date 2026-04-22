/**
 * Endpoint Discovery Tests
 *
 * Aday path probe mantığını test eder. Gerçek HTTP server ile: farklı path'ler
 * farklı response'lar dönecek şekilde küçük test server kuruyoruz.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { discoverLLMEndpoint, formatDiscoveryResult } from '../src/agent/endpoint-discovery';

describe('endpoint-discovery', () => {
  let server: http.Server;
  let port: number;
  let responseMap: Map<string, { status: number; body?: string }>;

  beforeEach(async () => {
    responseMap = new Map();
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const resp = responseMap.get(req.url || '');
        if (resp) {
          res.statusCode = resp.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(resp.body ?? '');
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('discoverLLMEndpoint', () => {
    it('detects /v1/models when available (200 + models list)', async () => {
      responseMap.set('/v1/models', {
        status: 200,
        body: JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'claude-3' }] }),
      });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
      expect(result.matchedPath).toBe('/v1/models');
      expect(result.statusCode).toBe(200);
      expect(result.availableModels).toEqual(['gpt-4o', 'claude-3']);
    });

    it('detects /api/v1/models when /v1 returns 404', async () => {
      responseMap.set('/api/v1/models', {
        status: 200,
        body: JSON.stringify({ data: [{ id: 'openai-codex/gpt-5.4' }] }),
      });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${port}/api/v1`);
      expect(result.matchedPath).toBe('/api/v1/models');
      expect(result.availableModels).toContain('openai-codex/gpt-5.4');
    });

    it('detects /__openclaw__/api/v1/models (OpenClaw-style namespace)', async () => {
      responseMap.set('/__openclaw__/api/v1/models', {
        status: 200,
        body: JSON.stringify({ data: [{ id: 'qwen3.5-plus' }] }),
      });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${port}/__openclaw__/api/v1`);
      expect(result.matchedPath).toBe('/__openclaw__/api/v1/models');
    });

    it('accepts 401 as "path correct but auth required"', async () => {
      responseMap.set('/v1/models', { status: 401, body: 'unauthorized' });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.matchedPath).toBe('/v1/models');
      expect(result.statusCode).toBe(401);
      expect(result.availableModels).toEqual([]);
    });

    it('accepts 403 as "path correct"', async () => {
      responseMap.set('/api/v1/models', { status: 403 });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.statusCode).toBe(403);
    });

    it('accepts 405 Method Not Allowed as "path exists but GET not allowed"', async () => {
      responseMap.set('/v1/models', { status: 405 });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.statusCode).toBe(405);
    });

    it('returns detected:false when no path matches (all 404)', async () => {
      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(false);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
      expect(result.attempts.length).toBeGreaterThan(0);
    });

    it('returns detected:false when server is unreachable', async () => {
      const result = await discoverLLMEndpoint('http://127.0.0.1:59999/v1');
      expect(result.detected).toBe(false);
      // Tüm aday path'ler için hata olmalı
      for (const a of result.attempts) {
        expect(a.status === null).toBe(true);
      }
    });

    it('handles malformed baseUrl gracefully', async () => {
      // toOrigin'in fallback path'i — geçersiz URL'de de throw etmemeli
      const result = await discoverLLMEndpoint('not-a-url');
      expect(result.detected).toBe(false);
    });

    it('parses alternative models response shape {models:[{id}]}', async () => {
      responseMap.set('/v1/models', {
        status: 200,
        body: JSON.stringify({ models: [{ id: 'llama-3.1' }] }),
      });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      expect(result.detected).toBe(true);
      expect(result.availableModels).toEqual(['llama-3.1']);
    });

    it('prefers earlier candidate path when multiple match', async () => {
      responseMap.set('/v1/models', { status: 200, body: '{}' });
      responseMap.set('/api/v1/models', { status: 200, body: '{}' });

      const result = await discoverLLMEndpoint(`http://127.0.0.1:${port}/v1`);
      // /v1 daha önce, o kazanmalı
      expect(result.matchedPath).toBe('/v1/models');
    });
  });

  describe('formatDiscoveryResult', () => {
    it('formats a success case concisely', () => {
      const msg = formatDiscoveryResult({
        detected: true,
        baseUrl: 'http://x/v1',
        matchedPath: '/v1/models',
        statusCode: 200,
        availableModels: ['m1', 'm2'],
        attempts: [],
      });
      expect(msg).toContain('discovered');
      expect(msg).toContain('http://x/v1');
      expect(msg).toContain('200');
      expect(msg).toContain('2 models');
    });

    it('formats a failure case with attempts summary', () => {
      const msg = formatDiscoveryResult({
        detected: false,
        baseUrl: 'http://x/v1',
        matchedPath: '',
        statusCode: 0,
        availableModels: [],
        attempts: [
          { path: '/v1/models', status: 404 },
          { path: '/api/v1/models', status: null, error: 'timeout' },
        ],
      });
      expect(msg).toContain('failed');
      expect(msg).toContain('/v1/models: 404');
      expect(msg).toContain('timeout');
    });
  });
});
