import { promises as fs } from 'fs';
import { join as joinPath } from 'path';
import querystring from 'querystring';
import fastJson from 'fast-json-stringify';
import { GAME_TYPES } from '@airbattle/protocol';
import { HttpResponse, TemplatedApp } from 'uWebSockets.js';
import { GameServerConfigInterface } from '../../config';
import { CHAT_SUPERUSER_MUTE_TIME_MS, CONNECTIONS_SUPERUSER_BAN_MS } from '../../constants';
import {
  CHAT_MUTE_BY_IP,
  CHAT_UNMUTE_BY_IP,
  CONNECTIONS_BAN_IP,
  CTF_REMOVE_PLAYER_FROM_LEADER,
  PLAYERS_KICK,
  WS_WORKER_GET_PLAYER,
  WS_WORKER_GET_PLAYERS_LIST,
  WS_WORKER_GET_PLAYERS_LIST_RESPONSE,
  WS_WORKER_GET_PLAYER_RESPONSE,
} from '../../events';
import { AdminActionPlayer, AdminPlayersListItem } from '../../types';
import { Hub, hub } from '../../workers/events-hub';
import Log from '../../workers/logger';
import GameServerBootstrap from '../../core/bootstrap';

const { readFile, readdir } = fs;

const readRequest = (res: HttpResponse, cb: Function, errCb: () => void): void => {
  let buffer = Buffer.alloc(0);

  res.onAborted(errCb);

  res.onData((ab, isLast) => {
    buffer = Buffer.concat([buffer, Buffer.from(ab)]);

    if (isLast) {
      try {
        cb(buffer.toString());
      } catch (err) {
        this.log.error('Reading request error: %o', { error: err.stack });
        res.close();
      }
    }
  });
};

const stringifyPlayers = fastJson({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: {
        type: 'number',
      },
      name: {
        type: 'string',
      },
      captures: {
        type: 'number',
      },
      spectate: {
        type: 'number',
      },
      kills: {
        type: 'number',
      },
      deaths: {
        type: 'number',
      },
      score: {
        type: 'number',
      },
      lastMove: {
        type: 'number',
      },
      ping: {
        type: 'number',
      },
      flag: {
        type: 'string',
      },
      isMuted: {
        type: 'boolean',
      },
      isBot: {
        type: 'boolean',
      },
    },
  },
});

class Admin {
  private config: GameServerConfigInterface;

  private moderatorActions: string[] = [];

  private log: any;

  private app: GameServerBootstrap;

  constructor(config: GameServerConfigInterface, app?: GameServerBootstrap) {
    this.config = config;

    if (config.threads) {
      this.log = Log;
    } else {
      this.app = app;
      this.log = app.log;
    }
  }

  bindRoutes(uws: TemplatedApp): void {
    if (this.config.admin.active) {
      const adminRoute = this.config.admin.route;

      uws
        .get(`/${adminRoute}/server`, res => {
          res.writeHeader('Content-type', 'application/json');
          res.end(`{"type":${this.config.server.typeId}}`);
        })

        .get(`/${adminRoute}/actions`, res => {
          res.writeHeader('Content-type', 'application/json');
          res.end(`[${this.moderatorActions.join(',\n')}]`);
        })

        .post(`/${adminRoute}/actions`, res => {
          readRequest(
            res,
            (requestData: string) => {
              this.onActionsPost(res, requestData);
            },
            () => {
              this.log.error('Failed to parse /actions POST.');
            }
          );
        })

        .get(`/${adminRoute}/players`, async res => {
          res.aborted = false;

          res.onAborted(() => {
            res.aborted = true;
          });

          const playersList: AdminPlayersListItem[] = await new Promise(resolve => {
            if (this.config.threads) {
              hub.events.once(WS_WORKER_GET_PLAYERS_LIST_RESPONSE, (playersData: any) => {
                resolve(playersData);
              });

              Hub.emitToMain(WS_WORKER_GET_PLAYERS_LIST);
            } else {
              this.app.events.once(WS_WORKER_GET_PLAYERS_LIST_RESPONSE, (playersData: any) => {
                resolve(playersData);
              });

              this.app.events.emit(WS_WORKER_GET_PLAYERS_LIST);
            }
          });

          if (!res.aborted) {
            res.writeHeader('Content-type', 'application/json');
            res.end(stringifyPlayers(playersList));
          }
        })

        .get(`/${adminRoute}/`, async res => {
          res.aborted = false;

          res.onAborted(() => {
            res.aborted = true;
          });

          try {
            const adminHtml = await readFile(this.config.admin.htmlPath);

            if (!res.aborted) {
              res.writeHeader('Content-type', 'text/html');
              res.end(adminHtml);
            }
          } catch (err) {
            if (!res.aborted) {
              res.writeStatus('503 Service Unavailable').end('');
            }

            this.log.error('Error reading admin html: %o', { error: err.stack });
          }
        });

      if (this.config.server.typeId === GAME_TYPES.CTF) {
        if (this.config.ctfSaveMatchesResults) {
          const matchesDir = joinPath(this.config.cache.path, 'matches');

          /**
           * Get the list of the matches history records.
           */
          uws
            .post(`/${adminRoute}/matches`, async res => {
              res.aborted = false;

              res.onAborted(() => {
                res.aborted = true;
              });

              readRequest(
                res,
                async (requestData: string) => {
                  const isAuth = await this.isModAuthorized(requestData);

                  if (isAuth === true) {
                    try {
                      const files = JSON.stringify(await readdir(matchesDir));

                      if (!res.aborted) {
                        res.writeHeader('Content-type', 'application/json');
                        res.end(files);
                      }
                    } catch (err) {
                      if (!res.aborted) {
                        res.writeStatus('500 Internal Server Error').end('');
                      }

                      this.log.error('Error while reading directory: %o', {
                        dir: matchesDir,
                        error: err.stack,
                      });
                    }
                  } else if (!res.aborted) {
                    res.writeStatus('403 Forbidden').end('');
                  }
                },
                () => {
                  this.log.error('failed to parse /matches POST.');
                }
              );
            })

            /**
             * Get the match record.
             * Temporary route.
             */
            .post(`/${adminRoute}/matches/:timestamp`, async (res, req) => {
              res.aborted = false;

              res.onAborted(() => {
                res.aborted = true;
              });

              const timestamp = parseInt(req.getParameter(0), 10);

              readRequest(
                res,
                async (requestData: string) => {
                  const isAuth = await this.isModAuthorized(requestData);

                  if (isAuth === true) {
                    try {
                      const content = await readFile(joinPath(matchesDir, `${timestamp}.json`));

                      if (!res.aborted) {
                        res.writeHeader('Content-type', 'application/json');
                        res.end(content);
                      }
                    } catch (err) {
                      if (!res.aborted) {
                        res.writeStatus('404 Not Found').end('');
                      }

                      this.log.error('Error while reading file: %o', {
                        file: `${matchesDir}${timestamp}.json`,
                        error: err.stack,
                      });
                    }
                  } else if (!res.aborted) {
                    res.writeStatus('403 Forbidden').end('');
                  }
                },
                () => {
                  this.log.error('failed to parse /matches/:timestamp POST');
                }
              );
            });
        }
      }
    }
  }

  protected async getModeratorByPassword(password: string): Promise<string | boolean> {
    if (typeof password === 'undefined') {
      return false;
    }

    let file = null;

    try {
      file = await readFile(this.config.admin.passwordsPath);
    } catch (err) {
      this.log.error('Cannot read mod passwords: %o', { error: err.stack });

      return false;
    }

    const lines = file.toString().split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (line.indexOf(':') !== -1) {
        const [name, test] = line.split(':');

        if (test === password) {
          return name;
        }
      }
    }

    this.log.error('Failed mod password attempt: %o', { password });

    return false;
  }

  protected async isModAuthorized(requestData: string): Promise<boolean> {
    const params = querystring.parse(requestData);
    const mod = await this.getModeratorByPassword(params.password as string);

    return mod !== false;
  }

  protected async onActionsPost(res: HttpResponse, requestData: string): Promise<void> {
    res.aborted = false;

    res.onAborted(() => {
      res.aborted = true;
    });

    const params = querystring.parse(requestData);
    const mod = await this.getModeratorByPassword(params.password as string);

    if (mod === false) {
      if (!res.aborted) {
        res.end('Invalid password');
      }

      return;
    }

    const playerId = parseInt(params.playerid as string, 10);

    const player: AdminActionPlayer = await new Promise(resolve => {
      if (this.config.threads) {
        hub.events.once(WS_WORKER_GET_PLAYER_RESPONSE, (playerData: any) => {
          resolve(playerData);
        });

        Hub.emitToMain(WS_WORKER_GET_PLAYER, playerId);
      } else {
        this.app.events.once(WS_WORKER_GET_PLAYER_RESPONSE, (playerData: any) => {
          resolve(playerData);
        });

        this.app.events.emit(WS_WORKER_GET_PLAYER, playerId);
      }
    });

    if (player === null) {
      if (!res.aborted) {
        res.end('Invalid player');
      }

      return;
    }

    let isValidAction = true;

    switch (params.action) {
      case 'Mute':
        if (this.config.threads) {
          Hub.emitToMain(CHAT_MUTE_BY_IP, player.ip, CHAT_SUPERUSER_MUTE_TIME_MS);
        } else {
          this.app.events.emit(CHAT_MUTE_BY_IP, player.ip, CHAT_SUPERUSER_MUTE_TIME_MS);
        }

        break;

      case 'Unmute':
        if (this.config.threads) {
          Hub.emitToMain(CHAT_UNMUTE_BY_IP, player.ip);
        } else {
          this.app.events.emit(CHAT_UNMUTE_BY_IP, player.ip);
        }

        break;

      case 'Dismiss':
        if (this.config.threads) {
          Hub.emitToMain(CTF_REMOVE_PLAYER_FROM_LEADER, playerId);
        } else {
          this.app.events.emit(CTF_REMOVE_PLAYER_FROM_LEADER, playerId);
        }

        break;

      case 'Kick':
        if (this.config.threads) {
          Hub.emitToMain(PLAYERS_KICK, playerId);
        } else {
          this.app.events.emit(PLAYERS_KICK, playerId);
        }

        break;

      case 'Ban':
        if (this.config.threads) {
          Hub.emitToMain(
            CONNECTIONS_BAN_IP,
            player.ip,
            CONNECTIONS_SUPERUSER_BAN_MS,
            `${mod}: ${params.reason}`
          );

          Hub.emitToMain(PLAYERS_KICK, playerId);
        } else {
          this.app.events.emit(
            CONNECTIONS_BAN_IP,
            player.ip,
            CONNECTIONS_SUPERUSER_BAN_MS,
            `${mod}: ${params.reason}`
          );

          this.app.events.emit(PLAYERS_KICK, playerId);
        }

        break;

      default:
        isValidAction = false;
    }

    if (!isValidAction) {
      if (!res.aborted) {
        res.end('Invalid action');
      }

      return;
    }

    this.logModeratorAction(
      mod as string,
      params.action as string,
      params.reason as string,
      player
    );

    this.moderatorActions.push(
      JSON.stringify({
        date: Date.now(),
        who: mod,
        action: params.action,
        victim: player.name,
        reason: params.reason,
      })
    );

    while (this.moderatorActions.length > 100) {
      this.moderatorActions.shift();
    }

    if (!res.aborted) {
      res.end('OK');
    }
  }

  private logModeratorAction(
    moderator: string,
    action: string,
    reason: string,
    player: AdminActionPlayer
  ): void {
    this.log.info('Moderator action: %o', {
      moderator,
      action,
      reason,
      playerId: player.id,
      ip: player.ip,
      name: player.name,
    });
  }
}

export default Admin;
