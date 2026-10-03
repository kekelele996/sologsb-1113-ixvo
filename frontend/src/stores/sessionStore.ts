import { create } from 'zustand';
import { db, deleteRow, persistRow, persistRows, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { ObsNight, ObsSession, ObsTarget, SessionStatus } from '../types';
import {
  planMoveToNight,
  RECOMPUTABLE_STATUSES,
  recheckSession,
  sessionVersionState,
  type MovePlan,
} from '../utils/scheduling';

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

/** 换夜结果（planMoveToNight 的落库结果，明细供页面提示） */
export interface MoveSessionsResult extends MovePlan {
  targetNight: ObsNight;
}

/** 核对（按新数据复核）单段结果 */
export interface ConfirmResult {
  id: string;
  ok: boolean;
  reason?: string;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /**
   * 评审组改了某目标的坐标 / 高度门槛（dataVersion 已 +1）后调用：
   * 未终局的在用段全部按「版本对不上」先挂起；按新数据当场不达标 的挂起原因写明不达标。
   * 评审组不删段，挂起段由编排台之后核对 / 换夜 / 排队。返回挂起明细。
   */
  suspendForTargetDataChange: (targetId: string, target: ObsTarget) => Promise<Array<{ id: string; reason: string }>>;
  /**
   * 编排台按目标编号核对在用版本并按新数据复核：
   * 通过 → 恢复为待执行并刷新版本快照；不通过 → 保持挂起并写明原因。返回每段核对结果。
   */
  confirmSessions: (ids: string[]) => Promise<ConfirmResult[]>;
  /**
   * 换到别的夜：按目标夜剩余容量逐段预演，装得下的改挂该夜并恢复，
   * 装不下的转排队并记录还差多少分钟；按新数据在目标夜不达标的保持挂起。
   */
  moveSessions: (ids: string[], targetNightId: string, note?: string) => Promise<MoveSessionsResult | undefined>;
}

async function readTarget(id: string): Promise<ObsTarget | undefined> {
  return (await db.targets.get(id)) as ObsTarget | undefined;
}
async function readNight(id: string): Promise<ObsNight | undefined> {
  return (await db.nights.get(id)) as ObsNight | undefined;
}

/** 排程段与冲突检测所需数据（编排台侧；只读目标库，不回写） */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    // 新增排程时按目标编号快照在用版本：目标库查不到则记 0，留给运行时核对挂起
    const target = await readTarget(input.targetId);
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      targetVersion: target?.dataVersion ?? 0,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    let targetVersion = current.targetVersion;
    if (patch.targetId && patch.targetId !== current.targetId) {
      const target = await readTarget(patch.targetId);
      targetVersion = target?.dataVersion ?? 0;
    }
    const next: ObsSession = { ...current, ...patch, targetVersion, schemaVersion: SCHEMA_VERSION };
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
    await persistRows('sessions', updated);
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  suspendForTargetDataChange: async (targetId, target) => {
    const affected = get().sessions.filter(
      (session) =>
        session.targetId === targetId &&
        (RECOMPUTABLE_STATUSES as readonly string[]).includes(session.status),
    );
    if (affected.length === 0) return [];
    const nightsById = new Map((await db.nights.toArray()).map((night: ObsNight) => [night.id, night]));
    const updated: ObsSession[] = affected.map((session) => {
      const recheck = recheckSession(session, target, nightsById.get(session.nightId));
      return {
        ...session,
        status: '挂起' as SessionStatus,
        suspendReason: recheck.ok
          ? `目标数据版本对不上：排程快照 v${session.targetVersion ?? '?'}，目标库现用 v${target.dataVersion}，等待按新数据复核`
          : recheck.reason,
        // 排队状态因目标变更一并打回，排队信息清掉，等编排台重新决定
        queueNightId: undefined,
        queueShortfallMinutes: undefined,
        schemaVersion: SCHEMA_VERSION,
      };
    });
    await persistRows('sessions', updated);
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.map((session) => ({ id: session.id, reason: session.suspendReason ?? '' }));
  },

  confirmSessions: async (ids) => {
    const sessions = get().sessions.filter((session) => ids.includes(session.id));
    const results: ConfirmResult[] = [];
    const updated: ObsSession[] = [];
    for (const session of sessions) {
      const target = await readTarget(session.targetId);
      const night = await readNight(session.nightId);
      const state = sessionVersionState(session, target);
      let result: ConfirmResult;
      if (state === 'target-missing') {
        result = { id: session.id, ok: false, reason: '目标库中找不到该目标编号，无法核对' };
      } else {
        const recheck = recheckSession(session, target, night);
        if (!recheck.ok) {
          result = { id: session.id, ok: false, reason: recheck.reason };
        } else {
          result = { id: session.id, ok: true };
        }
      }
      results.push(result);
      if (result.ok && target) {
        updated.push({
          ...session,
          status: '待执行',
          targetVersion: target.dataVersion,
          suspendReason: undefined,
          // 排队段核对通过后回到待执行；是否真排得下由编排台再换夜
          queueNightId: undefined,
          queueShortfallMinutes: undefined,
          schemaVersion: SCHEMA_VERSION,
        });
      } else if (session.status !== '挂起') {
        // 复核不达标：非挂起态先挂起等编排台决定
        updated.push({ ...session, status: '挂起', suspendReason: result.reason, schemaVersion: SCHEMA_VERSION });
      } else if (session.suspendReason !== result.reason) {
        updated.push({ ...session, suspendReason: result.reason, schemaVersion: SCHEMA_VERSION });
      }
    }
    if (updated.length) {
      await persistRows('sessions', updated);
      set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    }
    return results;
  },

  moveSessions: async (ids, targetNightId, note) => {
    const targetNight = await readNight(targetNightId);
    if (!targetNight) return undefined;
    // 只处理编排台勾给本动作的挂起 / 排队 / 待执行 / 进行中段
    const picked = get().sessions.filter(
      (session) => ids.includes(session.id) && (RECOMPUTABLE_STATUSES as readonly string[]).includes(session.status),
    );
    const targets = await db.targets.toArray();
    const targetsById = new Map((targets as ObsTarget[]).map((target) => [target.id, target]));
    const plan = planMoveToNight(picked, targetNight, targetsById, get().sessions);
    const itemById = new Map(plan.items.map((item) => [item.sessionId, item]));
    const updated: ObsSession[] = picked.map((session) => {
      const item = itemById.get(session.id)!;
      const reasonSuffix = note?.trim() ? `（${note.trim()}）` : '';
      if (item.decision === 'move') {
        return {
          ...session,
          nightId: targetNight.id,
          status: '待执行',
          targetVersion: targetsById.get(session.targetId)?.dataVersion ?? session.targetVersion,
          suspendReason: undefined,
          queueNightId: undefined,
          queueShortfallMinutes: undefined,
          backupNightId: targetNight.backup ? targetNight.id : session.backupNightId,
          rescheduleReason: note?.trim() ? note.trim() : session.rescheduleReason,
          schemaVersion: SCHEMA_VERSION,
        };
      }
      if (item.decision === 'queue') {
        return {
          ...session,
          status: '排队',
          queueNightId: targetNight.id,
          queueShortfallMinutes: item.shortfallMinutes,
          suspendReason: undefined,
          rescheduleReason: `转 ${targetNight.date} 容量不足，排队等候，还差 ${item.shortfallMinutes} 分钟${reasonSuffix}`,
          schemaVersion: SCHEMA_VERSION,
        };
      }
      return {
        ...session,
        status: '挂起',
        queueNightId: undefined,
        queueShortfallMinutes: undefined,
        suspendReason: item.holdReason,
        schemaVersion: SCHEMA_VERSION,
      };
    });
    await persistRows('sessions', updated);
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return { ...plan, targetNight };
  },
}));
