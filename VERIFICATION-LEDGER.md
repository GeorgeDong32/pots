# VERIFICATION-LEDGER.md — 需真机/真实飞书验收的门

每条：门 ID / 前置条件 / 复现命令 / 预期结果。实现侧已自动化的门（A3/T-P0-2a 等）标注 DONE。

## P0（A 系列）

### A1 DM 连续 10 轮对话 + 60 消息长会话 — **需真实飞书 + CPA**
- 前置：Keychain item ×2、`~/.pi-larkd/config.json`、飞书自建应用（机器人能力 + `im:message` 收发 + WS 事件订阅 + card.action.trigger 回调，**已发布版本**）、CPA 运行中。
- 命令：`launchctl bootstrap gui/$(id -u) launchd/dev.gd32.pi-larkd.plist`，然后在 DM 连发 10 轮（其中至少 2 轮触发 read 工具，如「读 ~/.pi-larkd/config.json 告诉我 modelId」），再进行一轮 60+ 条消息长会话。
- 预期：每轮流式卡片 + 终态正确；长会话中卡片内容无错乱/重复（pump partial diff 正确性，含 F30 场景）。
- 关注点：cherry-studio 实盘警示的 watch coalescing——恢复后首帧一致性。

### A2 kill -9 崩溃续跑 + 重投幂等 — **需真实飞书**
- 前置：A1 已通；daemon 运行中，一轮 run 进行中。
- 命令：`kill -9 $(cat ~/.pi-larkd/daemon.lock)`（run 中途），launchd 10s 内拉起；崩溃前各投 1 条、重启后投同 message_id（飞书 3s 重投模拟：可用 lark-cli 重发同 ID 或等 adapter 重投）。
- 预期：in-flight run 经 `resume()` 续跑完成；前后消息不丢不重。
- 已自动化部分：T-P0-2a「restart 后同 requestId 同 submission id」已绿（test/substrate.test.ts）。

### A3 幂等钉子 — **DONE（自动化）**
- test/substrate.test.ts「T-P0-2a」两条：同 requestId 二次 submit 同 id、跨重启同 id、无重复模型调用。

### A4 launchd 守护 — **需真机**
- 命令：`launchctl kickstart -k gui/$(id -u)/dev.gd32.pi-larkd`，观察 10s 内复活；重启 Mac 验证 RunAtLoad；连续 3 次制造中毒 run（如配置坏模型端点）观察无重启风暴。
- 预期：KeepAlive{Crashed} × harness crash-loop(5) 不叠加成风暴；crash 计数持久性实测结论回填本 ledger（F07 疑问：计数若在内存，launchd 拉起即清零——需观察 restartLimit 行为）。

### A5 断网 30s 恢复 + backfill — **需真实飞书**
- 前置：A1 已通。r2 遗留：bot 身份 `+chat-messages-list` 实拉验证 JSON 实形（字段名系二进制+同源 API 推定）。
- 命令：关 Wi-Fi 30s 期间在 DM 发 2 条消息；恢复后观察 `~/Library/Logs/pi-larkd.log` 中 backfill 命令与 admit 记录。
- 预期：重连 + backfill 补收断线窗口两条消息且各只回复一次（watermark 幂等）。先手工跑一次：
  `lark-cli im +chat-messages-list --as bot --chat-id <home_chat_id> --start <ISO> --no-reactions`
  核对输出字段名与 `src/channel.ts` 解析器（message_id/create_time/sender.sender_type/body.content）一致；不一致则修解析器。

### A6 飞书已知坑 — **需真实飞书**
- 重启 daemon 后首条 DM 路由正确（adapter DM 缓存冷启动可能先走 onNewMention——观察是否影响 admit）；3s ack 无超时重试风暴（日志无重复同 messageId 处理）。

### A7 优雅关闭 — **需真机**
- 命令：`launchctl bootout gui/$(id -u)/dev.gd32.pi-larkd`（流式回复进行中执行）。
- 预期：半流卡片收到「⏸ pi-larkd 正在关闭…」终态；日志确认 harness.close() 完成；`lsof -i | grep -i lark` 无 WS 半开。

### A8 单例互斥 — **可半自动（无飞书也能测）**
- 命令：daemon 由 launchd 运行时，另开终端 `PI_LARKD_CONFIG=... LARK_APP_ID=... node dist/daemon.js`。
- 预期：第二实例打印「another instance is running」退出码 1，第一实例不受影响。

## 手工准备清单（部署时一次）

1. `security add-generic-password -s pi-larkd -a lark-app-secret -w '<LARK_APP_SECRET>'`
2. `security add-generic-password -s pi-larkd -a model-api-key -w '<CPA_KEY>'`
3. `~/.pi-larkd/config.json`（模板见 README，无 secret）
4. 飞书开放平台：自建应用 → 机器人 + 事件订阅（WS 模式）+ `im:message` 与 `im:message.group_msg`（群用）权限 + card.action.trigger 回调 → **发布版本**
5. plist 中 `LARK_APP_ID` 填入后 `launchctl bootstrap`
