/**
 * OpenClaw Home Resolver
 *
 * OpenClaw ekosisteminin canonical kök dizinini bulur. Docs'a göre:
 *   - OpenClaw Home   → `~/.openclaw/`            (openclaw.json, credentials/, .env burada)
 *   - OpenClaw Workspace → `~/.openclaw/workspace/` (IDENTITY.md, SOUL.md, MEMORY.md burada)
 *
 * Çözümleme sırası (ilk geçerli kazanır):
 *   1. `OPENCLAW_HOME` env var
 *   2. Legacy `OPENCLAW_WORKSPACE` env var (geriye dönük uyumluluk — deprecated)
 *   3. Kullanıcının dashboard/CLI ile seçip persist ettiği path
 *   4. Platform varsayılanı (`~/.openclaw/`)
 *   5. Bulunamadı → resolver bunu işaret eder, çağıran UI/CLI kullanıcıya sorar
 *
 * Bir path "geçerli" sayılır eğer:
 *   - Dizin olarak var, VE
 *   - İçinde `openclaw.json` VEYA `workspace/` alt dizini var
 *
 * Böylece kullanıcı ya tam OpenClaw home'unu (config dosyası olan) gösterir,
 * ya da workspace-only kurulumlara tolerans gösteririz.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadPersistentConfig, savePersistentConfig } from './persistent-config';

export type OpenClawHomeSource =
  | 'env-home'           // OPENCLAW_HOME env var
  | 'env-workspace'      // Legacy OPENCLAW_WORKSPACE env var
  | 'persistent-config'  // Kullanıcının daha önce seçip kaydettiği path
  | 'platform-default'   // ~/.openclaw
  | 'unresolved';        // Hiçbir yerde bulunamadı

export interface OpenClawHomeResolution {
  /** Çözülmüş home path'i (unresolved ise boş string) */
  path: string;
  /** Çözümün nereden geldiği */
  source: OpenClawHomeSource;
  /** Path'in gerçekten var olup okunabildiği */
  resolved: boolean;
  /** `${path}/workspace` alt dizini (identity dosyaları için) */
  workspacePath: string;
  /** `${path}/openclaw.json` var mı */
  hasConfigFile: boolean;
  /** `${path}/workspace` var mı */
  hasWorkspaceDir: boolean;
  /** Hangi platform varsayılanının denendiği (tanı için) */
  triedPlatformDefault: string;
}

/** Bir klasörün gerçekten OpenClaw home olup olmadığını doğrular. */
export function isValidOpenClawHome(candidate: string): boolean {
  if (!candidate) return false;
  try {
    if (!fs.existsSync(candidate)) return false;
    if (!fs.statSync(candidate).isDirectory()) return false;
    const hasConfig = fs.existsSync(path.join(candidate, 'openclaw.json'));
    const hasWorkspace = fs.existsSync(path.join(candidate, 'workspace'));
    return hasConfig || hasWorkspace;
  } catch {
    return false;
  }
}

/** Platform varsayılanını döner — tüm platformlarda `~/.openclaw`. */
export function platformDefaultOpenClawHome(): string {
  return path.join(os.homedir(), '.openclaw');
}

/**
 * OpenClaw home'unu çözümler. Yukarıdaki sırayla dener; ilk geçerli olanı döner.
 * Bulunamazsa `resolved: false, source: 'unresolved'` döner — çağıran UI ile kullanıcıya sorar.
 */
export function resolveOpenClawHome(): OpenClawHomeResolution {
  const platformDefault = platformDefaultOpenClawHome();

  // Aday path'leri sırayla topla (source ile eşleşmeli)
  const candidates: Array<{ path: string; source: OpenClawHomeSource }> = [];

  const envHome = process.env['OPENCLAW_HOME'];
  if (envHome && envHome.length > 0) {
    candidates.push({ path: expandHome(envHome), source: 'env-home' });
  }

  const envWorkspace = process.env['OPENCLAW_WORKSPACE'];
  if (envWorkspace && envWorkspace.length > 0) {
    candidates.push({ path: expandHome(envWorkspace), source: 'env-workspace' });
  }

  const persisted = loadPersistentConfig().openclawHome;
  if (persisted && persisted.length > 0) {
    candidates.push({ path: expandHome(persisted), source: 'persistent-config' });
  }

  candidates.push({ path: platformDefault, source: 'platform-default' });

  for (const candidate of candidates) {
    if (isValidOpenClawHome(candidate.path)) {
      return buildResolution(candidate.path, candidate.source, platformDefault);
    }
  }

  // Hiçbir aday geçerli değil — unresolved
  return {
    path: '',
    source: 'unresolved',
    resolved: false,
    workspacePath: '',
    hasConfigFile: false,
    hasWorkspaceDir: false,
    triedPlatformDefault: platformDefault,
  };
}

/**
 * Kullanıcının seçtiği OpenClaw home path'ini persist eder.
 * Dashboard'daki first-run wizard veya "klasörü değiştir" butonu çağırır.
 *
 * @param homePath - Tam path (tilde desteklenir)
 * @returns yeni çözüm — başarılı olursa seçilen path, başarısız olursa otomatik çözüm
 */
export function setOpenClawHome(homePath: string): OpenClawHomeResolution {
  const expanded = expandHome(homePath);
  if (!isValidOpenClawHome(expanded)) {
    // Path geçersiz — kaydetme, mevcut durumu döndür
    return resolveOpenClawHome();
  }

  const cfg = loadPersistentConfig();
  cfg.openclawHome = expanded;
  savePersistentConfig(cfg);

  return buildResolution(expanded, 'persistent-config', platformDefaultOpenClawHome());
}

/** Tilde (~) ve ortam değişkenlerini genişletir. */
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  // Windows'ta %USERPROFILE% gibi env var'ları da bırak — Node bunları otomatik açmaz
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
}

function buildResolution(
  homePath: string,
  source: OpenClawHomeSource,
  platformDefault: string,
): OpenClawHomeResolution {
  const workspacePath = path.join(homePath, 'workspace');
  return {
    path: homePath,
    source,
    resolved: true,
    workspacePath,
    hasConfigFile: fs.existsSync(path.join(homePath, 'openclaw.json')),
    hasWorkspaceDir: fs.existsSync(workspacePath),
    triedPlatformDefault: platformDefault,
  };
}
