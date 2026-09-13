"use strict";

/**
 * メモリ上で回数を数える固定ウィンドウ方式のレートリミッター。
 * サーバーを 1 プロセスで動かす前提（複数台に分ける場合は Redis などの共有ストアが必要）。
 */
class RateLimiter {
  /** @param {{ max: number, windowMs: number }} options */
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.entries = new Map();
  }

  /** 上限に達していれば、解除されるまでのミリ秒を返す（達していなければ 0） */
  retryAfterMs(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now || entry.count < this.max) return 0;
    return entry.resetAt - now;
  }

  hit(key, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
  }

  reset(key) {
    this.entries.delete(key);
  }

  /** 期限切れの記録を捨ててメモリを解放する */
  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

module.exports = { RateLimiter };
