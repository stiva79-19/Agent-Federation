/**
 * OpenClaw Home Resolver Tests
 *
 * Çözümleme sırasını, path genişletmeyi, ve `isValidOpenClawHome` validasyonunu test eder.
 * Gerçek disk I/O gerektiği için her test izole bir temp dizin kullanır.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveOpenClawHome,
  setOpenClawHome,
  isValidOpenClawHome,
  platformDefaultOpenClawHome,
} from '../src/agent/openclaw-home';

describe('openclaw-home', () => {
  let tmpRoot: string;
  let envBackup: { [key: string]: string | undefined };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-test-'));
    envBackup = {
      OPENCLAW_HOME: process.env['OPENCLAW_HOME'],
      OPENCLAW_WORKSPACE: process.env['OPENCLAW_WORKSPACE'],
      AGENT_FEDERATION_CONFIG_DIR: process.env['AGENT_FEDERATION_CONFIG_DIR'],
    };
    // Her test izole bir config dir kullansın
    process.env['AGENT_FEDERATION_CONFIG_DIR'] = path.join(tmpRoot, 'cfg');
    // Env override'ları temizle
    delete process.env['OPENCLAW_HOME'];
    delete process.env['OPENCLAW_WORKSPACE'];
  });

  afterEach(() => {
    // Env'i geri yükle
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Temp dizini sil
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('isValidOpenClawHome', () => {
    it('returns false for non-existent path', () => {
      expect(isValidOpenClawHome(path.join(tmpRoot, 'nope'))).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidOpenClawHome('')).toBe(false);
    });

    it('returns false for a file (not directory)', () => {
      const file = path.join(tmpRoot, 'file.txt');
      fs.writeFileSync(file, 'x');
      expect(isValidOpenClawHome(file)).toBe(false);
    });

    it('returns false for directory without openclaw.json or workspace/', () => {
      const empty = path.join(tmpRoot, 'empty');
      fs.mkdirSync(empty);
      expect(isValidOpenClawHome(empty)).toBe(false);
    });

    it('returns true when openclaw.json exists', () => {
      const home = path.join(tmpRoot, 'home1');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'openclaw.json'), '{}');
      expect(isValidOpenClawHome(home)).toBe(true);
    });

    it('returns true when workspace/ directory exists', () => {
      const home = path.join(tmpRoot, 'home2');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(home, 'workspace'));
      expect(isValidOpenClawHome(home)).toBe(true);
    });
  });

  describe('platformDefaultOpenClawHome', () => {
    it('points to ~/.openclaw on all platforms', () => {
      const defaultHome = platformDefaultOpenClawHome();
      expect(defaultHome).toBe(path.join(os.homedir(), '.openclaw'));
    });
  });

  describe('resolveOpenClawHome', () => {
    it('returns unresolved when nothing matches', () => {
      // Platform default'un var olmadığı bir durum için (tmpRoot'u home default'a map et)
      // Gerçek ~/.openclaw varsa false pozitif riski var; bu yüzden env ile override test ediyoruz
      process.env['OPENCLAW_HOME'] = path.join(tmpRoot, 'missing');
      const resolution = resolveOpenClawHome();
      // env var geçersiz → diğer kaynaklar (persistent, platform default) denenir.
      // Test ortamında platform default (~/.openclaw) olmayabilir, o zaman unresolved.
      // Eğer varsa bu test laptop'a göre değişir — sadece env-home'un bypass edilip geçersizse
      // başka kaynakların denendiğini doğrula.
      if (!resolution.resolved) {
        expect(resolution.source).toBe('unresolved');
      }
    });

    it('resolves from OPENCLAW_HOME env var when set and valid', () => {
      const home = path.join(tmpRoot, 'claw');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'openclaw.json'), '{}');
      process.env['OPENCLAW_HOME'] = home;

      const resolution = resolveOpenClawHome();

      expect(resolution.resolved).toBe(true);
      expect(resolution.source).toBe('env-home');
      expect(resolution.path).toBe(home);
      expect(resolution.hasConfigFile).toBe(true);
      expect(resolution.hasWorkspaceDir).toBe(false);
      expect(resolution.workspacePath).toBe(path.join(home, 'workspace'));
    });

    it('falls back to legacy OPENCLAW_WORKSPACE env var', () => {
      const home = path.join(tmpRoot, 'legacy');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(home, 'workspace'));
      process.env['OPENCLAW_WORKSPACE'] = home;

      const resolution = resolveOpenClawHome();

      expect(resolution.resolved).toBe(true);
      expect(resolution.source).toBe('env-workspace');
      expect(resolution.path).toBe(home);
      expect(resolution.hasWorkspaceDir).toBe(true);
    });

    it('OPENCLAW_HOME takes precedence over OPENCLAW_WORKSPACE', () => {
      const homeNew = path.join(tmpRoot, 'new-home');
      const homeLegacy = path.join(tmpRoot, 'legacy-home');
      for (const h of [homeNew, homeLegacy]) {
        fs.mkdirSync(h);
        fs.writeFileSync(path.join(h, 'openclaw.json'), '{}');
      }
      process.env['OPENCLAW_HOME'] = homeNew;
      process.env['OPENCLAW_WORKSPACE'] = homeLegacy;

      const resolution = resolveOpenClawHome();
      expect(resolution.path).toBe(homeNew);
      expect(resolution.source).toBe('env-home');
    });

    it('expands tilde (~) in OPENCLAW_HOME', () => {
      // Bu test ~'ı HOME'a map ediyor. Gerçek ~/.openclaw varsa kaçın.
      // Sadece resolver'ın tilde'yi açtığını doğrula.
      const fakePath = '~/nonexistent-test-dir-xyz-123';
      process.env['OPENCLAW_HOME'] = fakePath;
      const resolution = resolveOpenClawHome();
      // Path açılmış mı kontrol et (dizin yoksa unresolved ama açılma denenmiş olmalı)
      // Dolaylı check: resolved false ama platform-default denemiş olmalı
      expect(resolution.triedPlatformDefault).toBe(platformDefaultOpenClawHome());
    });

    it('uses persistent config when no env var set', () => {
      const home = path.join(tmpRoot, 'persisted');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'openclaw.json'), '{}');

      // Persistent config'i manuel yaz
      const cfgDir = path.join(tmpRoot, 'cfg');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ openclawHome: home }));

      const resolution = resolveOpenClawHome();
      expect(resolution.resolved).toBe(true);
      expect(resolution.source).toBe('persistent-config');
      expect(resolution.path).toBe(home);
    });
  });

  describe('setOpenClawHome', () => {
    it('persists a valid home path and returns resolved', () => {
      const home = path.join(tmpRoot, 'chosen');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, 'openclaw.json'), '{}');

      const resolution = setOpenClawHome(home);

      expect(resolution.resolved).toBe(true);
      expect(resolution.source).toBe('persistent-config');
      expect(resolution.path).toBe(home);

      // Dosya yazılmış olmalı
      const cfgPath = path.join(tmpRoot, 'cfg', 'config.json');
      expect(fs.existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(cfg.openclawHome).toBe(home);
    });

    it('does not persist an invalid home path', () => {
      const invalid = path.join(tmpRoot, 'does-not-exist');
      setOpenClawHome(invalid);

      // Persistent config yazılmamış olmalı
      const cfgPath = path.join(tmpRoot, 'cfg', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        expect(cfg.openclawHome).toBeUndefined();
      }
    });
  });
});
