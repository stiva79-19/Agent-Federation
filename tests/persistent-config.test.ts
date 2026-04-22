/**
 * Persistent Config Tests
 *
 * Platform-aware path çözümleme ve read/write cycle'ını test eder.
 * AGENT_FEDERATION_CONFIG_DIR override ile izole test dizini kullanır.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadPersistentConfig,
  savePersistentConfig,
  getPersistentConfigDir,
  getPersistentConfigPath,
  clearPersistentConfigField,
} from '../src/agent/persistent-config';

describe('persistent-config', () => {
  let tmpRoot: string;
  let envBackup: { [k: string]: string | undefined };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-cfg-test-'));
    envBackup = {
      AGENT_FEDERATION_CONFIG_DIR: process.env['AGENT_FEDERATION_CONFIG_DIR'],
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
      APPDATA: process.env['APPDATA'],
    };
    process.env['AGENT_FEDERATION_CONFIG_DIR'] = tmpRoot;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('getPersistentConfigDir', () => {
    it('honors AGENT_FEDERATION_CONFIG_DIR override', () => {
      expect(getPersistentConfigDir()).toBe(tmpRoot);
    });

    it('uses platform-appropriate default when override unset', () => {
      delete process.env['AGENT_FEDERATION_CONFIG_DIR'];
      delete process.env['XDG_CONFIG_HOME'];
      delete process.env['APPDATA'];

      const dir = getPersistentConfigDir();
      expect(dir.endsWith('agent-federation')).toBe(true);

      if (process.platform === 'darwin') {
        expect(dir).toContain('Library/Application Support');
      } else if (process.platform === 'linux') {
        expect(dir).toContain('.config');
      }
    });

    it('Linux honors XDG_CONFIG_HOME', () => {
      if (process.platform !== 'linux') return; // Skip non-Linux
      delete process.env['AGENT_FEDERATION_CONFIG_DIR'];
      process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-test';

      const dir = getPersistentConfigDir();
      expect(dir).toBe('/tmp/xdg-test/agent-federation');
    });
  });

  describe('getPersistentConfigPath', () => {
    it('appends config.json to the dir', () => {
      expect(getPersistentConfigPath()).toBe(path.join(tmpRoot, 'config.json'));
    });
  });

  describe('loadPersistentConfig', () => {
    it('returns empty object when file does not exist', () => {
      expect(loadPersistentConfig()).toEqual({});
    });

    it('returns empty object when file is malformed JSON', () => {
      fs.writeFileSync(path.join(tmpRoot, 'config.json'), 'not json {');
      expect(loadPersistentConfig()).toEqual({});
    });

    it('returns empty object when JSON is an array (wrong shape)', () => {
      fs.writeFileSync(path.join(tmpRoot, 'config.json'), '[1,2,3]');
      expect(loadPersistentConfig()).toEqual({});
    });

    it('reads a valid config file', () => {
      const data = { openclawHome: '/home/x/.openclaw', theme: 'dark' };
      fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify(data));
      expect(loadPersistentConfig()).toEqual(data);
    });
  });

  describe('savePersistentConfig', () => {
    it('writes a fresh config file', () => {
      const ok = savePersistentConfig({ openclawHome: '/home/x' });
      expect(ok).toBe(true);
      const raw = fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ openclawHome: '/home/x' });
    });

    it('creates parent directory if missing', () => {
      const nested = path.join(tmpRoot, 'deep', 'nested');
      process.env['AGENT_FEDERATION_CONFIG_DIR'] = nested;
      const ok = savePersistentConfig({ foo: 'bar' });
      expect(ok).toBe(true);
      expect(fs.existsSync(path.join(nested, 'config.json'))).toBe(true);
    });

    it('overwrites existing file', () => {
      savePersistentConfig({ a: 1 });
      savePersistentConfig({ b: 2 });
      expect(loadPersistentConfig()).toEqual({ b: 2 });
    });
  });

  describe('clearPersistentConfigField', () => {
    it('removes a single field without touching others', () => {
      savePersistentConfig({ openclawHome: '/x', theme: 'dark' });
      clearPersistentConfigField('theme');
      expect(loadPersistentConfig()).toEqual({ openclawHome: '/x' });
    });

    it('is a no-op when field does not exist', () => {
      savePersistentConfig({ a: 1 });
      const ok = clearPersistentConfigField('nonexistent');
      expect(ok).toBe(true);
      expect(loadPersistentConfig()).toEqual({ a: 1 });
    });
  });
});
