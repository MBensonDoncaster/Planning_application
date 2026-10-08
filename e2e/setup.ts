import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default async function setup() {
  const child = fork(fileURLToPath(new URL('../apps/backend/test/browser-server.ts', import.meta.url)), {
    cwd: fileURLToPath(new URL('../apps/backend/', import.meta.url)), execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test', DEPLOYMENT_PROFILE: 'test', AUTH_MODE: 'TEST_USER' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const stop = () => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) { resolve(); return; }
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Browser test server cleanup timed out.')); }, 20_000);
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error('Browser test server exited unsuccessfully.')); });
    if (child.connected) child.send('stop'); else child.kill();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Browser test server startup timed out.')), 90_000);
      child.once('message', message => { clearTimeout(timeout); if (message === 'ready') resolve(); else reject(new Error('Unexpected browser server response.')); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Browser test server failed to start.')); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  } catch (error) { await stop(); throw error; }
  return stop;
}
