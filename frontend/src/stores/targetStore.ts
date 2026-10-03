import { create } from 'zustand';
import { db, deleteRow, persistRow } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { FilterName, ObsTarget, Priority, TargetType } from '../types';

export interface TargetInput {
  name: string;
  catalog: string;
  raHours: number;
  decDeg: number;
  magnitude: number;
  type: TargetType;
  filter: FilterName;
  exposureSec: number;
  totalMinutes: number;
  priority: Priority;
  minAltitude: number;
  remark?: string;
}

/** 影响排程是否成立的字段：只有这三个变更才需要把已排段打回重算 */
export const SCHEDULING_FIELDS = ['raHours', 'decDeg', 'minAltitude'] as const;
type SchedulingField = (typeof SCHEDULING_FIELDS)[number];

export interface UpdateTargetResult {
  target: ObsTarget;
  /** 是否发生了影响排程的数据变更（版本 +1） */
  schedulingChanged: boolean;
  /** 因版本对不上 / 按新数据不达标被挂起的排程段数（由编排台 store 处理） */
  suspendedCount: number;
  /** 挂起段明细 id + 原因 */
  suspended: Array<{ id: string; reason: string }>;
}

interface TargetState {
  targets: ObsTarget[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTarget: (input: TargetInput) => Promise<ObsTarget>;
  updateTarget: (id: string, patch: Partial<TargetInput>) => Promise<UpdateTargetResult | undefined>;
  removeTarget: (id: string) => Promise<void>;
}

function schedulingChanged(prev: ObsTarget, patch: Partial<TargetInput>): boolean {
  return SCHEDULING_FIELDS.some((field: SchedulingField) => field in patch && Number(patch[field]) !== prev[field]);
}

/**
 * 观测目标库（评审组侧）。评审组只维护目标本身：改坐标 / 高度门槛时 dataVersion +1，
 * 编排台的排程段不在这里删除或改写，只通过 sessionStore 的 suspendForTargetDataChange 打回挂起。
 */
export const useTargetStore = create<TargetState>()((set, get) => ({
  targets: [],
  hydrated: false,

  hydrate: async () => {
    const targets = await db.targets.orderBy('name').toArray();
    set({ targets, hydrated: true });
  },

  addTarget: async (input) => {
    const target: ObsTarget = {
      id: uid('target'),
      name: input.name.trim(),
      catalog: input.catalog.trim(),
      raHours: Number(input.raHours) || 0,
      decDeg: Number(input.decDeg) || 0,
      magnitude: Number(input.magnitude) || 0,
      type: input.type,
      filter: input.filter,
      exposureSec: Number(input.exposureSec) || 0,
      totalMinutes: Number(input.totalMinutes) || 0,
      priority: input.priority,
      minAltitude: Number(input.minAltitude) || 0,
      dataVersion: 1,
      remark: input.remark?.trim() || undefined,
    };
    await persistRow('targets', target);
    set({ targets: [...get().targets, target].sort((a, b) => a.name.localeCompare(b.name)) });
    return target;
  },

  updateTarget: async (id, patch) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) return undefined;
    const changed = schedulingChanged(current, patch);
    const next: ObsTarget = {
      ...current,
      ...patch,
      dataVersion: changed ? current.dataVersion + 1 : current.dataVersion,
    };
    await persistRow('targets', next);
    set({ targets: get().targets.map((target) => (target.id === id ? next : target)) });

    let suspended: Array<{ id: string; reason: string }> = [];
    if (changed) {
      // 动态引入避免与 sessionStore 形成模块初始化环；编排台持有排程段，评审组不替它删段
      const { useSessionStore } = await import('./sessionStore');
      suspended = await useSessionStore.getState().suspendForTargetDataChange(id, next);
    }
    return { target: next, schedulingChanged: changed, suspendedCount: suspended.length, suspended };
  },

  removeTarget: async (id) => {
    // 评审组不替编排台删段：目标删除后，相关排程段在版本核对时因 target-missing 挂起等确认
    await deleteRow('targets', id);
    set({ targets: get().targets.filter((target) => target.id !== id) });
  },
}));
