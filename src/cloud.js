/* ===========================================================================
 * cloud.js — WorkBuddy 云服务接入层
 *
 * 设计原则：
 *   1) 云是「叠加」而非「替代」：所有云调用失败都必须降级为游戏原本的本地行为，
 *      且必须把失败如实告知玩家 —— 绝不静默假装保存成功。
 *   2) 浏览器端只持有 publicConfig（endpoint + publishableKey）。publishableKey
 *      只标识应用、本身不含权限，服务端按 Origin 精确校验；长效密钥永远不下发。
 *   3) 本文件不直接 fetch /.cloud/**：一律通过官方 SDK
 *      @tencent-ai/workbuddy-cloud-sdk（IIFE 形态，全局 WorkBuddyCloud）。
 *
 * 接入的云端能力（与既有本地功能一一对应）：
 *   本地 localStorage 成就   → dr_achievements（跨设备合并同步）
 *   本地最佳圈速             → dr_lap_records（公开排行榜）
 *   本地昵称 / 涂装           → dr_profiles（玩家档案 + 累计战绩）
 *   无身份                    → 邮箱账号（Auth，Web 端仅支持邮箱）
 * =========================================================================*/

/* ---------------------------------------------------------------------------
 * publicConfig —— 由 workbuddy_cloud_service 开通环境时下发，是浏览器端唯一
 * 可以落盘的云端配置。endpoint 必须原样使用，不能改写、不能从 location 推导：
 * 服务端对它做精确 Origin 匹配，改一个字都会导致云调用被拒。
 * -------------------------------------------------------------------------*/
export const PUBLIC_CONFIG = {
  endpoint: 'https://drift-rush-online.app.workbuddy.host',
  publishableKey: 'wbpk_8B7TFSc7WAeDg7U8mLEDd6_4kr1HLcseG32laNdauj0Ewn5Da1lNKhg',
};

/* ---------------------------------------------------------------------------
 * SDK 加载
 * 首选 index.html 里的本地 /vendor/workbuddy-cloud.global.js（自托管，不阻塞首屏）。
 * 若该文件缺失或加载失败，这里再动态注入 CDN 上的同一份 @dev 构建兜底。
 * -------------------------------------------------------------------------*/
const SDK_URL =
  'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const SDK_TIMEOUT_MS = 15000;

/* --------------------------------------------------------------- SDK 加载 */
let sdkPromise = null;

function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function') {
      resolve(window.WorkBuddyCloud);
      return;
    }
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    const timer = setTimeout(() => {
      s.remove();
      reject(new Error('云服务 SDK 加载超时'));
    }, SDK_TIMEOUT_MS);
    s.onload = () => {
      clearTimeout(timer);
      if (window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function') {
        resolve(window.WorkBuddyCloud);
      } else {
        reject(new Error('云服务 SDK 加载后未暴露 WorkBuddyCloud'));
      }
    };
    s.onerror = () => {
      clearTimeout(timer);
      s.remove();
      reject(new Error('云服务 SDK 加载失败（网络不可达）'));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/* ------------------------------------------------------------ 错误归一化 */
/**
 * 把 SDK 错误翻成给玩家看的中文提示，保留 kind 便于上层分支。
 * 优先按 kind 判定；kind 未覆盖时再用消息文本兜底（部分错误只带英文原文）。
 */
const MESSAGE_MAP = [
  [/username or password incorrect|invalid login|wrong password/i, '账号或密码不正确'],
  [/user already (registered|exists)|already exists/i, '该邮箱已注册，请直接用密码登录'],
  [/invalid email|email.*(invalid|format)/i, '邮箱格式不正确'],
  [/password.*(least|short|length)|weak password/i, '密码太短，请至少 8 位'],
  [/too many requests|rate limit/i, '操作过于频繁，请稍后再试'],
  [/expired/i, '验证码已过期，请重新获取'],
  [/not found|could not find/i, '账号不存在或验证码已失效'],
];

export function normalizeError(e) {
  if (!e) return { kind: 'unknown', message: '未知错误' };
  const kind = e.kind || e.code || (e.error && (e.error.kind || e.error.code)) || 'unknown';
  const raw = e.message || (e.error && e.error.message) || String(e);
  let message = raw;
  switch (kind) {
    case 'unauthenticated': message = '请先登录账号'; break;
    case 'invalid_grant': message = '账号或密码不正确'; break;
    case 'network': message = '网络异常，请稍后重试'; break;
    case 'backend-unavailable': message = '云服务暂时不可用，请稍后重试'; break;
    case 'otp_expired': message = '验证码已过期，请重新获取'; break;
    case 'otp_invalid': message = '验证码不正确'; break;
    default: {
      for (const [re, zh] of MESSAGE_MAP) {
        if (re.test(raw)) { message = zh; break; }
      }
      break;
    }
  }
  return { kind, message };
}

const isMissingTable = (e) => !!e && (e.code === '42P01' || /relation .* does not exist/i.test(e.message || ''));
const isDenied = (e) => !!e && (e.code === '42501' || /permission denied|row-level security/i.test(e.message || ''));

/* ===========================================================================
 * CloudService
 * =========================================================================*/
class CloudService {
  constructor() {
    this.client = null;
    this.auth = null;
    this.db = null;
    this.status = 'idle';        // idle | loading | ready | error | unavailable
    this.error = null;
    this.user = null;            // { id, email }
    this.profile = null;         // dr_profiles 行
    this.listeners = new Set();
    this._authUnsub = null;
  }

  /* -------------------------------------------------------------- 初始化 */
  async init() {
    if (this.status === 'ready' || this.status === 'loading') return this.status;
    this.status = 'loading';
    this._emit();
    try {
      const sdk = await loadSdk();
      this.client = sdk.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        publishableKey: PUBLIC_CONFIG.publishableKey,
      });
      this.auth = this.client.auth;
      this.db = this.client.database;
      this.status = 'ready';
      this.error = null;

      // 恢复已有会话（刷新页面后仍保持登录）
      try {
        const { data } = await this.auth.getSession();
        this.user = data && data.user ? { id: data.user.id, email: data.user.email } : null;
      } catch (e) { /* 未登录属正常 */ }

      try {
        this._authUnsub = this.auth.onAuthStateChange((event, session) => {
          this.user = session && session.user ? { id: session.user.id, email: session.user.email } : null;
          if (event === 'SIGNED_OUT') this.profile = null;
          this._emit();
        });
      } catch (e) { /* 事件订阅失败不影响主流程 */ }

      this._emit();
      return this.status;
    } catch (e) {
      this.status = 'error';
      this.error = normalizeError(e);
      this._emit();
      return this.status;
    }
  }

  get available() { return this.status === 'ready' && !!this.client; }
  get signedIn() { return !!this.user; }

  /* ------------------------------------------------------------ 观察者 */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    for (const fn of this.listeners) {
      try { fn(this); } catch (e) { /* 单个监听器异常不拖垮其余 */ }
    }
  }

  /* ================================================================ 认证 */
  /** 发送邮箱验证码（注册或登录共用同一条链路） */
  async sendEmailCode(email) {
    if (!this.available) throw new Error('云服务尚未就绪');
    const res = await this.auth.sendOtp({ email });
    if (res.error) throw Object.assign(new Error(normalizeError(res.error).message), normalizeError(res.error));
    return res.data;   // { verificationId, isExistingUser }
  }

  /**
   * 提交邮箱验证码完成登录/注册。
   * pending 必须是「获取验证码」那一步返回的原始状态，且邮箱须与之一致 ——
   * 提交阶段绝不再发新码。
   */
  async verifyEmailCode({ email, token, pending, password }) {
    if (!pending || !pending.verificationId) throw new Error('请先获取验证码');
    if (pending.email !== email) throw new Error('请先为当前邮箱获取验证码');
    const res = await this.auth.verifyOtp({
      email: pending.email,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token,
      password: pending.isExistingUser ? undefined : password,
    });
    if (res.error) {
      const n = normalizeError(res.error);
      throw Object.assign(new Error(n.message), n);
    }
    this.user = res.data && res.data.user ? { id: res.data.user.id, email: res.data.user.email } : null;
    this._emit();
    return res.data;
  }

  /** 邮箱 + 密码登录 */
  async signInWithPassword(email, password) {
    if (!this.available) throw new Error('云服务尚未就绪');
    const res = await this.auth.signInWithPassword({ email, password });
    if (res.error) {
      const n = normalizeError(res.error);
      throw Object.assign(new Error(n.message), n);
    }
    this.user = res.data && res.data.user ? { id: res.data.user.id, email: res.data.user.email } : null;
    this._emit();
    return res.data;
  }

  /** 忘记密码第 1 步：向邮箱发送重置验证码，返回带 updateUser 的挑战对象 */
  async requestPasswordReset(email) {
    if (!this.available) throw new Error('云服务尚未就绪');
    const res = await this.auth.resetPasswordForEmail(email);
    if (res.error) {
      const n = normalizeError(res.error);
      throw Object.assign(new Error(n.message), n);
    }
    return res.data;
  }

  /** 忘记密码第 2 步：用验证码设置新密码（成功后即为登录态） */
  async completePasswordReset(challenge, nonce, password) {
    const res = await challenge.updateUser({ nonce, password });
    if (res.error) {
      const n = normalizeError(res.error);
      throw Object.assign(new Error(n.message), n);
    }
    try {
      const { data } = await this.auth.getSession();
      this.user = data && data.user ? { id: data.user.id, email: data.user.email } : null;
    } catch (e) { /* ignore */ }
    this._emit();
    return res.data;
  }

  async signOut() {
    if (!this.available) return;
    await this.auth.signOut();
    this.user = null;
    this.profile = null;
    this._emit();
  }

  /* ============================================================== 数据库 */
  _requireReady() {
    if (!this.available) throw new Error('云服务尚未就绪');
  }

  /**
   * 保存玩家档案（每人一行，按 owner_id 冲突更新）。
   * owner_id 一律不传：数据库用 DEFAULT auth.uid() 填，RLS 兜底防伪造。
   * 返回写入后的行；若 RLS 过滤掉（非本人）会得到空数组 —— 视为失败。
   */
  async saveProfile(patch) {
    if (!this.signedIn) throw new Error('请先登录账号');
    this._requireReady();
    const row = { ...patch, updated_at: new Date().toISOString() };
    const { data, error } = await this.db
      .from('dr_profiles')
      .upsert(row, { onConflict: 'owner_id' })
      .select();
    if (error) throw new Error(this._dbMessage(error));
    const saved = Array.isArray(data) ? data[0] : data;
    if (!saved) throw new Error('档案未能写入（可能没有权限）');
    this.profile = saved;
    this._emit();
    return saved;
  }

  /** 读取自己的档案；没有则返回 null（首次登录） */
  async loadProfile() {
    if (!this.signedIn) return null;
    this._requireReady();
    if (!this.user.id) return null;
    const { data, error } = await this.db
      .from('dr_profiles')
      .select('*')
      .eq('owner_id', this.user.id)
      .limit(1);
    if (error) {
      if (isMissingTable(error)) return null;
      throw new Error(this._dbMessage(error));
    }
    const row = Array.isArray(data) && data.length ? data[0] : null;
    this.profile = row;
    this._emit();
    return row;
  }

  /** 提交一条单圈成绩（登录后才有身份；未登录直接失败，不做任何伪装） */
  async submitLap({ trackId, lapMs, topKmh = 0, driftScore = 0, mode = 'solo', playerName }) {
    if (!this.signedIn) throw new Error('请先登录账号，成绩才能上榜');
    this._requireReady();
    if (!Number.isFinite(lapMs) || lapMs <= 0) throw new Error('圈速无效，未提交');
    const { data, error } = await this.db
      .from('dr_lap_records')
      .insert({
        track_id: String(trackId),
        lap_ms: Math.round(lapMs),
        top_kmh: Math.round(topKmh * 10) / 10,
        drift_score: Math.max(0, Math.round(driftScore)),
        mode: String(mode),
        player_name: String(playerName || '车手').slice(0, 16),
      })
      .select();
    if (error) throw new Error(this._dbMessage(error));
    if (!Array.isArray(data) || !data.length) throw new Error('成绩未写入（权限被拒）');
    return data[0];
  }

  /** 排行榜：公开读，未登录也能看 */
  async fetchLeaderboard(trackId, limit = 20) {
    this._requireReady();
    const { data, error } = await this.db
      .from('dr_lap_records')
      .select('id, player_name, lap_ms, top_kmh, drift_score, mode, created_at, owner_id')
      .eq('track_id', String(trackId))
      .order('lap_ms', { ascending: true })
      .limit(limit);
    if (error) throw new Error(this._dbMessage(error));
    return Array.isArray(data) ? data : [];
  }

  /** 某条赛道上自己最快的一圈 */
  async fetchMyBest(trackId) {
    if (!this.signedIn || !this.user.id) return null;
    this._requireReady();
    const { data, error } = await this.db
      .from('dr_lap_records')
      .select('lap_ms, top_kmh, mode, created_at')
      .eq('track_id', String(trackId))
      .eq('owner_id', this.user.id)
      .order('lap_ms', { ascending: true })
      .limit(1);
    if (error) throw new Error(this._dbMessage(error));
    return Array.isArray(data) && data.length ? data[0] : null;
  }

  /**
   * 成就同步：推送本地已解锁项（重复项忽略），再拉回云端全集。
   * 返回合并后的成就 id 数组（本地 ∪ 云端）。
   */
  async syncAchievements(localIds, playerName) {
    if (!this.signedIn || !this.user.id) throw new Error('请先登录账号');
    this._requireReady();
    const name = String(playerName || '车手').slice(0, 16);

    if (localIds.length) {
      const rows = localIds.map((ach_id) => ({ ach_id: String(ach_id), player_name: name }));
      const { error } = await this.db
        .from('dr_achievements')
        .upsert(rows, { onConflict: 'owner_id,ach_id', ignoreDuplicates: true });
      if (error) throw new Error(this._dbMessage(error));
    }

    const { data, error } = await this.db
      .from('dr_achievements')
      .select('ach_id')
      .eq('owner_id', this.user.id);
    if (error) throw new Error(this._dbMessage(error));
    const remote = (Array.isArray(data) ? data : []).map((r) => r.ach_id);
    const merged = Array.from(new Set([...localIds, ...remote]));
    return { merged, remote };
  }

  /** 云端成就总数排行（展示他人成就进度用，公开读） */
  async fetchAchievementBoard(limit = 10) {
    this._requireReady();
    const { data, error } = await this.db
      .from('dr_achievements')
      .select('owner_id, player_name, ach_id');
    if (error) throw new Error(this._dbMessage(error));
    const byOwner = new Map();
    for (const row of (Array.isArray(data) ? data : [])) {
      const key = row.owner_id;
      if (!byOwner.has(key)) byOwner.set(key, { owner_id: key, player_name: row.player_name, count: 0 });
      byOwner.get(key).count++;
    }
    return [...byOwner.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  _dbMessage(error) {
    if (isMissingTable(error)) return '云端数据表不存在，请检查云服务环境';
    if (isDenied(error)) return '没有权限执行该操作';
    if (error && error.code === '23505') return '该记录已存在';
    return (error && error.message) || '云数据库操作失败';
  }
}

export const cloud = new CloudService();

/* ---------------------------------------------------------------------------
 * 一次性「登录后拉取」：档案 + 成就合并 + 个人最佳
 * 由 app.js 在登录成功后调用，避免各处重复写编排逻辑
 * -------------------------------------------------------------------------*/
export async function pullCloudState(ach) {
  const out = { profile: null, mergedAchievements: null, myBests: null, errors: [] };
  if (!cloud.signedIn) return out;

  try {
    out.profile = await cloud.loadProfile();
  } catch (e) { out.errors.push('档案读取失败：' + e.message); }

  try {
    const localIds = ach ? [...ach.unlocked] : [];
    const { merged } = await cloud.syncAchievements(localIds, out.profile ? out.profile.display_name : '车手');
    out.mergedAchievements = merged;
  } catch (e) { out.errors.push('成就同步失败：' + e.message); }

  return out;
}
