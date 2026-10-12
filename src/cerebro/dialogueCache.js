// src/cerebro/dialogueCache.js
// Cache LRU + TTL para diálogos generados por el LLM del Cerebro.
//
// CAMBIOS V2.0.0:
//   - [FIX] La clave ahora es por PAR de entidades (a.id + b.id).
//     Antes era por emoción+intent, lo que hacía que todas las
//     entidades "neutral/charla" compartieran el mismo diálogo.
//   - [FIX] TTL reducido a 15min por defecto. Antes 2h hacía que
//     los mismos diálogos se sirvieran durante horas.
//   - [FEAT] Solo se usa como optimización del fallback (cuando el
//     LLM no está disponible o está rate-limited).

import { env } from '../config/env.js';

class DialogueCache {
  constructor({ maxSize, ttlMs }) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Construye una clave por PAR de entidades.
   * Dos entidades A y B siempre tienen la misma clave,
   * sin importar el orden.
   */
  static key(a, b) {
    const idA = String(a.id);
    const idB = String(b.id);
    return idA < idB
      ? `pair:${idA}|${idB}`
      : `pair:${idB}|${idA}`;
  }

  /**
   * Construye una clave por emoción+intent (fallback legado).
   * Solo se usa si no hay IDs disponibles.
   */
  static legacyKey(a, b) {
    const emoA = a.dominantEmotion || 'neutral';
    const emoB = b.dominantEmotion || 'neutral';
    const intA = a.dominantIntent || 'charla';
    const intB = b.dominantIntent || 'charla';
    const pair = [emoA + ':' + intA, emoB + ':' + intB].sort();
    return `legacy:${pair[0]}|${pair[1]}`;
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

  invalidate(key) {
    this.map.delete(key);
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
  // TTL por defecto más bajo: 15 min en vez de 2h
  ttlMs: Math.min(env.llmDialogueCacheTtlMs, 900000),
});

export default dialogueCache;
