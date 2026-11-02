const path = require('node:path');

const bunPath =
  process.env.BUN_BIN ||
  path.join(process.env.HOME || '/home/ubuntu', '.bun', 'bin', 'bun');

module.exports = {
  apps: [
    {
      name: 'bmkg-bot',
      cwd: __dirname,
      script: bunPath,
      args: 'run src/index.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
