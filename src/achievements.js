/* ===========================================================================
 * achievements.js — 成就系统
 * 判定逻辑集中在这里，元数据在 config.js（含 20 项成就）
 * =========================================================================*/

import { ACHIEVEMENTS, TRACK_ORDER, STORAGE } from './config.js';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式 */ }
}

export class Achievements {
  constructor() {
    this.unlocked = new Set(load(STORAGE.ACH, []));
    this.tracksDone = new Set(load(STORAGE.TRACKS_DONE, []));
    this.onUnlock = null;      // (meta) => void
    this.onChange = null;      // () => void
    this.reset();
  }

  /** 每场比赛开始时重置场内状态 */
  reset() {
    this.race = {
      scoreAtStart: 0,
      raceScore: 0,
      wasLast: false,
      onlinePlayers: 0,
      mode: 'solo',
      aiLevel: 'normal',
      trackId: null,
      startDelay: null,
      maxMult: 1,
      gapToWinner: null,
      lapsDone: 0,
    };
  }

  isUnlocked(id) { return this.unlocked.has(id); }
  count() { return this.unlocked.size; }
  total() { return ACHIEVEMENTS.length; }
  meta(id) { return ACHIEVEMENTS.find((a) => a.id === id); }

  unlock(id) {
    if (this.unlocked.has(id)) return false;
    this.unlocked.add(id);
    save(STORAGE.ACH, [...this.unlocked]);
    const m = this.meta(id);
    if (m && this.onUnlock) this.onUnlock(m);
    if (this.onChange) this.onChange();
    return true;
  }

  resetAll() {
    this.unlocked.clear();
    this.tracksDone.clear();
    save(STORAGE.ACH, []);
    save(STORAGE.TRACKS_DONE, []);
    if (this.onChange) this.onChange();
  }

  /**
   * 合并一批成就 id（云端拉回时使用）：只新增、不移除，返回新增数量。
   * 未知 id 会被忽略，避免云端脏数据污染本地成就表。
   */
  mergeUnlocked(ids) {
    let added = 0;
    for (const id of ids || []) {
      if (this.unlocked.has(id)) continue;
      if (!this.meta(id)) continue;
      this.unlocked.add(id);
      added++;
    }
    if (added) {
      save(STORAGE.ACH, [...this.unlocked]);
      if (this.onChange) this.onChange();
    }
    return added;
  }

  /* ---------------------------------------------------------------------
   * 比赛开始
   * -------------------------------------------------------------------*/
  beginRace({ mode, aiLevel, trackId, onlinePlayers = 0, startDelay = null, localScores = [] }) {
    this.race.mode = mode;
    this.race.aiLevel = aiLevel;
    this.race.trackId = trackId;
    this.race.onlinePlayers = onlinePlayers;
    this.race.startDelay = startDelay;
    this.race.scoreAtStart = localScores.reduce((a, b) => a + b, 0);
    this.race.raceScore = 0;
    this.race.wasLast = false;
    this.race.maxMult = 1;
    this.race.lapsDone = 0;
    this.race.gapToWinner = null;
    if (startDelay !== null && startDelay <= 0.35) this.unlock('perfectionist');
  }

  /* ---------------------------------------------------------------------
   * 每帧轻量检查（只做阈值类判定，开销极低）
   * -------------------------------------------------------------------*/
  tick(localRacers, racers) {
    for (const r of localRacers) {
      const kmh = Math.abs(r.vF) * 3.6;
      if (kmh >= 150) this.unlock('speed_150');
      if (kmh >= 210) this.unlock('speed_210');
      if (r.wallTime >= 2) this.unlock('wall_ride');
      if (r.driftMult > this.race.maxMult) this.race.maxMult = r.driftMult;
      if (r.driftMult >= 5) this.unlock('combo_5');
      // 最后一名（至少跑起来之后才算，避免发车瞬间误判）
      if (r.lap >= 1 && r.rank === racers.length && racers.length >= 3 && r.progress > 0.08) {
        this.race.wasLast = true;
      }
    }
    this.race.raceScore = Math.max(
      this.race.raceScore,
      localRacers.reduce((a, r) => a + r.score, 0) - this.race.scoreAtStart
    );
    if (this.race.raceScore >= 500) this.unlock('drift_500');
    if (this.race.raceScore >= 3000) this.unlock('drift_3000');
  }

  /* ---------------------------------------------------------------------
   * 完成一圈
   * -------------------------------------------------------------------*/
  onLap(racer, lapTime, track) {
    if (racer.kind === 'ai' || racer.kind === 'remote') return;
    this.unlock('first_lap');
    this.race.lapsDone++;
    if (racer.cleanLap) this.unlock('clean_lap');
    if (racer.noBrakeLap) this.unlock('no_brake');
    if (track.id === 'city' && lapTime < 60000) this.unlock('night_owl');

    this.tracksDone.add(track.id);
    save(STORAGE.TRACKS_DONE, [...this.tracksDone]);
    if (TRACK_ORDER.every((t) => this.tracksDone.has(t))) this.unlock('tour_all');

    // 新圈开始，重置单圈状态标记
    racer.cleanLap = true;
    racer.noBrakeLap = true;
  }

  /* ---------------------------------------------------------------------
   * 比赛结束
   * -------------------------------------------------------------------*/
  endRace({ localRacers, allRacers, mode, aiLevel }) {
    const locals = localRacers.filter((r) => r.kind !== 'ai' && r.kind !== 'remote');
    if (!locals.length) return;
    const best = locals.reduce((a, b) => (a.rank <= b.rank ? a : b));

    if (locals.every((r) => r.finished || r.lap > 1)) this.unlock('first_race');

    const hasAI = allRacers.some((r) => r.kind === 'ai');
    if (mode === 'online') {
      this.unlock('online_first');
      if (allRacers.length >= 4) this.unlock('online_party');
    }
    if (mode === 'split') this.unlock('splitscreen');
    if (best.rank === 1 && hasAI) {
      this.unlock('win_ai');
      if (aiLevel === 'hard') this.unlock('ai_beater');
    }
    if (best.rank === 1 && this.race.wasLast) this.unlock('comeback');

    // 毫厘之争：与第二名的完赛时间差 < 0.3 秒
    const finished = allRacers.filter((r) => r.finished).sort((a, b) => a.finishTime - b.finishTime);
    if (finished.length >= 2 && best.rank === 1 && (finished[1].finishTime - finished[0].finishTime) < 0.3) {
      this.unlock('photo_finish');
    }
  }
}
