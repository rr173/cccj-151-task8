# 协调 API

基础地址 `http://localhost:8092`；请求/响应均为 JSON。所有错误形如：

```json
{ "ok": false, "error": "STALE_GENERATION",
  "message": "世代围栏拒绝：请求世代 1，当前世代 2（旧控制台/已交班）",
  "detail": { "current_generation": 2 } }
```

| HTTP | 含义 |
|---|---|
| 200/201 | 成功 |
| 400 | 参数非法 / 未知席位外的业务错误 |
| 403 | 角色或资格不允许（非持有人、非接班人、见证人无资格） |
| 404 | 席位/交接/接管申请不存在 |
| 409 | 状态冲突（旧世代、重复见证、指纹复用、待确认交接已存在、接管竞争失败） |
| 423 | 时序未到/租约失效（ACTIVE 内接管过早、GRACE 宽限、EXPIRED） |
| 503 | （适配器侧）协调器不可达，安全失败 |

时间单位均为**毫秒**（Unix epoch ms，服务端时钟）。

## 读取

### GET /api/state
管理页面全量视图：人员、班次、席位（含 `phase`、`ms_to_expiry`、
`ms_to_grace_end`、`writable`）、交接、进行中接管、已接受写操作（`effects`）、
拒绝流（`denials`）。

### GET /api/events
WAL 最近 500 条事件（`seq/ts/type/data`）。

### GET /api/health
`{ok, time_ms, wal_seq}`。

## 人员 / 班次 / 派座

### POST /api/people
`{person_id, name, roles?, witness_qualified?}`（幂等：已存在则返回原人员）。

### POST /api/people/witness-qualified
`{actor_id, person_id, qualified}` —— 资格变更立即影响进行中接管的 finalize 重算。

### POST /api/shifts（排班负责人）
`{actor_id, name, seats:[{id, ttl_ms?, grace_ms?}]}`；`actor_id` 需具
`shift_lead` 角色，否则 `NOT_SHIFT_LEAD`。

### POST /api/seats/grant
`{seat, holder_id, ttl_ms?, grace_ms?}` —— 空缺席位冷启动派座，世代从 1 起；
席位已有持有人时 `LEASE_STILL_HELD`（应走交接/接管）。

## 心跳

### POST /api/seats/heartbeat
`{seat, actor_id, generation}`：

| 条件 | 结果 |
|---|---|
| 世代 != 当前 | 409 `STALE_GENERATION`（旧持有人/旧控制台优先报此码） |
| 非当前持有人 | 403 `NOT_HOLDER` |
| GRACE | 423 `GRACE_WINDOW`（不可续租） |
| EXPIRED | 423 `LEASE_NOT_ACTIVE` |
| ACTIVE | 租约从“现在”重新起算，返回席位视图 |

## 两阶段交接

1. `POST /api/handovers` `{seat, actor_id, successor_id}` → `handover`
   （仅当前持有人、ACTIVE；每席位至多一个 pending，否则 `HANDOVER_ALREADY_PENDING`）
2. `POST /api/handovers/confirm` `{handover_id, actor_id}`（仅接班人）
3. `POST /api/handovers/release` `{handover_id, actor_id}`（仅持有人）

第 2、3 步顺序不限；两步齐备时同一条 `HANDOVER_COMMIT` 原子生效：
新世代 = 旧世代 + 1，新持有人租约从提交时刻起算。任一步前崩溃，旧持有人
在旧世代仍唯一有效。进行中若租约越过 EXPIRED，交接不能再完成
（`LEASE_NOT_ACTIVE`），须走紧急接管。

`POST /api/handovers/cancel` `{handover_id, actor_id, reason?}`
（双方或排班负责人可取消）。

## 紧急接管

### POST /api/takeovers
`{seat, claimant_id, witness_ids: []}` 发起（可先空名单，随后增补）。

### POST /api/takeovers/attest
`{takeover_id, witness_id}`。拒绝码：

- `NOT_WITNESS_ELIGIBLE`：无资格 / 是夺取人 / 是当前持有人；
- `DUPLICATE_WITNESS`：同一人重复见证；
- `TAKEOVER_SUPERSEDED`：申请时登记的世代已变化（被交班或他人胜出）。

### POST /api/takeovers/finalize
`{takeover_id, actor_id}`。按**当前时刻**重算：

1. 世代必须仍等于申请登记的 `from_generation`，否则
   `TAKEOVER_SUPERSEDED`（并发输家）；
2. 两名互不相同、当前仍合格、非夺取人/非持有人的见证人，否则
   `NOT_WITNESS_ELIGIBLE`（detail 给出当前有效名单）；
3. 租约必须 EXPIRED：ACTIVE → `TAKEOVER_TOO_EARLY`，GRACE →
   `TAKEOVER_PREMATURE`（detail 含剩余毫秒）。

成功：席位世代 +1、持有人=夺取人、同席位 pending 交接与其他 witnessing 接管
全部置 `superseded`。

## 围栏判定（业务适配器入口）

### POST /api/fence/decide
```json
{
  "seat": "EVAC-1",
  "generation": 2,
  "fingerprint": "evt-20261005-0007",
  "actor_id": "bob",
  "op": "evacuation_publish",
  "payload": { "order_id": "ZONE-A", "vehicles": ["V3"] }
}
```

判定顺序与语义：

1. **围栏先行**：世代不匹配 → 409 `STALE_GENERATION`；非持有人 →
   403 `NOT_HOLDER`；GRACE → 423 `GRACE_WINDOW`；EXPIRED →
   423 `LEASE_NOT_ACTIVE`。旧世代上的“原样重试”也不能复活写权限。
2. **幂等**：围栏通过后查指纹表。同指纹且 `content_hash` 相同（规范化
   JSON 的 SHA-256，键序无关）→ 返回原 verdict，响应带 `"replay": true`。
3. **指纹复用**：同指纹不同 `content_hash` → 409 `FINGERPRINT_REUSE`
   （进拒绝流，且不覆盖该指纹首次判定）。
4. 通过 → 200 `{ok, verdict:{result:"accepted", response:{status, op,
   reference, digest}, ...}}`。已接受判定是不可变记录，交班/接管/重启后
   原结果不变、不重复入账。

允许的 `op`：`evacuation_publish`、`convoy_dispatch`、`seal_review`、
`generic_write`。

### 业务同名端点（内置演示适配器）

- `POST /api/business/evacuation-publish`
- `POST /api/business/convoy-dispatch`
- `POST /api/business/seal-review`

请求体同 `/api/fence/decide`（`op` 由路径决定）。

## 开发 / 运维

- `POST /api/dev/reset` —— 清空 WAL 与快照并重新播种（演示/测试用）。
- `POST /api/dev/snapshot` —— 在当前 seq 打快照并压缩 WAL；重启后从
  “快照 + 尾部事件”恢复。

## 典型拒绝码速查

| 机读码 | 场景 |
|---|---|
| `STALE_GENERATION` | 旧控制台/已交班/已接管世代的写或心跳 |
| `NOT_HOLDER` | 请求人不是席位当前持有人 |
| `GRACE_WINDOW` | 宽限边界内续租或写 |
| `LEASE_NOT_ACTIVE` | 租约到期后续租/写，或过期后完成交接 |
| `FINGERPRINT_REUSE` | 同指纹携带不同请求内容 |
| `TAKEOVER_TOO_EARLY` | ACTIVE 期内夺取 |
| `TAKEOVER_PREMATURE` | GRACE 宽限未结束就夺取 |
| `TAKEOVER_SUPERSEDED` | 基于旧世代的接管/见证（他人已赢或已交班） |
| `NOT_WITNESS_ELIGIBLE` / `DUPLICATE_WITNESS` | 见证人资格/重复问题 |
| `HANDOVER_ALREADY_PENDING` / `NO_PENDING_HANDOVER` | 交接状态冲突 |
| `NOT_SHIFT_LEAD` / `NOT_SUCCESSOR` | 角色不匹配 |
