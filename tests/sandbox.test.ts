/**
 * Sandbox Security Tests
 * 
 * Testler: Path traversal, symlink bypass, Windows path separator edge case'leri
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sandbox, defaultSandbox } from '../src/sandbox/sandbox';

describe('Sandbox Security', () => {
  let testRoot: string;
  let sandbox: Sandbox;

  beforeEach(() => {
    // Geçici test dizini oluştur
    testRoot = fs.mkdtempSync(path.join('/tmp', 'sandbox-test-'));
    sandbox = new Sandbox({
      rootPath: testRoot,
      canRead: true,
      canWrite: true,
      canExecute: false,
    });

    // Test yapısı oluştur
    fs.mkdirSync(path.join(testRoot, 'allowed'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'allowed', 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'allowed', 'file.txt'), 'test content');
  });

  afterEach(() => {
    // Temizlik
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  describe('Path Traversal Prevention', () => {
    it('should block basic path traversal with ..', () => {
      const result = sandbox.validatePath('../etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Path traversal not allowed');
    });

    it('should block nested path traversal', () => {
      const result = sandbox.validatePath('allowed/../../etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Path traversal not allowed');
    });

    it('should block path traversal that escapes after normalization', () => {
      const result = sandbox.validatePath('allowed/subdir/../../../etc/passwd');
      expect(result.ok).toBe(false);
    });

    it('should allow valid paths within sandbox', () => {
      const result = sandbox.validatePath('allowed/file.txt');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toContain(testRoot);
      }
    });

    it('should block path that tries to escape using encoded sequences', () => {
      const result = sandbox.validatePath('allowed/..%2f..%2fetc/passwd');
      // URL encoding should be handled by the path resolution
      expect(result.ok).toBe(false);
    });
  });

  describe('Symlink Bypass Prevention', () => {
    it('should detect symlink that points outside sandbox', () => {
      // Sandbox dışına işaret eden symlink oluştur
      const outsidePath = path.join('/tmp', 'outside-file.txt');
      fs.writeFileSync(outsidePath, 'outside content');
      const symlinkPath = path.join(testRoot, 'allowed', 'evil-link');
      
      try {
        fs.symlinkSync(outsidePath, symlinkPath);
        
        const result = sandbox.validatePath('allowed/evil-link');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Symlink bypass detected');
      } finally {
        // Temizlik
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
      }
    });

    it('should allow symlink within sandbox', () => {
      // Sandbox içinde symlink oluştur
      const targetPath = path.join(testRoot, 'allowed', 'file.txt');
      const symlinkPath = path.join(testRoot, 'allowed', 'good-link');
      
      try {
        fs.symlinkSync(targetPath, symlinkPath);
        
        const result = sandbox.validatePath('allowed/good-link');
        expect(result.ok).toBe(true);
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      }
    });

    it('should block symlink directory that points outside sandbox', () => {
      const outsideDir = path.join('/tmp', 'outside-dir');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
      
      const symlinkPath = path.join(testRoot, 'evil-dir-link');
      
      try {
        fs.symlinkSync(outsideDir, symlinkPath);
        
        const result = sandbox.validatePath('evil-dir-link/secret.txt');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Symlink bypass detected');
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Windows Path Separator Handling', () => {
    it('should handle Windows-style backslash separators', () => {
      const result = sandbox.validatePath('allowed\\file.txt');
      expect(result.ok).toBe(true);
    });

    it('should handle mixed separators', () => {
      const result = sandbox.validatePath('allowed\\subdir/file.txt');
      expect(result.ok).toBe(true);
    });

    it('should block path traversal with backslashes', () => {
      const result = sandbox.validatePath('allowed\\..\\..\\etc\\passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Path traversal not allowed');
    });

    it('should normalize double backslashes', () => {
      const result = sandbox.validatePath('allowed\\\\subdir\\\\file.txt');
      // Should be handled by path normalization
      expect(result.ok).toBe(true);
    });
  });

  describe('Null Byte Injection', () => {
    it('should block null byte injection', () => {
      const result = sandbox.validatePath('allowed/file.txt\0.jpg');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Null byte injection detected');
    });

    it('should block null byte in middle of path', () => {
      const result = sandbox.validatePath('all\0owed/file.txt');
      expect(result.ok).toBe(false);
    });
  });

  describe('Sandbox Boundary Checks', () => {
    it('should block path that escapes via prefix matching edge case', () => {
      // Edge case: /tmp/sandbox-test vs /tmp/sandbox-test-evil
      // startsWith check'ini bypass etmeye çalışıyor
      const result = sandbox.validatePath('../../' + testRoot + '-evil/file.txt');
      expect(result.ok).toBe(false);
    });

    it('should allow root path itself', () => {
      const result = sandbox.validatePath('');
      expect(result.ok).toBe(true);
    });

    it('should allow current directory reference', () => {
      const result = sandbox.validatePath('.');
      expect(result.ok).toBe(true);
    });
  });

  describe('isWithinSandbox', () => {
    it('should correctly identify paths within sandbox', () => {
      expect(sandbox.isWithinSandbox('allowed/file.txt')).toBe(true);
      expect(sandbox.isWithinSandbox('allowed')).toBe(true);
    });

    it('should reject paths outside sandbox', () => {
      expect(sandbox.isWithinSandbox('../etc/passwd')).toBe(false);
      expect(sandbox.isWithinSandbox('/etc/passwd')).toBe(false);
    });

    it('should handle Windows separators in isWithinSandbox', () => {
      expect(sandbox.isWithinSandbox('allowed\\file.txt')).toBe(true);
    });
  });

  describe('checkAccess', () => {
    it('should validate path before checking access', () => {
      const result = sandbox.checkAccess('../etc/passwd', 'read');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Path traversal not allowed');
    });

    it('should check read permission', () => {
      const readonlySandbox = new Sandbox({
        rootPath: testRoot,
        canRead: false,
        canWrite: true,
        canExecute: false,
      });
      
      const result = readonlySandbox.checkAccess('allowed/file.txt', 'read');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Read access not granted');
    });

    it('should check write permission', () => {
      const nowriteSandbox = new Sandbox({
        rootPath: testRoot,
        canRead: true,
        canWrite: false,
        canExecute: false,
      });
      
      const result = nowriteSandbox.checkAccess('allowed/file.txt', 'write');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Write access not granted');
    });
  });

  describe('defaultSandbox', () => {
    it('should create valid default configuration', () => {
      const config = defaultSandbox('test-project');
      expect(config.rootPath).toContain('test-project');
      expect(config.canRead).toBe(true);
      expect(config.canWrite).toBe(true);
      expect(config.canExecute).toBe(false);
      // allowedPaths artık yok
      expect('allowedPaths' in config).toBe(false);
    });
  });
});
