# 值班席位租约协调器（Seat Lease Coordinator）

把**撤离方案发布、车队调度、封存审查**等业务写操作接到**带世代号（generation
fencing）的席位租约**上：交班、网络抖动、多控制台同时在线、紧急接管时都不会出现
**双主**。旧世代控制台随后发出的任何写操作都被业务适配器拒绝。

- **零第三方依赖**：后端仅 Python 3.9+ 标准库（`http.server` + fsync JSONL WAL），
  前端原生 HTML/JS；提供 Python 标准库写的**校验适配器**与被保护业务服务示例。
- **单调世代 + 租约两阶段边界**：`ACTIVE → GRACE → EXPIRED`，宽限边界内任何人
  都不能取得席位；到期后并发接管**只产生一个更大的连续世代**。
- **两阶段交班**：接班人**确认** + 当前持有人**交出**都完成后，新世代在同一条
  fsync 记录里原子生效；任一步前崩溃，旧持有人在旧世代仍唯一有效、可判定。
- **紧急接管**：两名**互不相同、当前仍有资格、且不是夺取人/原持有人**的见证人；
  见证资格变化、重复见证、过早接管、基于旧世代的请求都不能改变归属。
- **心跳/断连/时钟偏差**：心跳只能在 ACTIVE 续租；GRACE/EXPIRED 一律拒绝。
  恢复连接的旧持有人可查看状态，但不能续租、不能写。
- **请求指纹 + 内容哈希**：`(seat, generation, fingerprint, content_hash)` 判定；
  完全相同重试返回原判定；同指纹不同内容拒绝（且不污染原判定）；已接受请求的
  结果永不被之后的交班/接管/重启回滚。
- **崩溃安全**：状态变更先 `write+flush+fsync` 再更新内存；支持 SIGKILL 恢复、
  快照压缩 WAL；重启恢复单调世代、租约边界与全部请求判定。

## 快速开始

### 本地（无需 Docker）

```bash
./run.sh                         # 或 python3 backend/server.py
# 打开 http://localhost:8092
```

环境变量：`SEATLEASE_PORT`（默认 8092）、`SEATLEASE_DB`（默认 ./data/wal.jsonl）、
`SEATLEASE_NO_SEED=1`（关闭演示数据）。

### 容器

```bash
docker compose up -d --build
# http://localhost:8092 ；数据卷 seatlease-data 持久化 WAL+快照
```

### 重置演示数据

```bash
python3 seed_demo.py --reset     # 或页面右上角“重置演示数据”
```

## 3 分钟演示（页面“模拟控制台”可同时开多个）

1. 默认两个控制台：**艾丽（EVAC-1 持有人，g1）** 与 **鲍博（接班人）**，
   均“在线”时持有人控制台每 4 秒自动心跳（TTL 15s + 宽限 8s）。
2. **正常交班**：艾丽“发起交接 → 鲍博” → 鲍博“接班人确认” → 艾丽“交出席位”，
   席位进入 g2；此时勾选艾丽控制台“使用旧世代”或直接发写操作 →
   红色 `STALE_GENERATION` 拒绝出现在“被围栏拒绝”面板。
3. **断连恢复**：取消持有人控制台“在线”/“自动心跳” → 席位倒计时依次变
   GRACE（黄，不可写但尚不可接管）→ EXPIRED（红）。重新上线后旧持有人只能看，
   心跳与写全部被世代/租约拒绝。
4. **竞争接管**：EXPIRED 后用两台控制台分别“发起紧急接管”，各找两名不同合格
   见证人见证，同时点“夺取席位”——只有一方赢，世代仅 +1，另一方得到
   `TAKEOVER_SUPERSEDED`。
5. **幂等**：任一写操作连续点“完全相同重试”→ 原判定（同 reference，标 🔁）；
   点“复用指纹但改内容”→ `FINGERPRINT_REUSE`。
6. **见证资格变化**：接管见证后，在“排班与人员”里取消某见证人资格，
   finalize 时按**当前资格**重算，不足两人即拒绝。
7. **崩溃恢复**：点“打快照”压缩 WAL；或在交接/接管中途 `kill -9` 服务再启动——
   世代、倒计时边界、待确认交接、请求判定全部恢复，绝无双主。

## 业务系统如何接入（校验适配器）

所有现有服务在**执行写副作用之前**调用协调器判定：

```python
from adapter import LeaseFence, FenceRejected

fence = LeaseFence("http://localhost:8092")
try:
    verdict = fence.decide(
        seat="EVAC-1", generation=console.generation,
        fingerprint=request.idempotency_key,   # 业务侧唯一请求 ID
        actor_id="bob", op="evacuation_publish",
        payload=order_body)
except FenceRejected as rej:
    return reject(rej.reason)   # STALE_GENERATION/GRACE_WINDOW/FINGERPRINT_REUSE…
# verdict["result"] == "accepted"：执行业务；同指纹任意重试都返回同一 verdict
```

也可以直接 `POST /api/fence/decide`（见 [API.md](API.md)）。完整的受保护微服务
示例见 [examples/guarded_service.py](examples/guarded_service.py)
（`X-Seat/X-Generation/X-Fingerprint/X-Actor` 请求头，协调器不可用时安全失败 503）：

```bash
SEATLEASE_URL=http://localhost:8092 BIZ_PORT=8095 \
  python3 examples/guarded_service.py
```

内置三个业务演示端点与撤离业务同名：
`/api/business/evacuation-publish`（撤离方案发布）、
`/api/business/convoy-dispatch`（车队调度）、
`/api/business/seal-review`（封存审查）。

## 租约与接管的时序

```
持有人心跳（仅 ACTIVE 接受）
  last_heartbeat ─────── expires_at ───────── grace_until
  │←──────── TTL ───────→│←────── grace ──────→│
         ACTIVE（可写、可交班）   GRACE（不可写/不可续租/不可接管）   EXPIRED（合格接管可夺取）
```

- 宽限边界吸收短暂断连与时钟偏差：边界内竞争者一律拿到
  `TAKEOVER_TOO_EARLY`/`TAKEOVER_PREMATURE`，保证不会误夺仍在抖动的席位。
- 接管申请登记 `from_generation`：finalize 时若世代已变（他人已赢/已交班），
  申请标记 `superseded` 并拒绝——并发窗口内世代只 +1 一次。
- 见证人资格在 **finalize 时刻**重新核验（见证后被取消资格即失效，可增补第三人）。

## 持久化与崩溃模型

- 所有状态变更 = 追加一条 WAL 事件，`write → flush → fsync` 成功才提交并返回；
  内存态只是 WAL 的投影，崩溃重放与在线提交共用同一个纯函数 `reduce`。
- 两阶段交班的提交是**单条** `HANDOVER_COMMIT`（确认位+交出位齐备时产出），
  因此不存在“交出了但没提交”的分裂窗口：要么旧世代仍完整有效，要么新世代已生效。
- 快照（`wal.jsonl.snapshot`）先原子落盘再重写 WAL 尾部，任意时刻崩溃都能用
  “快照 + seq 更大的事件”完整复原。页面“打快照”与 `/api/dev/snapshot` 可触发压缩。
- 数据文件即审计：`GET /api/events` 可读全部事件（seq/时间戳/类型/内容）。

## 测试

```bash
./run_tests.sh
# 或分开：
python3 -m unittest tests.test_coordinator   # 33 项领域测试（注入假钟，确定性边界）
python3 -m unittest tests.test_e2e           # 6 项端到端：真实 HTTP、真实时钟、
                                             # 子进程重启、SIGKILL 崩溃、适配器集成
```

覆盖：两阶段交班全链路、先交出后确认、过期不能完成交接、GRACE/EXPIRED 边界、
心跳续租规则、两名不同见证人/重复见证/资格变更/夺取人自证/原持有人见证、
并发接管只产生一个世代、旧世代接管作废、旧控制台写+心跳被围栏拒绝、
指纹幂等/复用污染防护、已接受结果跨交班不回滚、WAL 重放/快照压缩/
SIGKILL 恢复/单调世代、适配器客户端与被保护服务（含 503 安全失败）。

## 目录

```
backend/
  store.py        fsync JSONL WAL + 快照压缩 + 崩溃重放
  coordinator.py  状态机/租约时序/两阶段交接/接管/围栏判定（纯函数 reducer）
  server.py       HTTP API + 静态页面 + 内置业务演示端点
  adapter.py      供现有服务调用的校验适配器（LeaseFence / @guarded / FenceRejected）
  seed.py         演示数据
frontend/         管理页面（席位倒计时/交接/见证接管/拒绝流/事件流/多模拟控制台）
examples/
  guarded_service.py  接入适配器的业务微服务示例（端口 8095）
tests/            test_coordinator.py（33）+ test_e2e.py（6）
Dockerfile  docker-compose.yml  run.sh  run_tests.sh  seed_demo.py
```

## 一致性说明

- `ThreadingHTTPServer` 多线程收请求，但所有读-改-写都在协调器单一
  `commit_lock` 内串行，提交点即 WAL fsync；单实例部署即线性化。
- 世代号是跨实例/时钟的最终裁决：适配器只信 `(seat, generation)`，
  不依赖各控制台本地时钟；服务端时钟用于租约边界，宽限窗口吸收偏差。
