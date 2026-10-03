import type { ObsNight, ObsSession, ObsTarget, SuspensionReason } from '../types';
import { altitudeAt, overlapMinutes } from './astro';

/** 版本核对结果：排程段快照版本与目标库当前版本不一致 */
export interface VersionMismatch {
  sessionId: string;
  targetId: string;
  targetName: string;
  /** 排程段快照的目标版本 */
  sessionVersion: number;
  /** 目标库当前版本（目标已删除时为 -1） */
  currentVersion: number;
  reason: SuspensionReason;
}

/** 容量核对结果：排程段能否迁入目标夜 */
export interface CapacityResult {
  /** 是否排得下（目标夜该望远镜时段无冲突） */
  fits: boolean;
  /** 排不下时距可用容量还差的分钟数（重叠时长） */
  deficitMinutes: number;
  /** 与之冲突的排程段 id */
  conflictingSessionIds: string[];
}

/** 失效重算结果 */
export interface InvalidationResult {
  /** 仍达标的排程段（更新快照版本，保留原状态） */
  revalidated: ObsSession[];
  /** 不达标的排程段（挂起，等待换夜或排队） */
  suspended: ObsSession[];
}

/** 不参与失效重算的状态：已完成 / 因云取消 / 已挂起 */
const INVALIDATION_SKIP_STATUSES = new Set(['已完成', '因云取消', '挂起']);

/** 不占用夜容量的状态：因云取消 / 挂起 */
const NON_BLOCKING_STATUSES = new Set(['因云取消', '挂起']);

/**
 * 按目标编号核对在用版本：排程段快照的 targetVersion 与目标库当前 version 对不上即挂起等确认。
 * 已完成 / 因云取消的排程段不参与核对（复核过的照旧保留）。
 */
export function reconcileVersions(targets: ObsTarget[], sessions: ObsSession[]): VersionMismatch[] {
  const targetMap = new Map(targets.map((target) => [target.id, target]));
  const mismatches: VersionMismatch[] = [];
  for (const session of sessions) {
    if (INVALIDATION_SKIP_STATUSES.has(session.status)) continue;
    // 复核过的排程段照旧保留，不参与版本核对
    if (session.reviewed) continue;
    const target = targetMap.get(session.targetId);
    if (!target) {
      mismatches.push({
        sessionId: session.id,
        targetId: session.targetId,
        targetName: '未知目标',
        sessionVersion: session.targetVersion,
        currentVersion: -1,
        reason: '版本不一致',
      });
    } else if (session.targetVersion !== target.version) {
      mismatches.push({
        sessionId: session.id,
        targetId: session.targetId,
        targetName: target.name,
        sessionVersion: session.targetVersion,
        currentVersion: target.version,
        reason: '版本不一致',
      });
    }
  }
  return mismatches;
}

/**
 * 目标坐标或高度门槛变更后，对引用该目标的在排程段做失效重算：
 * 按新数据重排，仍达标的更新快照版本保留原状态，不达标的挂起。
 * 评审组不替编排台删段，编排台也不回写目标库。
 */
export function invalidateForTarget(
  target: ObsTarget,
  sessions: ObsSession[],
  nights: ObsNight[],
): InvalidationResult {
  const nightMap = new Map(nights.map((night) => [night.id, night]));
  const revalidated: ObsSession[] = [];
  const suspended: ObsSession[] = [];

  for (const session of sessions) {
    if (session.targetId !== target.id) continue;
    if (INVALIDATION_SKIP_STATUSES.has(session.status)) continue;
    // 复核过的排程段照旧保留，不参与失效重算（版本也不更新）
    if (session.reviewed) continue;
    const night = nightMap.get(session.nightId);
    if (!night) {
      suspended.push({ ...session, status: '挂起', suspensionReason: '版本不一致' });
      continue;
    }
    const sessionDate = new Date(`${night.date}T${session.startTime}:00`);
    const alt = altitudeAt(target, sessionDate, night.siteLat, night.siteLng);
    if (alt < target.minAltitude) {
      suspended.push({ ...session, status: '挂起', suspensionReason: '低于高度门槛' });
    } else {
      revalidated.push({ ...session, targetVersion: target.version });
    }
  }
  return { revalidated, suspended };
}

/**
 * 容量核对：排程段迁入目标夜时，该望远镜在目标时段是否已被占用。
 * 排不下则排队，差额为重叠分钟数。
 */
export function checkNightCapacity(
  session: ObsSession,
  targetNight: ObsNight,
  sessions: ObsSession[],
): CapacityResult {
  const conflicts = sessions.filter(
    (other) =>
      other.nightId === targetNight.id &&
      other.telescopeId === session.telescopeId &&
      other.id !== session.id &&
      !NON_BLOCKING_STATUSES.has(other.status),
  );
  const conflictingSessionIds: string[] = [];
  let maxOverlap = 0;
  for (const other of conflicts) {
    const overlap = overlapMinutes(session.startTime, session.endTime, other.startTime, other.endTime);
    if (overlap > 0) {
      conflictingSessionIds.push(other.id);
      maxOverlap = Math.max(maxOverlap, overlap);
    }
  }
  return {
    fits: conflictingSessionIds.length === 0,
    deficitMinutes: maxOverlap,
    conflictingSessionIds: conflictingSessionIds,
  };
}

/**
 * 生成排队记录文案：写明距可用容量还差多少分钟。
 */
export function formatDeficit(deficitMinutes: number): string {
  if (deficitMinutes <= 0) return '排得下';
  const h = Math.floor(deficitMinutes / 60);
  const m = deficitMinutes % 60;
  if (h > 0 && m > 0) return `还差 ${h}h${m}m`;
  if (h > 0) return `还差 ${h}h`;
  return `还差 ${m} 分钟`;
}
