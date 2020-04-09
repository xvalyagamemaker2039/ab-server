import { GAME_TYPES } from '@airbattle/protocol';
import { SpawnZonesTemplate } from '../types';
import { BTR_SPAWN_MATCH_START, BTR_SPAWN_WAITING } from './btr';
import { FFA_SPAWN_EUROPE } from './ffa';

export const PLAYERS_SPAWN_ZONES: SpawnZonesTemplate = {
  [GAME_TYPES.FFA]: [FFA_SPAWN_EUROPE],
  [GAME_TYPES.BTR]: [BTR_SPAWN_WAITING, BTR_SPAWN_MATCH_START],
};
