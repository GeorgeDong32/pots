# DEVIATIONS.md — spec 与实现/一手 API 的偏差记录

原则：spec 与 pi-durable / Chat SDK 实际不符时不静默改设计；每条记录对照 + 理由 + 最小替代。

## D-1 flock → O_EXCL pidfile（P0-5，F12）

- **对照**：P0-5 要求启动即 flock `~/.pi-larkd/daemon.lock`（非阻塞）。
- **实情**：macOS 不带 `flock(1)` CLI（Linux util-linux 专属）；Node stdlib 无 `flock(2)` 绑定，引入原生依赖违背最小依赖。
- **最小替代**：`src/daemon.ts` 的 `acquireProcessLock()` —— `open(path,"wx")` + 写 pid + 存活探测（`kill(pid,0)`，ESRCH 即陈锁可清）。对「手动第二实例 vs launchd 实例」这一目标场景，保证与 flock 等价。

## D-2 pi-durable import 边界的解释（P0-2 lint 规则）

- **对照**：P0-2「substrate.ts 是 pi-durable 唯一进口」；P1 的 M4 `registerTools` / M5 beforeTool hook / M6 section 又必须使用 pi-durable 的 extension-authoring API（defineTool/hook/section/defineTask）。
- **解释**：「唯一进口」的对象是 **Harness 运行时**（open/storage/resume/commit/watch/Conversation 句柄）——升级 pi-durable 时最可能碎的面。extension authoring 是「跑在 Harness 里的代码」，spec 的模块接口表（M4 `registerTools(ext)` 等）本身就预设 M4/M5/M6 能定义工具。
- **落地**：ESLint 允许 `src/substrate.ts` 与 `src/durable-ext/**` 两处 import pi-durable；其余 src 一律报错（已负向验证）。durable-ext/ 因此也是 P3-4.3 升级时须检查的面，README 升级章节明示。

## D-3 pump 采用 `pi.live.generation.message` partial 而非 entries diff（P0-4.2 / F30）

- **对照**：spec 提「按 entryId diff，容忍 window 50→100→50 splice」。
- **实情**：`pi.live.generation.message`（提交的节流 partial）直接给出当前 attempt 的增量文本；终态用 `submission.wait()` + `settled.answer` 直接按 EntryId 取全文，均不经过 window。window splice 只影响「对 view.entries 做 diff」的实现路线。
- **最小替代**：partial 前缀 diff（attempt 内单调增长；新 attempt 前缀不匹配即视为新段落整段追加）+ 终态 remainder 补发。A1 的 60+ 消息长会话门仍照 spec 验证行为正确性。效果等价，少一类边界。

## D-4 Chat SDK state 用 memory adapter（P0-3.1）

- **对照**：Chat SDK 生产建议 Redis/Postgres state；spec 未指定（只列依赖 `chat` + lark adapter）。
- **决定**：单实例 daemon + 单飞书应用，去重/锁的跨进程需求不存在；崩溃后的飞书 3s 重投由我方 `requestId=feishu:{message_id}` 幂等吸收（这正是设计意图）。生产 state adapter 无必要，不加依赖。
