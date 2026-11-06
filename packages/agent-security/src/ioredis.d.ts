declare module 'ioredis' {
  export interface RedisOptions {
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number | null;
    enableReadyCheck?: boolean;
    connectTimeout?: number;
    [key: string]: unknown;
  }

  export class Redis {
    constructor(url?: string, options?: RedisOptions);
    constructor(options?: RedisOptions);
    connect(): Promise<void>;
    disconnect(): void;
    quit(): Promise<string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string | number, ...args: unknown[]): Promise<string | null>;
    del(...keys: string[]): Promise<number>;
    exists(...keys: string[]): Promise<number>;
    incr(key: string): Promise<number>;
    hset(key: string, ...args: (string | number)[]): Promise<number>;
    hgetall(key: string): Promise<Record<string, string>>;
    hdel(key: string, ...fields: string[]): Promise<number>;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export default Redis;
}
