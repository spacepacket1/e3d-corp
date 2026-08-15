module.exports = {
  apps: [
    {
      name: 'e3d-corp-futco-web',
      script: 'bash',
      args: 'ops/run/run-futco-web.sh',
      cwd: '/Users/mini/e3d-corp',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '/Users/mini/e3d-corp/.e3d-corp/instance/futco/web-error.log',
      out_file: '/Users/mini/e3d-corp/.e3d-corp/instance/futco/web-out.log',
      time: true
    }
  ]
};
