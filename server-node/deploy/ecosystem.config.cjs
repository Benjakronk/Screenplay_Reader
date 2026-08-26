// pm2 process definition for the Faaglarna API.
//
//   cd /srv/faaglarna-api
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save            # persist across reboots (after `pm2 startup` once)
//   pm2 logs faaglarna-api
//
// This one process listens on TWO ports: the REST API on PORT and the
// collaboration WebSocket on COLLAB_PORT (see collab.js for why they are
// separate listeners). Both bind to 127.0.0.1 – only nginx faces the internet.
//
// DB credentials are NOT set here; they live in .env next to server.js and are
// loaded by db.js. Keep secrets out of this committed file.

module.exports = {
  apps: [
    {
      name: 'faaglarna-api',
      script: 'server.js',
      cwd: '/srv/faaglarna-api',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Give the process time to flush debounced CRDT writes on restart
      // instead of being SIGKILLed mid-save (see the SIGTERM handler in
      // server.js). pm2's default is 1600ms.
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        COLLAB_PORT: '3003',
        HOST: '127.0.0.1',
        EXPORT_SERVICE_URL: 'http://127.0.0.1:3002',
      },
    },
  ],
};
