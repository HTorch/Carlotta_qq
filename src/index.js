import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { OneBotClient } from './onebot-client.js';
import { loadConfig } from './config.js';
import { HotRuntime } from './hot-runtime.js';
import { BotRuntimeBusyError, claimBotRuntime } from './runtime-state.js';

let releaseRuntime = () => {};
let shutdownRuntime = () => {};

function installSignalHandlers() {
  process.once('exit', () => shutdownRuntime());
  process.once('SIGINT', () => {
    shutdownRuntime();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    shutdownRuntime();
    process.exit(143);
  });
}

export function createShutdown({ getApiClient, getHotRuntime, releaseRuntime: release, onError = () => {} }) {
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }

    stopped = true;
    for (const cleanup of [
      () => getHotRuntime()?.stop?.(),
      () => getApiClient()?.stop?.(),
      release,
    ]) {
      try {
        cleanup();
      } catch (error) {
        onError(error);
      }
    }
  };
}

async function main() {
  const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runtimeOwner = process.platform === 'win32' ? 'windows' : 'linux';
  const runtime = await claimBotRuntime({
    rootDir,
    owner: runtimeOwner,
  });
  let runtimeReleased = false;

  releaseRuntime = () => {
    if (runtimeReleased) {
      return;
    }

    runtimeReleased = true;
    runtime.releaseSync();
  };

  let apiClient = null;
  let hotRuntime = null;
  const shutdown = createShutdown({
    getApiClient: () => apiClient,
    getHotRuntime: () => hotRuntime,
    releaseRuntime,
    onError: (error) => logger.error('Shutdown cleanup failed:', error.message),
  });
  shutdownRuntime = shutdown;

  try {
    apiClient = new OneBotClient({
      eventUrl: config.napcat.eventUrl,
      apiUrl: config.napcat.apiUrl,
      accessToken: config.napcat.accessToken,
      autoReconnect: config.napcat.autoReconnect,
      logger,
    });
    hotRuntime = new HotRuntime({ apiClient, logger, rootDir });

    await apiClient.connect();
    await hotRuntime.initialize();
    apiClient.onGroupMessage((event) => hotRuntime.handleGroupMessage(event));
    await apiClient.startHistoryPolling();

    logger.info('Public bot is running');
  } catch (error) {
    shutdown();
    throw error;
  }
}

function handleMainError(error) {
  if (error instanceof BotRuntimeBusyError) {
    console.warn('[WARN] Bot runtime lock is already held:', JSON.stringify(error.details ?? {}));
    process.exitCode = 1;
    return;
  }

  shutdownRuntime();

  console.error('[FATAL]', error);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalHandlers();
  main().catch(handleMainError);
}
