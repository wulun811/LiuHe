# TRACE v0 — 本地轨迹：开关、分析、复盘指南

**状态**：TRACE v0，随 0.6.1 RC 引入。
**默认**：`off`。**发版默认关闭，用户不需要也不应该打开。**
**用途**：只给开发方自用（六合自己的迭代），用真实使用暴露工具设计问题。

---

## 0. 一句话

它不是遥测，不是埋点，不上报任何地方。就是开发方在自己机器上开一个本地文件，
记录「哪个工具被调了、多慢、成没成功、有没有验证」，然后定期看一眼哪里不舒服。

**给用户的话：保持默认 `off`。** 打开它对你没有任何收益，只会多一个本地文件。

---

## 1. 开关

| 值 | 行为 |
|---|---|
| `off`（默认） | 完全不写盘，连文件都不创建 |
| `errors` | 只记 `started` + 失败的 `finished`（崩溃窗和出错路径） |
| `all` | 记所有 `started` + `finished` |
| 其它任意值 | 一律回落 `off`（不报错、不猜测） |

> **不要把它当路径用**（2026-11-05 自用实测踩坑）：`MALONG_TRACE=/tmp/x.jsonl`
> 不在枚举里，会被**静默**当成 `off` —— 目录不建、文件不写、也没有任何警告。
> 轨迹位置是固定的 `<MALONG_STATE_DIR>/trace/malong-trace.jsonl`，不能指到别处。
> 想知道到底开没开，查 `health(stats).trace.mode`，别靠"我设了环境变量"推断。

```bash
# 自用开启（每次起 MCP 宿主前设环境变量）
MALONG_TRACE=errors opencode        # 推荐：只看出错
MALONG_TRACE=all opencode           # 排查期：全量
```

判定是否真的开了：

```
health(action="check", stats=true)  →  .trace.mode / .trace.enabled / .trace.write_failed
```

`trace.note` 会直说现在是「没采集」还是「在采集」。**不要让 `0` 看起来像「采集了没数据」。**

---

## 2. 记了什么、没记什么

### 记（schema v1，字段白名单）

```json
{"v":1,"ts":"2026-10-30T00:00:00.000Z","session":"ephemeral-abc",
 "call_id":"c-...","parent_call_id":null,"tool":"code_patch","phase":"started"}

{"v":1,"ts":"...","session":"ephemeral-abc","call_id":"c-...","parent_call_id":null,
 "tool":"code_patch","phase":"finished","latency_ms":82,
 "outcome":"version_conflict","effect":"not_applied","state_commit":"not_attempted",
 "verification":"not_run","next_action":"code_read","next_action_basis":"handler_next_action_field",
 "error_code":"VERSION_CONFLICT","output_chars":460,"truncated":false}
```

| 字段 | 含义 | 取值 |
|---|---|---|
| `phase` | 阶段 | `started` / `finished` / `timeout` / `abandoned` |
| `outcome` | 工具自称的结果 | 枚举收敛，见下 |
| `effect` | 是否动了工作区 | `workspace_write` / `read_only` / `not_applied` / `unknown` / `none` |
| `state_commit` | 任务状态是否已提交 | `committed` / `pending` / `not_attempted` / `unknown` |
| `verification` | 有没有验过 | `verified` / `not_run` / `failed` / `unknown` |
| `next_action` | 工具**建议**下一步调什么 | 工具名（正则 `^[a-z][a-z0-9_]{0,63}$`）或 `null` |
| `latency_ms` | 本次调用耗时 | 整数 |

### 三个概念必须分开（这是设计要点）

- **`outcome`** = 工具自己说成没成。**不代表文件真写对了。**
- **`effect`** = 有没有动工作区。
- **`verification`** = 有没有独立验证过。

`outcome:"ok"` **不会**自动变成 `verification:"verified"`。
只有工具显式返回 `readback_verified: true` 才算 verified。这是刻意的：
「报成功了」和「验过了」是两个不同的事实，混在一起就再也分不出来。

### 不记

绝不写入：工具参数原文、源码片段、补丁内容、提示词、工具返回正文、文件绝对路径、
token / key、环境变量值。

`next_action` **只取工具名**，不取 `args` 也不取 `note`——`note` 是自由文本，里面可能有绝对路径。
只给了自由文本 `next_step` 时不提取（宁可空着也不猜）。

`session` 是宿主机 session 名的 sha256 前 8 位，原文不落盘。

**宿主没注入会话变量时**（opencode 实测就是这样，此前 `session` 恒为 `null`）：
按「本进程身份」（pid + 进程启动时刻）派生 `sess-<8位>`（R16m 引入，R16n 修正）。

> **⚠️ 命名与用法限制（专家 R16o 裁决 Q3，2026-11-02）**
>
> 专家明确：**绝不可用「同进程=同会话」「(workspace,宿主,pid)=真实对话」替代真实会话 ID。**
> 能拿到宿主可信 opaque session ID 就用它；**拿不到只能称为 `process_segment`**。
>
> 现状：`sess-` 实质就是 `process_segment`（进程身份），**名不副实**。
> 更严重的是它**当前被用于** triage 的「建议是否采纳」判定（同 session + ≤120s），
> 而按裁决这属于**越界使用**——不得凭此计算「某次推荐是否被具体会话采纳」。
>
> 本轮**未修改**（裁决明确不批准扩大改动面），登记为待办：
> ① `sess-` 前缀正名为 `process_segment-`（或等价显式命名）；
> ② triage 的采纳判定改用真实会话，取不到时**不判定**而不是降级降成 process_segment。

必须说清这只是**近似**，不是“知道真实会话”：

| 情形 | `session` | 读的时候怎么理解 |
|---|---|---|
| 宿主给了 `OPENCODE_SESSION` / `MCP_SESSION_ID` / `SESSION_ID` | `ephemeral-<8位>` | 真会话，可放心按它聚合 |
| 宿主没给 | `sess-<8位>`（pid + 进程启动时刻） | 一个 MCP 进程一个标识：不同 workspace 不会混，同进程内的多个对话会合并 |

后果：`sess-` 前缀只能用来“把同一个 MCP 进程的调用分组”，**不能**用来断言“这是同一个对话”。
按会话聚合前先看前缀：`ephemeral-` 才是准的。

> **R16n 修正的由来（值得记一笔）**：R16m 先按“小时桶”派生，看代码没毛病，一跑就露了：
> 本机同时有 6 个 mcp-server 进程，分属 6 个**不同 workspace**
> （/home/chen、0bore、NAI2、1FTY-llm、mail、ANT-FTY），同一小时内启动就拿到**同一个**
> `sess-`。于是 triage 把跨 workspace 的调用当成“同一条链”——口径收紧反而制造了新误报。
> 按进程身份派生就没这个问题，且同 pid 重启会换新标识（重启就是新会话段）。

### 有界

- 单文件 4MB，滚动保留 3 档
- 按体积轮转 + 按天数清理（14 天）
- 写日志失败**不改变工具结果**，只累加 `health(stats).trace.write_failed`

---

## 3. 怎么分析

只读脚本，不联网、不调 LLM、不写盘：

```bash
node scripts/trace-triage.mjs              # 人类可读
node scripts/trace-triage.mjs --days 7     # 只看最近 7 天
node scripts/trace-triage.mjs --json       # 机器可读
```

它输出五个信号（专家 §4.2 点名的口径）：

| 信号 | 说明 | 指向什么 |
|---|---|---|
| **有开始无结果** | `started` 没有配对的 `finished` | 真崩溃 / 被 kill / 超时没落盘 |
| **版本冲突后未重读就继续** | `VERSION_CONFLICT` 之后的下一个调用不是 `code_read`/`read_symbol`/`code_query` | 工具在教模型「撞了继续撞」，提示不够强 |
| **60s 内同工具连续失败** | 同一工具短时间连挂 ≥3 次 | 要么工具坏了，要么提示词把人带沟里 |
| **写入但未验证** | `effect=workspace_write` 且 `verification=not_run` | 写路径缺回读，或工具没报验证态 |

> 读这一栏时先确认 `effect` 不是 `unknown`。如果整表都是 `unknown`，
> 说明版本有 8.1 那个形状坑（已在 2026-10-30 修掉）——`unknown` 不等于「没有写入」，
> 而是「根本没读到」。
| **建议 next_action 未被调用** | 给了建议，**同会话且 120s 内**的下一条调的是别的 | 建议不合适，或者模型读不懂 |

> R16m/R16n（2026-11-02）口径收紧：旧口径把整个时间窗里任意一条都当下继。
> 自用实测 20/33——那个数字既不是「建议差」，也不是「不听话」，
> 而是「我同时开了好几条线程，下一条本来就不是它」。
> 现在先**按 `session` 分组**，只在同一 `session` 内、且间隔 ≤120s 才算“这条建议的下一次”。
>
> 注意“取同 session 的下一条”而不是“全局下一条”：两个 workspace 交错时（A1 → B1 → A2），
> A1 的全局下一条总是 B1。拿它去比会把真未采纳**永远漏掉**（R16n 实测：本例旧实现报 0）。
>
> 偏差方向：宁可少报（跨会话/跨时段不计数），不要恒亮；但也不能反过来变成“永远报 0”。
> `session` 为 `null` 的旧数据退回全局顺序（兼容，行为同 R16m）。

`--days` 是必要的：不设时间窗的话，上个季度的老毛病会一直挂在「现状」里。

---

## 4. 复盘节奏

**不要每天看。** 一周一次，或者「最近感觉别扭」的时候看一次。

一次复盘的动作：

1. `node scripts/trace-triage.mjs --days 7`
2. 五个信号里挑**数值最大**的那个，问一句「这是工具的问题，还是我的问题」
3. 只挑 **1 条** 能复现的，写成最小复现（一个 failing test 或一段反例脚本）
4. 修，跑全链
5. 下周同一时间再看同一指标有没有降

**别一次改五条。** 一次一条，改完看下次数值，才知道是不是真改了。

---

## 5. 它证明不了什么（重要）

这份轨迹**只能**说明「本机这段时间里，工具调用的形状是什么样的」。

它**不能**证明：

- 工具在别人机器上也是这个形状
- 某次具体改动的因果收益（要对照组，不是看轨迹）
- 模型能力差异（同一个工具给不同模型，形状会变）
- 没记录 = 没发生（`errors` 模式本来就只记失败）

**特别地**：`unfinished` 在 `MALONG_TRACE=errors` 模式下会偏多——因为成功调用的
`finished` 被过滤掉了，但 `started` 保留了（否则崩溃窗看不出来）。判断崩溃窗要用
`all` 模式的数据，或者接受这个已知偏差。

---

## 6. 关掉 / 清掉

轨迹单独放在 `<stateDir>/trace/` 一个目录里（`stateDir` 默认 `~/.config/malong`）：

```
~/.config/malong/trace/malong-trace.jsonl            # 当前
~/.config/malong/trace/malong-trace.jsonl.1 … .3     # 轮转
~/.config/malong/trace/malong-trace-counters.json    # 累计计数
```

单独一个目录的理由：轨迹要跟用户自己的状态文件（`code-index/`、`workspaces/`、
`entry-tasks/`、`malong-feedback.jsonl`）分开。混在同一层有两个后果：产物目录被
轨迹污染；想“清掉轨迹”很容易写成宽匹配 `rm` 而误删别的状态。

```bash
# 关：不设 MALONG_TRACE 就是 off
# 清：只删这一个目录，不碰其它状态
rm -rf ~/.config/malong/trace
# 或者用 MALONG_STATE_DIR 指到别处后再删
```

**从旧版升上来的**：旧轨迹在 `stateDir` 根（`malong-trace.jsonl` 等）。
不需要手动搬——开启后第一次写入会自动移进 `trace/`（新位置已有同名文件时
不覆盖，两份都留）。不开启时只读接口仍能把旧位置读出来，
并且 `health(stats).trace.legacy_files` 与 `trace-triage` 会明确点名
“旧位置还有 N 个文件未计入”，不会静默少一截。

---

## 7. 实现位置

| 文件 | 作用 |
|---|---|
| `trace.js` | 开关、字段白名单、写盘、轮转（体积 + 14 天保留）、`traceStats()`、`traceDir()`、`readTraceEntriesDetailed()`（唯一读取入口）、`legacyTraceFiles()`、`extractSuggestedTool()`、`summarizeToolResult()` |
| `mcp-server.js` | dispatch 层挂钩（`started` 先写，`finished`/`timeout`/`abandoned` 后写） |
| `tools/tool-health/handler.js` | `health(stats=true).trace` 暴露模式、目录、写失败计数与旧位置残留 |
| `scripts/trace-triage.mjs` | 只读聚合（`--days` / `--limit` / `--json`） |
| `tests/test-trace-v0.js` | 103 条：开关、脱敏、收敛、保留期、写失败、三态提取、独立目录与迁移 |
| `tests/test-trace-e2e.js` | 17 条：真起 MCP server 验证 `off` 零文件、`all` 无泄漏 |
| `tests/test-trace-triage.js` | 36 条：五个信号口径（含末条不误报、时间窗、与权威读取逐项一致、旧位置点名） |

**没有新增 MCP 工具**（仍 44），**没有改任何工具返回 schema**。

---

## 8. 真机试用发现并修掉的两个「假绿」（2026-10-30）

这一节保留下来，因为它比功能列表有用：两个问题都是**统计看起来正常，实际上没意义**。

### 8.1 写路径的三态全部退化成 `unknown`

写类工具（`code_patch` / `code_batch` / `code_maintain`）把 `effect` / `committed` /
`receipt` 放在 **`observation` 层**，顶层没有。而 `summarizeToolResult()` 只查
`result.effect ?? result.receipt?.effect` → 所有写路径都记成
`effect=unknown, state_commit=unknown`。

后果很具体：**「写入但未验证」这个信号恒为 0。** 一个永远是 0 的指标，
比没有指标更坏——它会让人以为「没有未验证的写入」。

修法：按「顶层优先、`observation` 兜底」取值（仍只取白名单值，不臆造）。
`committed:true/false` 推导为 `committed`/`not_attempted`。
真机复验：修前 `effect:unknown`，修后 `effect:workspace_write, state_commit:committed`。

### 8.2 末条调用永远被算「建议未采纳」

triage 判断「给了 `next_action` 但没调」时，取「下一条调用」来比。
但**最后一条没有下一条**，于是每个会话/时间窗都固定多报 1 条假阳性。
实测：3 条调用报 2 条，其中 1 条就是这么来的。

修法：没有后继时不判定、不计入。修后同样数据从 2 条降到 1 条，剩下那条是真的。

### 8.3 读取只有一份口径

同一份轨迹目录曾经有两个读取器：`trace.js` 的 `readTraceEntries()`，和
`scripts/trace-triage.mjs` 自己写的 `readAll()`。它们对「哪些文件算轨迹」
的判断不同，于是**已经读出了不同结果**：

```
目录：malong-trace.jsonl / .1 / .2 / .4 / .1.bak
权威读取：3 条（只认主文件 + .1/.2）
triage ：5 条（把越界档 .4 和外来后缀 .1.bak 也当成轨迹）
```

一个聚合工具如果和权威读取不一致，基于它的任何结论都不可信。
现在只有一份口径，**聚合层不得再写第二份**：

- 入口：`readTraceEntriesDetailed({ limit, includeRotated, sinceMs })`
- 只认主文件 + `.1` … `.MAX_ROTATIONS` 这几档，越界档与任何其它后缀都不算
- 顺序：最旧轮转档 → 最新主文件
- 坏行跳过并计数；时间窗 `sinceMs` 也在这里过滤
- `readTraceEntries()` 保留为兼容入口，内部就是调它

合同锁在 `test-trace-v0` ⑰ 与 `test-trace-triage` ⑬（两边结果必须逐项一致）。

### 8.4 顺带修的相邻问题
`code_check` 预览已经知道「本工作区没有任何可运行目标」时，旧实现仍给
`next_action = code_check(run:true)`。照做只会空跑一轮拿到 `skipped`，
白白多一次往返，还让人以为「再试一次就能验」。现在无可跑目标 → `next_action=null`
+ 明说是环境限制；有可跑目标时行为不变（不误伤）。

### 8.5 轨迹搬到独立子目录（跟别的状态分开）

轨迹一开始直接写在 `stateDir` 根，和 `code-index/`、`workspaces/`、`entry-tasks/`、
`malong-feedback.jsonl` 摆在同一层。这不是单纯的“不整齐”，是两个具体风险：

- **污染用户产物目录**：用户的 `~/.config/malong` 突然多出几个跟他们无关的文件。
- **清理变成一个容易出事的操作**：想清轨迹就得写 `rm malong-trace.jsonl*`，
  这种宽匹配一旦手滑或复制错，删的就是别人的状态文件。

现在固定 `<stateDir>/trace/`，清轨迹就是 `rm -rf` 那一个目录。

**迁移与“历史消失”的边界**（这几条都锁了断言）：

| 情形 | 行为 |
|---|---|
| `off`（默认） | 连 `trace/` 目录都不建；只读接口能读旧位置，不搬 |
| 开启后首次写入，旧位置有文件 | 一次搬进 `trace/`；新位置已有同名文件则不覆盖（两份都留） |
| 迁移单个文件失败 | 留在原处，不阻断其它文件，不影响写入语义 |
| `trace/` 被普通文件占住 | 写入如实报 `written:false` + `write_failed++`，**旧文件不丢** |
| 新旧两处都有数据 | 按**目录**选，只读有数据的那个，不跨目录拼；旧位置残留在 `legacy_files` 里点名 |
| `trace-triage` 只读 | 不搬家，但人读输出会提示“旧位置还有 N 个文件未计入” |

失败路径真机验证（旧实现上跑同一组探测）：旧实现把新事件**追加进了旧的
`stateDir/malong-trace.jsonl`** 并返回 `written:true`—— “写成功”与“历史还在
原处”被合成了同一个假象；同时 `traceStats().dir`、`legacy_files` 全是 `undefined`。
新实现 7 条探测全绿（旧实现 7 条红）。

### 8.6 只读工具的 `effect` 整列是 `unknown`（2026-11-01 首次开采集实测）

P3 开采集第一天就看到：

```json
{"tool":"code_query","phase":"finished","outcome":"ok","effect":"unknown","state_commit":"unknown"}
```

`code_query` 明明在回执里写了 `boundaries.read_only: true`，但 `summarizeToolResult()` 只查
`result.effect / observation.effect / receipt.effect`，没看这个声明 → 13 个只读工具全部记成 `unknown`。

按指南自己的口径，`unknown` 的语义是“根本没读到”，于是这一列对只读工具完全失效；
而 P3 恰恰要看“谁在读、读完有没有写”，读一半就错一半。

修法（不臆造）：**只在工具显式声明 `read_only: true` 时**取 `read_only`；
没有声明仍然记 `unknown`（这一条有测试守着，防止从“没字段”推成“只读”）。
显式 `effect` 优先于声明；声明为 `false` 或其它值不采信。

测试：`test-trace-v0` ⑭ 新增 4 条（声明→read_only、observation 层也认、显式优先、不采信 false），
103 → **107 条**；先跑旧实现 2 红。

### 8.7 写的「回读已验证」跑了三段才到轨迹（2026-11-01 同日第二处）

`effect` 修完，`verification` 还恒为 `not_run`。写路径**确实做了**回读比对
（`readFileSync` 后与 `newContent` 全串比对，不一致返回 `READBACK_MISMATCH` + `indeterminate`），
但事实在传递路上掉了两次：

| 层 | 旧行为 | 修复 |
|---|---|---|
| `write-runtime` | 比对做了，返回体不申报 | `writeSymbol` / `writeBatch` 成功时带 `readback_verified: true` |
| `code_patch` / `code_batch` handler | 只在回执写 `readback: 'enforced'`（口号） | 从 runtime 结果透传布尔值 |
| `workflow/receipt.js` `serializeReceipt()` | **白名单**，把新字段丢掉了 | 调用方给布尔时才带出（不臆造） |

边界：`writeBatch` 只在「真写了 + 无失败件 + 非 dry_run」申报；
回读不一致走原错误路径；`edit_transaction` 事务路径仍显式 `false`（确实未做独立回读）——
如实说没做，比统一说「验过了」重要。

测试：`test-s2-patch` 加回执断言，旧实现 1 红（得 `undefined`）；修后 79 → **80/0**。

**方法教训**：同一个事实要穿三层（事实层 → 工具层 → 序列化白名单），
每层都可能默默丢掉——「改了实现」不等于「上层看得到」，必须断言最后可观测的那个字段。

---

## 9. 检索 MISS 日志（P3 用，默认关闭）

**为什么单开一个日志，不塞进轨迹**：轨迹的字段白名单**故意不含查询词**（§2）。
这带来一个具体后果：开 `MALONG_TRACE=all` 只能看到「`code_query` 被调了、耗时多少、成没成」，
**看不出这次查的是什么、是不是 0 命中**。用它做「按根因聚类检索 MISS」是拿形状回答内容问题，不成立。
所以另开一个：只在**代码 0 命中**时写一行，含查询词与命中计数。

**开关**：`MALONG_SEARCH_LOG=misses`。未设 / 其他任意值 = `off`（默认拒绝，不猜）。

```bash
MALONG_SEARCH_LOG=misses MALONG_TRACE=all opencode   # P3 采集期
```

**记什么（每行一条，只有这一行）**：

```json
{"v":1,"ts":"2026-11-01T08:00:00.000Z","entry":"code_search","reason":"zero_hit",
 "query":"回滚时怎么判断文件被别人改过","query_chars":18,"has_ascii":false,
 "code_hits":0,"partial_hits":0,"doc_hits":0,"doc_weak":0,
 "expanded_hits":0,"search_terms":0,"workspace":"ws-3f2a91c7"}
```

| 字段 | 用途 |
|---|---|
| `entry` | 哪个入口（`code_search` / `code_task`） |
| `reason` | `zero_hit`（什么都没中）/ `weak_docs_only`（只有 3 字片段命中的文档） |
| `has_ascii` | 查询里有没有 ASCII 标识符——P3 聚类第一刀 |
| `search_terms` | 调用方给没给假设词（P1 采纳率就看这个） |
| `workspace` | 目录指纹（sha256 前 8 位），**不落绝对路径** |

**不记**：命中的查询（不是全量审计）、工具返回正文、源码片段、绝对路径。

**有界**：单文件 1MB、滚动 2 档、30 天保留；写失败不改变工具结果（只返回 `written:false`）。
位置：`<stateDir>/trace/search-misses.jsonl`（跟轨迹同目录、不同文件）。

**怎么看**：

```bash
node scripts/trace-triage.mjs --search --days 7        # 人读
node scripts/trace-triage.mjs --search --json          # 机器读（search_misses 字段）
```

输出按 `reason` / 是否有标识符 / 有没有给假设词分组，并列出高频 MISS 原话。
**它给不出命中率**：日志里只有 MISS，没有命中侧分母；命中率看 `scripts/search-baseline.mjs`。

**清掉**：同轨迹，`rm -rf <stateDir>/trace` 会连轨迹一起清；只清 MISS 就删 `search-misses.jsonl*`。

**实现位置**：`search-log.js`（开关/白名单/轮转/唯一读取 `readSearchMisses`/`searchLogStats`）、
`tools/tool-code-search/handler.js` 与 `tools/tool-code-task/handler.js`（只在代码 0 命中时挂钩）、
`scripts/trace-triage.mjs --search`、`tests/test-search-log.js`（62 条）。

**怎么用**：见 `P3-COLLECT.md`（一页操作单：开启、日常看什么、结束时怎么聚类、停止与隐私边界）。
