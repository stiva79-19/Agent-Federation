/**
 * Swarm Protocol Tests — Agent Federation
 *
 * Mesaj serialization/deserialization, buffer parsing, mesaj oluşturma testleri.
 */

import { describe, it, expect } from 'vitest';
import {
  createSwarmMessage,
  serializeMessage,
  deserializeMessage,
  parseBuffer,
  createHandshake,
  createHandshakeAck,
  createPing,
  createPong,
  createError,
  PROTOCOL_VERSION,
  MESSAGE_DELIMITER,
  MAX_MESSAGE_SIZE,
} from '../src/swarm/protocol';

const testFrom = { agentName: 'TestAgent', agentDid: 'did:claw:test' };

describe('Swarm Protocol', () => {
  // ─── Message Creation ─────────────────────────────────────────────

  describe('createSwarmMessage', () => {
    it('should create a valid message with all fields', () => {
      const msg = createSwarmMessage('agent_message', testFrom, { content: 'hello' });

      expect(msg.type).toBe('agent_message');
      expect(msg.from).toEqual(testFrom);
      expect(msg.timestamp).toBeDefined();
      expect(msg.payload).toEqual({ content: 'hello' });
      // Timestamp should be ISO format
      expect(new Date(msg.timestamp).toISOString()).toBe(msg.timestamp);
    });
  });

  describe('createHandshake', () => {
    it('should create a handshake message with protocol version', () => {
      const msg = createHandshake('MrClaw', 'did:claw:mrclaw');

      expect(msg.type).toBe('handshake');
      expect(msg.payload.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(msg.payload.agentName).toBe('MrClaw');
      expect(msg.payload.agentDid).toBe('did:claw:mrclaw');
      expect(msg.from.agentName).toBe('MrClaw');
    });
  });

  describe('createHandshakeAck', () => {
    it('should create an accepted handshake ack', () => {
      const peers = [{ agentName: 'Peer1', agentDid: 'did:claw:peer1' }];
      const msg = createHandshakeAck(testFrom, true, 'abc123', peers);

      expect(msg.type).toBe('handshake_ack');
      expect(msg.payload.accepted).toBe(true);
      expect(msg.payload.sessionKey).toBe('abc123');
      expect(msg.payload.peers).toEqual(peers);
      expect(msg.payload.reason).toBeUndefined();
    });

    it('should create a rejected handshake ack with reason', () => {
      const msg = createHandshakeAck(testFrom, false, '', [], 'Session full');

      expect(msg.payload.accepted).toBe(false);
      expect(msg.payload.reason).toBe('Session full');
    });
  });

  describe('createPing/Pong', () => {
    it('should create ping with sentAt', () => {
      const msg = createPing(testFrom);
      expect(msg.type).toBe('ping');
      expect((msg.payload as Record<string, unknown>).sentAt).toBeDefined();
    });

    it('should create pong with sentAt', () => {
      const msg = createPong(testFrom);
      expect(msg.type).toBe('pong');
    });
  });

  describe('createError', () => {
    it('should create error with code and message', () => {
      const msg = createError(testFrom, 'MAX_PEERS', 'Session full (max 7)');
      expect(msg.type).toBe('error');
      const payload = msg.payload as { code: string; message: string };
      expect(payload.code).toBe('MAX_PEERS');
      expect(payload.message).toBe('Session full (max 7)');
    });
  });

  // ─── Serialization ────────────────────────────────────────────────

  describe('serializeMessage', () => {
    it('should serialize to JSON + newline', () => {
      const msg = createSwarmMessage('ping', testFrom, {});
      const serialized = serializeMessage(msg);

      expect(serialized.endsWith('\n')).toBe(true);
      expect(JSON.parse(serialized.trim())).toEqual(msg);
    });
  });

  describe('deserializeMessage', () => {
    it('should deserialize a valid message', () => {
      const original = createSwarmMessage('agent_message', testFrom, { content: 'test' });
      const json = JSON.stringify(original);
      const result = deserializeMessage(json);

      expect(result.type).toBe('agent_message');
      expect(result.from).toEqual(testFrom);
    });

    it('should throw on empty string', () => {
      expect(() => deserializeMessage('')).toThrow('Empty message');
    });

    it('should throw on invalid JSON', () => {
      expect(() => deserializeMessage('not json')).toThrow();
    });

    it('should throw on missing type', () => {
      expect(() => deserializeMessage(JSON.stringify({ from: testFrom, timestamp: new Date().toISOString() })))
        .toThrow('missing or invalid type');
    });

    it('should throw on missing from', () => {
      expect(() => deserializeMessage(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })))
        .toThrow('missing or invalid from');
    });

    it('should throw on missing timestamp', () => {
      expect(() => deserializeMessage(JSON.stringify({ type: 'ping', from: testFrom })))
        .toThrow('missing or invalid timestamp');
    });

    it('should throw on message too large', () => {
      const huge = JSON.stringify({
        type: 'test',
        from: testFrom,
        timestamp: new Date().toISOString(),
        payload: 'x'.repeat(MAX_MESSAGE_SIZE + 100),
      });
      expect(() => deserializeMessage(huge)).toThrow('Message too large');
    });
  });

  // ─── Buffer Parsing ───────────────────────────────────────────────

  describe('parseBuffer', () => {
    it('should parse multiple complete messages', () => {
      const msg1 = createSwarmMessage('ping', testFrom, {});
      const msg2 = createSwarmMessage('pong', testFrom, {});
      const buffer = serializeMessage(msg1) + serializeMessage(msg2);

      const [messages, remaining] = parseBuffer(buffer);

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('ping');
      expect(messages[1].type).toBe('pong');
      expect(remaining).toBe('');
    });

    it('should keep incomplete message in remaining buffer', () => {
      const msg = createSwarmMessage('ping', testFrom, {});
      const complete = serializeMessage(msg);
      const partial = '{"type":"pong","from":';
      const buffer = complete + partial;

      const [messages, remaining] = parseBuffer(buffer);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('ping');
      expect(remaining).toBe(partial);
    });

    it('should handle empty buffer', () => {
      const [messages, remaining] = parseBuffer('');
      expect(messages).toHaveLength(0);
      expect(remaining).toBe('');
    });

    it('should skip invalid JSON lines gracefully', () => {
      const msg = createSwarmMessage('ping', testFrom, {});
      const buffer = 'invalid json\n' + serializeMessage(msg);

      const [messages, remaining] = parseBuffer(buffer);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('ping');
      expect(remaining).toBe('');
    });

    it('should handle single newline', () => {
      const [messages, remaining] = parseBuffer('\n');
      expect(messages).toHaveLength(0);
      expect(remaining).toBe('');
    });
  });
});
