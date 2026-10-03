import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useNightStore } from '../stores/nightStore';
import { useSessionStore } from '../stores/sessionStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import type { ObsSession } from '../types';
import { checkNightCapacity, formatDeficit } from '../utils/version';
import { durationMinutes, formatMinutes } from '../utils/astro';

export interface SuspensionDialogProps {
  open: boolean;
  onClose: () => void;
  session: ObsSession | null;
  targetName: string;
}

/**
 * 挂起排程段处理对话框：编排台决定换到别的夜还是排队。
 * 换夜时做容量核对，排不下则排队并写明还差多少分钟。
 */
export default function SuspensionDialog({ open, onClose, session, targetName }: SuspensionDialogProps) {
  const nights = useNightStore((s) => s.nights);
  const sessions = useSessionStore((s) => s.sessions);
  const moveToNight = useSessionStore((s) => s.moveToNight);
  const queueSession = useSessionStore((s) => s.queueSession);
  const telescopes = useEquipmentStore((s) => s.telescopes);

  const [targetNightId, setTargetNightId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const candidateNights = useMemo(
    () => nights.filter((night) => night.id !== session?.nightId),
    [nights, session?.nightId],
  );

  const targetNight = nights.find((night) => night.id === targetNightId);
  const telescope = telescopes.find((item) => item.id === session?.telescopeId);

  const capacity = useMemo(() => {
    if (!session || !targetNight) return null;
    return checkNightCapacity(session, targetNight, sessions);
  }, [session, targetNight, sessions]);

  useEffect(() => {
    if (open) {
      setTargetNightId('');
      setError('');
      setNotice('');
    }
  }, [open]);

  if (!session) return null;

  const duration = durationMinutes(session.startTime, session.endTime);

  async function handleMove() {
    if (!targetNightId) {
      setError('请选择要迁入的观测夜');
      return;
    }
    const result = await moveToNight(session!.id, targetNightId);
    if (result.moved) {
      setNotice(`已迁入 ${targetNight?.date ?? ''}，排程段恢复待执行`);
      setTimeout(onClose, 1200);
    } else {
      setError(`目标夜容量不足，${formatDeficit(result.deficitMinutes)}，已排队`);
    }
  }

  async function handleQueue() {
    const deficit = capacity?.fits === false ? capacity.deficitMinutes : 0;
    await queueSession(session!.id, deficit);
    setNotice(`已排队${deficit > 0 ? `，${formatDeficit(deficit)}` : ''}`);
    setTimeout(onClose, 1200);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>处理挂起排程段</DialogTitle>
      <DialogContent>
        {error ? (
          <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError('')}>
            {error}
          </Alert>
        ) : null}
        {notice ? (
          <Alert severity="success" sx={{ mb: 1.5 }}>
            {notice}
          </Alert>
        ) : null}

        <Stack spacing={1} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Typography variant="subtitle2">{targetName}</Typography>
            <Chip size="small" label={`${session.startTime}-${session.endTime}`} />
            <Chip size="small" variant="outlined" label={formatMinutes(duration)} />
            <Chip size="small" variant="outlined" label={telescope?.code ?? session.telescopeId} />
          </Stack>
          <Chip size="small" color="warning" label={`挂起原因：${session.suspensionReason ?? '待确认'}`} sx={{ alignSelf: 'flex-start' }} />
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          编排台决定：换到别的夜，或排队等后续安排。评审组不替编排台删段，编排台也不回写目标库。
        </Typography>

        <TextField
          select
          size="small"
          fullWidth
          label="迁入观测夜"
          value={targetNightId}
          onChange={(event) => {
            setTargetNightId(event.target.value);
            setError('');
          }}
          sx={{ mb: 1.5 }}
        >
          {candidateNights.map((night) => (
            <MenuItem key={night.id} value={night.id}>
              {`${night.date} · ${night.siteName} · ${night.cloudText} · 月相 ${night.moonPhasePct}%${night.primary ? '（主夜）' : night.backup ? '（备用夜）' : ''}`}
            </MenuItem>
          ))}
        </TextField>

        {targetNight && capacity ? (
          <Alert severity={capacity.fits ? 'success' : 'warning'} sx={{ mb: 1.5 }}>
            {capacity.fits
              ? `容量核对通过：${targetNight.date} 该望远镜此时段空闲，可迁入`
              : `容量不足：${targetNight.date} 该望远镜此时段已排，${formatDeficit(capacity.deficitMinutes)}，将排队`}
          </Alert>
        ) : null}

        {session.deficitMinutes && session.deficitMinutes > 0 ? (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            排队记录：{formatDeficit(session.deficitMinutes)}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={handleQueue} color="inherit">
          排队
        </Button>
        <Button variant="contained" onClick={handleMove} disabled={!targetNightId}>
          迁入所选夜
        </Button>
      </DialogActions>
    </Dialog>
  );
}
