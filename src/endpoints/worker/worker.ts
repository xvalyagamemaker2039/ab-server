import { existsSync } from 'fs';
import { workerData } from 'worker_threads';
import uws, { DISABLED } from 'uWebSockets.js';
import { GameServerConfigInterface } from '../../config';
import {
  CONNECTIONS_IDLE_TIMEOUT_SEC,
  CONNECTIONS_MAX_BACKPRESSURE,
  CONNECTIONS_MAX_PAYLOAD_BYTES,
  CONNECTIONS_WEBSOCKETS_COMPRESSOR,
  MAX_UINT32,
} from '../../constants';
import {
  CONNECTIONS_CLOSE,
  CONNECTIONS_CLOSED,
  CONNECTIONS_PACKET_RECEIVED,
  WS_WORKER_CONNECTION_OPENED,
  WS_WORKER_SEND_PACKETS,
  WS_WORKER_STARTED,
  WS_WORKER_STOP,
  WS_WORKER_UPDATE_PLAYERS_AMOUNT,
} from '../../events';
import { decodeIPv4 } from '../../support/binary';
import { ConnectionId, PlayerConnection, WorkerConnectionMeta } from '../../types';
import { hub, Hub } from '../../workers/events-hub';
import Log from '../../workers/logger';
import ConnectionsStorage from '../storage';
import Admin from './admin';

class WsWorker {
  private uws: uws.TemplatedApp;

  private config: GameServerConfigInterface;

  private storage: ConnectionsStorage;

  constructor() {
    this.config = workerData.config;
    this.storage = new ConnectionsStorage();

    /**
     * Event handlers.
     */
    hub.events.on(WS_WORKER_SEND_PACKETS, this.sendPackets, this);
    hub.events.on(CONNECTIONS_CLOSE, this.closeConnection, this);

    hub.events.on(WS_WORKER_UPDATE_PLAYERS_AMOUNT, (playersOnline: number) => {
      this.storage.players = playersOnline;
    });

    hub.events.on(WS_WORKER_STOP, () => {
      process.exit();
    });

    /**
     * Setup endpoint.
     */
    if (this.config.tls) {
      const tlsConfig = {
        key_file_name: `${this.config.certs.path}/privkey.pem`, // eslint-disable-line
        cert_file_name: `${this.config.certs.path}/fullchain.pem`, // eslint-disable-line
        dh_params_file_name: `${this.config.certs.path}/dhparam.pem`, // eslint-disable-line
      };

      if (!existsSync(tlsConfig.dh_params_file_name)) {
        delete tlsConfig.dh_params_file_name;
      }

      this.uws = uws.SSLApp(tlsConfig);
    } else {
      this.uws = uws.App({});
    }

    this.bindWebsocketHandlers();
    this.bindHttpRoutes();
    new Admin(this.config).bindRoutes(this.uws);
  }

  /**
   * Run uWebSockets server.
   */
  start(): void {
    try {
      this.uws.listen(this.config.host, this.config.port, listenSocket => {
        if (!listenSocket) {
          process.exit(1);
        }

        Hub.emitToMain(WS_WORKER_STARTED);

        Log.info('WS/HTTP server started: %o', {
          host: this.config.host,
          port: this.config.port,
          compression: this.config.compression,
          tls: this.config.tls,
        });
      });
    } catch (err) {
      Log.error('WS/HTTP failed to start: %o', {
        host: this.config.host,
        port: this.config.port,
        compression: this.config.compression,
        tls: this.config.tls,
        error: err.stack,
      });

      process.exit(1);
    }
  }

  /**
   * Send packets.
   *
   * @param packet
   * @param connectionId
   * @param exceptions
   */
  sendPackets(
    packet: ArrayBuffer,
    connectionId: ConnectionId | ConnectionId[],
    exceptions: ConnectionId[] = null
  ): void {
    if (Array.isArray(connectionId)) {
      for (let index = 0; index < connectionId.length; index += 1) {
        if (exceptions === null || !exceptions.includes(connectionId[index])) {
          this.sendPacket(packet, connectionId[index]);
        }
      }
    } else {
      this.sendPacket(packet, connectionId);
    }
  }

  private sendPacket(packet: ArrayBuffer, connectionId: ConnectionId): void {
    try {
      if (!this.storage.connectionList.has(connectionId)) {
        return;
      }

      const ws = this.storage.connectionList.get(connectionId);

      if (ws.getBufferedAmount() !== 0) {
        Log.info('Slow connection, buffer > 0: %o', {
          connectionId,
          bufferSize: ws.getBufferedAmount(),
        });
      }

      const result = ws.send(packet, true, this.config.compression);

      if (!result) {
        Log.debug('Packet sending failed: %o', {
          connectionId,
          bufferSize: ws.getBufferedAmount(),
          packerSize: packet.byteLength,
        });
      }
    } catch (err) {
      Log.error('Packet sending error: %o', {
        connectionId,
        packerSize: packet.byteLength,
        error: err.stack,
      });
    }
  }

  private bindWebsocketHandlers(): void {
    this.uws.ws('/*', {
      compression: this.config.compression ? CONNECTIONS_WEBSOCKETS_COMPRESSOR : DISABLED,
      maxPayloadLength: CONNECTIONS_MAX_PAYLOAD_BYTES,
      maxBackpressure: CONNECTIONS_MAX_BACKPRESSURE,
      idleTimeout: CONNECTIONS_IDLE_TIMEOUT_SEC,

      open: (connection: PlayerConnection, req) => {
        const connectionId = this.createConnectionId();
        const now = Date.now();
        const meta: WorkerConnectionMeta = {
          id: connectionId,
          ip: decodeIPv4(connection.getRemoteAddress()),
          headers: {},
          createdAt: now,
        };

        if (req.getHeader('x-forwarded-for') !== '') {
          meta.ip = req.getHeader('x-forwarded-for');
        } else if (req.getHeader('x-real-ip') !== '') {
          meta.ip = req.getHeader('x-real-ip');
        }

        connection.meta = meta;

        this.storage.connectionList.set(connectionId, connection);

        req.forEach((title, value) => {
          meta.headers[title] = value;
        });

        Log.debug('Connection opened: %o', {
          connectionId,
          ip: meta.ip,
          method: req.getMethod(),
          headers: meta.headers,
        });

        Hub.emitToMain(WS_WORKER_CONNECTION_OPENED, meta);
      },

      message: (connection: PlayerConnection, message, isBinary) => {
        if (isBinary === true) {
          try {
            Hub.emitToMain(CONNECTIONS_PACKET_RECEIVED, message, connection.meta.id);
          } catch (err) {
            Log.error('Connection onMessage error: %o', {
              connectionId: connection.meta.id,
              error: err.stack,
            });
          }
        } else {
          Log.debug("Connection onMessage isn't binary: %o", {
            connectionId: connection.meta.id,
          });

          this.closeConnection(connection.meta.id);
        }
      },

      close: (connection: PlayerConnection, code) => {
        const { id } = connection.meta;

        try {
          this.storage.connectionList.delete(id);

          Log.debug('Connection closed: %o', { connectionId: id, code });

          Hub.emitToMain(CONNECTIONS_CLOSED, id);
        } catch (err) {
          Log.error('Connection closing error: %o', { connectionId: id, error: err.stack });
        }
      },
    });
  }

  private bindHttpRoutes(): void {
    this.uws
      .get('/ping', res => {
        res.writeHeader('Content-type', 'application/json').end('{"pong":1}');
      })

      .get('/', res => {
        res
          .writeHeader('Content-type', 'application/json')
          .end(`{"players":${this.storage.players}}`);
      })

      .any('/*', res => {
        res.writeStatus('404 Not Found').end('');
      });
  }

  private createConnectionId(): ConnectionId {
    while (this.storage.connectionList.has(this.storage.nextConnectionId)) {
      this.storage.nextConnectionId += 1;

      if (this.storage.nextConnectionId >= MAX_UINT32) {
        this.storage.nextConnectionId = 1;
      }
    }

    if (this.storage.nextConnectionId >= MAX_UINT32) {
      this.storage.nextConnectionId = 1;
    }

    this.storage.nextConnectionId += 1;

    return this.storage.nextConnectionId - 1;
  }

  private closeConnection(connectionId: ConnectionId): void {
    try {
      if (!this.storage.connectionList.has(connectionId)) {
        return;
      }

      const ws = this.storage.connectionList.get(connectionId);

      ws.close();
    } catch (err) {
      Log.error('Connection closing error: %o', { connectionId, error: err.stack });
    }
  }
}

const endpoint = new WsWorker();

endpoint.start();
