import {
  PLAYERS_HEALTH,
  PROJECTILES_EXTRA_SPEED_TO_DAMAGE_FACTOR,
  PROJECTILES_SPECS,
  SHIPS_SPECS,
  UPGRADES_SPECS,
} from '../../../constants';
import { BROADCAST_EVENT_STEALTH, BROADCAST_PLAYER_UPDATE, PLAYERS_HIT } from '../../../events';
import { MobId, PlayerId, Projectile } from '../../../types';
import { System } from '../../system';

export default class GamePlayersHit extends System {
  constructor({ app }) {
    super({ app });

    this.listeners = {
      [PLAYERS_HIT]: this.onHitPlayer,
    };
  }

  /**
   * Hit the player.
   *
   * @param victimId
   * @param projectileId
   * @param firewallDamage used if projectileId is zero
   */
  onHitPlayer(victimId: PlayerId, projectileId: MobId, firewallDamage: number): void {
    /**
     * Check current game status.
     */
    if (!this.storage.gameEntity.match.isActive) {
      return;
    }

    const now = Date.now();
    const victim = this.storage.playerList.get(victimId);
    let damage: number;

    if (victim.planestate.stealthed) {
      victim.planestate.stealthed = false;
      victim.times.lastStealth = now;

      this.delay(BROADCAST_EVENT_STEALTH, victim.id.current);
      this.delay(BROADCAST_PLAYER_UPDATE, victim.id.current);
    }

    if (projectileId === 0) {
      /**
       * Projectile zero is the BTR firewall
       */
      damage = firewallDamage;
    } else {
      if (victim.shield.current) {
        return;
      }

      victim.times.lastHit = now;
      victim.damage.hitsReceived += 1;

      const projectile = this.storage.mobList.get(projectileId) as Projectile;
      const scalar =
        projectile.velocity.x * victim.velocity.x + projectile.velocity.y * victim.velocity.y;
      const { maxSpeed } = PROJECTILES_SPECS[projectile.mobtype.current];

      damage = PROJECTILES_SPECS[projectile.mobtype.current].damage;
      let extraDamageFactor = 1;

      /**
       * Projectile upgrades increase the damage.
       */
      if (projectile.velocity.length > maxSpeed) {
        const extraSpeed = projectile.velocity.length - maxSpeed;

        extraDamageFactor += extraSpeed * PROJECTILES_EXTRA_SPEED_TO_DAMAGE_FACTOR;
      }

      /**
       * Damage increases or decreases depending on the collision speed.
       */
      {
        /**
         * 0.25 — max upgrade factor.
         */
        const maxExtraSpeed = maxSpeed * 0.25 * 2;
        let extraSpeed = -scalar / projectile.velocity.length;

        if (Math.abs(extraSpeed) > maxExtraSpeed) {
          extraSpeed = Math.sign(extraSpeed) * maxExtraSpeed;
        }

        extraDamageFactor += extraSpeed * PROJECTILES_EXTRA_SPEED_TO_DAMAGE_FACTOR;
      }

      damage *= extraDamageFactor;

      /**
       * Extra damage by repel.
       */
      if (projectile.damage.double) {
        damage *= 2;
      }

      /**
       * Tracking projectile owner damage.
       */
      if (this.helpers.isPlayerConnected(projectile.owner.current)) {
        const owner = this.storage.playerList.get(projectile.owner.current);
        const trackingDamage = Math.round(
          PROJECTILES_SPECS[projectile.mobtype.current].damage * 100
        );

        owner.damage.current += trackingDamage;
        owner.damage.hits += 1;

        if (this.storage.botIdList.has(victimId)) {
          owner.damage.bots += trackingDamage;
          owner.damage.hitsToBots += 1;
        }

        if (this.storage.botIdList.has(projectile.owner.current)) {
          victim.damage.hitsByBots += 1;
        }
      }
    }

    /**
     * Health value refers to Goliath health 1 (max among the airplanes).
     * Goliath = 1 / 1 = 1;
     * Predator = 1 / 2 = 0.5;
     * etc.
     */
    const fullAirplaneHealth =
      (1 / SHIPS_SPECS[victim.planetype.current].damageFactor) *
      UPGRADES_SPECS.DEFENSE.factor[victim.upgrades.defense];

    victim.health.current = fullAirplaneHealth * victim.health.current - damage;

    if (victim.health.current < PLAYERS_HEALTH.MIN) {
      /**
       * Player is dead.
       */
      victim.health.current = PLAYERS_HEALTH.MIN;
    } else {
      /**
       * % of the full health.
       */
      victim.health.current /= fullAirplaneHealth;
    }
  }
}
