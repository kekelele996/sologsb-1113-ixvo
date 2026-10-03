import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import ConflictBadge from '../components/common/ConflictBadge';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { FILTER_NAMES, SESSION_STATUSES, type ObsSession, type SessionStatus } from '../types';
import { axisMinutes, durationMinutes, formatMinutes } from '../utils/astro';
import { freeCapacity, planMoveToNight, sessionVersionState } from '../utils/scheduling';

interface SessionFormState {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason: string;
}

/** 可由编排台「核对 / 换夜」的状态（已完成与因云取消的不动） */
const REVIEWABLE: readonly SessionStatus[] = ['待执行', '进行中', '挂起', '排队'];

/** 排程段列表与冲突检测结果，支持批量改期到备用观测夜 */
export default function SessionsPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const addSession = useSessionStore((s) => s.addSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const rescheduleToBackup = useSessionStore((s) => s.rescheduleToBackup);
  const confirmSessions = useSessionStore((s) => s.confirmSessions);
  const moveSessions = useSessionStore((s) => s.moveSessions);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const { findConflicts, conflictIds } = useConflictCheck();

  /** 支持从设备分配视图一键跳转：?night=<夜ID>&highlight=<排程段ID> */
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight') ?? '';
  const nightParam = searchParams.get('night') ?? '';
  const [nightFilter, setNightFilter] = useState(nightParam || '全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [onlyConflict, setOnlyConflict] = useState(false);
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleNight, setRescheduleNight] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveNight, setMoveNight] = useState('');
  const [moveNote, setMoveNote] = useState('');
  const [form, setForm] = useState<SessionFormState>({
    nightId: '',
    targetId: '',
    startTime: '20:00',
    endTime: '21:00',
    telescopeId: '',
    instrumentId: '',
    filterSlot: 'L',
    plannedFrames: 30,
    status: '待执行',
    rescheduleReason: '',
  });

  const conflictSet = useMemo(() => conflictIds(), [conflictIds]);
  const backupNights = useMemo(() => nights.filter((night) => night.backup), [nights]);
  const targetsById = useMemo(() => new Map(targets.map((target) => [target.id, target])), [targets]);
  /** 各夜剩余容量（挂起 / 排队 / 取消 / 已完成不占容量） */
  const freeByNight = useMemo(() => new Map(nights.map((night) => [night.id, freeCapacity(night, sessions)])), [nights, sessions]);

  const visible = useMemo(() => {
    return [...sessions]
      .filter((session) => {
        if (nightFilter !== '全部' && session.nightId !== nightFilter && session.queueNightId !== nightFilter) return false;
        if (statusFilter !== '全部' && session.status !== statusFilter) return false;
        if (onlyConflict && !conflictSet.has(session.id)) return false;
        if (onlyHeld && session.status !== '挂起' && session.status !== '排队') return false;
        return true;
      })
      .sort((a, b) => a.nightId.localeCompare(b.nightId) || axisMinutes(a.startTime) - axisMinutes(b.startTime));
  }, [sessions, nightFilter, statusFilter, onlyConflict, onlyHeld, conflictSet]);

  /** 挂起 + 排队待编排台处理的数量 */
  const heldCount = sessions.filter((session) => session.status === '挂起' || session.status === '排队').length;

  const telescopeById = (id: string) => telescopes.find((item) => item.id === id);
  const instrumentById = (id: string) => instruments.find((item) => item.id === id);
  const nightById = (id?: string) => nights.find((night) => night.id === id);

  const liveConflicts = useMemo(() => {
    if (!dialogOpen) return [];
    return findConflicts({
      nightId: form.nightId,
      telescopeId: form.telescopeId,
      startTime: form.startTime,
      endTime: form.endTime,
      ignoreSessionId: editingId || undefined,
    });
  }, [dialogOpen, findConflicts, form.nightId, form.telescopeId, form.startTime, form.endTime, editingId]);

  const formDuration = durationMinutes(form.startTime, form.endTime);
  const formFree = form.nightId ? freeByNight.get(form.nightId) ?? 0 : 0;
  const formOverCapacity = dialogOpen && formDuration > 0 && form.status !== '已完成' && form.status !== '因云取消' && formDuration > formFree;

  /** 换夜预演：选中段在目标夜逐段套容量，给出排入 / 排队（缺口）/ 挂起明细 */
  const movePlan = useMemo(() => {
    if (!moveOpen || !moveNight) return undefined;
    const targetNight = nightById(moveNight);
    if (!targetNight) return undefined;
    const picked = visible.filter((session) => selected.includes(session.id));
    return planMoveToNight(picked, targetNight, targetsById, sessions);
  }, [moveOpen, moveNight, visible, selected, targetsById, sessions]);

  function openCreate() {
    setEditingId('');
    setError('');
    const night = nights.find((item) => item.primary) ?? nights[0];
    const telescope = telescopes.find((item) => item.status === '可用') ?? telescopes[0];
    const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
    setForm({
      nightId: night?.id ?? '',
      targetId: targets[0]?.id ?? '',
      startTime: '20:00',
      endTime: '21:00',
      telescopeId: telescope?.id ?? '',
      instrumentId: instrument?.id ?? '',
      filterSlot: 'L',
      plannedFrames: 30,
      status: '待执行',
      rescheduleReason: '',
    });
    setDialogOpen(true);
  }

  function openEdit(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    setEditingId(id);
    setError('');
    setForm({
      nightId: session.nightId,
      targetId: session.targetId,
      startTime: session.startTime,
      endTime: session.endTime,
      telescopeId: session.telescopeId,
      instrumentId: session.instrumentId,
      filterSlot: session.filterSlot,
      plannedFrames: session.plannedFrames,
      status: session.status,
      rescheduleReason: session.rescheduleReason ?? '',
    });
    setDialogOpen(true);
  }

  async function submit() {
    if (!form.nightId || !form.targetId || !form.telescopeId) {
      setError('观测夜、目标与望远镜均为必填');
      return;
    }
    if (formDuration <= 0) {
      setError('结束时刻必须晚于开始时刻');
      return;
    }
    if (liveConflicts.length > 0) {
      setError('该望远镜在所选时段已有排程，请调整时段或改期到备用观测夜');
      return;
    }
    if (formOverCapacity) {
      setError(`该夜仅剩 ${formFree} 分钟可排容量，本段需要 ${formDuration} 分钟；请换夜或保存后转排队`);
      return;
    }
    if (editingId) {
      await updateSession(editingId, { ...form, rescheduleReason: form.rescheduleReason });
      setNotice('已更新排程段');
    } else {
      await addSession({ ...form, rescheduleReason: form.rescheduleReason });
      setNotice('已新增排程段');
    }
    setDialogOpen(false);
  }

  async function submitReschedule() {
    if (!rescheduleNight) {
      setError('请选择备用观测夜');
      return;
    }
    const count = await rescheduleToBackup(selected, rescheduleNight, rescheduleReason);
    setNotice(`已将 ${count} 个排程段标记因云取消并改期至 ${nightById(rescheduleNight)?.date ?? rescheduleNight}，原因：${rescheduleReason || '未填写'}`);
    setSelected([]);
    setRescheduleOpen(false);
    setRescheduleReason('');
  }

  async function submitConfirm(ids: string[]) {
    const results = await confirmSessions(ids);
    const failed = results.filter((result) => !result.ok);
    if (failed.length === 0) {
      setNotice(`已核对 ${results.length} 个排程段：按现用数据复核通过，版本快照已刷新并恢复为待执行`);
    } else if (failed.length === results.length) {
      setNotice(`核对的 ${results.length} 个排程段均不达标，保持挂起：${failed.map((item) => `${item.id}（${item.reason}）`).join('；')}`);
    } else {
      setNotice(`核对完成：${results.length - failed.length} 段通过恢复，${failed.length} 段不达标保持挂起（${failed.map((item) => item.id).join('、')}）`);
    }
    setSelected((prev) => prev.filter((id) => !ids.includes(id)));
  }

  async function submitMove() {
    if (!moveNight) {
      setError('请选择目标观测夜');
      return;
    }
    const result = await moveSessions(selected, moveNight, moveNote);
    if (!result) {
      setError('目标观测夜不存在');
      return;
    }
    const parts = [`已处理 ${result.items.length} 个排程段 → ${result.targetNight.date}`];
    if (result.moveCount) parts.push(`${result.moveCount} 段排入`);
    if (result.queueCount) {
      parts.push(`${result.queueCount} 段容量不足转排队（${result.items.filter((item) => item.decision === 'queue').map((item) => `${item.sessionId} 差 ${item.shortfallMinutes} 分钟`).join('，')}）`);
    }
    if (result.holdCount) parts.push(`${result.holdCount} 段按新数据不达标保持挂起`);
    setNotice(parts.join('；'));
    setSelected([]);
    setMoveOpen(false);
    setMoveNote('');
  }

  function versionCell(session: ObsSession) {
    const target = targetsById.get(session.targetId);
    const state = sessionVersionState(session, target);
    if (state === 'target-missing') {
      return <Chip size="small" color="error" label="目标缺失" />;
    }
    if (state === 'stale' || state === 'snapshot-missing') {
      return (
        <Chip
          size="small"
          color="warning"
          variant="outlined"
          label={`v${session.targetVersion ?? '?'}→v${target?.dataVersion}`}
          onClick={() => void submitConfirm([session.id])}
        />
      );
    }
    return <Chip size="small" variant="outlined" label={`v${session.targetVersion}`} />;
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        排程段列表与冲突检测
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        评审组改坐标或高度门槛后，版本对不上 / 不达标的排程段先挂起，由编排台核对后恢复，或换到其他夜；目标夜容量有限，排不下的转排队并写明缺口分钟数。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      {heldCount > 0 ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          当前有 {heldCount} 个排程段挂起 / 排队，等待编排台处理：{' '}
          {sessions
            .filter((session) => session.status === '挂起' || session.status === '排队')
            .map((session) => session.id)
            .join('、')}
        </Alert>
      ) : null}

      {highlightId ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          已从设备分配视图定位到排程段 <strong>{highlightId}</strong>（对应行已用左侧红条标出）
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增排程段
        </Button>
        <Button variant="outlined" color="warning" disabled={selected.length === 0} onClick={() => setRescheduleOpen(true)}>
          因云改期（已选 {selected.length}）
        </Button>
        <Button variant="outlined" color="primary" disabled={selected.length === 0} onClick={() => setMoveOpen(true)}>
          换到其他夜 / 排队（已选 {selected.length}）
        </Button>
        <Button variant="outlined" disabled={selected.length === 0} onClick={() => void submitConfirm(selected)}>
          核对选中（已选 {selected.length}）
        </Button>
        <TextField select size="small" label="观测夜" value={nightFilter} onChange={(event) => setNightFilter(event.target.value)} sx={{ minWidth: 200 }}>
          {['全部', ...nights.map((night) => night.id)].map((id) => (
            <MenuItem key={id} value={id}>
              {id === '全部'
                ? '全部'
                : `${nightById(id)?.date ?? id}${nightById(id)?.primary ? '（主夜）' : '（备用夜）'} · 余 ${freeByNight.get(id) ?? 0} 分钟`}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 140 }}>
          {['全部', ...SESSION_STATUSES].map((status) => (
            <MenuItem key={status} value={status}>
              {status}
            </MenuItem>
          ))}
        </TextField>
        <Button variant={onlyConflict ? 'contained' : 'outlined'} color="error" onClick={() => setOnlyConflict((value) => !value)}>
          仅看冲突（{conflictSet.size} 段）
        </Button>
        <Button variant={onlyHeld ? 'contained' : 'outlined'} color="warning" onClick={() => setOnlyHeld((value) => !value)}>
          仅看挂起 / 排队（{heldCount} 段）
        </Button>
        <Chip size="small" label={`命中 ${visible.length} / ${sessions.length}`} />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={visible.length > 0 && selected.length === visible.length}
                  onChange={(event) => setSelected(event.target.checked ? visible.map((session) => session.id) : [])}
                />
              </TableCell>
              <TableCell>观测夜</TableCell>
              <TableCell>时段</TableCell>
              <TableCell>目标 / 版本</TableCell>
              <TableCell>望远镜 / 终端</TableCell>
              <TableCell>滤镜</TableCell>
              <TableCell align="right">帧数</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>冲突</TableCell>
              <TableCell>挂起 / 排队 / 改期</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((session) => {
              const conflicts = findConflicts({
                nightId: session.nightId,
                telescopeId: session.telescopeId,
                startTime: session.startTime,
                endTime: session.endTime,
                ignoreSessionId: session.id,
              });
              const target = targetsById.get(session.targetId);
              return (
                <TableRow
                  key={session.id}
                  hover
                  selected={selected.includes(session.id)}
                  sx={{
                    ...(session.id === highlightId ? { boxShadow: 'inset 4px 0 0 #d32f2f' } : undefined),
                    ...(session.status === '挂起' ? { bgcolor: 'warning.50' } : session.status === '排队' ? { bgcolor: 'info.50' } : undefined),
                  }}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(session.id)}
                      onChange={(event) =>
                        setSelected((prev) => (event.target.checked ? [...prev, session.id] : prev.filter((id) => id !== session.id)))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {nightById(session.nightId)?.date ?? session.nightId}
                    {session.queueNightId ? (
                      <Typography variant="caption" color="info.main" sx={{ display: 'block' }}>
                        拟转 {nightById(session.queueNightId)?.date ?? session.queueNightId}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {session.startTime}-{session.endTime}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {formatMinutes(durationMinutes(session.startTime, session.endTime))}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="body2">{target?.name ?? '未知目标'}</Typography>
                      {versionCell(session)}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {telescopeById(session.telescopeId)?.code ?? '-'} / {instrumentById(session.instrumentId)?.model ?? '-'}
                  </TableCell>
                  <TableCell>{session.filterSlot}</TableCell>
                  <TableCell align="right">{session.plannedFrames}</TableCell>
                  <TableCell>
                    <StatusChip status={session.status} />
                  </TableCell>
                  <TableCell>
                    <ConflictBadge conflicts={conflicts} compact />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 280 }}>
                    {session.status === '排队' ? (
                      <Chip size="small" color="info" label={`排队中，还差 ${session.queueShortfallMinutes ?? 0} 分钟`} sx={{ mb: 0.5 }} />
                    ) : null}
                    {session.suspendReason ? (
                      <Typography variant="caption" color="warning.main">
                        {session.suspendReason}
                      </Typography>
                    ) : session.rescheduleReason ? (
                      <Typography variant="caption">{session.rescheduleReason}</Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        -
                      </Typography>
                    )}
                    {session.backupNightId ? (
                      <Chip size="small" variant="outlined" label={`替补 ${nightById(session.backupNightId)?.date ?? session.backupNightId}`} sx={{ ml: 0.5 }} />
                    ) : null}
                  </TableCell>
                  <TableCell align="right">
                    {REVIEWABLE.includes(session.status) ? (
                      <Button size="small" color="primary" onClick={() => void submitConfirm([session.id])}>
                        核对
                      </Button>
                    ) : null}
                    <Button size="small" onClick={() => openEdit(session.id)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => void removeSession(session.id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? '编辑排程段' : '新增排程段'}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          {liveConflicts.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              该望远镜在所选时段已有 {liveConflicts.length} 段排程：
              {liveConflicts.map((conflict) => ` ${conflict.otherId}（${conflict.overlapText}）`).join('；')}
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mb: 1.5 }}>
              时段校验通过，该望远镜此时段空闲
            </Alert>
          )}
          {formOverCapacity ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              本段 {formDuration} 分钟，目标夜仅剩 {formFree} 分钟容量：保存前请换夜，否则需保存后转排队。
            </Alert>
          ) : null}
          <FieldRow label="观测夜" required>
            <TextField select size="small" fullWidth value={form.nightId} onChange={(event) => setForm({ ...form, nightId: event.target.value })}>
              {nights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.siteName}${night.primary ? '（主夜）' : night.backup ? '（备用夜）' : ''} · 余 ${freeByNight.get(night.id) ?? 0}/${night.capacityMinutes} 分钟`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="观测目标" required hint="保存时自动快照目标当前数据版本，之后按目标编号核对">
            <TextField select size="small" fullWidth value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })}>
              {targets.map((target) => (
                <MenuItem key={target.id} value={target.id}>
                  {`${target.name}（${target.catalog}）· ${target.magnitude} 等 · 数据 v${target.dataVersion}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="开始时刻" required hint="格式 HH:mm，可跨零点">
            <TextField size="small" fullWidth value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} placeholder="20:00" />
          </FieldRow>
          <FieldRow label="结束时刻" required>
            <TextField size="small" fullWidth value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} placeholder="21:30" />
          </FieldRow>
          <FieldRow label="望远镜" required>
            <TextField
              select
              size="small"
              fullWidth
              value={form.telescopeId}
              onChange={(event) => {
                const telescope = telescopes.find((item) => item.id === event.target.value);
                const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
                setForm({ ...form, telescopeId: event.target.value, instrumentId: instrument?.id ?? '' });
              }}
            >
              {telescopes.map((telescope) => (
                <MenuItem key={telescope.id} value={telescope.id}>
                  {`${telescope.code} · ${telescope.apertureMm}mm f/${(telescope.focalLengthMm / telescope.apertureMm).toFixed(1)} · ${telescope.status}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="终端">
            <TextField select size="small" fullWidth value={form.instrumentId} onChange={(event) => setForm({ ...form, instrumentId: event.target.value })}>
              {instruments
                .filter((instrument) => instrument.telescopeCode === telescopeById(form.telescopeId)?.code)
                .map((instrument) => (
                  <MenuItem key={instrument.id} value={instrument.id}>
                    {`${instrument.model} · ${instrument.terminalType}`}
                  </MenuItem>
                ))}
            </TextField>
          </FieldRow>
          <FieldRow label="滤镜轮位">
            <TextField select size="small" fullWidth value={form.filterSlot} onChange={(event) => setForm({ ...form, filterSlot: event.target.value })}>
              {FILTER_NAMES.map((filter) => (
                <MenuItem key={filter} value={filter}>
                  {filter}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="计划帧数" required>
            <TextField size="small" type="number" fullWidth value={form.plannedFrames} onChange={(event) => setForm({ ...form, plannedFrames: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="状态">
            <TextField select size="small" fullWidth value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SessionStatus })}>
              {SESSION_STATUSES.map((status) => (
                <MenuItem key={status} value={status}>
                  {status}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因">
            <TextField size="small" fullWidth multiline minRows={2} value={form.rescheduleReason} onChange={(event) => setForm({ ...form, rescheduleReason: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submit()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={rescheduleOpen} onClose={() => setRescheduleOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>因云改期到备用观测夜</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            已选 {selected.length} 个排程段，改期后状态置为「因云取消」并记录替补夜与改期原因（段保留，不删除）。
          </Alert>
          <FieldRow label="备用观测夜" required>
            <TextField select size="small" fullWidth value={rescheduleNight} onChange={(event) => setRescheduleNight(event.target.value)}>
              {backupNights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.cloudText} · 月相 ${night.moonPhasePct}% · ${night.dutyOfficer}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因" required hint="例如：夜间云量转多云，目标被云遮挡">
            <TextField size="small" fullWidth multiline minRows={2} value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRescheduleOpen(false)}>取消</Button>
          <Button variant="contained" color="warning" onClick={() => void submitReschedule()}>
            确认改期
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={moveOpen} onClose={() => setMoveOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>换到其他夜（容量不足自动排队）</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          <Alert severity="info" sx={{ mb: 1.5 }}>
            已选 {selected.length} 个排程段。按目标夜剩余容量逐段处理：装得下的改挂该夜并恢复待执行；装不下的转「排队」并写明还差多少分钟；按新数据在目标夜仍不达标的保持挂起。
          </Alert>
          <FieldRow label="目标观测夜" required>
            <TextField select size="small" fullWidth value={moveNight} onChange={(event) => setMoveNight(event.target.value)}>
              {nights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.siteName}${night.backup ? '（备用夜）' : ''} · 余 ${freeByNight.get(night.id) ?? 0}/${night.capacityMinutes} 分钟`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          {movePlan ? (
            <Box sx={{ mb: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap">
                <Chip size="small" color="success" label={`可排入 ${movePlan.moveCount} 段`} />
                <Chip size="small" color="info" label={movePlan.queueCount ? `排队 ${movePlan.queueCount} 段` : '无排队'} />
                <Chip size="small" color="warning" label={movePlan.holdCount ? `不达标挂起 ${movePlan.holdCount} 段` : '全部达标'} />
              </Stack>
              {movePlan.items.map((item) => {
                const session = sessions.find((entry) => entry.id === item.sessionId);
                return (
                  <Typography key={item.sessionId} variant="caption" display="block" color={item.decision === 'hold' ? 'warning.main' : item.decision === 'queue' ? 'info.main' : 'success.main'}>
                    {item.sessionId}（{targetsById.get(session?.targetId ?? '')?.name ?? '?'}，{item.duration} 分钟）：
                    {item.decision === 'move'
                      ? '排入'
                      : item.decision === 'queue'
                        ? `排队，还差 ${item.shortfallMinutes} 分钟`
                        : `保持挂起：${item.holdReason}`}
                  </Typography>
                );
              })}
            </Box>
          ) : null}
          <FieldRow label="备注">
            <TextField size="small" fullWidth multiline minRows={2} value={moveNote} onChange={(event) => setMoveNote(event.target.value)} placeholder="可选：换夜原因，会附在排队 / 改期说明后" />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submitMove()}>
            确认换夜
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
