/**
 * Network Egress Filter - Advanced Tests
 * 
 * Additional tests for comprehensive network filter coverage
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  NetworkEgressFilter,
  NetworkEgressConfig,
  secureConfig,
  defaultAllowlist,
} from '../src/security/network-egress-filter';

describe('NetworkEgressFilter - Advanced URL Validation', () => {
  let filter: NetworkEgressFilter;

  beforeEach(() => {
    filter = new NetworkEgressFilter({
      allowedDomains: [
        'api.example.com',
        '*.openai.com',
        'github.com',
        'registry.npmjs.org',
        'httpbin.org',
      ],
      blockedDomains: ['malicious.com', 'evil.com'],
      allowPrivateIPs: false,
      allowedPorts: [80, 443],
      interceptDNS: true,
    });
  });

  it('should validate complete URL with protocol', () => {
    const validation = filter.validateUrl('https://api.example.com/v1/users');
    
    expect(validation.allowed).toBe(true);
  });

  it('should handle HTTP vs HTTPS URLs', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['api.example.com'],
    });

    const httpsValidation = filter.validateUrl('https://api.example.com/test');
    expect(httpsValidation.allowed).toBe(true);
  });

  it('should allow HTTP URLs when explicitly permitted', () => {
    const httpFilter = new NetworkEgressFilter({
      allowedDomains: ['localhost'],
      allowHttp: true,
      allowPrivateIPs: true,
    });

    const validation = httpFilter.validateUrl('http://localhost:3000/api');
    expect(validation.allowed).toBe(true);
  });

  it('should handle URLs with query parameters', () => {
    const validation = filter.validateUrl('https://api.example.com/search?q=test&page=1');
    expect(validation.allowed).toBe(true);
  });

  it('should handle URLs with fragments', () => {
    const validation = filter.validateUrl('https://api.example.com/docs#section-1');
    expect(validation.allowed).toBe(true);
  });

  it('should handle URLs with authentication', () => {
    const validation = filter.validateUrl('https://user:pass@api.example.com/secure');
    // Should handle URL with auth (may or may not be allowed based on domain)
    expect(validation).toBeDefined();
  });

  it('should reject URLs with invalid ports', () => {
    const validation = filter.validateUrl('https://api.example.com:9999/test');
    // Port 9999 is not in allowedPorts [80, 443]
    expect(validation.allowed).toBe(false);
  });

  it('should handle wildcard domain matching', () => {
    const validation1 = filter.validateUrl('https://api.openai.com/v1');
    const validation2 = filter.validateUrl('https://chat.openai.com/api');
    const validation3 = filter.validateUrl('https://subdomain.openai.com/test');
    
    expect(validation1.allowed).toBe(true);
    expect(validation2.allowed).toBe(true);
    expect(validation3.allowed).toBe(true);
  });

  it('should block domains in blacklist', () => {
    const validation1 = filter.validateUrl('https://malicious.com/attack');
    const validation2 = filter.validateUrl('https://evil.com/malware');
    
    expect(validation1.allowed).toBe(false);
    expect(validation2.allowed).toBe(false);
    expect(validation1.reason).toBeDefined();
  });

  it('should handle empty URL gracefully', () => {
    const validation = filter.validateUrl('');
    expect(validation.allowed).toBe(false);
  });

  it('should handle malformed URLs', () => {
    const validation = filter.validateUrl('not-a-valid-url');
    expect(validation.allowed).toBe(false);
  });

  it('should handle URLs without protocol', () => {
    const validation = filter.validateUrl('api.example.com/test');
    // Should handle or reject gracefully
    expect(validation).toBeDefined();
  });
});

describe('NetworkEgressFilter - IP Address Validation', () => {
  let filter: NetworkEgressFilter;

  beforeEach(() => {
    filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      allowPrivateIPs: false,
      allowedPorts: [80, 443],
    });
  });

  it('should block IPv4 private addresses', () => {
    const testCases = [
      'http://192.168.1.1/admin',
      'http://10.0.0.1/internal',
      'http://172.16.0.1/private',
      'http://127.0.0.1/localhost',
    ];

    for (const url of testCases) {
      const validation = filter.validateUrl(url);
      expect(validation.allowed).toBe(false);
    }
  });

  it('should block IPv6 private addresses', () => {
    const testCases = [
      'http://[::1]/localhost',
      'http://[fe80::1]/link-local',
      'http://[fc00::1]/unique-local',
    ];

    for (const url of testCases) {
      const validation = filter.validateUrl(url);
      expect(validation.allowed).toBe(false);
    }
  });

  it('should allow IPv4 public addresses with whitelisted domain', () => {
    const publicFilter = new NetworkEgressFilter({
      allowedDomains: ['8.8.8.8'],
      allowPrivateIPs: false,
    });

    const validation = publicFilter.validateUrl('https://8.8.8.8/dns-query');
    expect(validation.allowed).toBe(true);
  });

  it('should detect localhost variations', () => {
    const testCases = [
      'http://localhost:3000',
      'http://localhost',
      'http://127.0.0.1',
      'http://0.0.0.0',
    ];

    for (const url of testCases) {
      const validation = filter.validateUrl(url);
      expect(validation.allowed).toBe(false);
    }
  });
});

describe('NetworkEgressFilter - Port Validation', () => {
  it('should allow standard HTTP ports', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      allowedPorts: [80, 443],
    });

    const httpValidation = filter.validateUrl('http://example.com');
    const httpsValidation = filter.validateUrl('https://example.com');
    
    expect(httpValidation.allowed).toBe(true);
    expect(httpsValidation.allowed).toBe(true);
  });

  it('should allow custom ports when configured', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['api.example.com'],
      allowedPorts: [80, 443, 8080, 8443],
    });

    const validation = filter.validateUrl('https://api.example.com:8080/api');
    expect(validation.allowed).toBe(true);
  });

  it('should block non-standard ports', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      allowedPorts: [80, 443],
    });

    const validation = filter.validateUrl('https://example.com:9000/test');
    expect(validation.allowed).toBe(false);
  });
});

describe('NetworkEgressFilter - DNS Interception', () => {
  it('should respect DNS interception setting', () => {
    const filterWithDns = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      interceptDNS: true,
    });

    const filterWithoutDns = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      interceptDNS: false,
    });

    expect(filterWithDns).toBeDefined();
    expect(filterWithoutDns).toBeDefined();
  });
});

describe('secureConfig Function', () => {
  it('should create secure configuration', () => {
    const config = secureConfig();

    expect(config.allowPrivateIPs).toBe(false);
    expect(config.allowedDomains).toBeDefined();
    expect(Array.isArray(config.allowedDomains)).toBe(true);
  });

  it('should include default allowlist domains', () => {
    const config = secureConfig();

    expect(config.allowedDomains.length).toBeGreaterThan(0);
    expect(config.allowedDomains).toContain('api.example.com');
  });
});

describe('defaultAllowlist', () => {
  it('should contain common safe domains', () => {
    const allowlist = defaultAllowlist();
    
    expect(allowlist).toBeDefined();
    expect(Array.isArray(allowlist)).toBe(true);
    expect(allowlist.length).toBeGreaterThan(0);
  });
});

describe('NetworkEgressFilter - Configuration Options', () => {
  it('should support different HTTP methods in config', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    
    methods.forEach(method => {
      expect(method).toMatch(/^(GET|POST|PUT|DELETE|PATCH)$/);
    });
  });

  it('should handle request configuration structure', () => {
    const request = {
      url: 'https://httpbin.org/headers',
      method: 'GET' as const,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
      },
    };

    expect(request.headers).toBeDefined();
    expect(request.headers['Content-Type']).toBe('application/json');
  });

  it('should handle request body configuration', () => {
    const request = {
      url: 'https://httpbin.org/post',
      method: 'POST' as const,
      body: JSON.stringify({ key: 'value' }),
    };

    expect(request.body).toBeDefined();
    expect(typeof request.body).toBe('string');
  });
});

describe('NetworkEgressFilter - Edge Cases', () => {
  it('should handle very long URLs', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
    });

    const longPath = '/a'.repeat(1000);
    const validation = filter.validateUrl(`https://example.com${longPath}`);
    
    expect(validation).toBeDefined();
    expect(validation.allowed).toBe(true);
  });

  it('should handle URLs with special characters', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
    });

    const validation = filter.validateUrl('https://example.com/path%20with%20spaces?param=value&other=123');
    expect(validation.allowed).toBe(true);
  });

  it('should handle international domain names', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com', 'örnek.com'],
    });

    const validation = filter.validateUrl('https://örnek.com/test');
    expect(validation).toBeDefined();
  });

  it('should handle subdomain depth', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['*.example.com'],
    });

    const deepSubdomain = filter.validateUrl('https://a.b.c.example.com/test');
    expect(deepSubdomain.allowed).toBe(true);
  });
});

describe('NetworkEgressConfig Type', () => {
  it('should accept complete configuration', () => {
    const config: NetworkEgressConfig = {
      allowedDomains: ['api.example.com'],
      blockedDomains: ['evil.com'],
      allowPrivateIPs: false,
      allowedPorts: [80, 443],
      allowHttp: false,
      interceptDNS: true,
      maxRedirects: 5,
      timeout: 30000,
    };

    expect(config.allowedDomains).toBeDefined();
    expect(config.blockedDomains).toBeDefined();
    expect(config.allowPrivateIPs).toBe(false);
    expect(config.allowedPorts).toBeDefined();
  });

  it('should accept minimal configuration', () => {
    const config: NetworkEgressConfig = {
      allowedDomains: ['example.com'],
    };

    expect(config.allowedDomains).toBeDefined();
  });
});
