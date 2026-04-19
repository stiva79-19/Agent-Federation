/**
 * Sandbox File System Tests
 *
 * SandboxFS modülünün path validation, dosya işlemleri,
 * risk skorlama ve güvenlik kontrollerini test eder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  SandboxFS,
  validateSandboxPath,
  calculateRiskScore,
} from '../src/server/sandbox-fs';

describe('SandboxFS', () => {
  let testBaseDir: string;
  let sandboxFS: SandboxFS;
  const sessionId = 'test-session-001';
  const agentName = 'TestAgent';

  beforeEach(() => {
    testBaseDir = fs.mkdtempSync(path.join('/tmp', 'sandbox-fs-test-'));
    sandboxFS = new SandboxFS({ baseDir: testBaseDir });
    sandboxFS.initSession(sessionId);
  });

  afterEach(() => {
    sandboxFS.clear();
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  // ─── Path Validation ────────────────────────────────────────────────────

  describe('validateSandboxPath', () => {
    it('should allow valid relative paths', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, 'src/utils.ts');
      expect(result.ok).toBe(true);
    });

    it('should block path traversal with ..', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, '../etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('..');
      }
    });

    it('should block nested path traversal', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, 'src/../../etc/passwd');
      expect(result.ok).toBe(false);
    });

    it('should block absolute paths', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, '/etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Absolute');
      }
    });

    it('should block null byte injection', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, 'file.txt\0.jpg');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Null byte');
      }
    });

    it('should normalize Windows backslashes', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, 'src\\utils.ts');
      expect(result.ok).toBe(true);
    });

    it('should block backslash path traversal', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const result = validateSandboxPath(sandboxRoot, 'src\\..\\..\\etc\\passwd');
      expect(result.ok).toBe(false);
    });

    it('should detect symlink bypass', () => {
      const sandboxRoot = path.join(testBaseDir, sessionId);
      const outsidePath = path.join('/tmp', 'outside-sandbox-test.txt');
      fs.writeFileSync(outsidePath, 'outside content');
      const symlinkPath = path.join(sandboxRoot, 'evil-link');

      try {
        fs.symlinkSync(outsidePath, symlinkPath);
        const result = validateSandboxPath(sandboxRoot, 'evil-link');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain('Symlink bypass');
        }
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        if (fs.existsSync(outsidePath)) fs.unlinkSync(outsidePath);
      }
    });
  });

  // ─── File Operations ────────────────────────────────────────────────────

  describe('fileCreate', () => {
    it('should create a file successfully', () => {
      const result = sandboxFS.fileCreate(sessionId, agentName, 'hello.txt', 'Hello World');
      expect(result.success).toBe(true);
      expect(result.action).toBe('file_create');
      expect(result.filePath).toBe('hello.txt');

      // Dosya var mı kontrol
      const sessionPath = sandboxFS.getSessionPath(sessionId);
      expect(fs.existsSync(path.join(sessionPath!, 'hello.txt'))).toBe(true);
    });

    it('should create nested files with auto-directory', () => {
      const result = sandboxFS.fileCreate(sessionId, agentName, 'src/utils/helpers.ts', 'export {}');
      expect(result.success).toBe(true);

      const sessionPath = sandboxFS.getSessionPath(sessionId);
      expect(fs.existsSync(path.join(sessionPath!, 'src/utils/helpers.ts'))).toBe(true);
    });

    it('should reject creating existing file', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'exists.txt', 'content');
      const result = sandboxFS.fileCreate(sessionId, agentName, 'exists.txt', 'new content');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should reject path traversal in file_create', () => {
      const result = sandboxFS.fileCreate(sessionId, agentName, '../evil.txt', 'pwned');
      expect(result.success).toBe(false);
      expect(result.error).toContain('..');
    });

    it('should fail for uninitialized session', () => {
      const result = sandboxFS.fileCreate('nonexistent', agentName, 'file.txt', 'content');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not initialized');
    });
  });

  describe('fileEdit', () => {
    it('should edit file with old/new content replacement', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'edit-me.txt', 'Hello World');
      const result = sandboxFS.fileEdit(sessionId, agentName, 'edit-me.txt', {
        oldContent: 'World',
        newContent: 'Universe',
      });
      expect(result.success).toBe(true);

      const readResult = sandboxFS.fileRead(sessionId, agentName, 'edit-me.txt');
      expect(readResult.fileContent).toBe('Hello Universe');
    });

    it('should edit file with full content replacement', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'replace-me.txt', 'old');
      const result = sandboxFS.fileEdit(sessionId, agentName, 'replace-me.txt', {
        fullContent: 'completely new content',
      });
      expect(result.success).toBe(true);

      const readResult = sandboxFS.fileRead(sessionId, agentName, 'replace-me.txt');
      expect(readResult.fileContent).toBe('completely new content');
    });

    it('should reject editing non-existent file', () => {
      const result = sandboxFS.fileEdit(sessionId, agentName, 'nope.txt', {
        fullContent: 'content',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should reject when old_content not found', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'no-match.txt', 'Hello World');
      const result = sandboxFS.fileEdit(sessionId, agentName, 'no-match.txt', {
        oldContent: 'Nonexistent',
        newContent: 'Replacement',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should record oldContent for diff', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'diff-test.txt', 'original');
      const result = sandboxFS.fileEdit(sessionId, agentName, 'diff-test.txt', {
        fullContent: 'modified',
      });
      expect(result.success).toBe(true);
      expect(result.oldContent).toBe('original');
      expect(result.content).toBe('modified');
    });
  });

  describe('fileDelete', () => {
    it('should delete a file', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'delete-me.txt', 'bye');
      const result = sandboxFS.fileDelete(sessionId, agentName, 'delete-me.txt');
      expect(result.success).toBe(true);

      const sessionPath = sandboxFS.getSessionPath(sessionId);
      expect(fs.existsSync(path.join(sessionPath!, 'delete-me.txt'))).toBe(false);
    });

    it('should reject deleting non-existent file', () => {
      const result = sandboxFS.fileDelete(sessionId, agentName, 'ghost.txt');
      expect(result.success).toBe(false);
    });
  });

  describe('fileRead', () => {
    it('should read file content', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'readable.txt', 'Read me!');
      const result = sandboxFS.fileRead(sessionId, agentName, 'readable.txt');
      expect(result.success).toBe(true);
      expect(result.fileContent).toBe('Read me!');
      expect(result.approvalStatus).toBe('auto_approved');
    });

    it('should fail for non-existent file', () => {
      const result = sandboxFS.fileRead(sessionId, agentName, 'nope.txt');
      expect(result.success).toBe(false);
    });
  });

  describe('fileList', () => {
    it('should list sandbox contents', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'file1.txt', 'a');
      sandboxFS.fileCreate(sessionId, agentName, 'file2.ts', 'b');
      sandboxFS.dirCreate(sessionId, agentName, 'subdir');

      const result = sandboxFS.fileList(sessionId, agentName);
      expect(result.success).toBe(true);
      expect(result.files).toBeDefined();
      expect(result.files!.length).toBe(3);
      expect(result.approvalStatus).toBe('auto_approved');
    });

    it('should list subdirectory contents', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'dir/nested.txt', 'nested');
      const result = sandboxFS.fileList(sessionId, agentName, 'dir');
      expect(result.success).toBe(true);
      expect(result.files!.length).toBe(1);
      expect(result.files![0].name).toBe('nested.txt');
    });
  });

  describe('dirCreate', () => {
    it('should create a directory', () => {
      const result = sandboxFS.dirCreate(sessionId, agentName, 'new-dir');
      expect(result.success).toBe(true);
    });

    it('should reject creating existing directory', () => {
      sandboxFS.dirCreate(sessionId, agentName, 'existing-dir');
      const result = sandboxFS.dirCreate(sessionId, agentName, 'existing-dir');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  // ─── Action Log ─────────────────────────────────────────────────────────

  describe('Action Log', () => {
    it('should record all actions', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'log-test.txt', 'data');
      sandboxFS.fileRead(sessionId, agentName, 'log-test.txt');
      sandboxFS.fileList(sessionId, agentName);

      const logs = sandboxFS.getActionLog(sessionId);
      expect(logs.length).toBe(3);
      expect(logs[0].action).toBe('file_create');
      expect(logs[1].action).toBe('file_read');
      expect(logs[2].action).toBe('file_list');
    });

    it('should include agent name and timestamps', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'agent-log.txt', 'data');
      const logs = sandboxFS.getActionLog(sessionId);
      expect(logs[0].agentName).toBe(agentName);
      expect(logs[0].timestamp).toBeInstanceOf(Date);
      expect(logs[0].id).toBeTruthy();
    });
  });

  // ─── Session Management ─────────────────────────────────────────────────

  describe('Session Management', () => {
    it('should initialize session and create directory', () => {
      const newSessionId = 'new-session';
      const sessionPath = sandboxFS.initSession(newSessionId);
      expect(fs.existsSync(sessionPath)).toBe(true);
      sandboxFS.cleanupSession(newSessionId);
    });

    it('should return existing path on re-init', () => {
      const path1 = sandboxFS.initSession(sessionId);
      const path2 = sandboxFS.initSession(sessionId);
      expect(path1).toBe(path2);
    });

    it('should cleanup session directory', () => {
      sandboxFS.fileCreate(sessionId, agentName, 'temp.txt', 'temp');
      const sessionPath = sandboxFS.getSessionPath(sessionId);
      expect(fs.existsSync(sessionPath!)).toBe(true);

      sandboxFS.cleanupSession(sessionId);
      expect(fs.existsSync(sessionPath!)).toBe(false);
    });
  });
});

// ─── Risk Score Tests ───────────────────────────────────────────────────────

describe('calculateRiskScore', () => {
  it('should give low score for normal file creation', () => {
    const score = calculateRiskScore('file_create', 'src/utils.ts', 'export const x = 1;');
    expect(score).toBeLessThan(30);
  });

  it('should give high score for .env file', () => {
    const score = calculateRiskScore('file_create', '.env', 'SECRET=abc');
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('should give high score for executable files', () => {
    const score = calculateRiskScore('file_create', 'deploy.sh', '#!/bin/bash\nrm -rf /');
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('should give moderate score for deletion', () => {
    const score = calculateRiskScore('file_delete', 'important.ts');
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it('should give zero/low score for reads', () => {
    const score = calculateRiskScore('file_read', 'readme.md');
    expect(score).toBeLessThan(10);
  });

  it('should detect eval/exec patterns', () => {
    const score = calculateRiskScore('file_create', 'code.js', 'eval("dangerous code")');
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it('should cap at 100', () => {
    const score = calculateRiskScore('file_delete', '.env', '#!/bin/bash\neval("x")');
    expect(score).toBeLessThanOrEqual(100);
  });
});
