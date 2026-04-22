/**
 * Persistent Config
 *
 * Agent-Federation'ın kullanıcı-spesifik ayarlarını saklar. Örn:
 *   - Kullanıcının seçtiği OpenClaw home path'i
 *   - İleride: tercih edilen LLM override, UI theme vb.
 *
 * Platform convention'ına uyar:
 *   - macOS:   ~/Library/Application Support/agent-federation/config.json
 *   - Linux:   ${XDG_CONFIG_HOME:-~/.config}/agent-federation/config.json
 *   - Windows: %APPDATA%\agent-federation\config.json  (%APPDATA% yoksa ~/.agent-federation)
 *
 * Dosya yoksa bile `loadPersistentConfig()` hata vermez; boş ayarlar döner.
 * `savePersistentConfig()` gerekli dizinleri yaratır.
 *
 * NOT: Schema küçük — sık eklenen alanlar olursa `migratePersistentConfig()` eklenebilir.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PersistentConfig {
  /** Kullanıcının seçtiği OpenClaw home (env var veya default'u override eder) */
  openclawHome?: string;
  /** Gelecekte: diğer ayarlar buraya eklenir */
  [key: string]: unknown;
}

/**
 * Platform'a uygun config dizinini döner. Test override için
 * `AGENT_FEDERATION_CONFIG_DIR` env var'ı da desteklenir.
 */
export function getPersistentConfigDir(): string {
  // Test override
  const override = process.env['AGENT_FEDERATION_CONFIG_DIR'];
  if (override && override.length > 0) return override;

  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'agent-federation');
  }

  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData && appData.length > 0) {
      return path.join(appData, 'agent-federation');
    }
    return path.join(home, '.agent-federation');
  }

  // Linux + diğer UNIX'ler → XDG Base Directory Specification
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'agent-federation');
  }
  return path.join(home, '.config', 'agent-federation');
}

/** Tam config dosyası path'i. */
export function getPersistentConfigPath(): string {
  return path.join(getPersistentConfigDir(), 'config.json');
}

/**
 * Config'i yükler. Dosya yok/bozuksa boş objeyle döner — throw etmez.
 * Böylece çağıranların sürekli try/catch yazmasına gerek kalmaz.
 */
export function loadPersistentConfig(): PersistentConfig {
  try {
    const configPath = getPersistentConfigPath();
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PersistentConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Config'i yazar. Dizin yoksa yaratır. Hata olursa false döner (throw etmez).
 */
export function savePersistentConfig(config: PersistentConfig): boolean {
  try {
    const dir = getPersistentConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const configPath = getPersistentConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Bir alanı siler. */
export function clearPersistentConfigField(key: string): boolean {
  const cfg = loadPersistentConfig();
  delete cfg[key];
  return savePersistentConfig(cfg);
}
