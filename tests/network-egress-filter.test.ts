/**
 * Network Egress Filter Tests
 * 
 * Tests for domain whitelist, private IP blocking, and HTTP/HTTPS filtering
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  NetworkEgressFilter,
  NetworkEgressConfig,
  secureConfig,
  defaultAllowlist,
} from '../src/security/network-egress-filter';

describe('NetworkEgressFilter', () => {
  let filter: NetworkEgressFilter;

  beforeEach(() => {
    filter = new NetworkEgressFilter({
      allowedDomains: [
        'api.example.com',
        '*.openai.com',
        'github.com',
        'registry.npmjs.org',
      ],
      blockedDomains: ['malicious.com'],
      allowPrivateIPs: false,
      allowedPorts: [80, 443],
      interceptDNS: true,
    });
  });

  describe('Domain Whitelist', () => {
    it('should allow exact domain match', () => {
      expect(filter.isDomainAllowed('api.example.com')).toBe(true);
      expect(filter.isDomainAllowed('github.com')).toBe(true);
    });

    it('should normalize domains (lowercase, remove www)', () => {
      expect(filter.isDomainAllowed('API.EXAMPLE.COM')).toBe(true);
      expect(filter.isDomainAllowed('www.github.com')).toBe(true);
      expect(filter.isDomainAllowed('WWW.API.EXAMPLE.COM')).toBe(true);
    });

    it('should block domains not in whitelist', () => {
      expect(filter.isDomainAllowed('evil.com')).toBe(false);
      expect(filter.isDomainAllowed('random-site.org')).toBe(false);
    });

    it('should respect blocked domains (blacklist)', () => {
      expect(filter.isDomainAllowed('malicious.com')).toBe(false);
    });

    it('should allow subdomains with wildcard', () => {
      expect(filter.isDomainAllowed('api.openai.com')).toBe(true);
      expect(filter.isDomainAllowed('chat.openai.com')).toBe(true);
      expect(filter.isDomainAllowed('openai.com')).toBe(true);
    });

    it('should not allow unrelated subdomains', () => {
      expect(filter.isDomainAllowed('evil.api.example.com')).toBe(false);
    });
  });

  describe('Private IP Blocking', () => {
    it('should detect loopback addresses', () => {
      expect(filter.isPrivateIP('127.0.0.1')).toBe(true);
      expect(filter.isPrivateIP('127.255.255.255')).toBe(true);
      expect(filter.isPrivateIP('::1')).toBe(true);
    });

    it('should detect private Class A networks', () => {
      expect(filter.isPrivateIP('10.0.0.1')).toBe(true);
      expect(filter.isPrivateIP('10.255.255.255')).toBe(true);
    });

    it('should detect private Class B networks', () => {
      expect(filter.isPrivateIP('172.16.0.1')).toBe(true);
      expect(filter.isPrivateIP('172.31.255.255')).toBe(true);
      expect(filter.isPrivateIP('172.15.0.1')).toBe(false); // Not in range
      expect(filter.isPrivateIP('172.32.0.1')).toBe(false); // Not in range
    });

    it('should detect private Class C networks', () => {
      expect(filter.isPrivateIP('192.168.0.1')).toBe(true);
      expect(filter.isPrivateIP('192.168.255.255')).toBe(true);
      expect(filter.isPrivateIP('192.167.0.1')).toBe(false);
    });

    it('should detect link-local addresses', () => {
      expect(filter.isPrivateIP('169.254.1.1')).toBe(true);
      expect(filter.isPrivateIP('fe80::1')).toBe(true);
    });

    it('should detect IPv6 unique local addresses', () => {
      expect(filter.isPrivateIP('fc00::1')).toBe(true);
      expect(filter.isPrivateIP('fd00::1')).toBe(true);
    });

    it('should allow public IPs', () => {
      expect(filter.isPrivateIP('8.8.8.8')).toBe(false);
      expect(filter.isPrivateIP('1.1.1.1')).toBe(false);
      expect(filter.isPrivateIP('151.101.1.140')).toBe(false);
    });
  });

  describe('URL Validation', () => {
    it('should allow whitelisted HTTP URLs', () => {
      const result = filter.validateUrl('http://api.example.com/test');
      expect(result.allowed).toBe(true);
    });

    it('should allow whitelisted HTTPS URLs', () => {
      const result = filter.validateUrl('https://github.com/user/repo');
      expect(result.allowed).toBe(true);
    });

    it('should block non-HTTP/HTTPS protocols', () => {
      const result1 = filter.validateUrl('ftp://example.com/file');
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain('Protocol not allowed');

      const result2 = filter.validateUrl('file:///etc/passwd');
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain('Protocol not allowed');
    });

    it('should block non-whitelisted domains', () => {
      const result = filter.validateUrl('https://evil.com/malware');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Domain not in whitelist');
    });

    it('should block custom ports not in allowed list', () => {
      const customFilter = new NetworkEgressFilter({
        allowedDomains: ['example.com'],
        allowedPorts: [443],
      });

      const result = customFilter.validateUrl('http://example.com:8080/test');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Port');
    });

    it('should handle invalid URLs gracefully', () => {
      const result = filter.validateUrl('not-a-valid-url');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Invalid URL');
    });
  });

  describe('Secure Config', () => {
    it('should provide secure default configuration', () => {
      const config = secureConfig();
      
      expect(config.allowPrivateIPs).toBe(false);
      expect(config.interceptDNS).toBe(true);
      expect(config.allowedPorts).toEqual([80, 443]);
      expect(config.allowedDomains.length).toBeGreaterThan(0);
    });

    it('should include safe default allowlist', () => {
      const allowlist = defaultAllowlist();
      
      expect(allowlist).toContain('registry.npmjs.org');
      expect(allowlist.some(d => d.includes('openai'))).toBe(true);
      expect(allowlist.some(d => d.includes('github'))).toBe(true);
    });
  });

  describe('Network Egress Filter Integration', () => {
    it('should create egress filtered agent', () => {
      const agent = filter.createEgressFilteredAgent();
      
      expect(agent.fetch).toBeDefined();
      expect(agent.validateUrl).toBeDefined();
      expect(agent.isPrivateIP).toBeDefined();
      expect(agent.isDomainAllowed).toBeDefined();
    });

    it('should validate URLs through filtered agent', () => {
      const agent = filter.createEgressFilteredAgent();
      
      const validResult = agent.validateUrl('https://api.example.com/test');
      expect(validResult.allowed).toBe(true);
      
      const invalidResult = agent.validateUrl('https://evil.com/test');
      expect(invalidResult.allowed).toBe(false);
    });
  });
});

describe('NetworkEgressFilter - Edge Cases', () => {
  it('should handle domain with trailing slash', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
    });
    
    expect(filter.isDomainAllowed('example.com/')).toBe(true);
  });

  it('should handle empty domain list', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: [],
    });
    
    expect(filter.isDomainAllowed('anything.com')).toBe(false);
  });

  it('should handle case-insensitive blocking', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      blockedDomains: ['BAD.com'],
    });
    
    expect(filter.isDomainAllowed('bad.com')).toBe(false);
    expect(filter.isDomainAllowed('BAD.COM')).toBe(false);
  });

  it('should handle wildcard at different levels', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['*.example.com'],
    });
    
    expect(filter.isDomainAllowed('sub.example.com')).toBe(true);
    expect(filter.isDomainAllowed('deep.sub.example.com')).toBe(true);
    expect(filter.isDomainAllowed('example.com')).toBe(true);
    expect(filter.isDomainAllowed('notexample.com')).toBe(false);
  });
});

describe('NetworkEgressFilter - DNS Rebinding Protection', () => {
  it('should intercept DNS lookups', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['example.com'],
      interceptDNS: true,
      allowPrivateIPs: false,
    });
    
    // DNS lookup interception is tested through the fetch method
    // In a real scenario, this would prevent DNS rebinding attacks
    expect(filter.config.interceptDNS).toBe(true);
  });

  it('should allow private IPs when configured', () => {
    const filter = new NetworkEgressFilter({
      allowedDomains: ['internal.example.com'],
      allowPrivateIPs: true,
    });
    
    // Filter still detects private IPs but allows them
    expect(filter.isPrivateIP('192.168.1.1')).toBe(true);
    // But the configuration allows them
    expect(filter.config.allowPrivateIPs).toBe(true);
  });
});

describe('NetworkEgressFilter - Fetch Method', () => {
  let filter: NetworkEgressFilter;

  beforeEach(() => {
    filter = new NetworkEgressFilter({
      allowedDomains: ['api.example.com', 'httpbin.org'],
      allowPrivateIPs: false,
    });
  });

  it('should throw error for blocked domain', async () => {
    await expect(filter.fetch('https://evil.com/test'))
      .rejects
      .toThrow('Network egress blocked');
  });

  it('should throw error for private IP URLs', async () => {
    await expect(filter.fetch('http://192.168.1.1/admin'))
      .rejects
      .toThrow('Network egress blocked');
  });

  it('should validate URL before making request', async () => {
    // This test would make a real request in integration testing
    // For unit tests, we verify the validation happens
    const validation = filter.validateUrl('https://api.example.com/test');
    expect(validation.allowed).toBe(true);
  });
});
