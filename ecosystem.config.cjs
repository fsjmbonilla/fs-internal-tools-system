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
