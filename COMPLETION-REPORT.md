# pi-larkd 完工报告（P0→P3 全案实施）

日期：2026-11-09 · repo：`~/Coding/pi-larkd`（独立，本地 git，4 commits，无远程）
基准：spec `specs/pi-larkd/`（r2 PASS 可实施）+ pi-durable@1.5.0 exact pin

## 1. 已验证（自动化，可复现）

`pnpm check` = typecheck（src+test 双 tsconfig）+ vitest + eslint，**53/53 测试绿**：

| 阵地 | 钉子 |
|---|---|
| P0 | T-P0-2a requestId 幂等（同 id 同 submission + **跨重启** + 零重复模型调用）；路由 deny/冷却/dropBots；pump 单卡不重复；backfill 命令实形（--start 截秒回退 1s/--no-reactions/分页/bot 过滤）；import 门负向验证（违规文件必被 lint 拒） |
| P1 | T-P1-1a 准入矩阵（非白名单零提交/mentionOnly/muted/disabled/bot）；审批状态机 ×7（deny/approve_once/Always 4h 精确串/非 owner 忽略+审计/敏感路径零卡硬拒/超时 janitor/**crash 重入同 approvalId 重发卡**）；patrol 基线不推/变化推一次/幂等 rearm；B7 静态门（flow-board 零写路径 + M5 白名单零突变零无条件放行）；burst 合并窗口/上限/确定性 requestId；远程控制 owner-only |
| P2 | v0 双层注入落 pi.system section；memory_write 服务端 chat 归属圈禁；indexHeader 读共享用户层；runConsolidation 必收缩/删除 provenance/原子批 |
| P3 | 晨报 09:00 数学 + same-day 补跑/跨日不重发；reminder 跨重启交付；soak 15s 冒烟 PASS（219 msgs/0 未答/RSS 146MB/WAL 4MB）；升级演练 dry-run 全流程（含完整 check 回归） |
| daemon | 模块链冒烟：transform-types 下全量加载，预期停在 Keychain 缺失处 |

## 2. 待真机验证（详见 VERIFICATION-LEDGER.md，不阻塞交付）

- **A 系列**：真实飞书 DM 10 轮+60 消息长会话、kill -9 续跑+重投、launchd 守护与中毒 run 不成风暴、
  断网 30s backfill 实拉（bot 身份 JSON 字段实形核对）、3s ack、优雅关闭半流卡终态、单例互斥
- **B 系列**：双 channel 并行重叠断言、真实卡片渲染与点击（operatorOpenId 是否 ou_ 形）、
  审批跨 launchctl kickstart、board 巡检真实工作区、远程控制实测
- **C 系列**：pi ↔ pi-larkd 用户层记忆双向可见（同文件同锁）
- **D 系列**：CPA 真模型 soak 3conv×30min、24h RSS/WAL 曲线、晨报连续 3 日准点、真实 pin 升级

## 3. 偏差（DEVIATIONS.md，11 条，均有对照+理由+最小替代）

关键四条：
- **D-1** flock→O_EXCL pidfile（macOS 无 flock(1)，Node 无 syscall 绑定）
- **D-2** pi-durable import 边界=substrate.ts+durable-ext/（M4/M5 的 extension authoring 是 spec 自身预设）
- **D-9** cc-core 语义核就地相对路径引用（其单包 exports 不含 memory 子路径，file:/workspace 不可构造）；
  连带运行时改 `--experimental-transform-types` 直跑 TS 源码、放宽 noUncheckedIndexedAccess
- **D-10** DP-P2-1 决策=b（session_recall 工具模式+静态索引头；LLM 选档留升级位）

另：D-3 pump 走 pi.live partial 而非 entries diff（绕开 window splice 类边界）；D-5 janitor 进程内
定时器+启动扫描；D-7 Bindings 单文档（pi-durable 无 doc 枚举 API）；D-11 记忆锁=cc-core 自带
acquireLayerLock（无需另造 flock）。

## 4. 剩余风险与建议

1. **上游毛边**（cherry-studio 实盘警示的 steer freeze/stale resume 类）：A2/B5 真机若遇，按 pin+记录+
   必要时 patch 处理；`pi.durable` 的公开 watch coalescing 对打字机流无感，恢复首帧一致性靠 A1 实测。
2. **审批体验**：remind/channel_bind/memory 外工具全走卡片——高频操作建议 owner 点一次 Always（4h 精确串）。
3. **faux 压测噪声**：soak 在 >1000 msg/s 的极端速率下有响应队列竞态（已用 pace 参数规避）；真实 CPA
   速率远低，D2 真机结论以 CPA 跑为准。
4. **跨仓引用的机器耦合**：memcore.ts 相对引用 `~/Coding/Pi-Extension/pi-claude-code-core`——cc-core
   移动/重构会断 daemon 启动（fail-fast，日志直指）；这是「不 copy」决策的代价，接受并已文档化。
5. **群 thread 回填**（P1-1.6 遗留）：backfill 用 `+threads-messages-list` 补群 thread 回复——当前
   bindChannel 默认群场景未接（晨报/巡检不受影响）；群重度使用前补。
