// tests/setup.ts (loaded via env.setup.ts as a `setupFiles` entry) fixes LOG_LEVEL=error
// for the whole suite, which only ever exercises the `error` branch of logger.ts.
// This file reloads config/env + utils/logger in isolation with a higher LOG_LEVEL
// so every level's console call gets covered too.
describe('logger at LOG_LEVEL=debug', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    jest.resetModules();
  });

  it('logs at every level once currentLevel allows it', () => {
    jest.resetModules();
    process.env.LOG_LEVEL = 'debug';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logger } = require('../../src/utils/logger');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    logger.warn('a warning');
    logger.info('some info');
    logger.http('an http line');
    logger.debug('a debug line');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
