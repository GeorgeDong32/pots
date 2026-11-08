# pi-larkd

飞书（Lark）双工 super-agent daemon：飞书多 channel 经官方 Lark adapter（WebSocket）进入
[pi-durable](https://github.com/earendil-works/pi) Harness，流式卡片回复、崩溃续跑、事件重投幂等；
deny-by-default 工具审批、rex-flow board 只读巡检、双层记忆（与本机 pi 共享用户层）。
Spec：`../Pi-Extension/specs/pi-larkd/`（r2 PASS 可实施）。**P0-P3 全部落地。**

## 架构

```
launchd (RunAtLoad + KeepAlive{Crashed} + ThrottleInterval 10)
└─ node --experimental-transform-types src/daemon.ts   # 直跑 TS 源码，无构建产物
   ├─ channel.ts        M1  Chat SDK + @larksuite/vercel-chat-adapter；200ms 流式节流；
   │                        4 QPS 合并式文本发送；lark-cli backfill；审批卡
   ├─ bridge.ts         M2  BindingsDoc 路由表 + 原子准入（INV-P1-1）；watch→post 泵；
   │                        owner 远程控制 stop/status/compact/new
   ├─ substrate.ts      M3  pi-durable 唯一进口（lint 强制）；SQLite；requestId 幂等
   ├─ durable-ext/          M5 beforeTool 审批门 + M4 board 巡检 task + M6 记忆 + P3 cron
   ├─ approvals.ts       M5  ApprovalDoc 状态机：卡片审批/owner-only/4h TTL/超时 janitor/crash 重入
   ├─ supervisor.ts      M4  board 只读工具实现 + 摘要（F27 provenance）
   ├─ memcore.ts             cc-core 记忆语义核唯一跨仓进口（就地引用，不 copy）
   └─ keychain/config/log
```

安全姿态：**deny-by-default**——非 allowSenders 零提交；M5 拦一切非白名单工具（白名单=只读监控+
路径圈禁记忆工具）；sensitive 路径硬拒；审批 operator==owner。

## 开发

```bash
pnpm install
pnpm check          # typecheck(src+test) + vitest + eslint  — 53 测试
pnpm test           # vitest only
node --experimental-transform-types scripts/soak.ts --convs 3 --seconds 60   # soak 冒烟
node scripts/status.mjs                                                      # 状态快照
```

依赖 pin：`@earendil-works/pi-durable@1.5.0`（exact）。升级面= `src/substrate.ts` +
`src/durable-ext/**` + `src/memcore.ts`（ESLint import 门钉住；runbook：`scripts/upgrade.sh`）。

## 部署

1. **Keychain**（secret 永不进 config/plist/git）：

   ```bash
   security add-generic-password -s pi-larkd -a lark-app-secret -w '<LARK_APP_SECRET>'
   security add-generic-password -s pi-larkd -a model-api-key -w '<模型 API key>'
   ```

2. **配置** `~/.pi-larkd/config.json`（模板；无 secret）：

   ```json
   {
     "homeChatId": "oc_xxx",
     "ownerOpenId": "ou_xxx",
     "model": {
       "provider": "cpa",
       "modelId": "<CPA 上的模型 id>",
       "baseUrl": "http://127.0.0.1:18317",
       "contextWindow": 200000,
       "maxTokens": 32768
     }
   }
   ```

3. **飞书自建应用**：机器人能力、`im:message`（群加 `im:message.group_msg`）、事件订阅 WS 模式、
   card.action.trigger 回调，**发布版本**。`cli_a...` App ID 填 plist 的 `LARK_APP_ID`。

4. **launchd**：

   ```bash
   cp launchd/dev.gd32.pi-larkd.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.gd32.pi-larkd.plist
   tail -f ~/Library/Logs/pi-larkd.log
   ```

回滚：`launchctl bootout gui/$(id -u)/dev.gd32.pi-larkd` + 删本目录（不触碰 pi 安装面）。

## 运维速查

| 动作 | 命令 |
|---|---|
| 状态 | `node scripts/status.mjs`（读 status.json 快照，不开库） |
| 心跳 | daemon 每 30min 直发 home chat；连续 2 周期静默=daemon 死了 |
| 升级 | `sh scripts/upgrade.sh <version> [--dry-run]` |
| soak | `node --experimental-transform-types scripts/soak.ts --convs 3 --seconds 1800` |
| 远程控制 | owner 在频道发 `stop` / `status` / `compact` / `new <note>`（群须 @） |
| 绑频道 | 让 agent 调 `channel_bind`（经审批卡）或 DM 自然语言落表 |

## 记忆

- v0：`~/.pi-larkd/memory/shared.md` + `channels/<chatId>.md`（memory_write 工具，owner-only 约定）
- v1：cc-core 语义核（`~/.pi/agent/memory` 用户层与本机 pi **共享**，双方 consolidation 共用同一把
  层锁）；session_recall 检索 + memory_consolidate 收缩（必收缩+provenance 校验）+ 超预算自动去抖整合

## 文档

- 验收门台账（真机待验清单）：`VERIFICATION-LEDGER.md`
- 与 spec 的偏差：`DEVIATIONS.md`（11 条，含 DP-P2-1 决策）
- replay 审计：`docs/replay-audit.md` · 安全审计：`docs/security-audit.md`
- 完工报告：`COMPLETION-REPORT.md`
