# Replay 语义审计（P3-1，D1）

每个会进 registry 的工具/任务的 replay 标注与理由。规则：`replay:"safe"`（幂等，崩溃后
rerun 无害）才允许恢复重跑；未标注=默认 `unsafe`（interrupted 语义正确——重跑即重复副作用）。

| 工具/任务 | replay | 理由 |
|---|---|---|
| `read`（pi-durable 内置） | unsafe（默认） | 读文件幂等，但未标注时崩溃即 interrupted——模型看到中断结果后自行决定是否重发；标注 safe 反而在文件被并发修改时把陈内容当新结果。保持默认。 |
| `board_status` | safe | 纯读 board JSON/摘要，rerun 结果一致。 |
| `board_tasks` | safe | 同上。 |
| `watch_run` | safe | flow-watch --check-now 快查，幂等。 |
| `workspace_list` | safe | 读 bindings 表。 |
| `session_recall` | safe | 读双层记忆，幂等。 |
| `dispatch_note` | unsafe（默认） | 追加 note 文件——rerun=重复 note。 |
| `memory_write` | unsafe（默认） | 追加记忆行——rerun=重复行。 |
| `memory_consolidate` | unsafe（默认） | 写记忆层（持锁+必收缩校验），崩溃中断正确。 |
| `channel_bind` | unsafe（默认） | 改路由表=改安全边界；且经 M5 审批（审批本身有 pending-guard 幂等，但工具重跑不标注）。 |
| `remind` | unsafe（默认） | 创建 durable task——rerun=重复提醒。经 M5 审批。 |
| `pots.patrol` 任务 | 按 phase 设计 | poll=纯读+doc commit；escalate 的 post 有 postedDiffIds 环幂等（B3）。 |
| `pots.memory-consolidate-debounce` | 幂等 by design | overBudget 复查+follow-up 提交（requestId 未显式——重复提交最多多一次 directive 输入，agent 幂等处理）。 |
| `pots.morning-report` / `pots.reminder` | 幂等 by design | day 键防重发；reminder 终态后不复跑。 |

## bash 的 replay 结论（P3-1.1）

**P0-P3 的 registry 从未安装 bash**（deny-by-default 安全姿态：write/edit/bash 不进
registry）。因此「kill -9 于 bash 执行中 → rerun 还是 interrupted」在本 daemon 无实测
对象；内置 bash 若未来经 M5 审批引入，须先补此实测再定 replay 标注。pi-durable 语义：
未标 safe 的工具调用崩溃后模型收到 interrupted 错误结果——对 bash 是正确语义（命令
可能已部分执行）。

## restartLimit 调优依据（P3-1.3）

默认 5。GLM 高峰 429 场景由 `settings.retry.maxRetries=3`（provider 层退避）先吸收；
restartLimit 只统计 crash/eviction 类中断。当前无 bash/长任务工具面，崩溃源主要是我方
bug 与系统级事件——保持 5；若 soak（D2）观察到模型故障引发 run 反复中断再调。
