// src/transport/ws.js
// WebSocket server con broadcast periódico del snapshot, backpressure,
// límite de clientes y autenticación opcional por token.

import { WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('ws');

const MAX_BUFFER_BYTES = 512 * 1024; // 512KB de backpressure
const HEARTBEAT_INTERVAL_MS = 25000;
const PING_TIMEOUT_MS = 10000;

export function createWSServer(httpServer, world) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 64 * 1024, // 64KB max mensajes client→server
    perMessageDeflate: false, // ahorra CPU, el payload ya es compacto
  });

  const clients = new Set();
  const stats = {
    totalConnections: 0,
    rejected: 0,
    bytesOut: 0,
    messagesSent: 0,
  };

  wss.on('connection', (ws, req) => {
    // ---------- Autenticación opcional ----------
    if (env.worldWsToken) {
      const url = new URL(req.url, 'http://x');
      const token = url.searchParams.get('token') || req.headers['x-world-token'];
      if (token !== env.worldWsToken) {
        stats.rejected++;
        log.warn(`WS rechazado: token inválido desde ${req.socket.remoteAddress}`);
        ws.close(4001, 'Token inválido');
        return;
      }
    }

    if (clients.size >= env.wsMaxClients) {
      stats.rejected++;
      log.warn(`WS rechazado: límite de clientes (${clients.size})`);
      ws.close(1013, 'Demasiados clientes');
      return;
    }

    stats.totalConnections++;
    const client = {
      ws,
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      connectedAt: Date.now(),
      ip: req.socket.remoteAddress,
      isAlive: true,
      lastSeenAt: Date.now(),
    };
    client.isAlive = true;
    clients.add(client);

    log.info(`WS cliente conectado: ${client.id} (total=${clients.size})`);

    // ---------- Snapshot inicial ----------
    safeSend(client, {
      type: 'welcome',
      serverTime: Date.now(),
      snapshot: world.snapshot(),
    });

    // ---------- Mensajes del cliente ----------
    ws.on('message', (raw) => {
      client.lastSeenAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      switch (msg?.type) {
        case 'ping':
          safeSend(client, { type: 'pong', ts: Date.now() });
          break;
        case 'snapshot':
          safeSend(client, { type: 'snapshot', snapshot: world.snapshot() });
          break;
        case 'stats':
          safeSend(client, { type: 'stats', stats: world.getStats() });
          break;
        default:
          break;
      }
    });

    ws.on('pong', () => {
      client.isAlive = true;
      client.lastSeenAt = Date.now();
    });

    ws.on('close', () => {
      clients.delete(client);
      log.info(`WS cliente desconectado: ${client.id} (total=${clients.size})`);
    });

    ws.on('error', (err) => {
      log.warn(`WS error en ${client.id}: ${err.message}`);
      clients.delete(client);
      try { ws.close(); } catch (_) {}
    });
  });

  // ---------- Heartbeat ----------
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        try { client.ws.terminate(); } catch (_) {}
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      try { client.ws.ping(); } catch (_) {}
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  // ---------- Broadcast periódico ----------
  const broadcastInterval = setInterval(() => {
    if (clients.size === 0) {
      // Drena eventos aunque no haya clientes, para no acumular memoria
      world.drainEvents();
      return;
    }

    const snapshot = world.snapshot();
    const events = world.drainEvents();

    const payload = JSON.stringify({
      type: 'tick',
      snapshot,
      events,
      serverTime: Date.now(),
    });

    const payloadBytes = Buffer.byteLength(payload);

    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) {
        clients.delete(client);
        continue;
      }
      // Backpressure: si el cliente no consume, salta el frame
      if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) {
        continue;
      }
      try {
        client.ws.send(payload);
        stats.bytesOut += payloadBytes;
        stats.messagesSent++;
      } catch (err) {
        log.warn(`send falló a ${client.id}: ${err.message}`);
        clients.delete(client);
        try { client.ws.close(); } catch (_) {}
      }
    }
  }, Math.max(30, Math.round(1000 / env.wsBroadcastHz)));
  if (broadcastInterval.unref) broadcastInterval.unref();

  // ---------- API ----------
  function safeSend(client, msg) {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) return;
    try {
      const s = JSON.stringify(msg);
      client.ws.send(s);
      stats.messagesSent++;
      stats.bytesOut += Buffer.byteLength(s);
    } catch (_) {}
  }

  /**
   * Broadcast manual de un mensaje a todos los clientes.
   * Usado para notificar eventos puntuales (ej: nueva entidad simulada).
   */
  function broadcast(msg) {
    if (clients.size === 0) return;
    const payload = JSON.stringify(msg);
    const size = Buffer.byteLength(payload);
    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) {
        clients.delete(client);
        continue;
      }
      if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) continue;
      try {
        client.ws.send(payload);
        stats.messagesSent++;
        stats.bytesOut += size;
      } catch (_) {
        clients.delete(client);
      }
    }
  }

  function getStats() {
    return {
      clients: clients.size,
      maxClients: env.wsMaxClients,
      broadcastHz: env.wsBroadcastHz,
      ...stats,
    };
  }

  async function close() {
    clearInterval(heartbeat);
    clearInterval(broadcastInterval);
    for (const client of clients) {
      try {
        client.ws.close(1001, 'Servidor cerrando');
      } catch (_) {}
    }
    clients.clear();
    await new Promise(resolve => wss.close(resolve));
    log.info('WS cerrado');
  }

  return { wss, broadcast, getStats, close, clients };
}
