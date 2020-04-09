import { Worker } from 'worker_threads';
import { marshalServerMessage, ProtocolPacket } from '@airbattle/protocol';
import EventEmitter from 'eventemitter3';
import {
  CONNECTIONS_PACKET_LOGIN_TIMEOUT_MS,
  CONNECTIONS_PLAYERS_TO_CONNECTIONS_MULTIPLIER,
  CONNECTIONS_STATUS,
} from '../constants';
import GameServerBootstrap from '../core/bootstrap';
import {
  CONNECTIONS_SEND_PACKETS,
  CONNECTIONS_UNBAN_IP,
  ERRORS_PACKET_FLOODING_DETECTED,
  PLAYERS_CREATED,
  PLAYERS_REMOVED,
  RESPONSE_PLAYER_BAN,
  TIMEOUT_LOGIN,
  WS_WORKER_CONNECTION_CLOSE,
  WS_WORKER_CONNECTION_OPENED,
  WS_WORKER_GET_PLAYER,
  WS_WORKER_GET_PLAYERS_LIST,
  WS_WORKER_GET_PLAYERS_LIST_RESPONSE,
  WS_WORKER_GET_PLAYER_RESPONSE,
  WS_WORKER_SEND_PACKETS,
  WS_WORKER_STARTED,
  WS_WORKER_STOP,
  WS_WORKER_UPDATE_PLAYERS_AMOUNT,
} from '../events';
import Logger from '../logger';
import { GameStorage } from '../server/storage';
import { has } from '../support/objects';
import {
  AdminActionPlayer,
  AdminPlayersListItem,
  ConnectionId,
  ConnectionMeta,
  Player,
  PlayerId,
  WorkerConnectionMeta,
} from '../types';

export default class WsEndpoint {
  private app: GameServerBootstrap;

  private log: Logger;

  private storage: GameStorage;

  private events: EventEmitter;

  private worker: Worker;

  constructor({ app }) {
    this.app = app;
    this.log = this.app.log;
    this.storage = this.app.storage;
    this.events = this.app.events;

    /**
     * Event handlers.
     */
    this.events.on(WS_WORKER_CONNECTION_CLOSE, this.closeConnection, this);
    this.events.on(WS_WORKER_CONNECTION_OPENED, this.connectionOpened, this);

    this.events.on(CONNECTIONS_SEND_PACKETS, this.sendPackets, this);

    this.events.on(PLAYERS_CREATED, this.updatePlayersAmount, this);
    this.events.on(PLAYERS_REMOVED, this.updatePlayersAmount, this);

    this.events.on(WS_WORKER_GET_PLAYER, this.getAdminPlayerById, this);
    this.events.on(WS_WORKER_GET_PLAYERS_LIST, this.getAdminPlayersList, this);
  }

  /**
   * Collect the response data on `/admin/actions` POST request.
   */
  getAdminPlayerById(playerId: PlayerId): void {
    let actionPlayerData: AdminActionPlayer = null;

    if (this.storage.playerList.has(playerId)) {
      const player = this.storage.playerList.get(playerId);

      actionPlayerData = {
        id: player.id.current,
        name: player.name.current,
        ip: player.ip.current,
      };
    }

    this.worker.postMessage({
      event: WS_WORKER_GET_PLAYER_RESPONSE,
      args: [actionPlayerData],
    });
  }

  /**
   * Collect the response data on `/admin/players` request.
   */
  getAdminPlayersList(): void {
    const now = Date.now();
    const list: AdminPlayersListItem[] = [];

    {
      const playersIterator = this.storage.playerList.values();
      let player: Player = playersIterator.next().value;

      while (player !== undefined) {
        list.push({
          id: player.id.current,
          name: player.name.current,
          captures: player.captures.current,
          spectate: player.spectate.current,
          kills: player.kills.current,
          deaths: player.deaths.current,
          score: player.score.current,
          lastMove: player.times.lastMove,
          ping: player.ping.current,
          flag: player.flag.current,
          isMuted: player.times.unmuteTime > now,
          isBot: player.bot.current,
        });

        player = playersIterator.next().value;
      }
    }

    this.worker.postMessage({
      event: WS_WORKER_GET_PLAYERS_LIST_RESPONSE,
      args: [list],
    });
  }

  /**
   * Handle just opened connection.
   *
   * @param workerConnectionMeta
   */
  connectionOpened(workerConnectionMeta: WorkerConnectionMeta): void {
    const connectionMeta: ConnectionMeta = {
      id: workerConnectionMeta.id,
      ip: workerConnectionMeta.ip,
      isBackup: false,
      isMain: false,
      status: CONNECTIONS_STATUS.OPENED,
      headers: workerConnectionMeta.headers,
      isBot: false,
      playerId: null,
      teamId: null,
      userId: null,
      lastPacketAt: workerConnectionMeta.createdAt,
      createdAt: workerConnectionMeta.createdAt,

      lagging: {
        isActive: false,
        lastAt: 0,
        lastDuration: 0,
        detects: 0,
        packets: 0,
      },

      periodic: {
        ping: null,
      },

      timeouts: {
        login: null,
        ack: null,
        backup: null,
        pong: null,
        respawn: null,
        lagging: null,
      },

      pending: {
        login: false,
        respawn: false,
        spectate: false,
      },

      limits: {
        any: 0,
        chat: 0,
        key: 0,
        respawn: 0,
        spectate: 0,
        su: 0,
        debug: 0,
        spam: 0,
      },
    };
    const connectionId = connectionMeta.id;
    const connection = this.storage.connectionList
      .set(connectionId, connectionMeta)
      .get(connectionId);
    const { ip } = connection;

    /**
     * Detect bots.
     */
    if (
      !this.app.config.whitelist ||
      this.storage.ipWhiteList.has(ip) ||
      (!has(connectionMeta.headers, 'user-agent') && this.app.config.env === 'development')
    ) {
      connection.isBot = true;
    }

    /**
     * Ban check.
     */
    if (this.storage.ipBanList.has(ip)) {
      const ipBan = this.storage.ipBanList.get(ip);

      if (ipBan.expire > connection.createdAt) {
        this.log.info('Connection refused. IP is banned: %o', {
          connectionId,
          ip,
        });

        this.events.emit(
          RESPONSE_PLAYER_BAN,
          connectionId,
          ipBan.reason === ERRORS_PACKET_FLOODING_DETECTED
        );

        setTimeout(() => {
          this.closeConnection(connectionId);
        }, 100);

        return;
      }

      this.events.emit(CONNECTIONS_UNBAN_IP, ip);
    }

    /**
     * Max IP connections check.
     */
    let connectionsCounter = 1;

    if (this.storage.connectionByIPCounter.has(ip)) {
      connectionsCounter = this.storage.connectionByIPCounter.get(ip) + 1;
    }

    if (
      connectionsCounter >
        this.app.config.maxPlayersPerIP * CONNECTIONS_PLAYERS_TO_CONNECTIONS_MULTIPLIER &&
      !this.storage.ipWhiteList.has(ip)
    ) {
      this.log.info('Connection refused: max connections per IP reached: %o', {
        connectionId,
        ip,
      });

      this.closeConnection(connectionId);
    } else {
      this.storage.connectionByIPCounter.set(ip, connectionsCounter);
      connection.status = CONNECTIONS_STATUS.ESTABLISHED;
    }

    /**
     * Awaiting for Login packet.
     */
    connection.timeouts.login = setTimeout(() => {
      this.events.emit(TIMEOUT_LOGIN, connectionId);
    }, CONNECTIONS_PACKET_LOGIN_TIMEOUT_MS);
  }

  /**
   * Send event to worker to close the connection.
   *
   * @param connectionId
   */
  closeConnection(connectionId: ConnectionId): void {
    this.worker.postMessage({
      event: WS_WORKER_CONNECTION_CLOSE,
      args: [connectionId],
    });
  }

  /**
   * Encode and pass binary packet to the worker to send it to the connection(s).
   *
   * Use `exceptions` array to prevent sending to some clients.
   * If `exceptions` array contains connection identifier,
   * this identifier must exist in `connectionId` array.
   *
   * Exceptions array mustn't contain any garbage.
   *
   * @param msg packet object
   * @param connectionId connectionId or array of unique connectionIds
   * @param exceptions array of unique connectionIds
   */
  sendPackets(
    msg: ProtocolPacket,
    connectionId: ConnectionId | ConnectionId[],
    exceptions: ConnectionId[] = null
  ): void {
    let packet: ArrayBuffer;
    let packetsAmount = 1;

    try {
      packet = marshalServerMessage(msg);
    } catch (err) {
      this.log.error('Message encoding error: %o', { error: err.stack });

      return;
    }

    if (Array.isArray(connectionId)) {
      packetsAmount = connectionId.length;

      if (exceptions !== null) {
        packetsAmount -= exceptions.length;
      }
    }

    this.app.metrics.packets.out += packetsAmount;
    this.app.metrics.transfer.outB += packet.byteLength * packetsAmount;

    if (this.app.metrics.collect === true) {
      this.app.metrics.sample.ppsOut += packetsAmount;
      this.app.metrics.sample.tOut += packet.byteLength * packetsAmount;
    }

    this.worker.postMessage({
      event: WS_WORKER_SEND_PACKETS,
      args: [packet, connectionId, exceptions],
    });
  }

  /**
   * Emit players amount update to the worker.
   */
  updatePlayersAmount(): void {
    this.worker.postMessage({
      event: WS_WORKER_UPDATE_PLAYERS_AMOUNT,
      args: [this.storage.playerList.size],
    });
  }

  /**
   * Run WS worker.
   */
  async start(): Promise<void> {
    this.worker = new Worker('./dist/endpoints/worker/worker.js', {
      workerData: {
        config: this.app.config,
      },
    });

    this.worker.on('exit', exitCode => {
      if (exitCode === 0) {
        process.exit();
      }

      this.log.fatal('UWS worker is down: %o', { exitCode });
      process.exit(exitCode);
    });

    /**
     * Re-emit events from the worker.
     */
    this.worker.on('message', msg => {
      try {
        this.events.emit(msg.event, ...msg.args);
      } catch (err) {
        this.log.error('Error re-emitting event from the WS worker: %o', {
          event: msg.event,
        });
      }
    });

    return new Promise((resolve, reject) => {
      this.worker.on('online', () => {
        this.log.debug('UWS worker started.');

        this.events.once(WS_WORKER_STARTED, () => {
          resolve();
        });
      });

      this.worker.on('error', () => {
        this.log.error('Error starting UWS worker.');

        reject();
      });
    });
  }

  stop(): void {
    this.worker.postMessage({
      event: WS_WORKER_STOP,
      args: [],
    });
  }
}
