# 校验适配器接入说明

业务服务（撤离方案发布、车队调度、封存审查等）在**执行写操作之前**调用协调器围栏。
判定通过才执行业务；失败必须拒绝。判定本身已持久化，与之后的交班/接管解耦，不会被回滚。

## 判定语义

| decision | 含义 | 业务侧动作 |
| --- | --- | --- |
| `ACCEPT` | 围栏通过，首次接受 | 执行写操作，保存 fingerprint |
| `ACCEPT_REPLAY` | 完全相同的重试，返回原判定 | **不要重复执行**，直接用 `verdict` 原结果 |
| `DENY` | 旧世代 / 非持有人 / 租约过期 / 已交出 / 席位类型不符 | 拒绝写操作 |
| HTTP 409 `FINGERPRINT_REUSED` | 复用同一指纹但席位、世代、操作或载荷不同 | 拒绝（疑似串扰/伪造） |
| HTTP 409 `PAYLOAD_HASH_MISMATCH` | 载荷与 `payloadHash` 不一致 | 拒绝（防篡改） |

## 约定

- `fingerprint`：请求唯一标识（UUID 即可），同一业务意图的**所有重试必须复用同一个**，换内容必须换新指纹。
- `payloadHash`：对规范化载荷（对象键按字典序、UTF-8）计算 SHA-256。参考实现内已内置。
- `generation`：从 `GET /api/state`（或 SSE）观察到的席位当前世代，随请求原样携带。
- 身份：`X-Actor-Id` 头或 `actorId` 字段（演示用，无真实认证）。

## curl

```bash
# 业务写操作（当前持有人 + 当前世代才 ACCEPT）
curl -s localhost:8080/api/adapter/evaluate \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: u-evac' \
  -d '{"seatId":"seat-evac","generation":1,"op":"evacuation",
       "payload":{"zones":["A-01","B-02"]},
       "payloadHash":"<sha256 of canonical payload>","fingerprint":"fp-demo-001"}'

# 相同 fingerprint + 相同内容的重试（哪怕已交班）→ ACCEPT_REPLAY 原判定
# 相同 fingerprint + 不同 payload → DENY FINGERPRINT_REUSED
# 交班后旧控制台 generation=1 重放新意图 → DENY STALE_GENERATION
```

## SDK

- Node.js：`adapters/node/adapter.js`（`LeaseFenceAdapter`）
- Python：`adapters/python/adapter.py`（`LeaseFenceAdapter`，纯标准库）
