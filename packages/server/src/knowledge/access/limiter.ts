import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { KnowledgeError } from "../errors.js";
const acquire = `local now=redis.call('TIME'); local ms=now[1]*1000+math.floor(now[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ms-60000)
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ms)
if redis.call('ZCARD',KEYS[1])>=60 then return 60 end
if redis.call('ZCARD',KEYS[2])>=5 then return 1 end
redis.call('ZADD',KEYS[1],ms,ARGV[1]); redis.call('PEXPIRE',KEYS[1],61000)
redis.call('ZADD',KEYS[2],ms+90000,ARGV[1]); redis.call('PEXPIRE',KEYS[2],91000)
return 0`;
export interface KnowledgeLimiter { enter(keyId: string): Promise<() => Promise<void>> }
export class RedisKnowledgeLimiter implements KnowledgeLimiter {
  constructor(readonly redis: Redis) {}
  async enter(keyId: string) {
    const id = randomUUID(); const prefix = `rag:access:{${keyId}}`;
    const retry = Number(await this.redis.eval(acquire, 2, `${prefix}:rate`, `${prefix}:active`, id));
    if (retry) throw new KnowledgeError("RATE_LIMITED", 429, `知识接口请求过于频繁，请稍后重试`, true);
    return async () => { await this.redis.zrem(`${prefix}:active`, id); };
  }
}
