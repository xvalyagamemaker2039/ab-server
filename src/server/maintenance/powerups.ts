/* eslint-disable no-param-reassign */

import { GAME_TYPES, MOB_DESPAWN_TYPES, MOB_TYPES } from '@airbattle/protocol';
import { Circle } from 'collisions';
import {
  COLLISIONS_OBJECT_TYPES,
  MAP_SIZE,
  MS_PER_SEC,
  POWERUPS_COLLISIONS,
  POWERUPS_DEFAULT_DESPAWN_MS,
  POWERUPS_GRID_COLS,
  POWERUPS_GRID_POW,
  POWERUPS_GRID_ROWS,
  POWERUPS_RESPAWN_TIMEOUT_MS,
  POWERUPS_SPAWN_GUARANTEED_SEC,
} from '../../constants';
import {
  BROADCAST_MOB_DESPAWN,
  COLLISIONS_ADD_OBJECT,
  COLLISIONS_REMOVE_OBJECT,
  POWERUPS_DESPAWN,
  POWERUPS_DESPAWNED,
  POWERUPS_PICKED,
  POWERUPS_SPAWN,
  POWERUPS_SPAWN_BY_COORDS,
  TIMELINE_CLOCK_SECOND,
  TIMELINE_GAME_MATCH_START,
} from '../../events';
import { getRandomInt } from '../../support/numbers';
import { MobId, PlayerId, Powerup } from '../../types';
import Despawn from '../components/despawn';
import HitCircles from '../components/hit-circles';
import Hitbox from '../components/hitbox';
import Id from '../components/mob-id';
import MobType from '../components/mob-type';
import Owner from '../components/owner';
import Position from '../components/position';
import Rotation from '../components/rotation';
import Entity from '../entity';
import { System } from '../system';

export default class GamePowerups extends System {
  private chunkToCheck = 1;

  constructor({ app }) {
    super({ app });

    this.listeners = {
      [POWERUPS_DESPAWN]: this.onDespawnPowerup,
      [POWERUPS_PICKED]: this.onPowerupPickedup,
      [POWERUPS_SPAWN_BY_COORDS]: this.onCheckRandomSpawnByCoords,
      [POWERUPS_SPAWN]: this.onSpawnPowerup,
      [TIMELINE_CLOCK_SECOND]: this.spawnRandomPowerups,
      [TIMELINE_GAME_MATCH_START]: this.forceDespawnUpgrades,
    };
  }

  spawnRandomPowerups(): void {
    this.checkRandomSpawnInChunk(this.chunkToCheck);

    this.chunkToCheck += 1;

    if (this.chunkToCheck > 32) {
      this.chunkToCheck = 1;
    }
  }

  checkRandomSpawnInChunk(chunkId: number): void {
    if (this.app.config.powerupSpawnChance === 0 || !this.storage.powerupSpawns.has(chunkId)) {
      return;
    }

    const now = Date.now();
    const minToSpawn =
      POWERUPS_SPAWN_GUARANTEED_SEC -
      Math.ceil(this.app.config.powerupSpawnChance * POWERUPS_SPAWN_GUARANTEED_SEC);
    const chunk = this.storage.powerupSpawns.get(chunkId);

    if (chunk.spawned !== 0) {
      return;
    }

    if (chunk.last > now - POWERUPS_RESPAWN_TIMEOUT_MS) {
      return;
    }

    const timeDiff = Math.ceil((now - chunk.last - POWERUPS_RESPAWN_TIMEOUT_MS) / MS_PER_SEC);
    const rand = getRandomInt(timeDiff, POWERUPS_SPAWN_GUARANTEED_SEC);

    if (timeDiff >= POWERUPS_SPAWN_GUARANTEED_SEC || rand >= minToSpawn) {
      const zoneIndex = getRandomInt(0, chunk.zones.size);

      if (!chunk.zones.has(zoneIndex)) {
        return;
      }

      const [x, y] = chunk.zones.get(zoneIndex);
      const r = 32 - 22;

      let type: MOB_TYPES;

      if (this.app.config.server.typeId === GAME_TYPES.BTR) {
        type = MOB_TYPES.INFERNO;
      } else {
        type = getRandomInt(1, 10) <= 5 ? MOB_TYPES.INFERNO : MOB_TYPES.SHIELD;
      }

      this.onSpawnPowerup({
        mobId: this.helpers.createMobId(),
        type,
        posX: x + getRandomInt(-r, r),
        posY: y + getRandomInt(-r, r),
      });
    }
  }

  onCheckRandomSpawnByCoords(x: number, y: number): void {
    const hposX = (x >> POWERUPS_GRID_POW) + POWERUPS_GRID_COLS / 2;
    const hposY = (y >> POWERUPS_GRID_POW) + POWERUPS_GRID_ROWS / 2;
    const chunkIndex = hposY * POWERUPS_GRID_COLS + hposX + 1;

    this.checkRandomSpawnInChunk(chunkIndex);
  }

  /**
   * In fact, this method doesn't despawn upgrades right after calling.
   * An upgrade will despawn at the time when it should be shown on a player screen.
   */
  forceDespawnUpgrades(): void {
    const upgradesIterator = this.storage.upgradeIdList.values();
    let upgradeId: MobId = upgradesIterator.next().value;

    while (upgradeId !== undefined) {
      const upgrade = this.storage.mobList.get(upgradeId) as Powerup;

      upgrade.despawn.time = 0;
      upgradeId = upgradesIterator.next().value;
    }
  }

  onDespawnPowerup(mobId: MobId): void {
    const powerup = this.storage.mobList.get(mobId) as Powerup;

    this.emit(COLLISIONS_REMOVE_OBJECT, powerup.hitbox.current);
    this.emit(BROADCAST_MOB_DESPAWN, mobId, MOB_DESPAWN_TYPES.EXPIRED);

    if (powerup.mobtype.current === MOB_TYPES.UPGRADE) {
      this.storage.upgradeIdList.delete(mobId);
    } else {
      this.updateSpawnGrid(powerup.position.x, powerup.position.y);

      if (powerup.mobtype.current === MOB_TYPES.SHIELD) {
        this.storage.shieldIdList.delete(mobId);
      } else {
        this.storage.infernoIdList.delete(mobId);
      }
    }

    this.storage.mobList.delete(mobId);
    this.storage.mobIdList.delete(mobId);

    this.emit(POWERUPS_DESPAWNED, mobId);
  }

  onPowerupPickedup(mobId: MobId, pickupPlayerId?: PlayerId): void {
    const powerup = this.storage.mobList.get(mobId) as Powerup;

    this.emit(COLLISIONS_REMOVE_OBJECT, powerup.hitbox.current);

    if (pickupPlayerId) {
      this.emit(BROADCAST_MOB_DESPAWN, mobId, MOB_DESPAWN_TYPES.PICKUP, pickupPlayerId);
    }

    this.emit(BROADCAST_MOB_DESPAWN, mobId, MOB_DESPAWN_TYPES.EXPIRED, pickupPlayerId);

    if (powerup.mobtype.current === MOB_TYPES.UPGRADE) {
      this.storage.upgradeIdList.delete(mobId);
    } else {
      this.updateSpawnGrid(powerup.position.x, powerup.position.y);
      this.emit(POWERUPS_SPAWN_BY_COORDS, powerup.position.x, powerup.position.y);

      if (powerup.mobtype.current === MOB_TYPES.SHIELD) {
        this.storage.shieldIdList.delete(mobId);
      } else {
        this.storage.infernoIdList.delete(mobId);
      }
    }

    this.storage.mobList.delete(mobId);
    this.storage.mobIdList.delete(mobId);

    this.emit(POWERUPS_DESPAWNED, mobId);
  }

  onSpawnPowerup({ mobId, type, posX, posY, ownerId = null, permanent = false }): void {
    const now = Date.now();
    let collitionsType = COLLISIONS_OBJECT_TYPES.INFERNO;

    if (type === MOB_TYPES.UPGRADE) {
      collitionsType = COLLISIONS_OBJECT_TYPES.UPGRADE;
    } else if (type === MOB_TYPES.SHIELD) {
      collitionsType = COLLISIONS_OBJECT_TYPES.SHIELD;
    }

    const powerup: Powerup = new Entity().attach(
      new Despawn(now + POWERUPS_DEFAULT_DESPAWN_MS),
      new Hitbox(),
      new HitCircles([...POWERUPS_COLLISIONS[type]]),
      new Id(mobId),
      new MobType(type),
      new Position(posX, posY),
      new Rotation(0)
    );

    if (ownerId !== null && type === MOB_TYPES.UPGRADE) {
      powerup.attach(new Owner(ownerId));
    }

    if (permanent) {
      powerup.despawn.permanent = true;
    }

    /**
     * Hitbox init.
     */
    const hitboxCache = this.storage.powerupHitboxesCache[type];

    powerup.hitbox.width = hitboxCache.width;
    powerup.hitbox.height = hitboxCache.height;
    powerup.hitbox.x = ~~powerup.position.x + MAP_SIZE.HALF_WIDTH + hitboxCache.x;
    powerup.hitbox.y = ~~powerup.position.y + MAP_SIZE.HALF_HEIGHT + hitboxCache.y;

    // TL, TR, BR, BL.
    const hitbox = new Circle(
      powerup.hitbox.x - hitboxCache.x,
      powerup.hitbox.y - hitboxCache.y,
      hitboxCache.width / 2
    );

    hitbox.id = powerup.id.current;
    hitbox.type = collitionsType;
    hitbox.isCollideWithViewport = true;
    hitbox.isCollideWithPlayer = true;
    hitbox.isBox = true;
    powerup.hitbox.current = hitbox;

    this.emit(COLLISIONS_ADD_OBJECT, powerup.hitbox.current);

    /**
     * Fill grid data.
     */
    if (type !== MOB_TYPES.UPGRADE) {
      const hposX = (posX >> POWERUPS_GRID_POW) + POWERUPS_GRID_COLS / 2;
      const hposY = (posY >> POWERUPS_GRID_POW) + POWERUPS_GRID_ROWS / 2;
      const chunkIndex = hposY * POWERUPS_GRID_COLS + hposX + 1;

      const chunk = this.storage.powerupSpawns.get(chunkIndex);

      chunk.spawned += 1;
      chunk.last = now;
    }

    /**
     * Add to storages.
     */
    this.storage.mobList.set(mobId, powerup);

    if (type === MOB_TYPES.UPGRADE) {
      this.storage.upgradeIdList.add(mobId);
    } else if (type === MOB_TYPES.SHIELD) {
      this.storage.shieldIdList.add(mobId);
    } else {
      this.storage.infernoIdList.add(mobId);
    }
  }

  updateSpawnGrid(x: number, y: number): void {
    const hposX = (x >> POWERUPS_GRID_POW) + POWERUPS_GRID_COLS / 2;
    const hposY = (y >> POWERUPS_GRID_POW) + POWERUPS_GRID_ROWS / 2;
    const chunkIndex = hposY * POWERUPS_GRID_COLS + hposX + 1;

    const chunk = this.storage.powerupSpawns.get(chunkIndex);

    chunk.spawned -= 1;
  }
}
