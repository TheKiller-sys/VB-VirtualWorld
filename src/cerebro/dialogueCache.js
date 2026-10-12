// src/cerebro/dialogueCache.js
// Cache LRU + TTL para diálogos generados por el LLM del Cerebro.
// Evita repetir llamadas costosas para combinaciones similares.

import { env } from '../config/env.js';

class DialogueCache {
  constructor({ maxSize, ttlMs }) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();  // key → { value, expiresAt }
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Construye la clave a partir de dos entidades.
   * Ordena alfabéticamente para que A-B y B-A compartan cache.
   */
  static key(a, b) {
    const emoA = a.dominantEmotion || 'neutral';
    const emoB = b.dominantEmotion || 'neutral';
    const intA = a.dominantIntent || 'charla';
    const intB = b.dominantIntent || 'charla';

    const pair = [emoA + ':' + intA, emoB + ':' + intB].sort();
    return `${pair[0]}|${pair[1]}`;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return null;
    }
    // Re-inserta para LRU
    this.map.delete(key);
    this.map.set(key, entry);
    this.stats.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
        this.stats.evictions++;
      }
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear() {
    this.map.clear();
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      ...this.stats,
      hitRate: total > 0 ? +(this.stats.hits / total).toFixed(3) : 0,
    };
  }
}

export const dialogueCache = new DialogueCache({
  maxSize: env.llmDialogueCacheSize,
  ttlMs: env.llmDialogueCacheTtlMs,
});

export default dialogueCache;
