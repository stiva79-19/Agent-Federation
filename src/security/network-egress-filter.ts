/**
 * Network Egress Filter — Domain Whitelist & IP Blocking
 * 
 * Agent'ların network erişimini kısıtlar:
 * - Sadece whitelist'teki domain'lere erişim
 * - Private IP bloklama (10.x.x.x, 192.168.x.x, 127.x.x.x)
 * - HTTP/HTTPS request filtering
 */

import * as http from 'http';
import * as https from 'https';
import * as url from 'url';

export interface NetworkEgressConfig {
  /** İzin verilen domain'ler */
  allowedDomains: string[];
  /** Yasaklı domain'ler (whitelist olsa bile) */
  blockedDomains?: string[];
  /** Private IP'lere erişim izinli mi (varsayılan: false) */
  allowPrivateIPs?: boolean;
  /** Custom port'lara erişim izinli mi */
  allowedPorts?: number[];
  /** DNS lookup'ı intercept et */
  interceptDNS?: boolean;
}

export interface NetworkRequest {
  /** Hedef URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Headers */
  headers?: Record<string, string>;
  /** Body */
  body?: string | Buffer;
}

export interface NetworkResponse {
  /** Status code */
  statusCode: number;
  /** Headers */
  headers: Record<string, string | string[]>;
  /** Body */
  body: string | Buffer;
}

export class NetworkEgressFilter {
  private config: NetworkEgressConfig;
  private allowedDomainSet: Set<string>;
  private blockedDomainSet: Set<string>;
  
  // Private IP ranges
  private readonly privateIPPatterns = [
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 127.0.0.0/8 (loopback)
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,            // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
    /^192\.168\.\d{1,3}\.\d{1,3}$/,               // 192.168.0.0/16
    /^169\.254\.\d{1,3}\.\d{1,3}$/,               // 169.254.0.0/16 (link-local)
    /^::1$/,                                       // IPv6 loopback
    /^fe80:/,                                      // IPv6 link-local
    /^fc[0-9a-f]{2}:/i,                            // IPv6 unique local
    /^fd[0-9a-f]{2}:/i,                            // IPv6 unique local
  ];

  constructor(config: NetworkEgressConfig) {
    this.config = {
      allowPrivateIPs: false,
      interceptDNS: true,
      ...config,
    };
    
    // Domain'leri normalize et ve set'e ekle
    this.allowedDomainSet = new Set(
      config.allowedDomains.map(d => this.normalizeDomain(d))
    );
    
    this.blockedDomainSet = new Set(
      (config.blockedDomains || []).map(d => this.normalizeDomain(d))
    );
  }

  /**
   * Domain'i normalize eder (küçük harf, www. prefix kaldırma)
   */
  private normalizeDomain(domain: string): string {
    return domain
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }

  /**
   * IP adresinin private olup olmadığını kontrol eder
   */
  isPrivateIP(ip: string): boolean {
    return this.privateIPPatterns.some(pattern => pattern.test(ip));
  }

  /**
   * Domain'in whitelist'te olup olmadığını kontrol eder
   */
  isDomainAllowed(domain: string): boolean {
    const normalized = this.normalizeDomain(domain);
    
    // Önce blacklist kontrolü
    if (this.blockedDomainSet.has(normalized)) {
      return false;
    }
    
    // Exact match
    if (this.allowedDomainSet.has(normalized)) {
      return true;
    }
    
    // Subdomain match (örn: *.example.com)
    for (const allowed of this.allowedDomainSet) {
      if (allowed.startsWith('*.')) {
        const baseDomain = allowed.slice(2);
        if (normalized === baseDomain || normalized.endsWith('.' + baseDomain)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * URL'i validate eder
   */
  validateUrl(requestUrl: string): { allowed: boolean; reason?: string } {
    try {
      const parsed = new url.URL(requestUrl);
      
      // Sadece HTTP/HTTPS
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return {
          allowed: false,
          reason: `Protocol not allowed: ${parsed.protocol}`,
        };
      }
      
      // Port kontrolü
      const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
      if (this.config.allowedPorts && !this.config.allowedPorts.includes(port)) {
        return {
          allowed: false,
          reason: `Port ${port} not in allowed list`,
        };
      }
      
      // Domain kontrolü
      if (!this.isDomainAllowed(parsed.hostname)) {
        return {
          allowed: false,
          reason: `Domain not in whitelist: ${parsed.hostname}`,
        };
      }
      
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        reason: `Invalid URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * HTTP/HTTPS request yapar (whitelist kontrolü ile)
   */
  async fetch(requestUrl: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeout?: number;
  }): Promise<NetworkResponse> {
    const validation = this.validateUrl(requestUrl);
    if (!validation.allowed) {
      throw new Error(`Network egress blocked: ${validation.reason}`);
    }
    
    const parsed = new url.URL(requestUrl);
    
    // DNS lookup sırasında IP kontrolü yap
    return new Promise((resolve, reject) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      
      const reqOptions: any = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options?.method || 'GET',
        headers: options?.headers,
        timeout: options?.timeout || 10000,
        
        // DNS lookup intercept - IP kontrolü yap
        lookup: (hostname: string, options: any, callback: any) => {
          const dns = require('dns');
          dns.lookup(hostname, options, (err: Error, address: string, family: number) => {
            if (err) {
              callback(err, address, family);
              return;
            }
            
            // Private IP kontrolü
            if (!this.config.allowPrivateIPs && this.isPrivateIP(address)) {
              callback(new Error(`Private IP address blocked: ${address}`), address, family);
              return;
            }
            
            callback(null, address, family);
          });
        },
      };
      
      const req = lib.request(reqOptions, (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[]>,
            body: res.headers['content-type']?.includes('application/json') 
              ? body.toString() 
              : body,
          });
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (options?.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  }

  /**
   * createEgressFilteredAgent - Agent için filtered HTTP client oluşturur
   */
  createEgressFilteredAgent(): {
    fetch: (url: string, options?: any) => Promise<NetworkResponse>;
    validateUrl: (url: string) => { allowed: boolean; reason?: string };
    isPrivateIP: (ip: string) => boolean;
    isDomainAllowed: (domain: string) => boolean;
  } {
    return {
      fetch: this.fetch.bind(this),
      validateUrl: this.validateUrl.bind(this),
      isPrivateIP: this.isPrivateIP.bind(this),
      isDomainAllowed: this.isDomainAllowed.bind(this),
    };
  }

  /**
   * Güvenli http/https agent oluşturur (DNS rebinding saldırılarına karşı)
   */
  createSecureAgent(): http.Agent | https.Agent {
    const useHttps = this.config.allowedPorts?.includes(443) !== false;
    const BaseAgent = useHttps ? https.Agent : http.Agent;
    const filter = this;
    
    class SecureAgent extends BaseAgent {
      createConnection(options: any, oncreate: any) {
        const host = options.host || options.hostname;
        
        // Hostname kontrolü
        if (host && !filter.isDomainAllowed(host)) {
          throw new Error(`Domain not in whitelist: ${host}`);
        }
        
        return super.createConnection(options, oncreate);
      }
    }
    
    return new SecureAgent({ keepAlive: true });
  }
}

/**
 * Varsayılan whitelist - sadece güvenli servisler
 */
export function defaultAllowlist(): string[] {
  return [
    // API servisleri (gerekirse ekle)
    'api.example.com',
    '*.openai.com',
    '*.anthropic.com',
    '*.github.com',
    
    // Package registry
    'registry.npmjs.org',
    
    // DNS ve NTP (sadece belirli servisler)
    'time.google.com',
  ];
}

/**
 * Güvenlik odaklı varsayılan yapılandırma
 */
export function secureConfig(): NetworkEgressConfig {
  return {
    allowedDomains: defaultAllowlist(),
    blockedDomains: [],
    allowPrivateIPs: false,
    allowedPorts: [80, 443],
    interceptDNS: true,
  };
}
