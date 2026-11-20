// Minimal ioredis types for the worker service.
// The full ioredis package ships types separately; this avoids the TS7016 error
// when the monorepo hoists a version without bundled .d.ts files.
declare module "ioredis" {
  import { EventEmitter } from "node:events";

  interface RedisOptions {
    maxRetriesPerRequest?: number | null;
    lazyConnect?: boolean;
    [key: string]: unknown;
  }

  export default class Redis extends EventEmitter {
    constructor(url?: string, options?: RedisOptions);
    connect(): Promise<void>;
    quit(): Promise<void>;
    on(event: string, callback: (...args: unknown[]) => void): this;
  }
}
