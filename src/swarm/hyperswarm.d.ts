/**
 * Minimal type definitions for hyperswarm.
 * Covers the API surface used by swarm-manager.ts.
 */

declare module 'hyperswarm' {
  import { EventEmitter } from 'events';

  interface Discovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  interface HyperswarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    seed?: Buffer;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
  }

  // Hyperswarm'ın connection event'indeki socket tipi:
  // Hem readable hem writable bir duplex stream + remotePublicKey + destroy.
  type HyperswarmSocket = NodeJS.ReadWriteStream & {
    remotePublicKey?: Buffer;
    destroy(): void;
  };

  type HyperswarmPeerInfo = {
    publicKey?: Buffer;
  };

  class Hyperswarm extends EventEmitter {
    constructor(options?: HyperswarmOptions);
    keyPair: { publicKey: Buffer; secretKey: Buffer };
    connections: Set<HyperswarmSocket>;
    join(topic: Buffer, options?: { server?: boolean; client?: boolean }): Discovery;
    leave(topic: Buffer): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (socket: HyperswarmSocket, info: HyperswarmPeerInfo) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export = Hyperswarm;
}
