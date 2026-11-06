# 中文检索路线图（P0 → P3）

> 这份文件是《六合 LiuHe｜中文自然语言检索与代码定位：轻量语义桥接升级方案 v0.1》的**可追踪副本**。
> 目的：计划不留在对话里。每完成一项，改「状态」与「证据」两列；没做的必须留在表里，不许悄悄消失。

**最后更新**：2026-11-05
**适用基线**：`0.6.1`（发布版本；本路线图初版基线为 `0.6.1-rc.1`，两者之间无检索层行为变更）

## 0. 状态总表

| 阶段 | 范围 | 状态 | 证据 / 提交 |
|---|---|---|---|
| **P0** | 冻结基线 + 只改提示与回执 | ✅ 完成 | commit `630e0fb`；`SEARCH-BASELINE.md`；全链 7126 断言 |
| **P1** | 跨入口查询合同（`search_terms` + 来源投影 + 反例） | ✅ 完成 | 本轮提交；`search-terms.js`、`code_search`/`code_query` 扩展词单列；`test-code-search` 29/0、`test-s1-entry` 143/0 |
| **P2** | 结构一跳 + 项目级术语映射 | ⬜ 未开始（需触发证据） | — |
| **P3** | 持续自用复盘（opt-in 轨迹 + 检索 MISS 日志 + 每周抽样） | 🟨 进行中 | 日志与读取已就绪（R16h，`test-search-log` 62/0）；**采集未启动**：需带 `MALONG_TRACE=all MALONG_SEARCH_LOG=misses` 重启进程 |

## 1. P0（已完成）

**做了什么**：10 条中文任务基线（真 MCP 调用）、`code_task` 新增 `query_interpretation`、零命中不再把「词面失配」说成「检查索引」、manifest 说明扩展词是假设。

**关键数字**（`scripts/search-baseline.mjs`，单仓库 10 条任务）：

- `code_task` 命中 2 / 未中 5 / 预期无目标 3
- `code_query(mode="search")` 命中 2 / 未中 5 / 预期无目标 3
- 带英文标识符假设：3/3 命中第一

**通过条件核对**：旧回归未退步 ✅；无事实夸大 ✅（明确写“P0 不提升命中率”）；至少一条卡住任务靠已有 `search_terms` 走通 ✅（3 条）。

## 2. P1（已完成）

**做了什么**：

1. `search-terms.js`：`normalizeSearchTerms()` 作为**唯一边界校验**（数组、trim、去空、≤64 字符、拒控制符、去重、上限 8），`code_task` 与 `code_search` 共用。
2. `code_search` / `code_query(mode="search")` 新增可选 `search_terms`；扩展词命中进 **`expanded_matches` 单独一栏**，**绝不合并进 `results`**（原查询命中永不降权）。
3. 回执新增 `query_interpretation`：`original_query`、`search_terms_used`、`search_terms_source="caller_hypothesis"`、`original_query_hit`、`expanded_hit_count`、`search_terms_dropped`（只给 index+reason，不回显原值）。
4. 原查询零命中、仅扩展词命中时，`next_step` 明说“这些是假设词碰到的候选，不是原话被找到”。

**实测（同一份 10 条任务、同一台机器）**：

| 任务 | `code_task`（带假设词） | `code_query(search)`（带假设词） | 来源标注 |
|---|---|---|---|
| CN03 让每次工具调用都留下一条记录 | 命中 #1 | `results=0`，`expanded=10`，命中 #1 | 全部 `expanded_term` |
| CN04 事务回滚 | 命中 #1 | `results=0`，`expanded=3`，命中 #1 | 全部 `expanded_term` |
| CN05 反馈文件多大才会被轮转 | 命中 #1 | `results=0`，`expanded=4`，命中 #1 | 全部 `expanded_term` |

跨入口一致：3/3（同一目标、同一组假设词，两个入口指向同一文件）。

**通过条件核对**：旧调用行为兼容 ✅（不传 `search_terms` 时回执不新增字段，`test-code-search` ① 锁住）；扩展词不冒充高可信 ✅（单列 + `original_query_hit`）；弱命中不引导写 ✅（`expanded_note` 明说不是答案）；有可观察收益 ✅（3/3 从 0 命中到命中第一）。

**为什么这样设计（而不是给扩展词一个分数）**：检索分数只是词面命中，不是语义可信度。给扩展词算分会诱导“0.91 置信度”的假精确；单列 + 来源标注让 LLM 自己决定要不要读。

## 3. P2（未开始，需触发证据）

**启动条件（三选一，必须写进本文件）**：

1. 真实轨迹里反复出现「注释提到概念、实现名不同」的 MISS，且 P1 的 `search_terms` 也没救回；
2. 同一项目术语失配（如「启动」→`bootstrap`）在 ≥3 个独立任务里复现；
3. 有 MISS 样本证明“召回存在但排序错”，且能区分是证据层还是截断造成。

**范围（不得扩大）**：

- 只用**已有**引用/调用图做一跳候选展开：最多 1 跳、少量候选、可溯源、可按需关闭；
- 邻居不因“连着”就晋升为直接命中，仍单列并标来源；
- 项目术语映射：只记项目内真实文件/符号或开发者显式确认的映射，记适用仓库与版本范围，失效即降级；**不建跨项目全局词典、不新增数据库表/后台服务**。

**交付**：MISS 样本集（含根因分类）、一跳实验的对照数据（首次正确目标命中 / 误定位率 / 额外读取量）、不达标就停的记录。

## 4. P3（进行中：采集未启动）

**范围**：开发环境带 `MALONG_TRACE=all` 短周期真实使用；发行版默认 off。按周抽样复盘少量典型成功/失败，**按根因聚类而不是按工具名**。

**数据来源补正（2026-11-01，R16h）**：轨迹的字段白名单**不含查询词**（`TRACE-GUIDE` §2），
所以「哪次查询没搜到」在轨迹里读不出来。为此新增独立开关 `MALONG_SEARCH_LOG=misses`
（`search-log.js`，默认 off，仅本地）：只在代码 0 命中时记一行（查询词 + 命中计数 + 是否含标识符），
位置 `<stateDir>/trace/search-misses.jsonl`；读取只有一份口径 `readSearchMisses()`，
聚合用 `node scripts/trace-triage.mjs --search --days 7`。

**采集口径**：带 `MALONG_TRACE=all MALONG_SEARCH_LOG=misses` 跑 3–5 天，攒 ≥10 条 MISS；
按「有没有 ASCII 标识符 / 给没给 `search_terms` / `reason`」三类聚类，再读高频原话。
**注意**：日志只记 MISS，没有命中侧分母，给不出命中率——命中率仍归 `scripts/search-baseline.mjs`。

**怎么用**：见 `P3-COLLECT.md`（一页：开启 / 日常 / 聚类 / 停止 / 隐私 / 常见误读）。

**指标**（只看这几个，不建重型遥测）：首次正确目标命中、误定位率、从零命中到读到正确文件的调用数、弱匹配导致的错误写入、纠错步数、Token/延迟。

**交付**：`LLM-UX-FINDINGS.md`（至少一次“模型被误导”的真实案例 + 最小修正，并区分“工具确实误导”与“模型自己判断错”）。

**硬约束**：轨迹不落原文查询/源码/绝对路径；`followup_observed` 观测不到就记 `unknown`，不得由 `next_step` 文本推断“模型遵从”。

## 5. CN01–CN12 验收矩阵（当前状态）

| 编号 | 要求 | 状态 | 证据 |
|---|---|---|---|
| CN01 | 中文原话 + 英文函数名无词面重合 → 靠显式扩展词找候选，标 `caller_hypothesis` | ✅ | P1：`expanded_matches` + `query_interpretation`；基线 CN03/04/05 |
| CN02 | 扩展词碰巧命中错误函数 → 不得标为“已确认目标”，须提示读取 | ✅ | `expanded_note` + `next_step`；“不是答案、先读” |
| CN03 | 中文同义改写 → 显式 `route` 可覆盖，`route_source=explicit` 可追溯 | ✅ | 既有三态路由 + `test-route-source` 42/0 |
| CN04 | `search_terms` 含控制符/长词/重复/超量 → 有界校验、无路径/权限副作用 | ✅ | `normalizeSearchTerms` + 丢弃原因；`test-code-search` ③、`test-s1-entry` P1 块 |
| CN05 | 中文查询只命中注释/README → 结果分栏，不等同实现位置 | ✅ | `comment_matches` / `doc_results` 分栏 + 文案 |
| CN06 | 三词只中一词 → 覆盖率仍 1/3，不被语料过滤成 100% | ✅ | `test-search-coverage` ⑤⑥（1/3→0.33、1/4→0.25 并落 partial）；变异（分母改成“已命中词”）会红 |
| CN07 | 扫描截断/索引失败 → 报告受限或 UNKNOWN，不谎称“仓库无此功能” | ✅ | `comment_search.reason` + 三档 `skipped` |
| CN08 | 精确符号命中与扩展词弱命中并存 → 直接证据不被淹没 | ✅ | 扩展词**不进** `results`；`test-code-search` ② 锁死 |
| CN09 | 同一原查询不传扩展词 → 与旧版兼容 | ✅ | `test-code-search` ①（不新增字段） |
| CN10 | 测试文件/FAQ 逐字引用 → 不推成唯一生产目标 | ✅ | `test_path_candidates` 分栏（R16） |
| CN11 | 只读检索建议涉及修改 → 仅推荐先读 | ✅ | 零命中/扩展词命中的 `next_step` 均只要求读 |
| CN12 | 默认关闭轨迹 → 无敏感原始数据落盘；开启后仅有界脱敏元数据 | ✅ | R16c：`call_id` 不可冒充、feedback 元数据脱敏 |

**CN06 补记（2026-11-01）**：分母是**原查询词数**，不是语料命中数——所以“词不在仓库里”不会被算成 100% 覆盖。`test-search-coverage` ⑤⑥ 锁死 1/3→0.33、1/4→0.25（后者还必须落 `partial_matches`）；把分母改成“已命中词”的变异会让这两条立刻红。

## 6. 下一步的具体顺序（避免又忘）

1. ~~CN06 反例~~ ✅ 2026-11-01 完成（`test-search-coverage` ⑤⑥，变异验证 2 红 2 绿）；
2. **P3 启动**：在生产进程开 `MALONG_TRACE=all` 跑 3–5 天，收 ≥10 条真实中文任务轨迹；
3. **P2 判定**：用 P3 的轨迹做根因分类，只有满足 §3 触发条件才动一跳/术语映射；
4. **P1 复盘**：观察模型是否真的会用 `search_terms`（`expanded_matches` 被读取的比例），若几乎不用，说明提示层还需改文案而不是加接口。

## 7. 明确不做（写入即承诺）

- 不引入 embedding / 向量重排 / 外部模型调用；
- 不引入分词重型依赖，不建新语义数据库；
- 不发中文二元组进内容扫描（`extractTokens` 保持 ASCII）；
- 不加中英近义词硬编码表；
- 不改现有排序键（扩展词也不参与排序，只单列）；
- 不为“语义理解”宣传分数。

## 8.3 Hub 裁决边界（专家 R16o，2026-11-02）

**裁决：S0/S1/S2 全部不得进入 0.6.1 RC。** 当前保持「每工作区独立进程」部署不变。

本轮评估的作废结论（勿再引用）：

| 旧结论 | 实际 |
|---|---|
| S0 “零语义风险” | `CodeIndex` 是进程级单例（`code-index.js:2465`），连接不会各自生出运行时 |
| 可省 455MB | RSS Σ=555MB 高估；实测 PSS Σ=**255MB**、Private Σ=**231MB** |
| UDS 是现成 MCP 接入骨架 | 那是 HTTP-over-UDS 的索引子集 API，非 MCP 传输；`udsToken` 默认空时认证跳过 |
| 句柄无上限常量 | `_handlesMax = 4`（`:437`） |

**保留有效**：H1–H8 风险清单、22 处裸回退定位、三阶段思路。

**`sess-` 的命名越界（待办，本轮未改）**：专家裁定不得用进程/工作区派生标识冒充真实会话；
`sess-` 实质是 `process_segment`，且当前被用于 triage “建议是否采纳”判定，属越界使用。
需独立修复：① 正名；② 取不到真会话时**不判定**，不降级。

---

## 9. 检索质量小项（2026-11-01，重启后自用实测发现）

| 项 | 状态 | 证据 |
|---|---|---|
| 生成副本（`dsh/bundle/**`）排在源码前 | ✅ | `code-search.js` 稳定后置 + `rank_reason=generated_bundle`；`test-search-coverage` ⑦ |
| 中文长句的 3 字滑窗文档噪音（88% 命中是 3 字片段） | ✅ | 同一文件需 ≥2 个不同滑窗才算弱相关；`match_basis`/`weak` 随结果透传；`test-search-coverage` ⑧ |
| 目录税余量只剩 27B | ✅ | 压缩后 16538B / 16800B（余量 262B）；测试新增“余量 ≥200B”断言 |

## 10. 维护约定

- 任何改动检索/回执的提交，必须同步更新本文件对应行的「状态 / 证据」；
- P2/P3 启动前，先在 §3 写入触发证据（原始任务 + 预期正确目标 + 根因），否则不开工；
- 基线数字只在同仓库、同任务集、同机器下对比；换任务集必须新建基线文件，不许覆盖旧值。
