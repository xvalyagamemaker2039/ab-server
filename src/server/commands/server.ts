import { GameServerConfigInterface } from '../../config';
import {
  BYTES_PER_KB,
  CHAT_SUPERUSER_MUTE_TIME_MS,
  CONNECTIONS_SUPERUSER_BAN_MS,
  LIMITS_DEBUG,
  LIMITS_DEBUG_WEIGHT,
  SERVER_MIN_SERVICE_MOB_ID,
} from '../../constants';
import {
  BROADCAST_CHAT_SERVER_PUBLIC,
  BROADCAST_CHAT_SERVER_WHISPER,
  CHAT_MUTE_BY_IP,
  CHAT_UNMUTE_BY_IP,
  COMMAND_SERVER,
  CONNECTIONS_BAN_IP,
  CONNECTIONS_FLUSH_BANS,
  CONNECTIONS_KICK,
  CONNECTIONS_UNBAN_IP,
  PLAYERS_KICK,
  RESPONSE_COMMAND_REPLY,
} from '../../events';
import { Metrics } from '../../logger/metrics';
import { numberToHumanReadable } from '../../support/numbers';
import { has } from '../../support/objects';
import { ConnectionId, ConnectionMeta, MainConnectionId, PlayerId } from '../../types';
import { System } from '../system';
import { msToHumanReadable } from '../../support/datetime';

export default class ServerCommandHandler extends System {
  private cfg: GameServerConfigInterface;

  private m: Metrics;

  constructor({ app }) {
    super({ app });

    this.cfg = this.app.config;
    this.m = this.app.metrics;

    this.listeners = {
      [COMMAND_SERVER]: this.onCommandReceived,
    };
  }

  private getServerAbout(): string {
    let edition = '';

    if (this.cfg.edition.length) {
      edition = ` (${this.cfg.edition})`;
    }

    let kbIn = ~~((this.m.lastSample.tIn / BYTES_PER_KB) * 100) / 100;
    let kbOut = ~~((this.m.lastSample.tOut / BYTES_PER_KB) * 100) / 100;

    if (kbIn > 9) {
      kbIn = ~~kbIn;
    }

    if (kbOut > 9) {
      kbOut = ~~kbOut;
    }

    return [
      `GLL: ${this.m.lastSample.ll} ms/s, `,
      `PPS: ${this.m.lastSample.ppsIn}/${this.m.lastSample.ppsOut}, `,
      `RAM: ${this.m.lastSample.ram} MB, `,
      `CPU: ${this.m.lastSample.cpu}%, `,
      `SF: ${this.cfg.server.scaleFactor}, `,
      `transfered: ${kbIn}/${kbOut} KB, `,
      `skipped: ${this.m.lastSample.sf} fr, `,
      `uptime: ${this.m.uptime.human}, `,
      `v${this.cfg.version}`,
      edition,
    ].join('');
  }

  /**
   * /server
   *
   * @param playerId
   */
  private responseServerAbout(playerId: PlayerId): void {
    this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, this.getServerAbout());
  }

  /**
   * /server health
   */
  private broadcastServerHealth(): void {
    this.emit(BROADCAST_CHAT_SERVER_PUBLIC, this.getServerAbout());
  }

  /**
   * /server upgrades
   *
   * @param playerId
   */
  private responseServerUpgrades(playerId: PlayerId): void {
    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      playerId,
      `Min: ${this.cfg.upgradesDropMinChance}, max: ${this.cfg.upgradesDropMaxChance}`
    );
  }

  /**
   * /server powerups
   *
   * @param playerId
   */
  private responseServerPowerups(playerId: PlayerId): void {
    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      playerId,
      `Spawn chance: ${this.cfg.powerupSpawnChance}`
    );
  }

  /**
   * /server limits
   *
   * @param connection
   */
  private responsePlayerLimits(connection: ConnectionMeta): void {
    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      connection.playerId,
      [
        `Any: ${connection.limits.any}, `,
        `key: ${connection.limits.key}, `,
        `chat: ${connection.limits.chat}, `,
        `spam: ${connection.limits.spam}, `,
        `respawn: ${connection.limits.respawn}, `,
        `spectate: ${connection.limits.spectate}.`,
      ].join('')
    );
  }

  /**
   * /server frames
   *
   * @param playerId
   */
  private responseServerFrames(playerId: PlayerId): void {
    let skipAgo = '';

    if (this.m.lastSample.sft !== 0) {
      skipAgo = ` (${msToHumanReadable(this.app.ticker.now - this.m.frames.skippedAt)} ago)`;
    }

    const response = [
      `Skipped frames: ${this.m.lastSample.sft}${skipAgo}. `,
      `History: (0, ${this.m.frames.skips[0]})`,
    ];
    const interval = 10;

    for (let range = 1; range < this.m.frames.skips.length; range += interval) {
      let sum = 0;

      if (range > this.m.players.max) {
        break;
      }

      for (let online = range; online < range + interval - 1; online += 1) {
        sum += this.m.frames.skips[online];
      }

      response.push(`, (${range}-${range + interval - 1}, ${sum})`);
    }

    response.push('.');

    this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, response.join(''));
  }

  /**
   * /server performance
   *
   * @param playerId
   */
  private responseServerPerformance(playerId: PlayerId): void {
    const fastcall =
      typeof process.env.EXPERIMENTAL_FASTCALL === 'undefined'
        ? 'undefined'
        : process.env.EXPERIMENTAL_FASTCALL;
    let skipAgo = '';
    let maxAgo = '';

    if (this.m.lastSample.sft !== 0) {
      skipAgo = ` (${msToHumanReadable(this.app.ticker.now - this.m.frames.skippedAt)} ago)`;
    }

    if (this.m.players.max !== 0) {
      maxAgo = ` (${msToHumanReadable(this.app.ticker.now - this.m.players.updatedAt)} ago)`;
    }

    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      playerId,
      [
        `Skipped frames: ${this.m.lastSample.sft}${skipAgo}. `,
        `Env: ${this.cfg.env}. `,
        `Fastcall: ${fastcall}. `,
        `Compression ${this.cfg.compression ? 'on' : 'off'}. `,
        `TLS ${this.cfg.tls ? 'on' : 'off'}. `,
        `Logs: ${this.cfg.logs.level}, `,
        `${this.cfg.logs.path === '' ? 'file off' : 'file on'}, `,
        `${this.cfg.logs.chat === '' ? 'chat off' : 'chat on'}, `,
        `${this.cfg.logs.console ? 'console on' : 'console off'}. `,
        `Max online: ${this.m.players.max} players${maxAgo}.`,
      ].join('')
    );
  }

  /**
   * /server network
   *
   * @param playerId
   */
  private responseServerNetwork(playerId: PlayerId): void {
    let packets = `${this.m.packets.inM} million in, `;

    if (this.m.packets.inB !== 0) {
      const packetsIn = ~~((this.m.packets.inB + this.m.packets.inM / 1000) * 1000) / 1000;

      packets = `${packetsIn} billion in, `;
    } else if (this.m.packets.inM < 10 && this.m.packets.in > 9999) {
      const packetsIn = ~~((this.m.packets.inM + this.m.packets.in / 1e6) * 100) / 100;

      packets = `${packetsIn} million in, `;
    }

    if (this.m.packets.outB !== 0) {
      const packetsIn = ~~((this.m.packets.outB + this.m.packets.outM / 1000) * 1000) / 1000;

      packets = `${packetsIn} billion out, `;
    } else if (this.m.packets.outM > 9 || this.m.packets.out < 10000) {
      packets += `${this.m.packets.outM} million out`;
    } else {
      const packetsOut = ~~((this.m.packets.outM + this.m.packets.out / 1e6) * 100) / 100;

      packets += `${packetsOut} million out`;
    }

    let transfer = '';

    if (this.m.transfer.inGB > 0) {
      if (this.m.transfer.inGB > 9) {
        transfer = `${this.m.transfer.inGB} GB in, `;
      } else {
        transfer = `${this.m.transfer.inGB}.${this.m.transfer.inMB} GB in, `;
      }
    } else {
      transfer = `${this.m.transfer.inMB} MB in, `;
    }

    if (this.m.transfer.outGB > 0) {
      if (this.m.transfer.outGB > 9) {
        transfer += `${this.m.transfer.outGB} GB out`;
      } else {
        transfer += `${this.m.transfer.outGB}.${this.m.transfer.outMB} GB out`;
      }
    } else {
      transfer += `${this.m.transfer.outMB} MB out`;
    }

    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      playerId,
      [
        `Transfer: ${transfer}. `,
        `Packets: ${packets}. `,
        `Lag packets: ${numberToHumanReadable(this.m.lagPackets)}. `,
        `Connections: ${this.storage.connectionList.size} `,
        `(${this.storage.mainConnectionIdList.size}m + `,
        `${this.storage.playerBackupConnectionList.size}b). `,
        `IP: ${this.storage.connectionByIPCounter.size} unique, `,
        `${this.storage.ipBanList.size} banned, `,
        `${this.storage.ipMuteList.size} muted, `,
        `${this.storage.ipWhiteList.size} in the whitelist. `,
      ].join('')
    );
  }

  /**
   * /server debug
   *
   * @param playerId
   */
  private responseServerDebug(playerId: PlayerId): void {
    const afkDisconnect = `AFK disconnect: ${
      this.cfg.afkDisconnectTimeout === 0 ? 'off.' : `${this.cfg.afkDisconnectTimeout} m.`
    }`;

    const spawnZones = (() => {
      let total = 0;

      this.storage.spawnZoneSet.forEach(zonesByPlaneType => {
        zonesByPlaneType.forEach(zones => {
          total += zones.size;
        });
      });

      if (total === 0) {
        return 'No precached spawn zones.';
      }

      return `Precached spawn zones: ${total}, sets: ${this.storage.spawnZoneSet.size}.`;
    })();

    this.emit(
      BROADCAST_CHAT_SERVER_WHISPER,
      playerId,
      [
        `Mob IDs: ${this.storage.mobIdList.size}. `,
        `Next mob ID: ${this.storage.nextMobId}. `,
        `Reserved IDs: ${this.storage.playerHistoryNameToIdList.size}. `,
        `Connections: ${this.storage.connectionIdByTeam.size} teamed, `,
        `${Object.keys(this.storage.connectionIdByNameList).length} named. `,
        `Users: ${this.storage.users.list.size} (${this.storage.users.online.size} online). `,
        `Players: ${this.storage.playerList.size}. `,
        `Bots: ${this.storage.botIdList.size}. `,
        `Spectators: ${this.storage.playerInSpecModeList.size}. `,
        `Mobs: ${this.storage.mobList.size} (${
          this.storage.nextServiceMobId - SERVER_MIN_SERVICE_MOB_ID - 1
        } service). `,
        `Projectiles: ${this.storage.projectileIdList.size}. `,
        `Repels: ${this.storage.repelList.size}. `,
        `Shields: ${this.storage.shieldIdList.size}. `,
        `Infernos: ${this.storage.infernoIdList.size}. `,
        `Upgrades: ${this.storage.upgradeIdList.size}. `,
        `Viewports: ${this.storage.viewportList.size}. `,
        `Broadcast lists: ${this.storage.broadcast.size}. `,
        `Recover: ${this.storage.playerRecoverList.size} records. `,
        `Rankings: ${this.storage.playerRankings.byBounty.length} items. `,
        `${spawnZones} `,
        `${afkDisconnect}`,
      ].join('')
    );
  }

  /**
   * /server ban <subcommand> [value]
   *
   * @param playerId
   * @param command
   */
  private handleBanCommand(playerId: PlayerId, command: string): void {
    const addCommand = 'ban add ';
    const hasCommand = 'ban has ';
    const removeCommand = 'ban remove ';
    const listCommand = 'ban list';
    const flushCommand = 'ban flush';

    if (command === listCommand) {
      if (this.storage.ipBanList.size === 0) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'The ban list is empty.');
      } else {
        this.storage.ipBanList.forEach((ban, ip) => {
          this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, `${ip}, ${ban.reason}`);
        });
      }

      return;
    }

    if (command === flushCommand) {
      const totalBans = this.storage.ipBanList.size;

      this.emit(CONNECTIONS_FLUSH_BANS);
      this.emit(
        BROADCAST_CHAT_SERVER_WHISPER,
        playerId,
        `The ban list has been cleared (${totalBans}).`
      );

      return;
    }

    if (command.indexOf(addCommand) === 0) {
      const ip = command.substring(addCommand.length).trim();

      this.emit(CONNECTIONS_BAN_IP, ip, CONNECTIONS_SUPERUSER_BAN_MS, 'Superuser');
      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'IP added.');

      return;
    }

    if (command.indexOf(removeCommand) === 0) {
      const ip = command.substring(removeCommand.length).trim();

      this.emit(CONNECTIONS_UNBAN_IP, ip);
      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'IP removed.');

      return;
    }

    if (command.indexOf(hasCommand) === 0) {
      const ip = command.substring(hasCommand.length).trim();

      if (this.storage.ipBanList.has(ip)) {
        this.emit(
          BROADCAST_CHAT_SERVER_WHISPER,
          playerId,
          `true, exipred: ${this.storage.ipBanList.get(ip).expire}, reason: ${
            this.storage.ipBanList.get(ip).reason
          }`
        );
      } else {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'false.');
      }
    }
  }

  /**
   * /server kick <subcommand> [value]
   *
   * @param connectionId
   * @param playerId
   * @param command
   */
  private handleKickCommand(connectionId: ConnectionId, playerId: PlayerId, command: string): void {
    const idCommand = 'kick id ';
    const nameCommand = 'kick name ';

    if (command.indexOf(idCommand) === 0) {
      const playerToKickId = ~~command.substring(idCommand.length);

      if (playerId === playerToKickId) {
        return;
      }

      if (!this.helpers.isPlayerConnected(playerToKickId)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        this.emit(PLAYERS_KICK, playerToKickId);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player kicked.');
      }

      return;
    }

    if (command.indexOf(nameCommand) === 0) {
      const playerName = command.substring(nameCommand.length);

      if (!has(this.storage.connectionIdByNameList, playerName)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        const kickConnectionId = this.storage.connectionIdByNameList[playerName];

        if (connectionId === kickConnectionId) {
          return;
        }

        this.emit(CONNECTIONS_KICK, kickConnectionId);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player kicked.');
      }
    }
  }

  /**
   * /server mute <subcommand> [value]
   *
   * @param connectionId
   * @param playerId
   * @param command
   */
  private handleMuteCommand(connectionId: ConnectionId, playerId: PlayerId, command: string): void {
    const idCommand = 'mute id ';
    const nameCommand = 'mute name ';
    const ipCommand = 'mute ip ';

    /**
     * Mute by ID.
     */
    if (command.indexOf(idCommand) === 0) {
      const playerToMuteId = ~~command.substring(idCommand.length);

      if (!this.helpers.isPlayerConnected(playerToMuteId)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        if (playerId === playerToMuteId) {
          return;
        }

        const muteConnection = this.storage.connectionList.get(
          this.storage.playerMainConnectionList.get(playerToMuteId)
        );

        this.emit(CHAT_MUTE_BY_IP, muteConnection.ip, CHAT_SUPERUSER_MUTE_TIME_MS);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player muted.');
      }

      return;
    }

    /**
     * Mute by name.
     */
    if (command.indexOf(nameCommand) === 0) {
      const playerName = command.substring(nameCommand.length);

      if (!has(this.storage.connectionIdByNameList, playerName)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        const muteConnectionId = this.storage.connectionIdByNameList[playerName];

        if (
          connectionId === muteConnectionId ||
          !this.storage.connectionList.has(muteConnectionId)
        ) {
          return;
        }

        const muteConnection = this.storage.connectionList.get(muteConnectionId);

        this.emit(CHAT_MUTE_BY_IP, muteConnection.ip, CHAT_SUPERUSER_MUTE_TIME_MS);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player muted.');
      }

      return;
    }

    /**
     * Mute by IP.
     */
    if (command.indexOf(ipCommand) === 0) {
      const ip = command.substring(ipCommand.length).trim();

      this.emit(CHAT_MUTE_BY_IP, ip, CHAT_SUPERUSER_MUTE_TIME_MS);
      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'IP muted.');
    }
  }

  /**
   * /server unmute <subcommand> [value]
   *
   * @param playerId
   * @param command
   */
  private handleUnmuteCommand(playerId: PlayerId, command: string): void {
    const idCommand = 'unmute id ';
    const nameCommand = 'unmute name ';
    const ipCommand = 'unmute ip ';

    /**
     * Unmute by ID.
     */
    if (command.indexOf(idCommand) === 0) {
      const playerToUnmuteId = ~~command.substring(idCommand.length);

      if (!this.helpers.isPlayerConnected(playerToUnmuteId)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        const unmuteConnection = this.storage.connectionList.get(
          this.storage.playerMainConnectionList.get(playerToUnmuteId)
        );

        this.emit(CHAT_UNMUTE_BY_IP, unmuteConnection.ip);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player unmuted.');
      }

      return;
    }

    /**
     * Unmute by name.
     */
    if (command.indexOf(nameCommand) === 0) {
      const playerName = command.substring(nameCommand.length);

      if (!has(this.storage.connectionIdByNameList, playerName)) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player not found.');
      } else {
        const unmuteConnectionId = this.storage.connectionIdByNameList[playerName];

        if (!this.storage.connectionList.has(unmuteConnectionId)) {
          return;
        }

        const unmuteConnection = this.storage.connectionList.get(unmuteConnectionId);

        this.emit(CHAT_UNMUTE_BY_IP, unmuteConnection.ip);
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Player unmuted.');
      }

      return;
    }

    /**
     * Unmute by IP.
     */
    if (command.indexOf(ipCommand) === 0) {
      const ip = command.substring(ipCommand.length).trim();

      this.emit(CHAT_UNMUTE_BY_IP, ip);
      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'IP unmuted.');
    }
  }

  /**
   * /server bot <subcommand> [value]
   *
   * @param playerId
   * @param command
   */
  private handleBotCommand(playerId: PlayerId, command: string): void {
    const addCommand = 'bot add ';
    const removeCommand = 'bot remove ';

    if (command.indexOf(addCommand) === 0) {
      const ip = command.substring(addCommand.length).trim();

      this.storage.ipWhiteList.add(ip);

      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Bot IP added.');

      return;
    }

    if (command.indexOf(removeCommand) === 0) {
      const ip = command.substring(removeCommand.length).trim();

      this.storage.ipWhiteList.delete(ip);

      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Bot IP removed.');
    }
  }

  /**
   * /server powerups <value>
   *
   * @param connectionId
   * @param command
   */
  private handlePowerupsSetupCommand(connectionId: ConnectionId, command: string): void {
    const value = parseFloat(command.substring(9));

    if (value >= 0 && value <= 1) {
      if (value < this.cfg.powerupSpawnChance) {
        this.emit(BROADCAST_CHAT_SERVER_PUBLIC, 'Powerups spawn chance decreased.');
      } else {
        this.emit(BROADCAST_CHAT_SERVER_PUBLIC, 'Powerups spawn chance increased.');
      }

      this.cfg.powerupSpawnChance = value;

      this.log.debug('Powerups spawn chance updated: %o', {
        chance: value,
      });
    } else {
      this.emit(RESPONSE_COMMAND_REPLY, connectionId, 'Invalid value. Allowed values: [0..1]');
    }
  }

  /**
   * /server upgrades <subcommand> [value]
   *
   * @param connectionId
   * @param playerId
   * @param command
   */
  private handleUpgradesSetupCommand(
    connectionId: ConnectionId,
    playerId: PlayerId,
    command: string
  ): void {
    if (command.indexOf('upgrades min') === 0 && command.length > 13) {
      const value = parseFloat(command.substring(13));

      if (value >= 0 && value < this.cfg.upgradesDropMaxChance) {
        if (value > this.cfg.upgradesDropMinChance) {
          this.emit(BROADCAST_CHAT_SERVER_PUBLIC, 'Upgrades drop chance increased.');
        } else {
          this.emit(BROADCAST_CHAT_SERVER_PUBLIC, 'Upgrades drop chance decreased.');
        }

        this.cfg.upgradesDropMinChance = value;

        this.log.debug('Upgrades drop min chance updated: %o', {
          chance: value,
        });
        this.emit(
          BROADCAST_CHAT_SERVER_WHISPER,
          playerId,
          `Drop chance updated: [${this.cfg.upgradesDropMinChance}, ${this.cfg.upgradesDropMaxChance}].`
        );
      } else {
        this.emit(
          RESPONSE_COMMAND_REPLY,
          connectionId,
          `Invalid value. Allowed values: [0..${this.cfg.upgradesDropMaxChance}).`
        );
      }

      return;
    }

    if (command.indexOf('upgrades max') === 0 && command.length > 13) {
      const value = parseFloat(command.substring(13));

      if (value > this.cfg.upgradesDropMinChance && value <= 1) {
        this.cfg.upgradesDropMaxChance = value;

        this.log.debug('Upgrades drop max chance updated: %o', { chance: value });
        this.emit(
          BROADCAST_CHAT_SERVER_WHISPER,
          playerId,
          `Drop chance updated: [${this.cfg.upgradesDropMinChance}, ${this.cfg.upgradesDropMaxChance}].`
        );
      } else {
        this.emit(
          RESPONSE_COMMAND_REPLY,
          connectionId,
          `Invalid value. Allowed values: (${this.cfg.upgradesDropMinChance}..1].`
        );
      }
    }
  }

  /**
   * /server welcome <subcommand> [value]
   *
   * @param playerId
   * @param command
   */
  private handleWelcomeCommand(playerId: PlayerId, command: string): void {
    const listCommand = 'welcome list';
    const flushCommand = 'welcome flush';
    const addCommand = 'welcome add ';
    const removeCommand = 'welcome remove ';

    if (command === listCommand) {
      if (this.cfg.welcomeMessages.length === 0) {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Welcome messages list is empty.');

        return;
      }

      for (let msgIndex = 0; msgIndex < this.cfg.welcomeMessages.length; msgIndex += 1) {
        const msg = this.cfg.welcomeMessages[msgIndex];

        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, `${msgIndex + 1}. ${msg}`);
      }

      return;
    }

    if (command === flushCommand) {
      const totalMessages = this.cfg.welcomeMessages.length;

      this.cfg.welcomeMessages = [];

      this.emit(
        BROADCAST_CHAT_SERVER_WHISPER,
        playerId,
        `Welcome messages list has been cleared (${totalMessages}).`
      );

      return;
    }

    if (command.indexOf(addCommand) === 0) {
      const msg = command.substring(addCommand.length);

      this.cfg.welcomeMessages.push(msg);

      this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Message added.');

      return;
    }

    if (command.indexOf(removeCommand) === 0) {
      const msgIndex = ~~command.substring(removeCommand.length) - 1;

      if (msgIndex > -1 && msgIndex < this.cfg.welcomeMessages.length) {
        this.cfg.welcomeMessages.splice(msgIndex, 1);

        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Message removed.');
      } else {
        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Invalid message index.');
      }
    }
  }

  /**
   * "/server" command handler.
   *
   * @param connectionId
   * @param command
   */
  onCommandReceived(connectionId: MainConnectionId, command = ''): void {
    const connection = this.storage.connectionList.get(connectionId);

    if (
      !this.storage.connectionList.has(connectionId) ||
      !this.helpers.isPlayerConnected(connection.playerId)
    ) {
      return;
    }

    const { playerId } = connection;
    const player = this.storage.playerList.get(connection.playerId);

    if (command === '') {
      this.responseServerAbout(playerId);

      return;
    }

    if (command === 'upgrades') {
      this.responseServerUpgrades(playerId);

      return;
    }

    if (command === 'powerups') {
      this.responseServerPowerups(playerId);

      return;
    }

    if (command === 'limits') {
      this.responsePlayerLimits(connection);

      return;
    }

    if (command === 'performance') {
      this.responseServerPerformance(playerId);

      return;
    }

    if (command === 'network') {
      this.responseServerNetwork(playerId);

      return;
    }

    if (command === 'frames') {
      this.responseServerFrames(playerId);

      return;
    }

    if (command === 'debug') {
      if (!player.su.current) {
        if (connection.limits.debug > LIMITS_DEBUG) {
          this.emit(RESPONSE_COMMAND_REPLY, connectionId, 'Too frequent requests.');

          return;
        }

        connection.limits.debug += LIMITS_DEBUG_WEIGHT;
      }

      this.responseServerDebug(playerId);

      return;
    }

    /**
     * Superuser commands.
     */
    if (player.su.current) {
      if (command === 'health') {
        this.broadcastServerHealth();

        return;
      }

      if (command === 'whitelist') {
        this.emit(
          BROADCAST_CHAT_SERVER_WHISPER,
          playerId,
          `Whitelist ${this.cfg.whitelist ? 'enabled' : 'disabled'}.`
        );

        return;
      }

      if (command === 'whitelist on' || command === 'whitelist true') {
        this.cfg.whitelist = true;

        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Whitelist turned on.');

        return;
      }

      if (command === 'whitelist off' || command === 'whitelist false') {
        this.cfg.whitelist = false;

        this.emit(BROADCAST_CHAT_SERVER_WHISPER, playerId, 'Whitelist turned off.');

        return;
      }

      if (command.indexOf('say ') === 0) {
        const text = command.substring('say '.length);

        this.emit(BROADCAST_CHAT_SERVER_PUBLIC, text);

        return;
      }

      if (command.indexOf('ban') === 0) {
        this.handleBanCommand(playerId, command);

        return;
      }

      if (command.indexOf('bot') === 0) {
        this.handleBotCommand(playerId, command);

        return;
      }

      if (command.indexOf('mute') === 0) {
        this.handleMuteCommand(connectionId, playerId, command);

        return;
      }

      if (command.indexOf('unmute') === 0) {
        this.handleUnmuteCommand(playerId, command);

        return;
      }

      if (command.indexOf('kick') === 0) {
        this.handleKickCommand(connectionId, playerId, command);

        return;
      }

      if (command.indexOf('powerups') === 0) {
        this.handlePowerupsSetupCommand(connectionId, command);

        return;
      }

      if (command.indexOf('upgrades') === 0) {
        this.handleUpgradesSetupCommand(connectionId, playerId, command);

        return;
      }

      if (command.indexOf('welcome') === 0) {
        this.handleWelcomeCommand(playerId, command);
      }
    }
  }
}
