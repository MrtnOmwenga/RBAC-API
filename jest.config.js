/** Unit tests run without a database; e2e tests get a real PostgreSQL (see test/global-setup.ts). */
const { existsSync } = require('node:fs');

// Rootless Podman instead of Docker: point Testcontainers at its socket. Its Ryuk reaper needs a
// privileged Docker socket, so it's off; global-teardown.ts stops the container instead.
const podman = `/run/user/${process.getuid?.()}/podman/podman.sock`;
if (!process.env.DOCKER_HOST && existsSync(podman)) process.env.DOCKER_HOST = `unix://${podman}`;
if (process.env.DOCKER_HOST?.includes('podman')) process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
};

module.exports = {
  projects: [
    { ...shared, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/global-setup.ts',
      globalTeardown: '<rootDir>/test/global-teardown.ts',
      testTimeout: 30000,
    },
  ],
};
