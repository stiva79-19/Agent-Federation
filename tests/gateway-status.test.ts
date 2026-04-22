/**
 * Gateway Status Tests
 *
 * parseHostPort, getSetupHints ve probeTcp davranışını test eder.
 * probeTcp için gerçek localhost TCP server kullanır (port 0 → random port).
 * probeOpenClawCli için testte spawn yapmıyoruz (çevrede CLI var/yok belirsiz).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import {
  parseHostPort,
  getSetupHints,
  detectPlatform,
  probeTcp,
  checkGatewayStatus,
  type Platform,
} from '../src/agent/gateway-status';

describe('gateway-status', () => {
  describe('parseHostPort', () => {
    it('parses standard OpenClaw Gateway URL', () => {
      expect(parseHostPort('http://localhost:18789/v1')).toEqual({ host: 'localhost', port: 18789 });
    });

    it('parses URL without port (http → 80)', () => {
      expect(parseHostPort('http://example.com/')).toEqual({ host: 'example.com', port: 80 });
    });

    it('parses URL without port (https → 443)', () => {
      expect(parseHostPort('https://example.com/')).toEqual({ host: 'example.com', port: 443 });
    });

    it('falls back to defaults on malformed URL', () => {
      expect(parseHostPort('not-a-url')).toEqual({ host: '127.0.0.1', port: 18789 });
    });

    it('falls back to defaults on empty string', () => {
      expect(parseHostPort('')).toEqual({ host: '127.0.0.1', port: 18789 });
    });

    it('parses 127.0.0.1 and IPv6', () => {
      expect(parseHostPort('http://127.0.0.1:18789')).toEqual({ host: '127.0.0.1', port: 18789 });
      expect(parseHostPort('http://[::1]:18789')).toEqual({ host: '::1', port: 18789 });
    });
  });

  describe('detectPlatform', () => {
    it('returns one of the known platforms', () => {
      const p = detectPlatform();
      expect(['darwin', 'linux', 'win32', 'other']).toContain(p);
    });
  });

  describe('getSetupHints', () => {
    it('returns primary and alternatives for macOS', () => {
      const h = getSetupHints('darwin');
      expect(h.primary.length).toBeGreaterThan(0);
      expect(h.alternatives.length).toBeGreaterThan(0);
      expect(h.primary.some(x => x.command === 'openclaw gateway install')).toBe(true);
    });

    it('returns primary for linux including systemd hint', () => {
      const h = getSetupHints('linux');
      expect(h.primary.some(x => x.command?.includes('systemctl --user'))).toBe(true);
    });

    it('returns primary for windows with Scheduled Task + WSL2 recommendation', () => {
      const h = getSetupHints('win32');
      expect(h.primary.some(x => x.command?.includes('schtasks'))).toBe(true);
      expect(h.primary.some(x => /WSL2/i.test(x.label))).toBe(true);
    });

    it('alternatives includes other platforms with section labels', () => {
      const h = getSetupHints('darwin');
      const labels = h.alternatives.map(a => a.label);
      expect(labels.some(l => /Linux/.test(l))).toBe(true);
      expect(labels.some(l => /Windows/.test(l))).toBe(true);
    });

    it('every hint has a label string', () => {
      const platforms: Platform[] = ['darwin', 'linux', 'win32', 'other'];
      for (const p of platforms) {
        const h = getSetupHints(p);
        for (const hint of [...h.primary, ...h.alternatives]) {
          expect(typeof hint.label).toBe('string');
          expect(hint.label.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('probeTcp', () => {
    let server: net.Server;
    let serverPort: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') serverPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('returns ok:true when port is open', async () => {
      const result = await probeTcp('127.0.0.1', serverPort);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns ok:false ECONNREFUSED when port is closed', async () => {
      // Kapalı olduğundan emin olunan bir port — çok yüksek ve rastgele
      const closedPort = 59999;
      const result = await probeTcp('127.0.0.1', closedPort, 1500);
      expect(result.ok).toBe(false);
      // Platform ve network konfigürasyonuna göre ECONNREFUSED ya da EHOSTUNREACH olabilir
      expect(['ECONNREFUSED', 'EHOSTUNREACH', 'timeout']).toContain(result.error);
    });

    it('honors timeout on unreachable host', async () => {
      // RFC 5737 TEST-NET-1 (non-routable) — timeout'a düşsün
      const result = await probeTcp('192.0.2.1', 18789, 500);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('checkGatewayStatus', () => {
    it('reports offline when port is closed', async () => {
      const status = await checkGatewayStatus('http://127.0.0.1:59999/v1');
      expect(status.health).toBe('offline');
      expect(status.summary).toContain('offline');
      expect(status.hints.primary.length).toBeGreaterThan(0);
      expect(status.port).toBe(59999);
    });

    it('includes platform-specific primary hints', async () => {
      const status = await checkGatewayStatus('http://127.0.0.1:59999/v1');
      const platform = detectPlatform();
      if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
        // Primary her zaman dolu olmalı
        expect(status.hints.primary.length).toBeGreaterThan(0);
      }
    });

    it('parses baseUrl correctly', async () => {
      const status = await checkGatewayStatus('http://127.0.0.1:59999/v1');
      expect(status.host).toBe('127.0.0.1');
      expect(status.port).toBe(59999);
    });
  });
});
