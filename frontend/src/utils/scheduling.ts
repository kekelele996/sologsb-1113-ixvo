import type { ObsNight, ObsSession, ObsTarget } from '../types';
import { altitudeAt, axisMinutes, durationMinutes } from './astro';

/** 占用夜容量、参与设备冲突判定的活跃状态（已完成 / 因云取消 / 挂起 / 排队 均不占容量） */
export const ACTIVE_STATUSES = ['待执行', '进行中'] as const;

/** 仍可被评审组数据变更打回、由编排台重新决定的状态（已完成的不动、因云取消的不改判） */
export const RECOMPUTABLE_STATUSES = ['待执行', '进行中', '挂起', '排队'] as const;

export function isActiveStatus(status: ObsSession['status']): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** 排程段版本与目标在用版本的核对结果 */
export type VersionState = 'snapshot-missing' | 'target-missing' | 'match' | 'stale';

/** 两边按目标编号核对在用版本：对不上（含旧数据无版本快照）先挂着等确认 */
export function sessionVersionState(session: Pick<ObsSession, 'targetId' | 'targetVersion'>, target: ObsTarget | undefined): VersionState {
  if (!target) return 'target-missing';
  if (session.targetVersion === undefined) return 'snapshot-missing';
  return session.targetVersion === target.dataVersion ? 'match' : 'stale';
}

/** 该夜已占用容量（分钟）：只统计活跃排程段，排队 / 挂起 / 取消 / 已完成均不占 */
export function occupiedCapacity(sessions: ObsSession[], nightId: string): number {
  return sessions
    .filter((session) => session.nightId === nightId && isActiveStatus(session.status))
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

/** 该夜剩余可排容量（分钟）；旧数据没有容量字段时按整夜 600 分钟兜底 */
export function freeCapacity(night: ObsNight, sessions: ObsSession[]): number {
  const capacity = Number.isFinite(night.capacityMinutes) ? night.capacityMinutes : 600;
  return Math.max(0, capacity - occupiedCapacity(sessions, night.id));
}

/** 复核结果：按当前目标 / 夜数据重算排程段是否仍成立 */
export interface RecheckResult {
  ok: boolean;
  /** 复核时刻区间内的最小高度角（度） */
  minAltitude?: number;
  /** 不达标原因（ok=false 时给出） */
  reason?: string;
}

/**
 * 按新数据复核一段排程：按段的起止时刻每 10 分钟采样地平高度角，
 * 任一点低于目标最低高度门槛即判不达标（段落在可见窗口之外也在此暴露）。
 */
export function recheckSession(
  session: Pick<ObsSession, 'targetId' | 'startTime' | 'endTime'>,
  target: ObsTarget | undefined,
  night: ObsNight | undefined,
): RecheckResult {
  if (!target) return { ok: false, reason: '目标库中已找不到该目标编号，需编排台人工确认' };
  if (!night) return { ok: false, reason: '原观测夜不存在，需换到别的夜' };
  const span = durationMinutes(session.startTime, session.endTime);
  if (span <= 0) return { ok: false, reason: '排程时段非法（结束不晚于开始）' };
  const base = new Date(`${night.date}T18:00:00`);
  const startAxis = axisMinutes(session.startTime);
  let minAltitude = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= span; offset += 10) {
    const date = new Date(base.getTime() + (startAxis + offset) * 60_000);
    const altitude = altitudeAt(target, date, night.siteLat, night.siteLng);
    if (altitude < minAltitude) minAltitude = altitude;
    if (altitude < target.minAltitude) {
      return {
        ok: false,
        minAltitude: altitude,
        reason: `按新数据复核：该段在 ${date.toTimeString().slice(0, 5)} 高度仅 ${altitude}°，低于门槛 ${target.minAltitude}°`,
      };
    }
  }
  return { ok: true, minAltitude: Number.isFinite(minAltitude) ? minAltitude : undefined };
}

/** 单段换夜预演结论 */
export type MoveDecision = 'move' | 'queue' | 'hold';

export interface MovePlanItem {
  sessionId: string;
  decision: MoveDecision;
  /** 排入（或排队目标）夜 ID */
  nightId: string;
  /** 段时长（分钟） */
  duration: number;
  /** 排队缺口（分钟）：decision=queue 时，距离排入目标夜还差多少分钟 */
  shortfallMinutes: number;
  /** 复核不达标原因（decision=hold 时） */
  holdReason?: string;
}

export interface MovePlan {
  items: MovePlanItem[];
  moveCount: number;
  queueCount: number;
  holdCount: number;
  /** 目标夜排入前的空闲容量（分钟） */
  initialFreeMinutes: number;
}

/**
 * 换夜预演：按入参顺序逐段套目标夜容量——
 * 复核不达标的先挂起（hold）；装得下的排入（move）；装不下的排队（queue），写明缺口分钟数。
 * 排队段不占容量，缺口按「本段时长 − 当前剩余」计算。
 * 选中段原本就在目标夜且为活跃态的，其容量计入基线（不能因为被选中而凭空释放）。
 */
export function planMoveToNight(sessions: ObsSession[], targetNight: ObsNight, targetsById: Map<string, ObsTarget>, allSessions: ObsSession[]): MovePlan {
  // 容量基线 = 目标夜全部活跃段（含被选中但本来就在该夜的活跃段，其容量不能因被选中而凭空释放；
  // 被选中的挂起 / 排队段本就不活跃，自然不占基线）。
  const baseline = allSessions.filter((session) => session.nightId === targetNight.id && isActiveStatus(session.status));
  let free = freeCapacity(targetNight, baseline);
  const initialFreeMinutes = free;
  const items: MovePlanItem[] = [];
  for (const session of sessions) {
    const duration = durationMinutes(session.startTime, session.endTime);
    const recheck = recheckSession(session, targetsById.get(session.targetId), targetNight);
    if (!recheck.ok) {
      items.push({ sessionId: session.id, decision: 'hold', nightId: targetNight.id, duration, shortfallMinutes: 0, holdReason: recheck.reason });
      continue;
    }
    // 本来就在目标夜且仍活跃：容量已含在基线中，按 0 增量处理
    const alreadyPlaced = session.nightId === targetNight.id && isActiveStatus(session.status);
    const need = alreadyPlaced ? 0 : duration;
    if (need <= free) {
      free -= need;
      items.push({ sessionId: session.id, decision: 'move', nightId: targetNight.id, duration, shortfallMinutes: 0 });
    } else {
      items.push({ sessionId: session.id, decision: 'queue', nightId: targetNight.id, duration, shortfallMinutes: duration - free });
    }
  }
  return {
    items,
    moveCount: items.filter((item) => item.decision === 'move').length,
    queueCount: items.filter((item) => item.decision === 'queue').length,
    holdCount: items.filter((item) => item.decision === 'hold').length,
    initialFreeMinutes,
  };
}
