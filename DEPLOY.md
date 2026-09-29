# DRIFT RUSH 部署 / 更新线上说明

本文档说明如何把本地 `drift-rush` 项目**手动更新到线上**（即覆盖已发布的分享链接）。

线上站点（已发布）：**https://drift-rush-online.app.workbuddy.host/**

---

## 0. 三个概念先分清楚

| 概念 | 是什么 | 怎么更新 |
|------|--------|----------|
| **本地代码** | 你工作区里的 `drift-rush/` 目录 | 直接改文件 |
| **GitHub 仓库** | `git@github.com:tjian123/drift-rush.git`（代码备份/协作） | `git push origin main`（需本机有 SSH 公钥权限） |
| **线上站点** | WorkBuddy 发布的应用，上面的分享链接 | 见下文「更新线上」 |

> ⚠️ **发布线上 ≠ 提交 GitHub。** 发布只把当前目录打包上传到 WorkBuddy 的托管沙箱，不会自动 push 到 GitHub。两套流程独立，建议先 commit 本地、再发布，保持三者一致。

---

## 1. 发布前提（必须满足）

1. 所有要上线的改动**已保存到磁盘**（文件确实写在 `drift-rush/` 下）。
2. 项目能作为**单端口 HTTP 服务**运行。本项目的服务端 `server/index.js` 已满足条件：
   - 监听 `process.env.PORT`（部署平台注入，缺失时默认 `3000`）；
   - 绑定 `0.0.0.0`（`server.listen(PORT, '0.0.0.0', ...)`）。
3. 没有依赖数据库 / Redis / 消息队列等沙箱不提供的外部服务（本游戏无此类依赖）。
4. **多语言自检已通过**（面向 itch.io 欧美买家，默认必须是英文）：

   ```bash
   npm run verify:i18n      # 20 项：默认 en / 一键切 zh / 无残留中文 / 无缺键
   ```

   判据是机器判的，不是肉眼看截图：英文模式下遍历所有可见文本节点不允许出现
   CJK 字符；所有 `data-i18n*` 的 key 必须在 `src/i18n.js` 的 `DICT.en` 与
   `DICT.zh` 里**同时存在**（`window.I18N.has(key)`）。

---

## 2. 手动更新线上的两种方式

### 方式 A：通过对话框让智能体发布（最省事）
在 WorkBuddy 对话框里直接说一句发布动词即可，例如：
> “更新到线上” / “发布” / “部署” / “同步到线上”

智能体会调用「发布为应用」能力，自动定位 `drift-rush` 目录、**覆盖现有线上应用**（链接不变），并返回新的访问状态。
（注意：每次内容变化后都需要重新说一次发布动词，上一轮的发布授权不会自动沿用。）

### 方式 B：通过界面手动发布
1. 打开 WorkBuddy 左侧的 **发布 / 发布为应用** 入口。
2. 选择本地目录 `drift-rush`（发布应用与目录绑定，重发同一目录会**复用同一个应用、保持同一链接**，覆盖旧内容）。
3. 确认覆盖提示（线上现有内容会被覆盖），点击发布。
4. 等待平台完成：上传源码 → 沙箱内安装依赖 → 启动服务 → 生成/复用访问链接。

运行时参数（平台通常会自动探测，无需手填）：
- 语言：`node`
- 启动命令：`node server/index.js`（监听 `$PORT`）
- 入口：HTTP 根（Node 项目无需指定 entryHtml）

---

## 3. 发布后自检

> **只测「首页返回 200」不足以证明新版本上去了。** 缓存与 CDN 会让旧版本同样返回 200。
> 要确认「这次改动真的在线上」，必须比对线上**源文件的内容**。

1. 基础探活：
   ```bash
   curl -s -o /dev/null -w "首页 %{http_code}\n" https://drift-rush-online.app.workbuddy.host/
   curl -s https://drift-rush-online.app.workbuddy.host/api/health
   # {"ok":true,"rooms":0,"players":0,"uptime":34}
   # uptime 很小 = 确实是刚新起的实例，不是旧进程
   ```
2. **比对线上源文件的版本特征**（把这次改动里的某个特征值 grep 出来）：
   ```bash
   curl -s https://drift-rush-online.app.workbuddy.host/src/config.js  | grep -n "0x8ec8ff\|shoreFrom"
   curl -s https://drift-rush-online.app.workbuddy.host/src/postfx.js  | grep -n "uThreshold"
   ```
   看不到本次改动的特征值，说明上传的是旧内容或命中了缓存。
3. 打开分享链接，确认页面正常加载、无控制台报错。
4. 跑一遍回归脚本（可选，但推荐）：
   ```bash
   # 先本地起服务（默认 3000 或指定端口）
   node server/index.js
   # 另开终端跑验收（需本地有 headless Chrome / CDP 环境）
   node tools/verify-mobile.mjs   # 移动端操控（含转向符号）
   node tools/verify-pad.mjs      # 手柄适配
   node tools/verify-item.mjs     # 道具赛
   ```
5. 实测玩法：键盘 WASD、触屏拖动转向（右拖=右转）、手柄（盖世小鸡等标准 XInput 布局）均应按预期工作。

---

## 4. 回滚 / 下线的手动方式

- **下线（停止分享）**：在对话框说 “下线 / 取消发布”，或通过「设置—数据管理—应用」找到该应用并下线，分享链接随即失效。
- **回滚到旧版本**：WorkBuddy 发布是按目录覆盖，没有内置版本历史。如需回滚，先在本地 `git checkout` 到目标提交，再重新发布一次即可。

---

## 5. 常见坑

- **本地改了但线上没变**：多半是忘了重新发布（或发布了别的目录）。发布只会用「当前磁盘目录」覆盖，不会读 GitHub。
- **SSH push 被拦**：本机若未配置 GitHub SSH 公钥，`git push` 会失败；先 `ssh -T git@github.com` 确认授权，或改用 HTTPS + 个人访问令牌。这是 GitHub 流程，与「发布线上」无关。
- **线上访问报 Blocked host**：仅当使用 Vite 类框架时需要额外配置；本项目是原生 Node 服务，不受影响。
