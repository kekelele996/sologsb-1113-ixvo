import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useTargetStore } from '../stores/targetStore';
import { useNightStore } from '../stores/nightStore';
import { FILTER_NAMES, PRIORITIES, TARGET_COLOR, TARGET_TYPES, type FilterName, type ObsTarget, type Priority, type TargetType } from '../types';
import { altitudeAt, formatMinutes, isBelowThreshold, moonConflict, visibilityWindow } from '../utils/astro';

interface TargetFormState {
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
  remark: string;
}

const EMPTY_FORM: TargetFormState = {
  name: '',
  catalog: '',
  raHours: 0,
  decDeg: 0,
  magnitude: 5,
  type: '星云',
  filter: 'L',
  exposureSec: 120,
  totalMinutes: 60,
  priority: 'P2',
  minAltitude: 30,
  remark: '',
};

/** 观测目标库：按类型与优先级筛选、按视星等排序、编辑地平高度阈值与曝光参数 */
export default function TargetsPage() {
  usePersistentStore();
  const targets = useTargetStore((s) => s.targets);
  const addTarget = useTargetStore((s) => s.addTarget);
  const updateTarget = useTargetStore((s) => s.updateTarget);
  const removeTarget = useTargetStore((s) => s.removeTarget);
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);

  const [typeFilter, setTypeFilter] = useState<string>('全部');
  const [priorityFilter, setPriorityFilter] = useState<string>('全部');
  const [sortByMagnitude, setSortByMagnitude] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<TargetFormState>(EMPTY_FORM);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const night = nights.find((item) => item.id === currentNightId) ?? nights.find((item) => item.primary) ?? nights[0];

  const visible = useMemo(() => {
    const list = targets.filter((target) => {
      if (typeFilter !== '全部' && target.type !== typeFilter) return false;
      if (priorityFilter !== '全部' && target.priority !== priorityFilter) return false;
      return true;
    });
    return sortByMagnitude ? [...list].sort((a, b) => a.magnitude - b.magnitude) : [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [targets, typeFilter, priorityFilter, sortByMagnitude]);

  const evaluationDate = useMemo(() => new Date(`${night?.date ?? '2025-10-11'}T22:00:00`), [night?.date]);

  function openCreate() {
    setEditingId('');
    setForm(EMPTY_FORM);
    setError('');
    setDialogOpen(true);
  }

  function openEdit(target: ObsTarget) {
    setEditingId(target.id);
    setError('');
    setForm({
      name: target.name,
      catalog: target.catalog,
      raHours: target.raHours,
      decDeg: target.decDeg,
      magnitude: target.magnitude,
      type: target.type,
      filter: target.filter,
      exposureSec: target.exposureSec,
      totalMinutes: target.totalMinutes,
      priority: target.priority,
      minAltitude: target.minAltitude,
      remark: target.remark ?? '',
    });
    setDialogOpen(true);
  }

  async function submit() {
    if (!form.name.trim()) {
      setError('目标名必填');
      return;
    }
    if (form.raHours < 0 || form.raHours > 24) {
      setError('赤经需在 0~24 小时之间');
      return;
    }
    if (form.decDeg < -90 || form.decDeg > 90) {
      setError('赤纬需在 -90~90 度之间');
      return;
    }
    if (editingId) {
      const result = await updateTarget(editingId, form);
      if (result?.schedulingChanged) {
        setNotice(
          `已更新目标 ${form.name}，数据版本升至 v${result.target.dataVersion}：编排台 ${result.suspendedCount} 个在途排程段已按新数据失效重算并挂起，由编排台核对或换夜（评审组不删段）`,
        );
      } else {
        setNotice(`已更新目标 ${form.name}（坐标 / 高度门槛未变，数据版本维持 v${result?.target.dataVersion ?? 1}）`);
      }
    } else {
      const target = await addTarget(form);
      setNotice(`已新增目标 ${form.name}，数据版本 v${target.dataVersion}`);
    }
    setDialogOpen(false);
  }

  function askRemove(target: ObsTarget) {
    // 评审组不替编排台删段：只从目标库移除，编排台相关段保留并在版本核对时按目标缺失挂起
    if (
      window.confirm(
        `删除目标 ${target.name} 只会从评审组目标库移除，编排台已排的段不会被删除：这些段核对时会因目标缺失挂起等确认。确认删除？`,
      )
    ) {
      void removeTarget(target.id).then(() => setNotice(`已从目标库删除 ${target.name}（编排台排程段保留）`));
    }
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        观测目标库
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        维护目标星表、视星等、推荐滤镜与曝光参数；地平高度阈值用于判断排程时是否标灰（评估时刻：夜间 22:00）。修改赤经 / 赤纬 / 高度门槛会令数据版本 +1，编排台在用排程段随即失效挂起重算，本页不会删除或回写任何排程段。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增目标
        </Button>
        <TextField select size="small" label="目标类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} sx={{ minWidth: 140 }}>
          {['全部', ...TARGET_TYPES].map((type) => (
            <MenuItem key={type} value={type}>
              {type}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="优先级" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} sx={{ minWidth: 120 }}>
          {['全部', ...PRIORITIES].map((priority) => (
            <MenuItem key={priority} value={priority}>
              {priority}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="outlined" onClick={() => setSortByMagnitude((value) => !value)}>
          {sortByMagnitude ? '当前按视星等排序' : '当前按名称排序'}
        </Button>
        <Chip label={`命中 ${visible.length} / ${targets.length}`} size="small" />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>目标</TableCell>
              <TableCell>星表编号</TableCell>
              <TableCell>类型</TableCell>
              <TableCell align="right">视星等</TableCell>
              <TableCell align="right">赤经(h)</TableCell>
              <TableCell align="right">赤纬(°)</TableCell>
              <TableCell>滤镜 / 曝光</TableCell>
              <TableCell align="right">阈值(°)</TableCell>
              <TableCell>本夜可见窗口</TableCell>
              <TableCell>优先级 / 版本</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((target) => {
              const altitude = altitudeAt(target, evaluationDate, night?.siteLat ?? 0, night?.siteLng ?? 0);
              const below = isBelowThreshold(altitude, target.minAltitude);
              const window = night ? visibilityWindow(target, night) : null;
              const conflict = moonConflict(target, night?.moonPhasePct ?? 0);
              return (
                <TableRow key={target.id} hover sx={below ? { bgcolor: 'action.hover', color: 'text.disabled' } : undefined}>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: TARGET_COLOR[target.type] }} />
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {target.name}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{target.catalog}</TableCell>
                  <TableCell>{target.type}</TableCell>
                  <TableCell align="right">{target.magnitude}</TableCell>
                  <TableCell align="right">{target.raHours}</TableCell>
                  <TableCell align="right">{target.decDeg}</TableCell>
                  <TableCell>
                    {target.filter} / {target.exposureSec}s · 累计 {target.totalMinutes}min
                  </TableCell>
                  <TableCell align="right">{target.minAltitude}</TableCell>
                  <TableCell>
                    {window ? (
                      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                        <Chip size="small" variant="outlined" label={`${window.startText}-${window.endText}`} />
                        <Chip size="small" variant="outlined" label={`最高 ${window.maxAltitude}°`} />
                        <Chip size="small" variant="outlined" label={formatMinutes(window.durationMinutes)} />
                        {below ? <Chip size="small" color="warning" label={`22:00 时 ${altitude}° 低于阈值`} /> : null}
                        {conflict ? <Chip size="small" color="info" label="月相偏亮" /> : null}
                      </Stack>
                    ) : (
                      <Chip size="small" color="default" label={`本夜不可见（22:00 时 ${altitude}°）`} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Chip size="small" color={target.priority === 'P1' ? 'error' : target.priority === 'P2' ? 'warning' : 'default'} label={target.priority} />
                      <Chip size="small" variant="outlined" color="secondary" label={`数据 v${target.dataVersion}`} />
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => openEdit(target)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => askRemove(target)}>
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
        <DialogTitle>{editingId ? '编辑观测目标' : '新增观测目标'}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          <FieldRow label="目标名" required>
            <TextField size="small" fullWidth value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="如：M31" />
          </FieldRow>
          <FieldRow label="星表编号">
            <TextField size="small" fullWidth value={form.catalog} onChange={(event) => setForm({ ...form, catalog: event.target.value })} placeholder="如：NGC 224" />
          </FieldRow>
          <FieldRow label="赤经(小时)" required hint="0~24；改动坐标会令数据版本 +1">
            <TextField size="small" type="number" fullWidth value={form.raHours} onChange={(event) => setForm({ ...form, raHours: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="赤纬(度)" required hint="-90~90；改动坐标会令数据版本 +1">
            <TextField size="small" type="number" fullWidth value={form.decDeg} onChange={(event) => setForm({ ...form, decDeg: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="视星等" required>
            <TextField size="small" type="number" fullWidth value={form.magnitude} onChange={(event) => setForm({ ...form, magnitude: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="目标类型">
            <TextField select size="small" fullWidth value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as TargetType })}>
              {TARGET_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {type}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="推荐滤镜">
            <TextField select size="small" fullWidth value={form.filter} onChange={(event) => setForm({ ...form, filter: event.target.value as FilterName })}>
              {FILTER_NAMES.map((filter) => (
                <MenuItem key={filter} value={filter}>
                  {filter}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="单帧曝光(秒)" required>
            <TextField size="small" type="number" fullWidth value={form.exposureSec} onChange={(event) => setForm({ ...form, exposureSec: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="建议累计(分钟)" required>
            <TextField size="small" type="number" fullWidth value={form.totalMinutes} onChange={(event) => setForm({ ...form, totalMinutes: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="优先级">
            <TextField select size="small" fullWidth value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as Priority })}>
              {PRIORITIES.map((priority) => (
                <MenuItem key={priority} value={priority}>
                  {priority}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="最小地平高度(°)" required hint="低于该值排程时自动标灰；改动会令数据版本 +1 并打回编排台在途段">
            <TextField size="small" type="number" fullWidth value={form.minAltitude} onChange={(event) => setForm({ ...form, minAltitude: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="备注">
            <TextField size="small" fullWidth multiline minRows={2} value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submit()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
