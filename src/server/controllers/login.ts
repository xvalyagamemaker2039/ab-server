import { ClientPackets, FLAGS_ISO_TO_CODE } from '@airbattle/protocol';
import { PLAYERS_DEFAULT_FLAG } from '../../constants';
import {
  ERRORS_INCORRECT_PROTOCOL,
  ERRORS_INVALID_LOGIN_DATA,
  PLAYERS_CREATE,
  PLAYERS_KICK,
  ROUTE_LOGIN,
} from '../../events';
import { CHANNEL_CONNECT_PLAYER } from '../../events/channels';
import { has } from '../../support/objects';
import { MainConnectionId } from '../../types';
import { System } from '../system';

export default class LoginMessageHandler extends System {
  private readonly nonAsciiRegexp = new RegExp('[^\x20-\x7E]', 'g');

  private readonly repeatedWhiteSpacesRegexp = new RegExp('\\s{2,}', 'g');

  private readonly onlyWhiteSpacesRegexp = new RegExp('^\\s+$');

  private botsNamePrefixTesters: string[] = [];

  constructor({ app }) {
    super({ app });

    this.botsNamePrefixTesters = LoginMessageHandler.getBotsNamePrefixTesters(
      this.app.config.botsNamePrefix
    );

    this.listeners = {
      [ROUTE_LOGIN]: this.onLoginMessageReceived,
    };
  }

  private static getBotsNamePrefixTesters(prefix: string): string[] {
    if (prefix === '') {
      return [];
    }

    const testers = [prefix];

    if (prefix !== prefix.trim()) {
      testers.push(prefix.trim());
    }

    return testers;
  }

  private hasBotsNamePrefix(name: string): boolean {
    for (let testerIndex = 0; testerIndex < this.botsNamePrefixTesters.length; testerIndex += 1) {
      if (name.indexOf(this.botsNamePrefixTesters[testerIndex]) === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle `Login` request.
   *
   * @param connectionId player connection id
   * @param msg player packet
   */
  onLoginMessageReceived(connectionId: MainConnectionId, msg: ClientPackets.Login): void {
    const connection = this.storage.connectionList.get(connectionId);

    if (!this.storage.connectionList.has(connectionId) || connection.pending.login) {
      return;
    }

    connection.pending.login = true;
    clearTimeout(connection.timeouts.login);

    /**
     * Check if player has already logged in.
     */
    if (connection.playerId !== null) {
      this.log.info('Double login attempt. Connection refused: %o', {
        connection: connectionId,
      });

      this.emit(PLAYERS_KICK, connection.playerId);

      return;
    }

    /**
     * Mark connection as main.
     */
    connection.isMain = true;

    /**
     * Validation.
     */
    let userId = '';
    let { flag, name } = msg;

    if (msg.protocol !== 5) {
      this.emit(ERRORS_INCORRECT_PROTOCOL, connectionId);

      return;
    }

    /**
     * Session validation.
     */
    if (this.app.config.auth.active && msg.session !== 'none') {
      let validSessionData = true;

      try {
        const session = JSON.parse(msg.session);

        if (has(session, 'token')) {
          if (typeof session.token === 'string') {
            userId = this.helpers.getUserIdFromToken(session.token);

            if (userId.length === 0) {
              validSessionData = false;
            }
          } else {
            validSessionData = false;
          }
        }
      } catch (e) {
        validSessionData = false;
      }

      if (!validSessionData) {
        this.emit(ERRORS_INVALID_LOGIN_DATA, connectionId);

        return;
      }
    }

    /**
     * Username validation.
     */
    if (!this.app.config.allowNonAsciiUsernames) {
      name = name.replace(this.nonAsciiRegexp, '');
    }

    name = name.replace(this.repeatedWhiteSpacesRegexp, ' ').trim();

    if (
      name.length === 0 ||
      name.length > 20 ||
      this.onlyWhiteSpacesRegexp.test(name) ||
      (!connection.isBot && this.botsNamePrefixTesters.length !== 0 && this.hasBotsNamePrefix(name))
    ) {
      this.emit(ERRORS_INVALID_LOGIN_DATA, connectionId);

      return;
    }

    /**
     * Flag code validation.
     */
    if (has(FLAGS_ISO_TO_CODE, msg.flag.toUpperCase())) {
      flag = msg.flag.toUpperCase();
    } else {
      const country = this.app.geocoder.get(connection.ip);

      if (
        has(country, 'country') &&
        has(country.country, 'iso_code') &&
        has(FLAGS_ISO_TO_CODE, country.country.iso_code.toUpperCase())
      ) {
        flag = country.country.iso_code.toUpperCase();
      } else {
        flag = PLAYERS_DEFAULT_FLAG;
      }
    }

    this.channel(CHANNEL_CONNECT_PLAYER).delay(PLAYERS_CREATE, {
      connectionId,
      name,
      flag,
      horizon: {
        x: msg.horizonX,
        y: msg.horizonY,
      },
      userId,
    });
  }
}
