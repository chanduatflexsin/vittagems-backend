import { logger } from '../../src/utils/logger';

describe('logger', () => {
  it('exposes error/warn/info/http/debug methods that log at their console counterpart', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    logger.error('an error', { code: 'X' });
    logger.warn('a warning');
    logger.info('some info');
    logger.http('an http line');
    logger.debug('a debug line'); // LOG_LEVEL is 'error' in tests, so this should be suppressed

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[ERROR] an error');
    expect(errorSpy.mock.calls[0][0]).toContain('"code":"X"');

    // At LOG_LEVEL=error (0), warn/info/http/debug are all above threshold and suppressed.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
