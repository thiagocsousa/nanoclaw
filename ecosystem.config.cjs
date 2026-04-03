module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
