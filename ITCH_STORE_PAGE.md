# itch.io 商店页文案（英文）

> 面向欧美买家的完整可粘贴文案。所有数字都对照 `src/config.js` 核实过，**没有虚构内容**。
> 唯一需要你拍板的是第 6 节「联机怎么写」——离线包当前隐藏联机入口，不能当成已上线功能卖。

---

## 1. Title

```
DRIFT RUSH — Arcade Drift Racing
```

备选（如果 itch.io 标题撞名）：

```
DRIFT RUSH: Arcade Drift Racing
DRIFT RUSH — Low-Poly Drift Racing
```

**为什么保留 DRIFT RUSH**：itch.io 是搜索驱动的分发平台，`drift` 和 `racing` 必须留在标题里，否则买家用品类词搜不到你。改名意味着包名 / bundle id / 四端原生壳 / 小游戏审核名 / 云端数据表全部返工，收益却不确定。名字解决「被找到」，tagline 解决「被点开」——后者零成本且直接决定转化率。

---

## 2. Tagline（itch.io Short description，上限 120 字符）

推荐（实测 114 字符）：

```
Arcade drift racing in your browser or desktop. 5 tracks, 20 achievements, couch split-screen. Nothing to install.
```

备选：

| 版本 | 字符数 | 侧重 |
|---|---|---|
| `Arcade drift racing in your browser or desktop. 5 tracks, 20 achievements, couch split-screen. Nothing to install.` | 114 | 内容量 + 零门槛 |
| `Chase the perfect slide. 5 tracks, 20 achievements, 2-player split-screen. Runs offline — zero downloads, zero fluff.` | 117 | 手感 + 离线 |
| `Pure drift. No cars to unlock, no loot boxes, no timers. Just you, 5 tracks, and the exit of every corner.` | 106 | 反 F2P 情绪 |

---

## 3. 一句话简介（elevator pitch，用于 devlog / 社媒 / 邮件）

```
DRIFT RUSH is a low-poly arcade racer about holding a slide — five hand-tuned tracks,
a drift combo that rewards commitment, and 20 achievements that teach you to stop braking.
Runs offline, installs in seconds, and never asks for another dollar.
```

---

## 4. Long description（itch.io 正文，HTML，可直接粘贴）

```html
<h2>Hold the slide.</h2>

<p>
  DRIFT RUSH is an arcade drift racer built around one question:
  <strong>how long can you keep the car sideways before the corner runs out?</strong>
  Every track is tuned so that the fast line is also the scary line —
  commit to the slide, chain it through the exit, and the combo multiplier climbs to 5x.
</p>

<p>
  No cars to unlock. No loot boxes. No energy timers. You pay once and everything is on the table.
</p>

<h3>What's in the box</h3>

<ul>
  <li><strong>5 tracks</strong> with genuinely different grip and rhythm —
    long coastal sweepers, tight midnight city blocks, high-speed desert climbs,
    low-grip glacier drifts, and mountain hairpins that never settle into one tempo.</li>
  <li><strong>Drift scoring with a 5x combo</strong> — the longer you hold it, the harder it pays.
    Banking 3,000 points in one race is an achievement, and it should feel like one.</li>
  <li><strong>20 achievements</strong> that actually teach driving:
    a clean lap without leaving the track, a lap without touching the brakes,
    winning on Hard, winning by less than 0.3 seconds.</li>
  <li><strong>Couch split-screen for 2 players</strong> — one keyboard, one screen,
    plus AI opponents to fill out the grid.</li>
  <li><strong>3 AI difficulties</strong> (Easy / Normal / Hard), 1 / 3 / 5 lap races,
    8 car paints, and 4 camera angles including a proper nose cam and a cinematic chase.</li>
  <li><strong>Item mode</strong> — boost, shield, oil slick and missile pickups,
    if you'd rather win ugly.</li>
</ul>

<h3>Built to be small and honest</h3>

<p>
  Every car, track and sky in DRIFT RUSH is generated procedurally at runtime.
  There are no downloaded models, no texture packs, no streaming assets —
  the whole game is a couple of megabytes and starts in about a second.
  It also means it runs offline, forever, with no server to shut down.
</p>

<h3>Controls</h3>

<ul>
  <li><strong>Keyboard</strong> — WASD or arrows, Space for handbrake, C for camera, R to reset, P to pause.</li>
  <li><strong>Gamepad</strong> — plug in any standard controller (Xbox, DualSense, GameSir) and press a button.
    Analog steering and analog triggers.</li>
  <li><strong>Touch</strong> — drag to steer, pedal buttons, with a left-handed option.</li>
  <li><strong>TV</strong> — ships with a TV mode that scales the whole interface for a couch distance,
    navigable with a remote or a gamepad.</li>
</ul>

<h3>Who this is for</h3>

<p>
  You want a racer you can pick up for six minutes, chase one personal best,
  and put down without a progression system nagging you.
</p>

<h3>Who this is not for</h3>

<p>
  If you want licensed cars, a career ladder, car tuning, or 60 hours of content —
  this isn't that game. It's a tight arcade drift toy with five good tracks.
</p>

<h3>Technical notes</h3>

<ul>
  <li>Renders with WebGL2 (falls back to WebGL1 on older hardware).</li>
  <li>Offline by default. An optional free account syncs your best laps to a public
    leaderboard and keeps achievements across devices — the game never requires it.</li>
  <li>Supports English and Chinese, switchable in-game.</li>
</ul>

<p><em>Made by a small team. Bug reports and track requests are genuinely welcome.</em></p>
```

---

## 5. Tags（itch.io 标签，最多 10 个左右效果最好）

```
Racing
Arcade
3D
Singleplayer
Local multiplayer
Controller support
Low-poly
Procedural generation
Drifting
```

> itch.io 的 tag 是受控词表。如果 `Drifting` 不存在，换成 `Sports` 或去掉；
> `Local multiplayer` 比 `Multiplayer` 更准确（避免买家误以为是联机）。

---

## 6. ⚠️ 联机怎么写（需要你拍板）

`src/net.js` 与 `server/` 的联机代码是**完整且验收通过的**（`npm run verify` 里 C/D 两组双客户端联机 40/40 通过），但服务器**尚未部署**，所以离线包用 `__DR_OFFLINE = true` 把联机入口藏了起来。

所以：

| 方案 | 做法 | 适用 |
|---|---|---|
| **A（推荐，先用这个）** | 描述里**完全不提联机**，只在正文末尾加一句 Roadmap | 服务器还没部署时 |
| **B** | 部署服务器后，把「8-player online」写进卖点列表 | 联机真正上线后 |

方案 A 的 Roadmap 句（接在正文最后）：

```html
<h3>What's next</h3>
<p>
  Online multiplayer (up to 8 players, room-code join) is built and tested
  but the matchmaking server isn't deployed yet. It will ship as a free update —
  buying now gets it at no extra cost.
</p>
```

方案 B 启用后，替换到卖点列表的那一条：

```html
<li><strong>Online rooms for up to 8 players</strong> — create a room, share the 4-letter code, race.</li>
```

并且 tag 里把 `Local multiplayer` 换成 `Multiplayer`。

---

## 7. 定价建议

| 档位 | 建议 | 理由 |
|---|---|---|
| 首发 | **$2.99**（或 PWYW 最低 $2.99） | 5 赛道 + 20 成就 + 分屏，对标同类 indie arcade racer |
| 冲量期 | $1.99 限時 | 换首发评价与曝光，攒够 10+ 评价再回调 |
| 联机上线后 | 上调到 $4.99，老买家自动保留 | 「早买早赚」的叙事，且联机确实是新增价值 |

不建议一开始就定 $4.99——内容厚度撑不住，且没有评价背书时转化率会很难看。

---

## 8. 页面素材清单（提交前备齐）

| 素材 | 规格 | 现状 |
|---|---|---|
| 封面图 | 630×500，第一眼要能看出「车在侧滑」 | 待做，可用现成的 `shot-coast-q3-drift.png` 类截图裁 |
| 截图 | 4–6 张：菜单 / 漂移瞬间 / 车头视角 / 分屏 / 结算 | `tools/` 下已有大量 `shot-*.png` 可挑 |
| 演示 GIF | 3–5 秒漂移循环，放在描述最上方 | 待做，对转化帮助最大的一项 |
| 系统需求 | 见下方 | 已整理 |

**系统需求（Windows 下载版）**

```
Minimum:
  OS:        Windows 10 (1809 or later)
  Graphics:  Any GPU with WebGL2 support (integrated graphics from 2015 onwards is fine)
  Memory:    2 GB RAM
  Storage:   25 MB
  Other:     Microsoft Edge WebView2 Runtime (bundled with Windows 10/11;
             the installer will guide you if it's missing)

Recommended:
  Graphics:  Dedicated GPU, WebGL2 with HDR render targets
  Input:     Any standard gamepad (Xbox / DualSense / GameSir)

Internet:
  Not required to play.
  Optional — a free account enables the public leaderboard and cross-device achievements.
```

---

## 9. 提交前自检

- [ ] 标题里有 `drift` 和 `racing` 两个品类词
- [ ] tagline ≤ 120 字符
- [ ] 描述里没有出现中文（用 `npm run verify:i18n` 保证游戏内是英文，页面文案另外人工过一遍）
- [ ] 联机方案的措辞与服务器实际状态一致（第 6 节）
- [ ] 截图里没有中文界面（**重要**：截图必须用英文版截，用菜单里的 EN/中 按钮切到 EN 再截）
- [ ] 所有外链图片已重新托管（itch.io 不接受外链失效）
- [ ] 定价与第 7 节一致
