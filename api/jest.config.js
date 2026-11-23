// Pin Prisma's query engine to one worker thread so concurrency tests reproduce
// low-CPU CI runners on every machine. Must be set here, before Jest spawns workers.
process.env.TOKIO_WORKER_THREADS = '1'

/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  globals: {
    'ts-jest': {
      tsconfig: {
        module: 'commonjs',
      },
    },
  },
}

module.exports = config
