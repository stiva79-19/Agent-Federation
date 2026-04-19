/**
 * Sandbox — Klasör İzolasyonu
 * 
 * Agent sadece izin verilen klasörde çalışabilir.
 * Başka hiçbir yere erişemez.
 * 
 * Security: Path traversal ve symlink attack'leri engeller.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface SandboxConfig {
  /** Sandbox root path */
  rootPath: string;
  /** Okuma izni */
  canRead: boolean;
  /** Yazma izni */
  canWrite: boolean;
  /** Çalıştırma izni */
  canExecute: boolean;
}

export class Sandbox {
  private config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = {
      ...config,
      rootPath: path.resolve(config.rootPath),
    };
  }

  /**
   * Path normalization - Windows ve Unix path separator'larını normalize eder
   * Tüm backslash'leri forward slash'e çevirir ve normalize eder
   */
  private normalizePath(filePath: string): string {
    // Windows path separator'larını Unix'e çevir
    const normalized = filePath.replace(/\\/g, '/');
    // Path normalize (.., ., vs. temizle)
    return path.normalize(normalized);
  }

  /**
   * Path'in sandbox içinde olup olmadığını kontrol eder
   * KRITICAL: Path traversal saldırılarını engeller
   */
  isWithinSandbox(filePath: string): boolean {
    const normalized = this.normalizePath(filePath);
    const resolved = path.resolve(this.config.rootPath, normalized);
    // Ensure rootPath ends with separator for accurate startsWith check
    const rootWithSep = this.config.rootPath.endsWith(path.sep) 
      ? this.config.rootPath 
      : this.config.rootPath + path.sep;
    return resolved === this.config.rootPath || resolved.startsWith(rootWithSep);
  }

  /**
   * Path doğrulaması
   * Security: Path traversal, symlink bypass, null byte injection engeller
   */
  validatePath(filePath: string): { ok: true; resolved: string } | { ok: false; error: string } {
    // Null byte injection
    if (filePath.includes('\0')) {
      return { ok: false, error: 'Null byte injection detected' };
    }

    // Normalize path (Windows separators, .., ., etc.)
    const normalized = this.normalizePath(filePath);

    // Path traversal kontrolü - normalize edilmiş path'te de kontrol et
    if (normalized.includes('..')) {
      return { ok: false, error: 'Path traversal not allowed' };
    }

    // Resolve the path within sandbox
    const resolved = path.resolve(this.config.rootPath, normalized);

    // Sandbox boundary kontrolü - rootPath sonuna separator ekleyerek false positive'leri önle
    const rootWithSep = this.config.rootPath.endsWith(path.sep) 
      ? this.config.rootPath 
      : this.config.rootPath + path.sep;
    
    if (resolved !== this.config.rootPath && !resolved.startsWith(rootWithSep)) {
      return { ok: false, error: `Path outside sandbox: ${resolved}` };
    }

    // CRITICAL: Symlink bypass engelle - gerçek path'i kontrol et
    try {
      // Dosya/klasör varsa realpath ile kontrol et
      if (fs.existsSync(resolved)) {
        const realPath = fs.realpathSync(resolved);
        const rootRealPath = fs.realpathSync(this.config.rootPath);
        const rootRealWithSep = rootRealPath.endsWith(path.sep) 
          ? rootRealPath 
          : rootRealPath + path.sep;
        
        if (realPath !== rootRealPath && !realPath.startsWith(rootRealWithSep)) {
          return { ok: false, error: 'Symlink bypass detected: path resolves outside sandbox' };
        }
      }
    } catch (err) {
      // realpathSync hatalarını güvenli şekilde ele al
      // Dosya yoksa veya erişim hatası varsa, resolved path üzerinden devam et
    }

    return { ok: true, resolved };
  }

  /**
   * Erişim kontrolü
   */
  checkAccess(filePath: string, mode: 'read' | 'write' | 'execute'): { ok: boolean; error?: string } {
    const validation = this.validatePath(filePath);
    if (!validation.ok) return validation;

    switch (mode) {
      case 'read':
        if (!this.config.canRead) {
          return { ok: false, error: 'Read access not granted' };
        }
        break;
      case 'write':
        if (!this.config.canWrite) {
          return { ok: false, error: 'Write access not granted' };
        }
        break;
      case 'execute':
        if (!this.config.canExecute) {
          return { ok: false, error: 'Execute access not granted' };
        }
        break;
    }

    return { ok: true };
  }
}

/**
 * Varsayılan sandbox yapılandırması
 */
export function defaultSandbox(projectName: string): SandboxConfig {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return {
    rootPath: path.join(homeDir, '.openclaw', 'shared-collab', projectName),
    canRead: true,
    canWrite: true,
    canExecute: false,
  };
}
