import {
  CHAT_MESSAGE_PER_TICKS_LIMIT,
  CHAT_SAY_LIFETIME_MS,
  PLAYERS_ALIVE_STATUSES,
} from '../../constants';
import {
  BROADCAST_CHAT_PUBLIC,
  BROADCAST_CHAT_SAY,
  BROADCAST_CHAT_TEAM,
  BROADCAST_CHAT_WHISPER,
  CHAT_EMIT_DELAYED_EVENTS,
  CHAT_PUBLIC,
  CHAT_SAY,
  CHAT_TEAM,
  CHAT_WHISPER,
  RESPONSE_COMMAND_REPLY,
} from '../../events';
import { CHANNEL_CHAT } from '../../events/channels';
import { PlayerId } from '../../types';
import { System } from '../system';

export default class GameChat extends System {
  private framesPassed = 0;

  constructor({ app }) {
    super({ app });

    this.listeners = {
      // Channels
      [CHAT_EMIT_DELAYED_EVENTS]: this.onHandleChatMessages,

      // Events
      [CHAT_PUBLIC]: this.onChatPublic,
      [CHAT_SAY]: this.onChatSay,
      [CHAT_TEAM]: this.onChatTeam,
      [CHAT_WHISPER]: this.onChatWhisper,
    };
  }

  onHandleChatMessages(): void {
    this.framesPassed += 1;

    if (this.framesPassed < CHAT_MESSAGE_PER_TICKS_LIMIT) {
      return;
    }

    this.channel(CHANNEL_CHAT).emitFirstDelayed();
    this.framesPassed = 0;
  }

  onChatPublic(playerId: PlayerId, msg: string): void {
    if (!this.helpers.isPlayerConnected(playerId)) {
      return;
    }

    this.emit(BROADCAST_CHAT_PUBLIC, playerId, msg);
  }

  onChatSay(playerId: PlayerId, msg: string): void {
    if (!this.helpers.isPlayerConnected(playerId)) {
      return;
    }

    const player = this.storage.playerList.get(playerId);

    if (
      !player.planestate.stealthed &&
      player.alivestatus.current === PLAYERS_ALIVE_STATUSES.ALIVE
    ) {
      player.say.text = msg;
      player.say.createdAt = Date.now();
      this.storage.playerIdSayBroadcastList.add(playerId);

      clearTimeout(player.say.resetTimeout);

      player.say.resetTimeout = setTimeout(() => {
        this.storage.playerIdSayBroadcastList.delete(playerId);
      }, CHAT_SAY_LIFETIME_MS);

      this.emit(BROADCAST_CHAT_SAY, playerId, msg);
    } else {
      this.emit(
        RESPONSE_COMMAND_REPLY,
        this.storage.playerMainConnectionList.get(playerId),
        'You have to be visible to use "/s".'
      );
    }
  }

  onChatTeam(playerId: PlayerId, msg: string): void {
    if (!this.helpers.isPlayerConnected(playerId)) {
      return;
    }

    this.emit(BROADCAST_CHAT_TEAM, playerId, msg);
  }

  onChatWhisper(playerId: PlayerId, receiverId: PlayerId, msg: string): void {
    if (!this.helpers.isPlayerConnected(playerId) || !this.helpers.isPlayerConnected(receiverId)) {
      return;
    }

    this.emit(BROADCAST_CHAT_WHISPER, playerId, receiverId, msg);
  }
}
