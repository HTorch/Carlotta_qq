const levelWeights = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function createLogger(level = 'info') {
  const currentWeight = levelWeights[level] ?? levelWeights.info;

  function shouldLog(targetLevel) {
    return (levelWeights[targetLevel] ?? levelWeights.info) <= currentWeight;
  }

  function log(targetLevel, ...args) {
    if (!shouldLog(targetLevel)) {
      return;
    }

    console[targetLevel === 'debug' ? 'log' : targetLevel](`[${targetLevel.toUpperCase()}]`, ...args);
  }

  return {
    error: (...args) => log('error', ...args),
    warn: (...args) => log('warn', ...args),
    info: (...args) => log('info', ...args),
    debug: (...args) => log('debug', ...args),
  };
}
