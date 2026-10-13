// PM2 config for a FUTURE, OWNER-APPROVED deploy of the remote endpoint (https://mcp.webrevenuescan.com/mcp).
// NOT started by the build. Usage (owner, on the target host):
//   cp .env.example .env && edit it (OAuth keys, public URL) ; npm ci && npm run build
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
// One instance only: rate limits, OAuth single-use codes and refresh-token revocation live in memory
// (see docs/REMOTE.md "Scaling" before raising instances).
module.exports = {
  apps: [
    {
      name: 'siteverdict-mcp',
      script: 'dist/cli.js',
      args: '--http',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--enable-source-maps',
      max_memory_restart: '400M',
      kill_timeout: 10000,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        SITEVERDICT_HTTP_HOST: '127.0.0.1',
        SITEVERDICT_HTTP_PORT: '3333',
        SITEVERDICT_TRUST_PROXY: '1',
      },
      out_file: '/dev/null',
      error_file: 'logs/siteverdict-mcp.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
