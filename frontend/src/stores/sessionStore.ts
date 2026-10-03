import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { checkNightCapacity, invalidateForTarget, reconcileVersions, type VersionMismatch } from '../utils/version';
import type { ObsSession, ObsTarget, SessionStatus, SuspensionReason } from '../types';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput, targetVersion?: number) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /** 挂起排程段（不删段，等待换夜或排队） */
  suspendSession: (id: string, reason: SuspensionReason) => Promise<void>;
  /** 排队：保持挂起状态并记录距可用容量还差的分钟数 */
  queueSession: (id: string, deficitMinutes: number) => Promise<void>;
  /** 迁入目标夜：容量核对通过则恢复待执行，否则排队并写明差额 */
  moveToNight: (id: string, targetNightId: string) => Promise<{ moved: boolean; deficitMinutes: number }>;
  /** 标记复核：复核过的排程段照旧保留，不参与失效重算 */
  markReviewed: (id: string) => Promise<void>;
  /** 按目标编号核对在用版本，返回不一致项 */
  checkVersions: (targets: ObsTarget[]) => VersionMismatch[];
  /** 目标数据变更后对引用该目标的在排程段做失效重算 */
  invalidateForTarget: (target: ObsTarget) => Promise<{ revalidated: number; suspended: number }>;
}

/** 排程段与冲突检测所需数据 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input, targetVersion) => {
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      targetVersion: targetVersion ?? 1,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const updated = targets.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      schemaVersion: SCHEMA_VERSION,
    }));
    for (const session of updated) {
      await persistRow('sessions', session);
    }
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  suspendSession: async (id, reason) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, status: '挂起', suspensionReason: reason, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  queueSession: async (id, deficitMinutes) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = {
      ...current,
      status: '挂起',
      suspensionReason: current.suspensionReason ?? '版本不一致',
      deficitMinutes,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  moveToNight: async (id, targetNightId) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return { moved: false, deficitMinutes: 0 };
    const [nights, targets] = await Promise.all([db.nights.toArray(), db.targets.toArray()]);
    const targetNight = nights.find((night) => night.id === targetNightId);
    if (!targetNight) return { moved: false, deficitMinutes: 0 };
    const capacity = checkNightCapacity(current, targetNight, get().sessions);
    if (!capacity.fits) {
      // 排不下：排队并写明还差多少分钟
      const next: ObsSession = {
        ...current,
        status: '挂起',
        suspensionReason: current.suspensionReason ?? '低于高度门槛',
        deficitMinutes: capacity.deficitMinutes,
        schemaVersion: SCHEMA_VERSION,
      };
      await persistRow('sessions', next);
      set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
      return { moved: false, deficitMinutes: capacity.deficitMinutes };
    }
    // 迁入新夜：按当前目标数据重新核对版本，恢复待执行
    const target = targets.find((item) => item.id === current.targetId);
    const next: ObsSession = {
      ...current,
      nightId: targetNightId,
      status: '待执行',
      targetVersion: target?.version ?? current.targetVersion,
      suspensionReason: undefined,
      deficitMinutes: undefined,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
    return { moved: true, deficitMinutes: 0 };
  },

  markReviewed: async (id) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = { ...current, reviewed: true, schemaVersion: SCHEMA_VERSION };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  checkVersions: (targets) => {
    return reconcileVersions(targets, get().sessions);
  },

  invalidateForTarget: async (target) => {
    const nights = await db.nights.toArray();
    const result = invalidateForTarget(target, get().sessions, nights);
    for (const session of result.revalidated) {
      await persistRow('sessions', session);
    }
    for (const session of result.suspended) {
      await persistRow('sessions', session);
    }
    set({
      sessions: get().sessions.map((session) => {
        const updated = [...result.revalidated, ...result.suspended].find((item) => item.id === session.id);
        return updated ?? session;
      }),
    });
    return { revalidated: result.revalidated.length, suspended: result.suspended.length };
  },
}));
