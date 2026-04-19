/**
 * Sandbox File System — Agent Federation Server
 *
 * Her collaboration oturumunda agent'ların dosya oluşturup, kod yazıp,
 * düzenleme yapabileceği izole bir sandbox klasörü sağlar.
 *
 * Security: Path traversal, symlink bypass, null byte injection koruması.
 * Her dosya işlemi bir SandboxAction kaydı oluşturur.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Sandbox dosya işlem tipleri */
export type SandboxActionType =
  | 'file_create'
  | 'file_edit'
  | 'file_delete'
  | 'file_read'
  | 'file_list'
  | 'dir_create';

/** Tek bir sandbox dosya işleminin kaydı */
export interface SandboxAction {
  /** Benzersiz işlem ID */
  id: string;
  /** Session ID */
  sessionId: string;
  /** İşlemi yapan agent adı */
  agentName: string;
  /** İşlem tipi */
  action: SandboxActionType;
  /** Dosya/klasör yolu (sandbox-relative) */
  filePath: string;
  /** Yeni içerik (file_create, file_edit) */
  content?: string;
  /** Eski içerik (file_edit — diff için) */
  oldContent?: string;
  /** İşlem zamanı */
  timestamp: Date;
  /** İşlem başarılı mı */
  success: boolean;
  /** Hata mesajı (başarısızsa) */
  error?: string;
  /** Onay durumu */
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'auto_approved';
}

/** Sandbox FS yapılandırması */
export interface SandboxFSConfig {
  /** Sandbox kök dizini (tüm session'lar burada oluşturulur) */
  baseDir: string;
}

/** Dosya bilgisi (file_list için) */
export interface SandboxFileInfo {
  /** Dosya/klasör adı */
  name: string;
  /** Sandbox-relative yol */
  path: string;
  /** Dosya mı, klasör mü */
  type: 'file' | 'directory';
  /** Boyut (byte) — sadece dosyalar için */
  size?: number;
  /** Son değişiklik zamanı */
  modifiedAt?: Date;
}

// ─── Path Validation ─────────────────────────────────────────────────────────

/**
 * Verilen yolun sandbox sınırları içinde olup olmadığını doğrular.
 * Path traversal, null byte injection ve symlink bypass saldırılarını engeller.
 *
 * @param sandboxRoot - Sandbox kök dizini (absolute path)
 * @param relativePath - Doğrulanacak relative path
 * @returns Doğrulama sonucu
 */
export function validateSandboxPath(
  sandboxRoot: string,
  relativePath: string
): { ok: true; resolved: string } | { ok: false; error: string } {
  // Null byte injection engelle
  if (relativePath.includes('\0')) {
    return { ok: false, error: 'Null byte injection detected' };
  }

  // Absolute path engelle
  if (path.isAbsolute(relativePath)) {
    return { ok: false, error: 'Absolute paths are not allowed' };
  }

  // Windows backslash'lerini normalize et
  const normalized = relativePath.replace(/\\/g, '/');

  // Path traversal kontrolü — normalize edilmiş path'te .. var mı?
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..') {
      return { ok: false, error: 'Path traversal (..) is not allowed' };
    }
  }

  // Resolve et ve sınır kontrolü yap
  const resolved = path.resolve(sandboxRoot, normalized);
  const rootWithSep = sandboxRoot.endsWith(path.sep)
    ? sandboxRoot
    : sandboxRoot + path.sep;

  if (resolved !== sandboxRoot && !resolved.startsWith(rootWithSep)) {
    return { ok: false, error: `Path escapes sandbox boundary: ${relativePath}` };
  }

  // Symlink bypass kontrolü — dosya/klasör varsa realpath ile kontrol et
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const rootRealPath = fs.realpathSync(sandboxRoot);
      const rootRealWithSep = rootRealPath.endsWith(path.sep)
        ? rootRealPath
        : rootRealPath + path.sep;

      if (realPath !== rootRealPath && !realPath.startsWith(rootRealWithSep)) {
        return { ok: false, error: 'Symlink bypass detected: path resolves outside sandbox' };
      }
    }
  } catch {
    // realpathSync hataları güvenli şekilde ele alınır
  }

  return { ok: true, resolved };
}

// ─── Risk Scoring ────────────────────────────────────────────────────────────

/** Dosya uzantılarına göre risk seviyeleri */
const HIGH_RISK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.env', '.pem', '.key', '.crt', '.p12', '.pfx',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.exe',
]);

const HIGH_RISK_FILENAMES: ReadonlySet<string> = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  '.gitignore', '.npmrc', '.yarnrc',
  'id_rsa', 'id_ed25519', 'authorized_keys',
  'Makefile', 'Dockerfile', 'docker-compose.yml',
]);

/**
 * Bir sandbox işleminin risk skorunu hesaplar (0-100).
 * Yüksek riskli dosya tipleri, büyük silme işlemleri vb. için yüksek skor verir.
 */
export function calculateRiskScore(
  action: SandboxActionType,
  filePath: string,
  content?: string
): number {
  let score = 0;
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  // Dosya tipi riski
  if (HIGH_RISK_EXTENSIONS.has(ext)) {
    score += 40;
  }
  if (HIGH_RISK_FILENAMES.has(basename)) {
    score += 50;
  }

  // .env ile başlayan dosyalar (örn: .env.local, .env.production)
  if (basename.startsWith('.env')) {
    score += 20;
  }

  // İşlem tipi riski
  switch (action) {
    case 'file_delete':
      score += 30;
      break;
    case 'file_create':
      score += 10;
      break;
    case 'file_edit':
      score += 15;
      break;
    case 'dir_create':
      score += 5;
      break;
    case 'file_read':
    case 'file_list':
      // Okuma işlemleri düşük riskli
      break;
  }

  // İçerik boyutu riski (büyük dosyalar)
  if (content && content.length > 50000) {
    score += 15;
  }

  // Executable pattern tespiti
  if (content) {
    if (content.startsWith('#!')) {
      score += 25; // shebang line
    }
    if (/eval\s*\(/.test(content) || /exec\s*\(/.test(content)) {
      score += 20;
    }
  }

  return Math.min(score, 100);
}

// ─── Sandbox File System Manager ─────────────────────────────────────────────

/**
 * Sandbox dosya sistemi yöneticisi.
 * Her session için izole bir klasör oluşturur ve dosya işlemlerini yönetir.
 */
export class SandboxFS {
  private readonly baseDir: string;
  /** Session ID → sandbox root path */
  private readonly sessionPaths: Map<string, string> = new Map();
  /** Tüm sandbox işlem logları (session ID → actions) */
  private readonly actionLogs: Map<string, SandboxAction[]> = new Map();

  constructor(config: SandboxFSConfig) {
    this.baseDir = path.resolve(config.baseDir);
  }

  /**
   * Bir session için sandbox dizini oluşturur.
   * Dizin zaten varsa mevcut yolu döner.
   */
  initSession(sessionId: string): string {
    const existing = this.sessionPaths.get(sessionId);
    if (existing) return existing;

    const sessionDir = path.join(this.baseDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    this.sessionPaths.set(sessionId, sessionDir);
    this.actionLogs.set(sessionId, []);
    return sessionDir;
  }

  /**
   * Session sandbox'ının kök dizinini döner.
   */
  getSessionPath(sessionId: string): string | undefined {
    return this.sessionPaths.get(sessionId);
  }

  /**
   * Bir sandbox işlemi kaydı oluşturur.
   */
  private recordAction(
    sessionId: string,
    agentName: string,
    action: SandboxActionType,
    filePath: string,
    success: boolean,
    approvalStatus: SandboxAction['approvalStatus'],
    options?: { content?: string; oldContent?: string; error?: string }
  ): SandboxAction {
    const record: SandboxAction = {
      id: crypto.randomUUID(),
      sessionId,
      agentName,
      action,
      filePath,
      content: options?.content,
      oldContent: options?.oldContent,
      timestamp: new Date(),
      success,
      error: options?.error,
      approvalStatus,
    };

    const logs = this.actionLogs.get(sessionId);
    if (logs) {
      logs.push(record);
    }

    return record;
  }

  /**
   * Dosya oluşturur.
   */
  fileCreate(
    sessionId: string,
    agentName: string,
    filePath: string,
    content: string
  ): SandboxAction {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      return this.recordAction(sessionId, agentName, 'file_create', filePath, false, 'rejected', {
        content,
        error: 'Session not initialized',
      });
    }

    const validation = validateSandboxPath(sandboxRoot, filePath);
    if (!validation.ok) {
      return this.recordAction(sessionId, agentName, 'file_create', filePath, false, 'rejected', {
        content,
        error: validation.error,
      });
    }

    try {
      // Parent dizini oluştur (gerekirse)
      const parentDir = path.dirname(validation.resolved);
      fs.mkdirSync(parentDir, { recursive: true });

      // Dosya zaten varsa hata
      if (fs.existsSync(validation.resolved)) {
        return this.recordAction(sessionId, agentName, 'file_create', filePath, false, 'rejected', {
          content,
          error: 'File already exists. Use file_edit to modify.',
        });
      }

      fs.writeFileSync(validation.resolved, content, 'utf-8');
      return this.recordAction(sessionId, agentName, 'file_create', filePath, true, 'approved', { content });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return this.recordAction(sessionId, agentName, 'file_create', filePath, false, 'rejected', {
        content,
        error: errorMsg,
      });
    }
  }

  /**
   * Dosyayı düzenler.
   * old_content + new_content veya full_content modu destekler.
   */
  fileEdit(
    sessionId: string,
    agentName: string,
    filePath: string,
    editPayload: { oldContent: string; newContent: string } | { fullContent: string }
  ): SandboxAction {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      return this.recordAction(sessionId, agentName, 'file_edit', filePath, false, 'rejected', {
        error: 'Session not initialized',
      });
    }

    const validation = validateSandboxPath(sandboxRoot, filePath);
    if (!validation.ok) {
      return this.recordAction(sessionId, agentName, 'file_edit', filePath, false, 'rejected', {
        error: validation.error,
      });
    }

    try {
      if (!fs.existsSync(validation.resolved)) {
        return this.recordAction(sessionId, agentName, 'file_edit', filePath, false, 'rejected', {
          error: 'File does not exist. Use file_create first.',
        });
      }

      const currentContent = fs.readFileSync(validation.resolved, 'utf-8');

      if ('fullContent' in editPayload) {
        // Tam içerik değiştirme
        fs.writeFileSync(validation.resolved, editPayload.fullContent, 'utf-8');
        return this.recordAction(sessionId, agentName, 'file_edit', filePath, true, 'approved', {
          content: editPayload.fullContent,
          oldContent: currentContent,
        });
      } else {
        // old_content → new_content değiştirme
        if (!currentContent.includes(editPayload.oldContent)) {
          return this.recordAction(sessionId, agentName, 'file_edit', filePath, false, 'rejected', {
            error: 'old_content not found in file',
          });
        }

        const updatedContent = currentContent.replace(editPayload.oldContent, editPayload.newContent);
        fs.writeFileSync(validation.resolved, updatedContent, 'utf-8');
        return this.recordAction(sessionId, agentName, 'file_edit', filePath, true, 'approved', {
          content: updatedContent,
          oldContent: currentContent,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return this.recordAction(sessionId, agentName, 'file_edit', filePath, false, 'rejected', {
        error: errorMsg,
      });
    }
  }

  /**
   * Dosya siler.
   */
  fileDelete(
    sessionId: string,
    agentName: string,
    filePath: string
  ): SandboxAction {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      return this.recordAction(sessionId, agentName, 'file_delete', filePath, false, 'rejected', {
        error: 'Session not initialized',
      });
    }

    const validation = validateSandboxPath(sandboxRoot, filePath);
    if (!validation.ok) {
      return this.recordAction(sessionId, agentName, 'file_delete', filePath, false, 'rejected', {
        error: validation.error,
      });
    }

    try {
      if (!fs.existsSync(validation.resolved)) {
        return this.recordAction(sessionId, agentName, 'file_delete', filePath, false, 'rejected', {
          error: 'File does not exist',
        });
      }

      const oldContent = fs.readFileSync(validation.resolved, 'utf-8');
      fs.unlinkSync(validation.resolved);
      return this.recordAction(sessionId, agentName, 'file_delete', filePath, true, 'approved', {
        oldContent,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return this.recordAction(sessionId, agentName, 'file_delete', filePath, false, 'rejected', {
        error: errorMsg,
      });
    }
  }

  /**
   * Dosya okur.
   * Bu işlem onay gerektirmez.
   */
  fileRead(
    sessionId: string,
    agentName: string,
    filePath: string
  ): SandboxAction & { fileContent?: string } {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      const action = this.recordAction(sessionId, agentName, 'file_read', filePath, false, 'auto_approved', {
        error: 'Session not initialized',
      });
      return { ...action, fileContent: undefined };
    }

    const validation = validateSandboxPath(sandboxRoot, filePath);
    if (!validation.ok) {
      const action = this.recordAction(sessionId, agentName, 'file_read', filePath, false, 'auto_approved', {
        error: validation.error,
      });
      return { ...action, fileContent: undefined };
    }

    try {
      if (!fs.existsSync(validation.resolved)) {
        const action = this.recordAction(sessionId, agentName, 'file_read', filePath, false, 'auto_approved', {
          error: 'File does not exist',
        });
        return { ...action, fileContent: undefined };
      }

      const content = fs.readFileSync(validation.resolved, 'utf-8');
      const action = this.recordAction(sessionId, agentName, 'file_read', filePath, true, 'auto_approved');
      return { ...action, fileContent: content };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const action = this.recordAction(sessionId, agentName, 'file_read', filePath, false, 'auto_approved', {
        error: errorMsg,
      });
      return { ...action, fileContent: undefined };
    }
  }

  /**
   * Sandbox içeriğini listeler.
   * Bu işlem onay gerektirmez.
   */
  fileList(
    sessionId: string,
    agentName: string,
    dirPath: string = ''
  ): SandboxAction & { files?: SandboxFileInfo[] } {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      const action = this.recordAction(sessionId, agentName, 'file_list', dirPath || '.', false, 'auto_approved', {
        error: 'Session not initialized',
      });
      return { ...action, files: undefined };
    }

    // Boş path = sandbox root
    const targetPath = dirPath || '.';

    const validation = validateSandboxPath(sandboxRoot, targetPath);
    if (!validation.ok) {
      const action = this.recordAction(sessionId, agentName, 'file_list', targetPath, false, 'auto_approved', {
        error: validation.error,
      });
      return { ...action, files: undefined };
    }

    try {
      if (!fs.existsSync(validation.resolved)) {
        const action = this.recordAction(sessionId, agentName, 'file_list', targetPath, false, 'auto_approved', {
          error: 'Directory does not exist',
        });
        return { ...action, files: undefined };
      }

      const stat = fs.statSync(validation.resolved);
      if (!stat.isDirectory()) {
        const action = this.recordAction(sessionId, agentName, 'file_list', targetPath, false, 'auto_approved', {
          error: 'Path is not a directory',
        });
        return { ...action, files: undefined };
      }

      const entries = fs.readdirSync(validation.resolved, { withFileTypes: true });
      const files: SandboxFileInfo[] = entries.map(entry => {
        const entryRelPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        const info: SandboxFileInfo = {
          name: entry.name,
          path: entryRelPath,
          type: entry.isDirectory() ? 'directory' : 'file',
        };

        if (entry.isFile()) {
          try {
            const entryStat = fs.statSync(path.join(validation.resolved, entry.name));
            info.size = entryStat.size;
            info.modifiedAt = entryStat.mtime;
          } catch {
            // stat hatası — boyut bilinmiyor
          }
        }

        return info;
      });

      const action = this.recordAction(sessionId, agentName, 'file_list', targetPath, true, 'auto_approved');
      return { ...action, files };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const action = this.recordAction(sessionId, agentName, 'file_list', targetPath, false, 'auto_approved', {
        error: errorMsg,
      });
      return { ...action, files: undefined };
    }
  }

  /**
   * Klasör oluşturur.
   */
  dirCreate(
    sessionId: string,
    agentName: string,
    dirPath: string
  ): SandboxAction {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (!sandboxRoot) {
      return this.recordAction(sessionId, agentName, 'dir_create', dirPath, false, 'rejected', {
        error: 'Session not initialized',
      });
    }

    const validation = validateSandboxPath(sandboxRoot, dirPath);
    if (!validation.ok) {
      return this.recordAction(sessionId, agentName, 'dir_create', dirPath, false, 'rejected', {
        error: validation.error,
      });
    }

    try {
      if (fs.existsSync(validation.resolved)) {
        return this.recordAction(sessionId, agentName, 'dir_create', dirPath, false, 'rejected', {
          error: 'Directory already exists',
        });
      }

      fs.mkdirSync(validation.resolved, { recursive: true });
      return this.recordAction(sessionId, agentName, 'dir_create', dirPath, true, 'approved');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return this.recordAction(sessionId, agentName, 'dir_create', dirPath, false, 'rejected', {
        error: errorMsg,
      });
    }
  }

  /**
   * Bir session'ın tüm sandbox işlem loglarını döner.
   */
  getActionLog(sessionId: string): SandboxAction[] {
    return this.actionLogs.get(sessionId) ?? [];
  }

  /**
   * Bir session'ın sandbox'ını temizler (session sonu).
   * İşlem logları korunur.
   */
  cleanupSession(sessionId: string): void {
    const sandboxRoot = this.sessionPaths.get(sessionId);
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
    this.sessionPaths.delete(sessionId);
  }

  /**
   * Tüm session'ları temizler (test için).
   */
  clear(): void {
    for (const sessionId of this.sessionPaths.keys()) {
      this.cleanupSession(sessionId);
    }
    this.actionLogs.clear();
  }

  /**
   * Bir session için bekleyen (pending) action sayısını döner.
   */
  getPendingCount(sessionId: string): number {
    const logs = this.actionLogs.get(sessionId);
    if (!logs) return 0;
    return logs.filter(a => a.approvalStatus === 'pending').length;
  }
}
