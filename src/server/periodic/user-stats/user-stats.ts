import { existsSync, readFileSync, writeFile } from 'fs';
import { Worker } from 'worker_threads';
import { USER_STATS_SAVE_INTERVAL_SEC } from '../../../constants';
import {
  TIMELINE_BEFORE_GAME_START,
  TIMELINE_CLOCK_SECOND,
  USERS_WORKER_SAVE_STATS,
  USERS_WORKER_SAVE_STATS_RESPONSE,
} from '../../../events';
import { System } from '../../system';
import { stringifyUserStats } from './user-stats-serialize';

export default class UserStatsPeriodic extends System {
  private worker: Worker;

  private seconds = 0;

  private saveInProgress = false;

  private dataToSave = '';

  constructor({ app }) {
    super({ app });

    this.listeners = {
      [TIMELINE_BEFORE_GAME_START]: this.onBeforeGameStart,
      [TIMELINE_CLOCK_SECOND]: this.onSecondTick,
      [USERS_WORKER_SAVE_STATS_RESPONSE]: this.updateSavingStatus,
    };
  }

  onBeforeGameStart(): void {
    if (this.app.config.threads) {
      this.runWorker();
    }

    if (existsSync(this.app.config.userStats.path)) {
      this.load();
    } else {
      this.save();
    }
  }

  onSecondTick(): void {
    this.seconds += 1;

    if (this.seconds >= USER_STATS_SAVE_INTERVAL_SEC) {
      if (this.storage.users.hasChanges && !this.saveInProgress) {
        this.save();
      }

      this.seconds = 0;
    }
  }

  load(): void {
    try {
      const data = readFileSync(this.app.config.userStats.path);

      this.storage.users.list = new Map(JSON.parse(data.toString()));
    } catch (err) {
      this.log.error('Error while loading user stats: %o', { error: err.stack });
    }
  }

  /**
   * Initiate data saving task.
   */
  save(): void {
    this.saveInProgress = true;
    this.storage.users.hasChanges = false;

    if (this.app.config.threads) {
      this.worker.postMessage({
        event: USERS_WORKER_SAVE_STATS,
        args: [this.storage.users.list],
      });
    } else {
      this.serializeData();
    }
  }

  saveToFile(): void {
    writeFile(this.app.config.userStats.path, this.dataToSave, err => {
      if (err) {
        this.log.error('Error while saving user stats: %o', { error: err.stack });
      }

      this.dataToSave = '';
      this.saveInProgress = false;
    });
  }

  updateSavingStatus(saved: boolean): void {
    this.saveInProgress = !saved;
  }

  private serializeData(): void {
    let resultStatus = true;

    try {
      this.dataToSave = stringifyUserStats([...this.storage.users.list.entries()]);
    } catch (err) {
      this.log.error('Error while serialising user stats: %o', { error: err.stack });

      this.dataToSave = '';
      this.saveInProgress = false;
      resultStatus = false;
    }

    /**
     * Postpone the saving to file for a second.
     */
    if (resultStatus) {
      this.events.once(TIMELINE_CLOCK_SECOND, this.saveToFile, this);
    }
  }

  private runWorker(): void {
    this.worker = new Worker('./dist/server/periodic/user-stats/user-stats-worker.js', {
      workerData: {
        config: this.app.config,
      },
    });

    this.worker.on('exit', exitCode => {
      if (exitCode !== 0) {
        this.log.fatal('Accounts worker is down: %o', { exitCode });
        process.exit(exitCode);
      }
    });

    /**
     * Re-emit events from the worker.
     */
    this.worker.on('message', msg => {
      try {
        this.events.emit(msg.event, ...msg.args);
      } catch (err) {
        this.log.error('Error re-emitting event from the accounts worker: %o', {
          event: msg.event,
        });
      }
    });

    this.worker.on('online', () => {
      this.log.debug('Accounts worker started.');
    });

    this.worker.on('error', () => {
      this.log.error('Error starting accounts worker.');
    });
  }
}
