module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: './start.sh',
      cwd: __dirname,
      interpreter: 'none',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 100,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
