import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { OneBotClient } from './onebot-client.js';
import { loadConfig } from './config.js';
import { HotRuntime } from './hot-runtime.js';
import { BotRuntimeBusyError, claimBotRuntime } from './runtime-state.js';

let releaseRuntime = () => {};

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

  process.once('exit', releaseRuntime);
  process.once('SIGINT', () => {
    releaseRuntime();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    releaseRuntime();
    process.exit(143);
  });

  try {
    const apiClient = new OneBotClient({
      eventUrl: config.napcat.eventUrl,
      apiUrl: config.napcat.apiUrl,
      accessToken: config.napcat.accessToken,
      logger,
    });
    const hotRuntime = new HotRuntime({ apiClient, logger, rootDir });

    await apiClient.connect();
    await hotRuntime.initialize();
    apiClient.onGroupMessage((event) => hotRuntime.handleGroupMessage(event));
    await apiClient.startHistoryPolling();

    logger.info('Public bot is running');
  } catch (error) {
    releaseRuntime();
    throw error;
  }
}

main().catch((error) => {
  if (error instanceof BotRuntimeBusyError) {
    console.warn('[WARN] Bot runtime lock is already held:', JSON.stringify(error.details ?? {}));
    process.exitCode = 1;
    return;
  }

  releaseRuntime();

  console.error('[FATAL]', error);
  process.exitCode = 1;
});
