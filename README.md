# pi-larkd

飞书（Lark）双工 super-agent daemon：飞书消息经官方 Lark adapter（WebSocket）进入
[pi-durable](https://github.com/earendil-works/pi) Harness，流式卡片回复、崩溃续跑、
事件重投幂等。Spec：`../Pi-Extension/specs/pi-larkd/`（r2 PASS 可实施）。

## 架构（P0）

```
launchd (RunAtLoad + KeepAlive{Crashed} + ThrottleInterval 10)
└─ dist/daemon.js
   ├─ channel.ts   M1  Chat SDK + @larksuite/vercel-chat-adapter；200ms 流式节流；lark-cli backfill
   ├─ bridge.ts    M2  homeChatId → root conv 路由；requestId=feishu:{message_id} 幂等准入；watch→post 泵
   ├─ substrate.ts M3  pi-durable 唯一进口（lint 强制）；只读 registry（仅 read 工具）
   ├─ approvals.ts M5  P0 占位：非只读一律 deny
   └─ config/keychain/log
```

安全姿态（P0）：**只读 agent**——registry 仅装 `read`；write/edit/bash 不存在即无攻击面；
未绑定 chat 一律回固定提示（deny-by-default）。

## 开发

```bash
pnpm install
pnpm check        # typecheck + vitest + eslint
pnpm build        # emit dist/（launchd 跑 dist/daemon.js）
```

依赖 pin：`@earendil-works/pi-durable@1.5.0`（exact）。升级只允许动
`src/substrate.ts` 与 `src/durable-ext/**`（ESLint import 门已钉住，见 DEVIATIONS.md D-2）。

## 部署

1. **Keychain**（secret 永不进 config/plist/git）：

   ```bash
   security add-generic-password -s pi-larkd -a lark-app-secret -w '<LARK_APP_SECRET>'
   security add-generic-password -s pi-larkd -a model-api-key -w '<模型 API key>'
   ```

2. **配置** `~/.pi-larkd/config.json`：

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

3. **飞书自建应用**：机器人能力、`im:message` 收发权限、事件订阅 WS 模式、
   card.action.trigger 回调配置，**发布版本**（否则卡片回调 200340）。
   `cli_a...` App ID 填入 plist 的 `LARK_APP_ID`。

4. **launchd**：

   ```bash
   pnpm build
   cp launchd/dev.gd32.pi-larkd.plist ~/Library/LaunchAgents/
   # 编辑 plist：确认路径与 LARK_APP_ID
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.gd32.pi-larkd.plist
   tail -f ~/Library/Logs/pi-larkd.log
   ```

回滚：`launchctl bootout gui/$(id -u)/dev.gd32.pi-larkd` + 删除本目录。

## 验收

- 自动化：`pnpm check`（幂等钉子 T-P0-2a、路由矩阵、backfill 命令实形、pump 单卡不重复）
- 真机门：见 `VERIFICATION-LEDGER.md`（A1-A8：真实飞书对话、kill -9、launchd、断网回填、优雅关闭）
- 偏差：见 `DEVIATIONS.md`
