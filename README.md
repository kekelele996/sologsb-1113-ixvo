# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v3 迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # target / session / equipment / night（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ scheduling.ts（版本核对/复核/容量排队）/ export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测结果、按时段/望远镜校验，版本对不上 / 复核不达标的段挂起，勾选多条核对恢复或换夜（容量不足自动排队并写明缺口分钟数） |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`meta`。
- `db.version(1).stores({...})` 声明索引；`db.version(2).upgrade(...)` 为排程段增加 `backupNightId` 索引，并给旧数据补齐 `schemaVersion` 与因云取消排程段的替补夜；`db.version(3).upgrade(...)` 引入目标数据版本化：
  - **两边各持数据、按编号核对版本**：目标库（评审组）每条目标有 `dataVersion`，排程段（编排台）保存排程时的 `targetVersion` 快照；两边只按目标编号（`targetId`）核对，编排台不回写目标库，评审组也不删除任何排程段。
  - **改坐标 / 高度门槛即失效重算**：评审组修改赤经、赤纬或最低高度角时目标 `dataVersion +1`；编排台在途排程段（待执行 / 进行中 / 挂起 / 排队）全部先置「挂起」——能按新数据算出达标的挂起原因记为「版本对不上，等待复核」，当场就不达标的写明具体时刻与高度。已完成、因云取消的段不动。
  - **核对 / 换夜 / 排队**：编排台在排程段页「核对」挂起段，按现用数据逐 10 分钟采样复核高度角，通过则刷新版本快照恢复待执行，不通过保持挂起；「换到其他夜」按目标夜 `capacityMinutes` 剩余容量逐段预演，装得下的改挂该夜，装不下的转「排队」并记录 `queueShortfallMinutes`（还差多少分钟）。挂起 / 排队 / 取消 / 已完成的段不占夜容量与设备时段。
  - **旧数据升级回填**：旧目标没有 `dataVersion` 的按现用数据补 1；旧排程段没有 `targetVersion` 的按对应目标现用版本回填（目标已缺失置 0，运行时核对会挂起），复核过（已完成）的段状态照旧保留；旧观测夜没有容量字段的补默认 600 分钟。升级回调在 versionchange 事务内执行，任一行校验失败即抛错，**整批升级回滚到 v2**，下次打开可重试。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、16 段排程，含 1 处设备冲突、1 条因云改期、1 条版本对不上的挂起段与 1 条容量不足的排队段）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
