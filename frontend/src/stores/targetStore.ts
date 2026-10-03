import { create } from 'zustand';
import { db, deleteRow, persistRow } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { TARGET_VERSION_FIELDS, type FilterName, type ObsTarget, type Priority, type TargetType } from '../types';

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

interface TargetState {
  targets: ObsTarget[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTarget: (input: TargetInput) => Promise<ObsTarget>;
  updateTarget: (id: string, patch: Partial<TargetInput>) => Promise<{ target: ObsTarget; versionBumped: boolean }>;
  removeTarget: (id: string) => Promise<void>;
}

/** 观测目标库 */
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
      version: 1,
      remark: input.remark?.trim() || undefined,
    };
    await persistRow('targets', target);
    set({ targets: [...get().targets, target].sort((a, b) => a.name.localeCompare(b.name)) });
    return target;
  },

  updateTarget: async (id, patch) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) return { target: null as unknown as ObsTarget, versionBumped: false };
    // 坐标或高度门槛变更时递增目标数据版本，排程段据此失效重算
    const versionBumped = TARGET_VERSION_FIELDS.some((field) => field in patch && patch[field] !== current[field]);
    const next: ObsTarget = {
      ...current,
      ...patch,
      version: versionBumped ? current.version + 1 : current.version,
    };
    await persistRow('targets', next);
    set({ targets: get().targets.map((target) => (target.id === id ? next : target)) });
    return { target: next, versionBumped };
  },

  removeTarget: async (id) => {
    await deleteRow('targets', id);
    set({ targets: get().targets.filter((target) => target.id !== id) });
  },
}));
