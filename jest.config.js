/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/**/*.test.ts'],
  clearMocks: true,
  // Several tests deliberately drive 401/403/409/500 error paths, which make the app's
  // real logger (and thus console.error/warn) fire as designed. That's expected noise,
  // not a test failure -- `silent` keeps it out of the terminal. It does not affect
  // Jest's own pass/fail reporting or assertion failure output.
  silent: true,
  setupFiles: ['./tests/env.setup.ts'],
  setupFilesAfterEnv: ['./tests/setup.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
};
