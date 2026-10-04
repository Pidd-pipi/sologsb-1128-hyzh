# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用。

## 一键启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21828>

停止：

```bash
docker compose down
```

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 |
| UI | Element Plus 2 |
| 状态 | Pinia |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`）+ localStorage（表单草稿） |
| 地图 | 高德地图 JS API（`VITE_AMAP_KEY`），未配置 key 时降级为本地 SVG 网格视图 |
| 托管 | nginx:alpine（gzip + 前端路由回退） |

## 目录结构

```
sologsb-1128/
├── docker-compose.yml          # 无 version 字段；顶层 name: gbfishport
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / lease.ts（租约模型）
│       ├── stores/             # portStore.ts（含账本版本号/租约/排队）/ vesselStore.ts / uiStore.ts
│       ├── services/           # ledger.ts（抢占/租约/版本号/排队/失效）/ occupancy.ts（生效占用）/ agent.ts（窗口心跳）
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft / useLedgerAgent
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / seed.ts
│       ├── scripts/            # 账本逻辑冒烟（fake-indexeddb，npm run smoke，不进生产包）
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数、排队数与占用率，支持按等级与避风能力筛选 | FishingPort、Berth、BerthLease |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格（点击查看占用租约）、在港船舶、排队等泊与近日流水 | 五个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期、当前航次（靠泊/排队）与进出港时间线 | FishingVessel、PortCall、BerthLease |
| `/calls` | 进出港登记：进港按账本最新状态抢占泊位，容量满自动排队；出港释放租约；带版本号防旧版本覆盖 | PortCall、Berth、BerthLease、FishingVessel |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要与排队 | FishingPort、Berth、BerthLease |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：泊位占用升级为**带租约与版本号的占用账本**——新增 `leases`（靠泊/排队租约，占用唯一事实来源）、`ledgerMeta`（按渔港的账本版本号）、`agents`（值班窗口心跳）；`berths` 回归物理泊位清单，旧「占用」状态回填为 system 租约，旧流水补 `portId`
- **泊位占用账本规则**：
  - 登记前进港在事务内按最新状态抢占最小空闲泊位（维修泊位不参与），容量满了进入 **FIFO 排队**，排队租约无泊位号、不挤占容量；离泊/失效后队首自动靠泊并回填进港流水泊位号
  - 每个渔港一份账本与版本号：提交时版本不符会被拒绝并提示「刷新占用」，旧窗口保存不会覆盖新状态
  - 租约带预计离港时间与登记窗口（agentId）：窗口心跳超时（失联）或超过预计离港时间，租约自动失效、补记出港流水、释放占用并重算在港船数；system 租约（演示/迁移回填）不受失联影响
  - 同一渔船已有未结束航次（靠泊或排队）时不能重复登记进港
  - 渔港详情、地图、流水、渔船档案统一从 `services/occupancy.ts` 的生效占用推导；**旧航次没有泊位号时按「未分配」处理，不挤占容量**
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、8 艘渔船、进出港流水、物理泊位、靠泊/排队租约与账本版本），其中含 1 条已超预计离港时间的租约与 1 条排队租约，便于直接看到失效释放与排队效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

## 账本逻辑冒烟（可选）

纯 Node 验证（fake-indexeddb 模拟 IndexedDB，不依赖浏览器）：

```bash
npm run smoke
```

覆盖：进港抢占/容量满排队、版本号乐观锁拦截旧版本保存、重复航次拒绝、出港释放与队首出泊回填、超时/失联失效释放与在港船数重算、v3→v4 与 v1→v4 升级迁移、首次播种启动扫描。

## 高德地图 Key（可选）

`VITE_AMAP_KEY` 留空时**不会**请求任何外部地图服务，`useAmapLoader()` 立即返回降级标记，页面渲染本地 SVG 网格视图（可点选查看泊位占用）。需要真实底图时，在 `.env` 中填入 key 后重新构建：

```bash
VITE_AMAP_KEY=your-key docker compose up -d --build
```

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev
```

构建校验（类型检查 + 打包）：`npm run build`（等价于 `vue-tsc -b && vite build`）。
