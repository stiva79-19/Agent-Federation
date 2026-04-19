/**
 * Consent Manager Tests - Network Access Integration
 * 
 * Tests for consent requests with network access control
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConsentManager, ConsentAction } from '../src/consent/consent';
import { NetworkEgressFilter } from '../src/security/network-egress-filter';

describe('ConsentManager - Network Access', () => {
  let consentManager: ConsentManager;
  let networkFilter: NetworkEgressFilter;

  beforeEach(() => {
    consentManager = new ConsentManager();
    networkFilter = new NetworkEgressFilter({
      allowedDomains: ['api.example.com', 'httpbin.org'],
      allowPrivateIPs: false,
    });
  });

  describe('Risk Calculation with Network Access', () => {
    it('should calculate higher risk for execute_code_with_network', () => {
      const riskExecuteCode = ConsentManager.calculateRisk('execute_code', {});
      const riskExecuteCodeNetwork = ConsentManager.calculateRisk('execute_code_with_network', {});
      
      expect(riskExecuteCodeNetwork).toBeGreaterThan(riskExecuteCode);
      expect(riskExecuteCodeNetwork).toBe(80);
    });

    it('should calculate risk for network_request action', () => {
      const risk = ConsentManager.calculateRisk('network_request', {
        url: 'https://api.example.com/test',
      });
      
      expect(risk).toBe(50);
    });

    it('should increase risk for POST/PUT/DELETE methods', () => {
      const baseRisk = ConsentManager.calculateRisk('network_request', {
        url: 'https://api.example.com/test',
        network: { method: 'GET' },
      });
      
      const postRisk = ConsentManager.calculateRisk('network_request', {
        url: 'https://api.example.com/test',
        network: { method: 'POST' },
      });
      
      expect(postRisk).toBeGreaterThan(baseRisk);
    });

    it('should increase risk for requests with body', () => {
      const riskWithoutBody = ConsentManager.calculateRisk('network_request', {
        url: 'https://api.example.com/test',
        network: { hasBody: false },
      });
      
      const riskWithBody = ConsentManager.calculateRisk('network_request', {
        url: 'https://api.example.com/test',
        network: { hasBody: true },
      });
      
      expect(riskWithBody).toBeGreaterThan(riskWithoutBody);
    });

    it('should increase risk for multiple URLs', () => {
      const riskFewUrls = ConsentManager.calculateRisk('network_request', {
        network: { urls: ['https://a.com', 'https://b.com'] },
      });
      
      const riskManyUrls = ConsentManager.calculateRisk('network_request', {
        network: { urls: Array(10).fill('https://example.com') },
      });
      
      expect(riskManyUrls).toBeGreaterThan(riskFewUrls);
    });

    it('should significantly increase risk for private IP access attempts', () => {
      const riskPublicIP = ConsentManager.calculateRisk('network_request', {
        network: { urls: ['https://8.8.8.8/test'] },
      });
      
      const riskPrivateIP = ConsentManager.calculateRisk('network_request', {
        network: { urls: ['http://192.168.1.1/admin'] },
      });
      
      expect(riskPrivateIP).toBeGreaterThan(riskPublicIP);
      expect(riskPrivateIP).toBeGreaterThanOrEqual(30); // Private IP penalty
    });

    it('should detect various private IP patterns', () => {
      const testCases = [
        { url: 'http://127.0.0.1/test', shouldPenalizeize: true },
        { url: 'http://10.0.0.1/admin', shouldPenalizeize: true },
        { url: 'http://192.168.1.1/', shouldPenalizeize: true },
        { url: 'http://172.16.0.1/', shouldPenalizeize: true },
        { url: 'https://example.com', shouldPenalizeize: false },
      ];

      for (const testCase of testCases) {
        const risk = ConsentManager.calculateRisk('network_request', {
          network: { urls: [testCase.url] },
        });
        
        if (testCase.shouldPenalizeize) {
          expect(risk).toBeGreaterThanOrEqual(30);
        }
      }
    });
  });

  describe('Consent Request with Network Details', () => {
    it('should create consent request with network access details', () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test123',
        action: 'execute_code_with_network',
        details: {
          code: 'console.log("hello")',
          network: {
            urls: ['https://api.example.com/data'],
            method: 'GET',
            hasBody: false,
          },
        },
        riskScore: 75,
        timeoutSeconds: 300,
      });

      expect(request.id).toBeDefined();
      expect(request.requesterDid).toBe('did:agent:test123');
      expect(request.action).toBe('execute_code_with_network');
      expect(request.details.network).toBeDefined();
      expect(request.details.network?.urls).toHaveLength(1);
    });

    it('should track network access in consent history', () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test123',
        action: 'network_request',
        details: {
          url: 'https://api.example.com/test',
          network: { urls: ['https://api.example.com/test'] },
        },
        riskScore: 50,
        timeoutSeconds: 120,
      });

      consentManager.decide({
        requestId: request.id,
        response: 'approved',
        note: 'Test approval',
      });

      const status = consentManager.getStatus(request.id);
      expect(status).not.toBe('pending');
      expect(typeof status !== 'string' && status.response).toBe('approved');
    });
  });

  describe('Consent Decision Flow', () => {
    it('should handle approval workflow', () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test',
        action: 'network_request',
        details: { url: 'https://api.example.com' },
        riskScore: 50,
        timeoutSeconds: 120,
      });

      // Initially pending
      expect(consentManager.getStatus(request.id)).toBe('pending');

      // Approve
      consentManager.decide({
        requestId: request.id,
        response: 'approved',
      });

      // Now approved
      const status = consentManager.getStatus(request.id);
      expect(typeof status !== 'string' && status.response).toBe('approved');
    });

    it('should handle rejection workflow', () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test',
        action: 'execute_code_with_network',
        details: { code: 'fetch("https://evil.com")' },
        riskScore: 90,
        timeoutSeconds: 120,
      });

      consentManager.decide({
        requestId: request.id,
        response: 'rejected',
        note: 'Suspicious network access',
      });

      const status = consentManager.getStatus(request.id);
      expect(typeof status !== 'string' && status.response).toBe('rejected');
    });

    it('should handle modified consent', () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test',
        action: 'execute_code_with_network',
        details: { 
          code: 'fetch("https://api.example.com")',
          network: { urls: ['https://api.example.com', 'https://other.com'] }
        },
        riskScore: 70,
        timeoutSeconds: 120,
      });

      consentManager.decide({
        requestId: request.id,
        response: 'modified',
        modifications: {
          network: { urls: ['https://api.example.com'] }, // Remove other.com
        },
      });

      const status = consentManager.getStatus(request.id);
      expect(typeof status !== 'string' && status.response).toBe('modified');
      expect(typeof status !== 'string' && status.modifications).toBeDefined();
    });

    it('should handle timeout/expiry', async () => {
      const request = consentManager.request({
        requesterDid: 'did:agent:test',
        action: 'network_request',
        details: { url: 'https://api.example.com' },
        riskScore: 50,
        timeoutSeconds: 1, // 1 second timeout
      });

      // Initially should be pending
      expect(consentManager.getStatus(request.id)).toBe('pending');
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const status = consentManager.getStatus(request.id);
      expect(status).toBe('expired');
    });
  });

  describe('Integration with Network Filter', () => {
    it('should validate URLs before creating consent request', () => {
      const validUrl = 'https://api.example.com/test';
      const validation = networkFilter.validateUrl(validUrl);
      
      expect(validation.allowed).toBe(true);
      
      // Now create consent request
      const request = consentManager.request({
        requesterDid: 'did:agent:test',
        action: 'network_request',
        details: {
          url: validUrl,
          network: { urls: [validUrl] },
        },
        riskScore: 50,
        timeoutSeconds: 120,
      });

      expect(request.id).toBeDefined();
    });

    it('should reject consent for blocked domains', () => {
      const blockedFilter = new NetworkEgressFilter({
        allowedDomains: ['safe.com'],
        blockedDomains: ['evil.com'],
      });

      const validation = blockedFilter.validateUrl('https://evil.com/test');
      expect(validation.allowed).toBe(false);
      expect(validation.reason).toContain('Domain not in whitelist');
    });
  });
});

describe('ConsentManager - High Risk Scenarios', () => {
  let consentManager: ConsentManager;

  beforeEach(() => {
    consentManager = new ConsentManager();
  });

  it('should assign high risk to code execution with multiple network calls', () => {
    const risk = ConsentManager.calculateRisk('execute_code_with_network', {
      code: 'urls.forEach(u => fetch(u))',
      network: {
        urls: Array(10).fill('https://example.com'),
        method: 'GET',
        hasBody: false,
      },
    });

    expect(risk).toBeGreaterThanOrEqual(80); // Base + multiple URLs penalty
  });

  it('should assign very high risk to private IP access with code execution', () => {
    const risk = ConsentManager.calculateRisk('execute_code_with_network', {
      code: 'fetch("http://192.168.1.1/admin")',
      network: {
        urls: ['http://192.168.1.1/admin'],
        method: 'GET',
      },
    });

    expect(risk).toBeGreaterThanOrEqual(80); // Base 80 + private IP penalty
  });

  it('should handle path traversal attempts in network URLs', () => {
    const risk = ConsentManager.calculateRisk('execute_code', {
      code: 'fetch("http://example.com/../../../etc/passwd")',
      path: '../etc/passwd', // Path traversal in details
    });

    expect(risk).toBeGreaterThanOrEqual(100); // Base + path traversal penalty
    expect(Math.min(risk, 100)).toBe(100); // Capped at 100
  });
});
