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

## D-5 审批超时 janitor 用进程内定时器 + 启动扫描（P1-3.3.4）

- **对照**：spec 写「超时 janitor task（时钟唤醒）」——durable sleeping task 形态。
- **实情**：daemon 是常驻进程；未决审批的 crash 兜底已由两层覆盖：启动扫描（`ApprovalManager.start()` 首扫）+ beforeTool 重入（pending 已过期 → 直接 deny）。janitor 的唯一职责是「进程活着时把超时落账」，`setInterval(60s)` 足够。
- **决定**：进程内定时器 + 启动扫描，语义等价、少一个 task kind。若未来审批量大或需要跨进程可见，再升级为 sleeping task。

## D-6 审批卡决策后回帖而非原地改卡（P1-3.4）

- **对照**：spec 未明确卡片的终态呈现方式（Chat SDK 的 requestApproval 有原地改卡，但绑定 Workflow SDK，RD 已否决）。
- **决定**：决策后在频道回一行结果（✅/❌/⏱），原卡片保留作为审计痕迹。原生 CardKit 改卡需持有 SentMessage 引用跨崩溃存活，复杂度不值。

## D-7 ChannelBinding 为 session 单文档（含 Record<chatId, binding>），非 doc family（P1-1.1）

- **对照**：spec「ChannelBinding chord document（chatId 主键）」。
- **实情**：pi-durable 的 Tx/Session 无文档枚举 API（scanTasks/scanEntries 有、scanDocs 无）；doc family 无法遍历出路由表。审批侧 R2-2 要求 family 是因为并发互覆；路由表是低频单写者（bind 工具 + 迁移），单文档原子更新安全且天然可枚举。
- **决定**：session 单文档 `pi-larkd.bindings`，`bindings: Record<chatId, ChannelBinding>`，chatId 仍是逻辑主键。语义与 spec 一致。

## D-8 patrol 通知丢失窗口的设计取舍（P1-2.3 / F11）

- **对照**：F11 要求「post 后 crash → rerun 不重复推送」。
- **实现**：LastSeen+pendingDiff 先 commit（F11 顺序），post 后写 postedDiffIds 环。crash 窗口分析：(a) commit 后、escalate 前死 → 重入 pendingDiff 补投（通知送达）；(b) post 后、环 commit 前死 → 重入发现 diffId 已在环中…… 环 commit 未落，实际会重投一次（宁重勿漏，与 backfill 哲学一致）。B3 实测关注此窗口。
