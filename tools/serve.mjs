/* ===========================================================================
 * serve.mjs — 确保本地服务器在跑（验收链路的前置条件）
 *
 * 为什么单独做成一个模块：验收脚本需要一个**已存在**的服务器，而用
 * `(node server/index.js &)` 起的话，那个进程会随该次 shell 调用结束被回收 ——
 * 下次跑验收时 8790 已经空了，于是每个场景的「页面加载完成」全红，看起来像
 * "这次改动把启动搞崩了"，实际上与产品代码毫无关系。这个假回归骗过了一次。
 *
 * 所以：spawn detached + unref（脱离父进程、不被回收），并且每次都**重新探活**
 * 而不是假设它还活着。verify.mjs 直接 import 本模块的 ensureServer 做自愈。
 *
 *   node tools/serve.mjs            起（或确认已在跑），打印结果
 * =========================================================================*/
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * 确认 base 上的服务器可用；不可用就以后台游离进程拉起。
 * @returns {Promise<boolean>} 最终是否可用
 */
export async function ensureServer(base = 'http://127.0.0.1:8790') {
  const alive = () =>
    fetch(base + '/api/health')
      .then((r) => r.ok)
      .catch(() => false);

  if (await alive()) return true;

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PORT: new URL(base).port || '3000' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await delay(250);
    if (await alive()) return true;
  }
  return false;
}

// 直接执行时才走 CLI 分支；被 import 时只导出函数
const isCli =
  process.argv[1] &&
  import.meta.url.replace(/\\/g, '/').endsWith(
    process.argv[1].replace(/\\/g, '/'),
  );
if (isCli) {
  const base =
    process.env.DR_SERVER || 'http://127.0.0.1:' + (process.env.PORT || '8790');
  const ok = await ensureServer(base);
  console.log(ok ? '服务器就绪 ' + base : '服务器启动失败 ' + base);
  process.exit(ok ? 0 : 1);
}
