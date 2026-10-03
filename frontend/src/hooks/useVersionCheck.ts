import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import type { VersionMismatch } from '../utils/version';

/**
 * 装载后按目标编号核对在用版本：排程段快照版本与目标库当前版本对不上即挂起等确认。
 * 自动把不一致的在排程段置为「挂起」，返回不一致项列表。
 */
export function useVersionCheck(): { mismatches: VersionMismatch[]; checking: boolean } {
  const targets = useTargetStore((s) => s.targets);
  const sessions = useSessionStore((s) => s.sessions);
  const checkVersions = useSessionStore((s) => s.checkVersions);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const [mismatches, setMismatches] = useState<VersionMismatch[]>([]);
  const [checking, setChecking] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (targets.length === 0 || sessions.length === 0) {
      setMismatches([]);
      return;
    }
    setChecking(true);
    const result = checkVersions(targets);
    setMismatches(result);
    // 自动挂起不一致的在排程段（仅首次装载时执行，避免重复挂起）
    if (!checkedRef.current && result.length > 0) {
      checkedRef.current = true;
      for (const mismatch of result) {
        void suspendSession(mismatch.sessionId, mismatch.reason);
      }
    }
    setChecking(false);
  }, [targets, sessions, checkVersions, suspendSession]);

  return { mismatches, checking };
}
