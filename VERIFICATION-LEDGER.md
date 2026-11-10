# VERIFICATION-LEDGER.md — 需真机/真实飞书验收的门

每条：门 ID / 前置条件 / 复现命令 / 预期结果。实现侧已自动化的门（A3/T-P0-2a 等）标注 DONE。

## P0（A 系列）

### A1 DM 连续 10 轮对话 + 60 消息长会话 — **需真实飞书 + CPA**
- 前置：Keychain item ×2、`~/.pots/config.json`、飞书自建应用（机器人能力 + `im:message` 收发 + WS 事件订阅 + card.action.trigger 回调，**已发布版本**）、CPA 运行中。
- 命令：`launchctl bootstrap gui/$(id -u) launchd/dev.gd32.pots.plist`，然后在 DM 连发 10 轮（其中至少 2 轮触发 read 工具，如「读 ~/.pots/config.json 告诉我 modelId」），再进行一轮 60+ 条消息长会话。
- 预期：每轮流式卡片 + 终态正确；长会话中卡片内容无错乱/重复（pump partial diff 正确性，含 F30 场景）。
- 关注点：cherry-studio 实盘警示的 watch coalescing——恢复后首帧一致性。

### A2 kill -9 崩溃续跑 + 重投幂等 — **需真实飞书**
- 前置：A1 已通；daemon 运行中，一轮 run 进行中。
- 命令：`kill -9 $(cat ~/.pots/daemon.lock)`（run 中途），launchd 10s 内拉起；崩溃前各投 1 条、重启后投同 message_id（飞书 3s 重投模拟：可用 lark-cli 重发同 ID 或等 adapter 重投）。
- 预期：in-flight run 经 `resume()` 续跑完成；前后消息不丢不重。
- 已自动化部分：T-P0-2a「restart 后同 requestId 同 submission id」已绿（test/substrate.test.ts）。

### A3 幂等钉子 — **DONE（自动化）**
- test/substrate.test.ts「T-P0-2a」两条：同 requestId 二次 submit 同 id、跨重启同 id、无重复模型调用。

### A4 launchd 守护 — **需真机**
- 命令：`launchctl kickstart -k gui/$(id -u)/dev.gd32.pots`，观察 10s 内复活；重启 Mac 验证 RunAtLoad；连续 3 次制造中毒 run（如配置坏模型端点）观察无重启风暴。
- 预期：KeepAlive{Crashed} × harness crash-loop(5) 不叠加成风暴；crash 计数持久性实测结论回填本 ledger（F07 疑问：计数若在内存，launchd 拉起即清零——需观察 restartLimit 行为）。

### A5 断网 30s 恢复 + backfill — **需真实飞书**
- 前置：A1 已通。r2 遗留：bot 身份 `+chat-messages-list` 实拉验证 JSON 实形（字段名系二进制+同源 API 推定）。
- 命令：关 Wi-Fi 30s 期间在 DM 发 2 条消息；恢复后观察 `~/Library/Logs/pots.log` 中 backfill 命令与 admit 记录。
- 预期：重连 + backfill 补收断线窗口两条消息且各只回复一次（watermark 幂等）。先手工跑一次：
  `lark-cli im +chat-messages-list --as bot --chat-id <home_chat_id> --start <ISO> --no-reactions`
  核对输出字段名与 `src/channel.ts` 解析器（message_id/create_time/sender.sender_type/body.content）一致；不一致则修解析器。

### A6 飞书已知坑 — **需真实飞书**
- 重启 daemon 后首条 DM 路由正确（adapter DM 缓存冷启动可能先走 onNewMention——观察是否影响 admit）；3s ack 无超时重试风暴（日志无重复同 messageId 处理）。

### A7 优雅关闭 — **需真机**
- 命令：`launchctl bootout gui/$(id -u)/dev.gd32.pots`（流式回复进行中执行）。
- 预期：半流卡片收到「⏸ pots 正在关闭…」终态；日志确认 harness.close() 完成；`lsof -i | grep -i lark` 无 WS 半开。

### A8 单例互斥 — **可半自动（无飞书也能测）**
- 命令：daemon 由 launchd 运行时，另开终端 `POTS_CONFIG=... LARK_APP_ID=... node dist/daemon.js`。
- 预期：第二实例打印「another instance is running」退出码 1，第一实例不受影响。

## 手工准备清单（部署时一次）

1. `security add-generic-password -s pots -a lark-app-secret -w '<LARK_APP_SECRET>'`
2. `security add-generic-password -s pots -a model-api-key -w '<CPA_KEY>'`
3. `~/.pots/config.json`（模板见 README，无 secret）
4. 飞书开放平台：自建应用 → 机器人 + 事件订阅（WS 模式）+ `im:message` 与 `im:message.group_msg`（群用）权限 + card.action.trigger 回调 → **发布版本**
5. plist 中 `LARK_APP_ID` 填入后 `launchctl bootstrap`

## P1（B 系列）

### B1 两 channel 并行 — **需真实飞书**
- 命令：两个已绑定 chat 同时发消息；`grep admitted ~/Library/Logs/pots.log` 取两 run 的起止时间戳。
- 预期：两 run 时间区间重叠（F28 断言）；同 channel 连发由 inbox 串行。

### B2 准入矩阵实测 — **需真实飞书**
- 自动化部分已绿：T-P1-1a（admission.test.ts）。
- 实测：非白名单成员群内 @ 零响应；陌生 DM 收 deny 提示（bridge F23 逻辑已测，需实测 notice 文案送达）；另一 bot 消息被 drop。

### B3 board 巡检 — **需真实 rex-flow 工作区**
- 命令：绑定带 boardPath 的 channel（channel_bind 或直接改 bindings doc）→ 等巡检基线 → 改 board（如 task 状态）→ 观察推送；kill -9 于 escalate 后重启验证不重复。
- 预期：变化 ≤60s 推送一次；重启后不重复。已知取舍见 DEVIATIONS D-8（post 后、环 commit 前的窗口宁重勿漏）。

### B4 审批闭环实测 — **需真实飞书卡片**
- 自动化部分已绿：approvals.test.ts 7 条（deny/approve_once/Always TTL+精确串/非 owner 忽略/敏感路径/超时/重入）。
- 实测：卡片三键在飞书端渲染与点击回调（operatorOpenId 是否为 open_id 形如 ou_）；卡片 JSX 的 Lark 渲染。

### B5 审批跨重启 — **可半自动（launchd + 手动卡片）**
- 命令：pending 时 `launchctl kickstart -k` → 重启后同 approvalId 重发卡片 → 点击生效。
- 自动化部分已绿：crash re-entry 用例（新 manager 同 ID 重发 + 决策生效）。真实卡片点击路径需 B4 前置。

### B6 远程控制 — **需真实飞书**
- 自动化部分已绿：owner status/new；非 owner stop 零效果（admission.test.ts）。
- 实测：owner DM 发 `stop`（run 进行中）/`compact`/`new <note>`；群内命令须 @。

### B7 只读纪律 — **DONE（自动化）**
- test/b7-static.test.ts：flow-board 写子命令零调用、board.json 零写路径、dispatch 只写 dispatch/ 树；M5 白名单 const 零突变、allow 全部条件化。运行时矩阵见 approvals.test.ts。

### B8 冻结语义 — **可半自动**
- 自动化部分：bridge 队列语义依赖 durable inbox（pi 语义保证）；手动：pending 期间发第二条消息，pi.inbox 断言（`pots status` 的 inbox 深度）。

## P2（C 系列）

### C1 v0 注入+跨重启 — **DONE（自动化）**
- test/memory.test.ts：shared/channel 两层注入 pi.system section 断言；memory_write 落盘。「次日新 run 生效」即文件系统持久，等价已验。

### C2 用户层共享（pi ↔ pots 双向）— **半自动**
- 自动化：indexHeader 读 `~/.pi/agent/memory`（隔离 HOME 下）已绿；consolidate 批次原子性/必收缩已绿。
- 真机：pi TUI 侧（cc-core）写一条 → pots 新 run 注入可见；反向亦然（同文件双向）。注意双方 consolidate 都拿 acquireLayerLock。

### C3 recall 选档 — **DP-P2-1 决策=b（见 DEVIATIONS D-10）**
- 工具模式已落地（session_recall）；LLM 选档为后续升级。真机：长会话中 session_recall 命中率体感。

### C4 consolidate — **DONE（自动化，核心语义）**
- runConsolidation 必收缩/删除 provenance/原子批已在隔离 HOME 下钉住。真机部分：afterRun 去抖 task 触发 directive → agent 调 memory_consolidate 的全链路（需 CPA 真模型）。

## P3（D 系列）

### D1 replay 审计报告 — **DONE**
- docs/replay-audit.md：全工具标注表 + bash 无实测对象的说明（registry 从未装 bash）+ restartLimit 调优依据。
- bash 实测：**N/A-by-design**（P0-P3 未引入 bash；引入前必须补实测，见审计文档）。

### D2 soak — **脚本 DONE + 15s 冒烟 PASS；30min/24h 挂机待真机**
- 脚本：`node --experimental-transform-types scripts/soak.ts --convs 3 --seconds 1800 [--model cpa]`
- 冒烟（3conv×15s，faux）：PASS · 219 msgs · 0 未答 · RSS 146MB / WAL 4MB（阈值 400/200）。
- 真机门：CPA 真模型 3conv×30min（观察 429/排队/降速与 channel 软上限结论）；24h RSS/WAL 曲线；超标处置（F32）动作见脚本输出字段。

### D3'/D3 cron — **自动化部分 DONE；连续 3 日准点待真机**
- 自动化：nextMorningReport 数学、same-day 补跑判定、跨日不重发、reminder 交付（cron.test.ts 4 条）。
- 真机门：晨报连续 3 日 09:00 准点（含 Mac 睡眠日醒后 ≤60s 补跑）；提醒跨 `launchctl kickstart -k` 存活。

### D4 升级演练 — **dry-run DONE；真升级待实际版本变更**
- `sh scripts/upgrade.sh <ver> --dry-run` 已跑通全流程（bootout→snapshot→pin→install→check→bootstrap 清单）。
- 真机门：真实 pin 升级（如 1.5.1）走同一脚本 + A/B 回归清单。
