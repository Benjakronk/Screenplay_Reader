// pm2 process definition for the Faaglarna export sidecar.
//
//   cd /srv/faaglarna-export
//   python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//   curl -s -X POST http://127.0.0.1:3002/health
//
// pm2 supervises this the same as a Node app; `interpreter` points at the venv
// so ReportLab is on the path. There is no .env: the service holds no secrets
// and talks to no database.
//
// It is bound to 127.0.0.1 and has no nginx block of its own — the Node API
// proxies /api/export/* to it and does the authentication. Nothing to open in
// the firewall.

module.exports = {
  apps: [
    {
      name: 'faaglarna-export',
      script: 'export_server.py',
      interpreter: '/srv/faaglarna-export/venv/bin/python',
      cwd: '/srv/faaglarna-export',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env: {
        HOST: '127.0.0.1',
        PORT: '3002',
      },
    },
  ],
};
