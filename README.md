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
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / lease.ts（租约账本模型）
│       ├── stores/             # portStore.ts（账本状态）/ vesselStore.ts / uiStore.ts
│       ├── services/           # occupancy.ts（占用账本：抢占 / 排队 / 版本冲突 / 租约失效 / 补位）
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数与占用率，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格（点击查看占用船舶）、在港船舶与近日流水 | 四个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期与进出港时间线 | FishingVessel、PortCall |
| `/calls` | 进出港登记：选渔船与类型、渔港与预计离港时间，进港抢占泊位 / 容量满排队、旧版本提示刷新，出港关闭租约并自动补位 | PortCall、BerthLease、Berth、FishingVessel |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要 | FishingPort、Berth |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：新增 `leases` **占用账本**（带租约与版本号）。泊位占用不再挂在 `berths` 上，
    而是由生效租约统一派生；v3 的历史占用会自动转写为生效租约
- **占用账本（租约）规则**：
  - 进港在 Dexie 事务内按**最新账本状态**抢占：指定泊位则抢指定泊位（自动选第一个空闲泊位），
    不选泊位则自动分配；泊位容量满时进入**排队**（FIFO），排队船舶无泊位号、不占容量、不计在港船数，
    一旦有泊位释放（出港 / 租约失效 / 新增泊位 / 维修恢复）自动补位
  - 每条租约带 `version` 乐观锁版本号与打开表单时的占用者快照；旧版本保存抛冲突错误，
    页面提示「刷新占用状态」而**不会覆盖**
  - 租约带预计离港时间与值班窗口心跳（15s）；**超过预计离港时间**或**窗口失联**（心跳超时 60s）
    自动失效、释放泊位、补写出港流水并重算在港船数（应用每 15s 巡检一次，也可手动「租约巡检」）
  - 同一渔船存在未结束航次（生效 / 排队租约）时**拒绝重复靠泊**
  - 一个浏览器标签页 = 一个值班窗口（`sessionStorage` 分配 windowId）；跨标签页通过 storage 事件同步账本
- **同一份生效占用**：港口详情、地图、流水、渔船档案全部读取「物理泊位 × 生效租约」的派生视图；
  旧流水没有泊位号时按**未分配**处理，不挤占容量
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

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
