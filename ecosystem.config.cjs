module.exports = {
  apps: [
    {
      name: 'fs-internal-system',
      script: 'serve',
      env: {
        PM2_SERVE_PATH: 'dist',
        PM2_SERVE_PORT: 3000,
        PM2_SERVE_SPA: 'true',
        PM2_SERVE_HOMEPAGE: '/index.html',
      },
    },
    {
      // The sandbox. Separate process locally, separate container in production —
      // it is the only thing that executes user-written code, and its isolation
      // is the security model rather than a deployment preference.
      name: 'fs-internal-runner',
      cwd: 'runner',
      script: 'dist/index.js',
      env: {
        RUNNER_API_BASE_URL: 'http://localhost:4000',
        // RUNNER_TOKEN must match the API's. Set it in the environment, never here.
      },
    },
    {
      name: 'fs-internal-server',
      cwd: 'server',
      script: 'dist/index.js',
      env: {
        PORT: 4000,
        CORS_ORIGIN: 'http://localhost:5173,http://localhost:3000',
      },
    },
  ],
};
