import fs from 'node:fs';
import path from 'node:path';

import { ChatService } from './chat-service.js';
import { CronScheduler } from './cron-scheduler.js';
import { GroupStateStore } from './group-state-store.js';
import { GroupPromptRegistry } from './group-prompt-registry.js';
import { IgnoredUserRegistry } from './ignored-user-registry.js';

const HOT_RELOAD_DELAY_MS = 300;
const HOT_RELOAD_POLL_INTERVAL_MS = 1000;

function importFresh(relativePath, stamp) {
  const url = new URL(relativePath, import.meta.url);
  url.searchParams.set('t', String(stamp));
  return import(url.href);
}

export class HotRuntime {
  constructor({ apiClient, logger, rootDir, fsModule = fs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, cronSetTimer = setTimeout, cronClearTimer = clearTimeout }) {
    this.apiClient = apiClient;
    this.logger = logger;
    this.rootDir = rootDir;
    this.fs = fsModule;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.runtime = null;
    this.stateStore = null;
    this.chatService = new ChatService();
    this.roleStore = null;
    this.promptRegistry = new GroupPromptRegistry({
      filePath: path.join(rootDir, 'config', 'group-prompts.json'),
    });
    this.ignoredUserRegistry = new IgnoredUserRegistry({
      filePath: path.join(rootDir, 'config', 'ignored-users.json'),
    });
    this.runtimeControl = {
      enabled: true,
      isEnabled: () => this.runtimeControl.enabled,
      enable: () => {
        this.runtimeControl.enabled = true;
      },
      disable: () => {
        this.runtimeControl.enabled = false;
      },
    };
    this.cronScheduler = new CronScheduler({
      filePath: path.join(rootDir, 'config', 'cron-reminders.json'),
      apiClient: this.apiClient,
      runtimeControl: this.runtimeControl,
      logger: this.logger,
      setTimer: cronSetTimer,
      clearTimer: cronClearTimer,
    });
    this.watchers = [];
    this.reloadTimer = null;
    this.reloadSequence = 0;
    this.stopped = false;
  }

  async initialize() {
    await this.promptRegistry.initialize();
    const ignoredUsersLoad = await this.ignoredUserRegistry.initialize();
    if (!ignoredUsersLoad.ok) {
      this.logger.error('Ignored user reload failed:', ignoredUsersLoad.error?.message ?? ignoredUsersLoad.error);
    }
    const cronLoad = await this.cronScheduler.initialize();
    if (!cronLoad.ok) {
      this.logger.error('Cron reminder reload failed:', cronLoad.error?.message ?? cronLoad.error);
    }
    if (this.stopped) {
      this.cronScheduler.stop();
      return;
    }
    await this.reload('startup');
    if (!this.stopped) {
      this.startWatching();
    }
  }

  async handleGroupMessage(event) {
    if (!this.runtime) {
      this.logger.warn('Hot runtime is not ready yet; dropping group message event.');
      return;
    }

    await this.runtime.messageEngine.handleGroupMessage(event);
  }

  async reload(reason) {
    if (this.stopped) {
      return;
    }

    const stamp = `${Date.now()}-${++this.reloadSequence}`;
    const [configMod, ruleMod, actionMod, messageEngineMod, img2ServiceMod, img2ClientMod] = await Promise.all([
      importFresh('./config.js', stamp),
      importFresh('./rule-registry.js', stamp),
      importFresh('./action-registry.js', stamp),
      importFresh('./message-engine.js', stamp),
      importFresh('./img2-service.js', stamp),
      importFresh('./img2-client.js', stamp),
    ]);

    const config = configMod.loadConfig();
    const promptReload = await this.promptRegistry.reloadFromDisk();
    if (!promptReload.ok) {
      this.logger.error(`Group prompt reload failed (${reason}):`, promptReload.error?.message ?? promptReload.error);
    }
    const ruleRegistry = new ruleMod.RuleRegistry(config.groupRules, config.defaultRule);
    this.roleStore ??= messageEngineMod.createSharedRoleStore();
    const actionRegistry = new actionMod.ActionRegistry();
    const normalizedGroupDefaults = ruleRegistry.getGroupDefaults();
    const candidateStateStore = this.stateStore ?? new GroupStateStore({
      groupDefaults: normalizedGroupDefaults,
    });
    const messageEngine = new messageEngineMod.MessageEngine({
      apiClient: this.apiClient,
      ruleRegistry,
      stateStore: candidateStateStore,
      actionRegistry,
      logger: this.logger,
      dependencyOverrides: {
        chatService: this.chatService,
        promptRegistry: this.promptRegistry,
        ignoredUserRegistry: this.ignoredUserRegistry,
        roleStore: this.roleStore,
        cronScheduler: this.cronScheduler,
        runtimeControl: this.runtimeControl,
        img2Service: {
          ...img2ServiceMod,
          generateImg2: (args) => img2ServiceMod.generateImg2({
            ...args,
            dependencyOverrides: {
              requestLumioImage: img2ClientMod.requestLumioImage,
            },
          }),
        },
      },
    });

    if (this.stateStore) {
      const previousDefaults = this.stateStore.getGroupDefaultsSnapshot();
      try {
        this.stateStore.replaceGroupDefaults(normalizedGroupDefaults);
      } catch (error) {
        this.stateStore.replaceGroupDefaults(previousDefaults);
        throw error;
      }
    }

    this.stateStore = candidateStateStore;
    this.runtime = {
      config,
      ruleRegistry,
      actionRegistry,
      messageEngine,
      chatService: this.chatService,
      loadedAt: new Date().toISOString(),
    };

    this.logger.info(`Hot runtime reloaded: ${reason}`);
  }

  startWatching() {
    if (this.stopped || this.watchers.length > 0) {
      return;
    }

    const watchedPaths = [
      path.join(this.rootDir, 'src', 'config.js'),
      path.join(this.rootDir, 'src', 'img2-service.js'),
      path.join(this.rootDir, 'src', 'img2-client.js'),
      path.join(this.rootDir, 'src', 'rule-registry.js'),
      path.join(this.rootDir, 'src', 'action-registry.js'),
      path.join(this.rootDir, 'src', 'message-engine.js'),
      path.join(this.rootDir, 'src', 'actions'),
      path.join(this.rootDir, 'config', 'group-rules.json'),
      path.join(this.rootDir, 'config'),
    ];

    const scheduleReload = (reason) => {
      if (this.stopped) {
        return;
      }

      if (this.reloadTimer) {
        this.clearTimeoutFn(this.reloadTimer);
      }

      this.reloadTimer = this.setTimeoutFn(() => {
        this.reloadTimer = null;
        if (this.stopped) {
          return;
        }

        this.reload(reason).catch((error) => {
          this.logger.error(`Hot runtime reload failed (${reason}):`, error.message);
        });
      }, HOT_RELOAD_DELAY_MS);
    };

    for (const watchedPath of watchedPaths) {
      try {
        const stat = this.fs.statSync(watchedPath);
        if (stat.isDirectory()) {
          const listener = () => {
            scheduleReload(`dir-changed:${path.basename(watchedPath)}`);
          };
          this.fs.watchFile(watchedPath, { interval: HOT_RELOAD_POLL_INTERVAL_MS }, listener);
          this.watchers.push({ type: 'watchFile', target: watchedPath, listener });
          continue;
        }

        const listener = (current, previous) => {
          if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
            scheduleReload(`file-changed:${path.basename(watchedPath)}`);
          }
        };
        this.fs.watchFile(watchedPath, { interval: HOT_RELOAD_POLL_INTERVAL_MS }, listener);
        this.watchers.push({ type: 'watchFile', target: watchedPath, listener });
      } catch (error) {
        this.logger.warn(`Hot runtime watch skipped for ${watchedPath}: ${error.message}`);
      }
    }
  }

  stop() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    if (this.reloadTimer) {
      this.clearTimeoutFn(this.reloadTimer);
      this.reloadTimer = null;
    }
    for (const watcher of this.watchers) {
      try {
        this.fs.unwatchFile(watcher.target, watcher.listener);
      } catch (error) {
        this.logger.warn(`Hot runtime watch cleanup failed for ${watcher.target}: ${error.message}`);
      }
    }
    this.watchers = [];
    this.cronScheduler.apiClient = null;
    this.cronScheduler.stop();
  }
}
