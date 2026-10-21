# 响应契约与工具选路（0.5.21 起随 npm 包发布）

> 目的：把「新用户最常误读的响应语义」与「目录面（六和线 13 默认 / classic 44 / diagnostic 18）怎么选」一次写清。
> 依据：首次使用者试用报告 + Q/R/S/T1/U 修复批次；env 门与环境变量含义见仓库根 `README.md` 的环境变量表；边界覆盖矩阵为内部材料，未随开源仓发布。

## 一、响应信封（response envelope）

| 字段 | 含义 | 注意 |
|---|---|---|
| `ok` | **请求被处理**（≠ 业务成功） | 写请求 ok=true 也可能是预览/被拦前收口，看下面三看 |
| `observation.committed` | 是否真的落盘 | 预览=false；拦截=false |
| `observation.result_kind` | `partial`（写/检查未验证）→ `validated`（检查通过且有 patch） | `skipped` 不算通过 |
| `observation.evidence[]` | 检查证据（kind/result/source/provenance/rule_version/depends_on/actual） | `actual` 含 `stdout_tail/stderr_tail`（尾 600 字符）可排障 |
| `error` / `code` / `message` / `suggestion` | 错误响应恒为 `{ok:false, error:<code>, code, message, suggestion?}` | 常见码：`INVALID_INPUT` `NO_MATCH` `VERSION_CONFLICT` `BATCH_LOCK_BUSY` `TXN_NOT_FOUND` `FILE_EXISTS` `VALIDATION_FAILED` `workspace_mismatch` `workspace_not_indexed` `service_unavailable` `no_commits` |
| `allowed_actions` | **推荐**下一步，不是权限表（ADR-004） | 活跃任务上仍可调 code_patch/code_check/… |
| `task.lifecycle` | 任务生命期（`active`/`cancelled`） | 写响应透出真实值；cancelled 拒绝新写（见 §三一） |
| `next_action` | 结构化下一步 `{tool, args, note?, template?, required_args?, awaiting_decision?, progress?}` | `template:true` 表示需补齐 `required_args` 才能直接调用；其余 args 取出即可调用；`awaiting_decision:true` = 完成/有发现，交还使用者决定（13-C）；`progress:"waiting"` = 在途（live job / prepared·running·indeterminate op），先等待或核对，勿重复启动（14-A AC31）；**14-B AC03：`next_action:null` + `progress:"done"` + `mechanical_requirements_met:true` + `goal_judgment:"host_required"` = 工具侧机械要求已满足（仅工具侧完成声明，业务目标交宿主判断；review 路线保留 awaiting_decision）** |
| `next_step` / `warning` / `limitations` | 指路 / 非阻断警告 / 声明局限 | — |

**extra 平铺**：`envelope({extra})` 会把 extra 字段平铺到**顶层**——写响应里 `r.undo`（不是 `r.extra.undo`）。

**状态目录**：统一 `getStateDir()`（`MALONG_STATE_DIR`，默认 `~/.config/malong`）——workspaces / jobs / feedback / ledger / entry-tasks 全在同一根（U，2026-10-05；旧 repo 相对 `data/malong-mcp` 启动时自动迁移）。

## 二、写操作

- 预览是默认：`dry_run` 缺省 true，不落盘、不记操作；响应含 `validation`（`syntax/bracket`: `pass|fail|skip`）。`edit_transaction(action="edit", dry_run:true)` 亦可先验证匹配（回显逐编辑 `matches[].line/occurrences` + `would_apply`，不落盘；edit 的 dry_run 可无 txn）。`line_span.expect_sha`（公开 schema 位）与 `edit.expect_sha`（兄弟位）等价生效——同值可、异值拒（14-A AC29）。
- 拦截策略：`standard`（默认）拦 `fail`（语态/括号）；`safety.block_on_validation_error=false` 显式放行；`strict` 连同 `skip` 拦；`fast` 不拦。preview 与 apply 同一策略——不再出现「preview OK、apply 被拒」的矛盾（Q3）。
- 撤销令牌（写响应顶层 `undo`）：`{ token, txn_id, expires_at, retention_hours: 24, via }` → `edit_transaction(action="undo_commit", txn_id=<token>)`。
- 双命名空间（Q1）：经典事务在 `.ai-transactions/recent/`（last-3 窗口）；写链（write_symbol/code_patch 等）在 `.malong/journal/`（24h）。`undo_commit` 未命中经典则自动回退写链；外部改动 → `EXTERNAL_CHANGE` 拒绝；`created` 事务的 undo = 删除文件。
- 新建文件（Q2）：`create:true` + `content`（写响应/`code_patch`/`code_batch` 同语义）；`edit_transaction(action="edit", create:true)` 同样支持（事务内新建，rollback/undo_commit 按哈希守卫删除，已存在 → INVALID_INPUT）；文件已存在 → `FILE_EXISTS`（写链）；禁 `base_version`/`patch`；父目录自动创建；批内回滚 = 删新建文件。
- 写后 `observation.reindex` 给出索引状态（`ok` / `skipped_large` / `non-code: not_indexed`）。

## 三、状态层（graph + stateful）

| env | 档位 | 工具数 | 含 |
|---|---|---|---|
| （默认） | graph 六和线 | 13 | `code_task`/`code_read`/`code_status`/`code_query` + `code_patch`/`code_batch`/`code_check`/`code_control`/`code_audit`/`code_maintain`/`code_worktree`/`invoke_capability` + `edit_transaction`（恢复出口） |
| `MALONG_ENTRY_STATE=0` | graph 只读 | 5 | 六和线读侧：`code_task`/`code_read`/`code_status`/`code_query` + `edit_transaction` |
| `MALONG_INTERFACE=classic` | classic | 44 | `edit_batch`/`write_symbol(s)`/`git_worktree` 等经典全集（逐字节不变，golden 锁定） |
| `MALONG_INTERFACE=diagnostic` | diagnostic | 18 | 六和线 13 + `security_review`/`sweep_dead_code`/`dependency_gatekeeper`/`config_drift`/`repo_map` |

> LH-007（真白名单）：graph/diagnostic 下白名单外的工具（含 read_symbol/impact_analysis 等 classic 常驻）一律隐藏；调用隐藏名返回显式 `Tool '<name>' is not available in the current interface (<reason>)`。目录合同见 `malong/contracts/classic-44.contract.json`。

闭环：`code_task`（resolve 候选+影响面）→ `code_read`（拿 read_ref/版本）→ `code_patch|code_batch|code_maintain`（写，带 operation+证据）→ `code_check`（run=true/async=true 落证据）→ `code_control`（status/resume/expand/reopen/job/cancel_job）。

- `result_kind`：写后 `partial`；检查通过且有 patch → `validated`。
- `result_stale` + `stale_reason`（13-B）：统一走 `workflow/evidence.effectiveState`（code_status / code_control / next_action 同一口径）；reason ∈ `goal_change`（switch_route 后 goal_revision 漂移）> `file_change`（依赖文件/最后写哈希变化）> `pending_work`（indeterminate 后台结果）；**同类证据取最新**——旧 failed 不压新 passed（R1）；**14-B AC18：同 kind 按 scope 取代——同 scope 后继取代、异 scope 独立（后查文件不吞先查文件的范围证明）**；stale validated 的 `next_action` 按 route 给 `code_check`/`code_audit`，不再指向完成复核。
- `validated` 完成交还（13-B/C；14-B AC03 收口）：`route=review` 的完成态由 audit 驱动——仅测试通过且无 audit 证据时 next_action 仍指 `code_audit`。**14-A AC30：audit 证据绑定 goal_revision + 依赖适用性——旧目标/文件漂移/未运行（skipped）不算完成审查，重跑 `code_audit` 并说明不适原因。** **14-B AC03：非 review 路线机械要求满足（validated 且未陈旧、无在途 job/op）→ `next_action:null` + `progress:"done"` + `mechanical_requirements_met:true` + `goal_judgment:"host_required"`（仅工具侧完成；五出口同源 completionProjection）；review 路线保留 awaiting_decision（findings 交还）。**
- 撤销/恢复：写链 journal 24h；崩溃窗口 W1/W3 自动对账（全 intended 收口 / 全 pre 重放 / 混合 → `indeterminate`，绝不谎报 committed）。
- 长检查：`code_check(async:true)` 返回 job_id，后台完成落证据；`code_control(action="job"|"cancel_job")`。
- **请求预算（MCP 请求级 120s 硬上限）**：前台阶段实际只给 110s（`verify_pipeline` 的 `cap = isBackground ? 600s : 110s`），后台 job 放宽到 600s。套件跑超过前台上限会被判 `failed`——**这是预算截断，不是代码缺陷**：0.5.26 起该情形会在 `evidence.actual.notice` 带上 `mcp_note` 原文、limitations 明说「NOT a code defect」，且 next_action 改指 `code_check(async=true)`（不再指回 code_patch 改代码）。

### 3.1 取消与恢复（LH-001）

- `code_control(action="cancel")` 后任务为**终态**：5 个写入口（`code_patch`/`code_batch`/`code_check`/`code_maintain`/`code_worktree`）对 cancelled 任务一律拒绝（`task_cancelled`）——preview/plan/status 也不例外；文件/HEAD/生命周期零变化。
- **已完成操作的无副作用复核**是唯一例外：同 `request_id`+同载荷重放 succeeded 写操作仍返回 dedup 结果（不写盘）；`code_read` 可读但**不落材料、不翻转 node、不发 `read_ref`**（响应 `warning=task_cancelled_read_not_recorded`）。
- 显式恢复：`code_control(action="reopen")`——仅 cancelled 可调（否则 `not_cancelled`）；在途操作/活 job 拒绝（`reopened:false` + `blocked_by`）；node 恢复为 cancel 前值（事件记录 `reopened:true`）。**写入绝不隐式恢复**；cancel 与 reopen 都通过 CAS 发 lifecycle 事件。
- `cancel`/`reopen` 的 `allowed_actions`、resume 的 `next_step`、`code_read` 的 `next_action`（cancelled 时）均指向 reopen 出口。

### 3.2 budget 生效值（LH-011）

- `read_symbol`/`code_read` 返回 `budget: {requested, effective, floor: 200, used_estimate, truncated}`：`budget_hint` 低于 floor 200 抬到 200、`0` = 100000、硬上限 100000；`effective` 是实际生效值，`requested` 保留原请求（旧实现 `requested` 字段存的是 clamp 后值，调用方无从得知被抬升）。

## 四、工具选路速查

| 场景 | 首选 | 备注 |
|---|---|---|
| 看一个符号/文件 | `read_symbol` / `code_read` | graph 里的 code_read 带 task 上下文与版本 |
| 单文件多处编辑 | `edit_batch` | 原子、唯一匹配、dry_run 预览 |
| 符号级改写 | `write_symbol` / `write_symbols` | 带 base_version 冲突锚点 |
| 新建文件 | `write_symbol`（create:true） | 也可 `code_patch` create / `edit_transaction` create:true（事务内可回滚） |
| 敏感多文件改动 | `edit_transaction` 或 `code_batch` | 前者 dry_run 预览 + 即时回滚，后者带 operation/证据 |
| 撤销 | `edit_transaction(action=undo_commit)` | token 来自写响应顶层 `undo` |
| 完整任务闭环 | `code_task` 流 | 状态/证据/恢复语义都在这一档 |
| 跑测试/lint | `verify_pipeline`（classic）/ `code_check`（stateful） | 后者落证据、可 async |
| 隔离工作树改动 | `git_worktree` / `code_worktree` | 后者带 operation + preserved 恢复 |

## 五、新用户 FAQ（来自首次试用）

1. **ok=true 为什么没写盘？** 预览或拦截；看 `committed/result_kind`。
2. **preview 与 apply 不一致？** 已修（Q3）：同一 validation 策略，preview 直接给出 fail/warning 并明示 apply 会被拦。
3. **undo 令牌在哪？** 写响应顶层 `undo`；`via` 已指路 `edit_transaction(undo_commit)`。
4. **搜索零命中？** `.malongignore` 排除的文件不可搜（零命中时会提示规则数）；用 `code_task` 显式 `target` 覆盖。
5. **code_check 全 skipped 算通过吗？** 不算——skipped 不 validated；`verify_pipeline` 的 `pass` 仅表示「无检查可跑」。
6. **候选排序看起来乱？** 已修（R3 + LH-004）：target.file∩target.symbol 联合锚点置顶（同目录次之，其它锚点再次）；目标文件里找不到该符号时 `scan_warnings` 显式提示，不静默拿别处命中冒充；无 target 时注意 `scan_scope_note`（候选仅索引集）。
7. **并发多工作区会串库吗？** T2 起每 workspace 独立 DB 句柄（并发切换不销毁旧句柄）：读写严格落各自库，不存在串库/静默空结果；长任务（批量索引）整段钉住本 ws 句柄，中途切换不受影响。
8. **空仓库 git_worktree 裸报错？** 已修（R4）：`no_commits` + initial commit 引导。
9. **cancel 后写工具还能调吗？** 不能——5 写入口一律 `task_cancelled`（preview 也拒）；同 request_id 重放已成功操作仍可 dedup 复核；用 `code_control(action="reopen")` 显式恢复，或新建任务。
10. **budget_hint=50 为什么还返回 200 字符？** floor=200（`budget.effective` 回传实际生效值）；0=全文（上限 100000）。
11. **中文 goal 返回零候选？** 符号检索只认 ASCII 标识符——`content_scan.skipped=non_ascii_goal` + `scan_warnings` 会显式提示；把标识符用反引号括起或传 `target={file|symbol}`；首屏文案明示「零命中不代表不存在」。
12. **文件改了但状态还说 validated？** 13-B 起 `result_stale:true` + `stale_reason:"file_change"`，next_action 指回 `code_check`；resume 文案按原因区分（goal 变更 ≠ 文件变更）。**14-A：在途优先——后台 job/写操作进行中时 `progress:"waiting"` 指向 `code_control`（job/status），先等待/核对再决定（AC31）。**
13. **换了目标后重跑旧测试算完成吗？** 不算：goal_revision 漂移 → `stale_reason:"goal_change"`；`route=review` 的完成态由 audit 驱动，测试通过不等于安全审查完成。
14. **code_check 报 failed，但代码没问题？** 多半是**请求预算截断**：前台阶段上限 110s（请求硬上限 120s），跑更久的套件会被判超时——这不是代码缺陷。证据里 `actual.notice` 会带「120s hard timeout … will definitely time out」原文、`limitations` 明说 NOT a code defect，且 next_action 直接指 `code_check(async=true)`（后台 600s 上限）——跟着它走即可，别去改代码。
