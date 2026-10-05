# 协调 API

- Base URL：`http://<host>:8080`
- 写操作：`POST`，`Content-Type: application/json`
- 身份：请求头 `X-Actor-Id: <userId>`，或 JSON 字段 `actorId`
- 错误：非 2xx 返回 `{ "error": "<CODE>", "message": "..." }`
- 实时：`GET /api/events` 为 SSE，事件 `state`（完整快照）与 `tick`（服务端时间，每秒）

## 错误码

| code | 含义 |
| --- | --- |
| `STALE_GENERATION` | 请求基于旧世代（fencing token 已落后） |
| `NOT_HOLDER` | 不是席位当前持有人 |
| `LEASE_EXPIRED` | 租约已越过宽限边界 |
| `LEASE_ACTIVE` | 租约仍有效，禁止接管（过早接管） |
| `SURRENDERED` | 席位已交出、等待新世代生效 |
| `FINGERPRINT_REUSED` | 指纹相同但席位/世代/操作/载荷不同 |
| `PAYLOAD_HASH_MISMATCH` | 载荷与 payloadHash 不一致 |
| `NOT_CANDIDATE` / `HANDOVER_OPEN` / `HANDOVER_NOT_PENDING` | 交接状态机冲突 |
| `WITNESS_UNQUALIFIED` / `WITNESS_CONFLICT` / `DUPLICATE_WITNESS` | 见证人不合规 |
| `SUPERSEDED` | 席位已被新世代授予，该申请/操作作废 |
| `KIND_MISMATCH` | 操作类型与席位业务类型不符 |

## 只读

### `GET /api/state[?as=<userId>]`
返回完整快照：`users / shifts / seats / handovers / takeovers / accepted / denials / serverNow / lastSeq`。

席位对象关键字段：
```json
{ "id": "seat-evac", "name": "撤离方案发布席", "kind": "evacuation",
  "holderId": "u-su", "holderName": "苏岚", "generation": 2,
  "expiresAt": 1759680020000, "serverNow": 1759680005000, "remainingMs": 15000,
  "status": "held|surrendering|expired", "ttlMs": 20000 }
```

### `GET /api/health` → `{ ok, serverNow, lastSeq }`
### `GET /api/events` → SSE

## 班次与资格

### `POST /api/shifts`
排班负责人建立班次（可一次建多个席位）。
```json
{ "actorId": "u-lead", "name": "10-06 早班",
  "seats": [ { "name": "应急联络席", "kind": "evacuation|convoy|sealing",
               "holderId": "u-evac", "ttlMs": 20000 } ] }
```
新席位 `generation=1`，租约到期点 = 服务端时间 + ttlMs。

### `POST /api/witness-qualification`
```json
{ "actorId": "u-lead", "userId": "u-w3", "qualified": true }
```
资格变化即时生效：撤销后待完成的见证会被拒；已完成的夺取结果不受影响。

## 心跳 / 续租

### `POST /api/heartbeat`
```json
{ "seatId": "seat-evac", "generation": 2 }
```
头 `X-Actor-Id` 为持有人。成功 → `{ ok, expiresAt }`（到期点顺延一个 TTL）。
拒绝：`STALE_GENERATION`（旧控制台）、`NOT_HOLDER`、`LEASE_EXPIRED`（已失联，不能续命）、`SURRENDERED`（已交出）。

## 协作交班（两步，可乱序）

### `POST /api/handover/start`
持有人发起：
```json
{ "seatId": "seat-evac", "toUserId": "u-su" }
```
### `POST /api/handover/confirm` — 指定接班人确认
```json
{ "handoverId": "ho-xxxx" }
```
### `POST /api/handover/release` — 当前持有人交出
```json
{ "handoverId": "ho-xxxx" }
```
两步都齐备的那次调用**原子**完成授予：持有人变为接班人、`generation+1`、旧交接关闭、
竞争者的开放接管单作废。接口对重复调用幂等；只完成一步时持有人与世代保持不变。

### `POST /api/handover/cancel` — 交接双方任一方取消
```json
{ "handoverId": "ho-xxxx", "reason": "..." }
```

## 紧急接管（双见证）

### `POST /api/takeover/open`
席位**已过宽限边界**后，非原持有人的竞争者申请：
```json
{ "seatId": "seat-convoy", "expectedGeneration": 2 }
```
`expectedGeneration` 与当前世代不符 → `STALE_GENERATION`；租约未到期 → `LEASE_ACTIVE`；
同一申请人重复申请幂等；不同申请人各自得到申请单。

### `POST /api/takeover/attest`
见证人签名：
```json
{ "takeoverId": "tk-xxxx" }
```
`X-Actor-Id` 为见证人。校验顺序：申请未作废 → 申请人≠见证人 → 租约已过期 →
见证人当前具备资格 → 未重复签名。第二个合格且互异签名到达时原子夺取（世代 CAS，
并发收尾只有一个胜出，败者收 `SUPERSEDED`）。

## 业务围栏（现有服务在写操作前必须调用）

### `POST /api/adapter/evaluate`
```json
{ "seatId": "seat-evac", "generation": 2, "op": "evacuation",
  "payload": { "zones": ["A-01"] },
  "payloadHash": "<sha256-hex：规范化载荷 JSON，键排序>",
  "fingerprint": "fp-唯一请求标识" }
```
持有人由 `X-Actor-Id` 给出。响应：

| decision | 含义 |
| --- | --- |
| `ACCEPT` | 围栏通过，`verdict` 为业务判定，已持久化 |
| `ACCEPT_REPLAY` | 完全相同的重试，`verdict` 为**原判定**，业务侧不要重复执行 |
| `DENY` | `reason` 给出拒绝码（见上表），并进入管理页「被围栏拒绝」审计流 |

判定匹配键为 `fingerprint + seatId + generation + holderId + op + sha256(canonical(payload))`。
规范化规则：UTF-8 JSON，对象键按码点升序递归排序，无多余空白。
`payloadHash` 可选（SDK 会计算）；不一致返回 409 `PAYLOAD_HASH_MISMATCH`。

内置示例业务判定（可替换为真实执行结果，协调器负责记住原判定）：

| op | 成功结果 | 业务失败结果（同样持久化为原判定） |
| --- | --- | --- |
| `evacuation` | `EVAC_PUBLISHED`（需非空 zones） | `EVAC_EMPTY` |
| `convoy` | `CONVOY_DISPATCHED`（vehicleCount>0） | `CONVOY_NO_VEHICLE` |
| `sealing` | `SEAL_REVIEW_ACCEPTED`（需 target） | `SEAL_NO_TARGET` |

## 演示 / 运维（`ENABLE_DEV_TOOLS=1` 时开放）

| 端点 | 作用 |
| --- | --- |
| `POST /api/dev/clock` `{ "offsetMs": 25000 }` | 设置逻辑时钟偏移（持久化），模拟失联超时 |
| `POST /api/dev/crash` | 立即 SIGKILL 本进程（由 restart 策略拉起） |
| `POST /api/dev/reset` | 清空事件日志并重新播种 |

## curl 速查

```bash
# 当前持有人执行业务
curl -s localhost:8080/api/adapter/evaluate \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: u-evac' \
  -d '{"seatId":"seat-evac","generation":1,"op":"evacuation",
       "payload":{"zones":["A-01"]},"payloadHash":"<hash>","fingerprint":"fp-1"}'

# 交班
curl -s -XPOST localhost:8080/api/handover/start   -H 'X-Actor-Id: u-evac'  -d '{"seatId":"seat-evac","toUserId":"u-su"}'
curl -s -XPOST localhost:8080/api/handover/confirm -H 'X-Actor-Id: u-su'    -d '{"handoverId":"ho-..."}'
curl -s -XPOST localhost:8080/api/handover/release -H 'X-Actor-Id: u-evac'  -d '{"handoverId":"ho-..."}'
```
