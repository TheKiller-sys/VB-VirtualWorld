// src/transport/ws.js
// WebSocket server con broadcast en tiempo real.
//
// CAMBIOS V1.5.0:
//   - [PERF] Broadcast LIGERO a wsBroadcastHz (30Hz por defecto).
//     Solo envía posición y velocidad de cada entidad.
//   - [FEAT] Broadcast COMPLETO cada wsFullSnapshotIntervalMs (3s).
//     Incluye emoción, traits, relaciones, etc.
//   - [FIX] El cliente extrapola entre broadcasts para 0ms de latencia.

import { WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('ws');

const MAX_BUFFER_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 25000;
const CLOSE_TOKEN_INVALID = 4001;
const CLOSE_TOO_MANY = 1013;

export function createWSServer(httpServer, world) {
  const requireToken = env.isProd && !env.worldWsToken;

  if (requireToken) {
    log.error(
      '❌ WS: NODE_ENV=production sin WORLD_WS_TOKEN. ' +
      'Todas las conexiones serán rechazadas.'
    );
  }

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });

  const clients = new Set();

  const stats = {
    totalConnections: 0,
    rejected: 0,
    rejectedAuth: 0,
    rejectedLimit: 0,
    bytesOut: 0,
    messagesSent: 0,
    lightBroadcasts: 0,
    fullBroadcasts: 0,
    lastConnectionAt: 0,
    lastDisconnectAt: 0,
  };

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';

    // Guard: configuración inválida
    if (requireToken) {
      stats.rejected++;
      stats.rejectedAuth++;
      log.warn(`WS rechazado (sin token configurado) desde ${ip}`);
      ws.close(CLOSE_TOKEN_INVALID, 'Servidor mal configurado');
      return;
    }

    // Autenticación por token
    if (env.worldWsToken) {
      let token = null;
      try {
        const url = new URL(req.url, 'http://x');
        token = url.searchParams.get('token');
      } catch (_) {}
      if (!token) token = req.headers['x-world-token'] || null;

      if (token !== env.worldWsToken) {
        stats.rejected++;
        stats.rejectedAuth++;
        log.warn(`WS rechazado (token inválido) desde ${ip}`);
        ws.close(CLOSE_TOKEN_INVALID, 'Token inválido');
        return;
      }
    }

    // Límite de clientes
    if (clients.size >= env.wsMaxClients) {
      stats.rejected++;
      stats.rejectedLimit++;
      log.warn(`WS rechazado (límite ${env.wsMaxClients}) desde ${ip}`);
      ws.close(CLOSE_TOO_MANY, 'Demasiados clientes');
      return;
    }

    stats.totalConnections++;
    stats.lastConnectionAt = Date.now();

    const client = {
      ws,
      id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      connectedAt: Date.now(),
      ip,
      isAlive: true,
      lastSeenAt: Date.now(),
    };

    clients.add(client);

    log.info(`🔌 WS cliente ${client.id} conectado (total=${clients.size})`);

    // Snapshot COMPLETO inicial
    safeSend(client, {
      type: 'welcome',
      serverTime: Date.now(),
      snapshot: world.snapshot(),
    });

    // Mensajes del cliente
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
      stats.lastDisconnectAt = Date.now();
      log.info(`🔌 WS cliente ${client.id} desconectado (total=${clients.size})`);
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

  // ---------- Broadcast ----------
  let lastFullBroadcastAt = 0;
  const broadcastIntervalMs = Math.max(16, Math.round(1000 / env.wsBroadcastHz));
  const fullIntervalMs = env.wsFullSnapshotIntervalMs;

  const broadcastInterval = setInterval(() => {
    if (clients.size === 0) {
      // Drena eventos incluso sin clientes para no acumular memoria
      world.drainEvents();
      return;
    }

    const now = Date.now();
    const isFull = (now - lastFullBroadcastAt) >= fullIntervalMs;

    let payload;
    const events = world.drainEvents();

    if (isFull) {
      lastFullBroadcastAt = now;
      stats.fullBroadcasts++;
      payload = JSON.stringify({
        type: 'full',
        snapshot: world.snapshot(),
        events,
        serverTime: now,
      });
    } else {
      stats.lightBroadcasts++;
      payload = JSON.stringify({
        type: 'tick',
        snapshot: world.snapshotLight(),
        events,
        serverTime: now,
      });
    }

    const payloadBytes = Buffer.byteLength(payload);

    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) {
        clients.delete(client);
        continue;
      }
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
  }, broadcastIntervalMs);
  if (broadcastInterval.unref) broadcastInterval.unref();

  // ---------- API ----------
  function safeSend(client, msg) {
    if (!client || client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFER_BYTES) return;
    try {
      const s = JSON.stringify(msg);
      client.ws.send(s);
      stats.messagesSent++;
      stats.bytesOut += Buffer.byteLength(s);
    } catch (_) {}
  }

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
      fullSnapshotIntervalMs: env.wsFullSnapshotIntervalMs,
      requiresToken: !!env.worldWsToken,
      requireTokenMissing: requireToken,
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
