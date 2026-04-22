/**
 * Silent Peer Helpers Tests
 *
 * isLLMUnreachableError ve classifyLLMError'ın hangi hataların "LLM
 * ulaşılamaz" sayılıp hangilerinin "real error" sayıldığını test eder.
 */

import { describe, it, expect } from 'vitest';
import { isLLMUnreachableError, classifyLLMError } from '../src/server/ws-server';

describe('silent-peer helpers', () => {
  describe('isLLMUnreachableError', () => {
    it('returns false for null/undefined', () => {
      expect(isLLMUnreachableError(null)).toBe(false);
      expect(isLLMUnreachableError(undefined)).toBe(false);
    });

    it('detects ECONNREFUSED at top level', () => {
      expect(isLLMUnreachableError({ code: 'ECONNREFUSED' })).toBe(true);
    });

    it('detects ECONNREFUSED in cause (Node fetch undici wraps it)', () => {
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      expect(isLLMUnreachableError(err)).toBe(true);
    });

    it('detects all unreachable codes', () => {
      const codes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE', 'ECONNRESET'];
      for (const code of codes) {
        expect(isLLMUnreachableError({ code })).toBe(true);
      }
    });

    it('detects AbortError', () => {
      const err = new Error('aborted');
      (err as Error).name = 'AbortError';
      expect(isLLMUnreachableError(err)).toBe(true);
    });

    it('detects "fetch failed" message', () => {
      expect(isLLMUnreachableError({ message: 'fetch failed' })).toBe(true);
      expect(isLLMUnreachableError(new TypeError('fetch failed'))).toBe(true);
    });

    it('detects "network error" messages', () => {
      expect(isLLMUnreachableError({ message: 'Network error occurred' })).toBe(true);
    });

    it('does NOT match auth errors (401/403 are "real" errors)', () => {
      expect(isLLMUnreachableError({ code: 'UNAUTHORIZED', message: 'bad api key' })).toBe(false);
      expect(isLLMUnreachableError({ message: 'Invalid api key' })).toBe(false);
    });

    it('does NOT match bad request errors', () => {
      expect(isLLMUnreachableError({ message: 'Bad request — invalid model' })).toBe(false);
    });

    it('does NOT match arbitrary JSON parse errors', () => {
      expect(isLLMUnreachableError(new SyntaxError('Unexpected token'))).toBe(false);
    });
  });

  describe('classifyLLMError', () => {
    it('returns "unknown" for null', () => {
      expect(classifyLLMError(null)).toBe('unknown');
    });

    it('returns code from top level', () => {
      expect(classifyLLMError({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    });

    it('returns code from cause (undici fetch)', () => {
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = { code: 'ETIMEDOUT' };
      expect(classifyLLMError(err)).toBe('ETIMEDOUT');
    });

    it('falls back to "fetch-failed" when no code', () => {
      expect(classifyLLMError(new TypeError('fetch failed'))).toBe('fetch-failed');
    });
  });
});
