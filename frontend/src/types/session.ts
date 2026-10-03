/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消' | '挂起';

/** 挂起原因：低于高度门槛 / 版本不一致（等确认） */
export type SuspensionReason = '低于高度门槛' | '版本不一致';

/** 观测排程段 */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 排程时快照的目标数据版本：与目标库按编号核对，对不上先挂着等确认 */
  targetVersion: number;
  /** 挂起原因（status 为「挂起」时填写） */
  suspensionReason?: SuspensionReason;
  /** 排队时距目标夜可用容量还差的分钟数 */
  deficitMinutes?: number;
  /** 复核标记：复核过的排程段在升级时照旧保留，不被失效重算 */
  reviewed?: boolean;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消', '挂起'];

/** 5 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
  挂起: 'warning',
};
