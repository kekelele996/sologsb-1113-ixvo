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
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v2 迁移） |
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
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测结果、按时段/望远镜校验，勾选多条批量改期到备用观测夜并填写改期原因 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`meta`。
- `db.version(1).stores({...})` 声明索引；`db.version(2).upgrade(...)` 为排程段增加 `backupNightId` 索引，并给旧数据补齐 `schemaVersion` 与因云取消排程段的替补夜；`db.version(3).upgrade(...)` 为目标数据版本化并给排程段快照目标版本，升级时按现用数据回填，已完成排程段标记复核。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、14 段排程，含 1 处设备冲突与 1 条改期记录）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 目标数据版本与排程段失效重算

观测目标库由科学评审组维护，编排台照着目标的最低高度和可见窗口排出当晚的排程段，两边各自持有数据。

- **目标数据版本**：每个目标持有 `version` 字段，坐标（赤经/赤纬）或高度门槛变更时递增；其他字段变更不触发版本递增。
- **排程段快照版本**：每段排程记录排程时所依据的目标版本 `targetVersion`，用于与目标库按编号核对在用版本。
- **版本核对**：装载后自动按目标编号核对排程段快照版本与目标库当前版本，对不上即挂起等确认（`挂起` 状态，原因 `版本不一致`），顶栏全局提示不一致项。
- **失效重算**：评审组改了目标坐标或高度门槛后，引用该目标的在排程段按新数据重算——仍达标的更新快照版本保留原状态，不达标的挂起（原因 `低于高度门槛`）。评审组不替编排台删段，编排台也不回写目标库。
- **挂起处理**：编排台决定换到别的夜还是排队。换夜时做容量核对（目标夜该望远镜时段是否空闲），排得下则迁入并恢复待执行；排不下则排队并写明还差多少分钟（`deficitMinutes`）。
- **复核保留**：已完成的排程段升级时自动标记复核，用户也可手动点「复核」；复核过的排程段照旧保留，不参与版本核对与失效重算。
- **升级迁移**：v2→v3 时旧数据没有目标数据版本，按现用数据回填（目标 version=1，排程段 targetVersion=目标当前版本）；升级在事务内执行，中途失败抛出即回滚到升级前状态，另在升级前备份全量数据到 localStorage 供手动回滚。
