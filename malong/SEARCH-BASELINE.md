# 中文检索基线（P0）

**日期**：2026-10-31
**对应方案**：六合 LiuHe｜中文自然语言检索与代码定位：轻量语义桥接升级方案 v0.1（§9 P0）
**被测源码**：`0.6.1-rc.1`（r16c 之后，工作区 `malong/`，410 个受控文件）

> **版本说明（2026-11-05）**：上面的 `0.6.1-rc.1` 是**当时实测的版本号**，保留不改。
> 该版本随后以 `0.6.1` 发布（仅版本位变更 + 发布文档/验收脚本修正，检索层零改动）。
> 本文件数字对应 `0.6.1-rc.1` 的检索行为，对 `0.6.1` 同样成立。

> **自污染提醒（2026-11-01）**：本文件正文里写着 10 条基线原话。在同一仓库重跑查询时，`doc_results` 会命中本文件自身；
> 基线判定只看 `code_task` 候选与 `code_query` 的 `results`/`expanded_matches`（不看 `doc_results`），所以数字不受影响，
> 但引用 doc 命中数时必须先排除本文件与 `SEARCH-ROADMAP.md`。
**测量脚本**：`scripts/search-baseline.mjs` + `scripts/search-baseline-tasks.json`
**结论先说**：P0 **不提升命中率**，也不宣称“六合懂中文”。P0 只做一件事：**把“没找到”说准，并把改写查询的办法摆在调用方手里**。

---

## 1. 怎么测的（可复现）

```bash
cd malong
node scripts/search-baseline.mjs --workspace "$PWD" \
  --tasks scripts/search-baseline-tasks.json \
  --out /tmp/search-baseline.json --markdown
```

- 真起 `mcp-server.js`，走真实 JSON-RPC / stdio（不 mock 检索层），档位与本机日常一致（`MALONG_INTERFACE=graph`）。
- 每次运行用**临时 stateDir**，索引落在临时目录，不写工作区、不产生任务态。
- 命中判定用**任务自带的接受集合**（路径子串），不由工具自评。
- 入口：`code_task`（首屏候选）与 `code_query(mode="search")`（六合线里 `code_search` 的真实入口，ADR-017 后 classic 工具不再暴露）。

## 2. 十个任务（冻结基线）

| ID | 类别 | 目标 |
|---|---|---|
| CN01 | 原词直命中 | 修改反馈文件轮转的字节上限 |
| CN02 | 跨中英名称 | 理清 DSH 启动流程 |
| CN03 | 中文换说法（词面不重合） | 让每次工具调用都留下一条记录 |
| CN04 | 歧义词 | 事务回滚 |
| CN05 | 只有注释（实现名不同） | 反馈文件多大才会被轮转 |
| CN06 | 只有文档 | 怎么开启 TRACE 模式 |
| CN07 | 中英混合 | code_task 的路由三态怎么判定 |
| CN08 | 未实现的功能 | 实现一个导出 CSV 的功能 |
| CN09 | 工作区外 / 范围受限 | 上一轮审核报告里的 G2 结论在哪 |
| CN10 | 模糊目标（弱证据） | 把质量分数算得更准 |

## 3. 实测结果（改动前后同一份任务、同一台机器）

| ID | code_task | code_query(search) | 注释/文档 | 传入 search_terms 后 |
|---|---|---|---|---|
| CN01 | 未命中 | 未命中 | 0/0 | **命中 #1**（`MAX_FEEDBACK_BYTES`） |
| CN02 | **命中 #1** | **命中 #2** | 0/7 | — |
| CN03 | 未命中 | 未命中 | 0/4 | **命中 #1**（`trace`） |
| CN04 | 未命中 | 未命中 | 0/0 | **命中 #1**（`undoTransaction`） |
| CN05 | 未命中 | 未命中 | 0/2 | **命中 #1**（`rotateIfNeeded`） |
| CN06 | 未命中 | 命中 #9 | 0/2 | — |
| CN07 | 命中 #4 | 未命中 | 0/9 | — |
| CN08 | 无目标（符合预期） | 无目标 | 0/1 | — |
| CN09 | 无目标（符合预期） | 无目标 | 0/0 | — |
| CN10 | 无目标（符合预期） | 无目标 | 0/0 | — |

合计：`code_task` 命中 2 / 未中 5 / 无目标 3；`code_query(search)` 命中 2 / 未中 5 / 无目标 3；**带 search_terms 3/3 命中**。

### 读这张表的三个事实

1. **纯中文目标在 `code_task` 里候选为 0**：`extractTokens()` 只认 ASCII 标识符，`修改反馈文件轮转的字节上限` 抽不出任何可检索 token，内容扫描直接跳过（`skipped=non_ascii_goal`）。这不是“仓库里没有”，是“这次查询没有可匹配的东西”。
2. **带英文标识符假设就能救回**：CN01/CN03/CN04/CN05 四条原词全部失配，给 `search_terms` 后 3/3 命中第一。也就是说 P1 之前，**现有能力已经够用——前提是模型知道可以这么传**。
3. **`search_terms` 目前是“有命中也看不出是猜中的”**：命中来自假设词还是用户原话，过去在回执里不可区分。这是 P0 修的诚实性问题，不是排序问题。

## 4. P0 改了什么（只改提示与回执，不动检索/排序/索引）

| 位置 | 改动 |
|---|---|
| `code_task` 回执 | 新增 `observation.query_interpretation`：`original_query`（原话，不被扩展词覆盖）、`ascii_identifiers_in_query`（原话里实际可检索的 ASCII 标识符，没有就是空数组）、`search_terms_used`、`search_terms_source="caller_hypothesis"`、`note`（随是否传了扩展词变文案） |
| `code_task` 零候选 summary / 扫描告警 | 明确指路 `search_terms=[English identifier guesses]`，并写明“是假设，不是已验证名称” |
| `code_task` manifest | 描述与 `search_terms` 字段说明：字面匹配、不懂中文语义；扩展词是调用方假设 |
| `code_query(mode="search")` / `code_search` 零命中 | 查询无可检索 token 时补一句：这次是字面匹配，**改写成具体标识符**再搜；扩展词仍是假设 |
| 零命中样本提示 | `search_terms=[...]` 处统一注明“hypotheses, not verified names” |

**没改**：`extractTokens` 仍只认 ASCII；不发中文二元组进内容扫描；不加近义词表；不改排序键；不给 `code_search` 加 `search_terms` 参数（那是 P1，要先用真实收益触发）。

### 改动前后同一调用的差异（CN01 零命中）

改前（`code_query(mode="search")` 的 `next_step`）：

> No matches. The comment scan ran but read no files (query_has_no_searchable_tokens) — this says nothing about whether the concept exists. **Check workspace_dir, or invoke_capability(name='reindex') if the workspace changed.**

改后：

> … this says nothing about whether the concept exists. **The query has no ASCII identifier to match: this search is literal, so rephrase to a concrete identifier (an English function/file name), or pass the caller English identifier guesses as search terms (those are hypotheses, not verified names).**

改前的前半句把“查询没有可匹配 token”误指向“检查 workspace_dir / 重建索引”，那是**把词面失配当成索引故障**；改后按真实原因给动作。

## 5. 三条真实轨迹（原始 JSON 摘录）

### 5.1 CN01 原话失配 → 传入假设词 → 命中第一

```json
// 第一次（只给原话）
{ "original_query": "修改反馈文件轮转的字节上限",
  "ascii_identifiers_in_query": [],
  "search_terms_used": [],
  "note": "The query has no searchable ASCII identifier… Pass search_terms = your English identifier guesses… Those are HYPOTHESES, not verified names…" }
// candidates: （空）

// 第二次（调用方给出两个英文标识符假设）
{ "original_query": "修改反馈文件轮转的字节上限",
  "ascii_identifiers_in_query": [],
  "search_terms_used": ["MAX_FEEDBACK_BYTES", "rotateIfNeeded"],
  "search_terms_source": "caller_hypothesis",
  "note": "search_terms are your hypothesis terms, not verified names… Read it before treating it as the target." }
// candidates: tools/tool-feedback/handler.js::MAX_FEEDBACK_BYTES [exact_name]
//             tools/tool-feedback/handler.js::rotateIfNeeded [ambiguous_name]
```

### 5.2 CN03 换说法（“留一条记录” → trace）

- 原话命中：`code_task` 0 候选、`code_query(search)` 0 符号命中（4 条文档命中）。
- 给 `search_terms=["trace","call_id","appendFileSync"]` → `trace.js` 命中第一。

### 5.3 CN02 跨中英名称（唯一不靠扩展词就中的样例）

- `code_task` 直接 `dsh/dsh-bridge.mjs` 第一（`path_hit`），`code_query(search)` 第二。
- 原因：`DSH` 是可检索的 ASCII 词；这解释了为什么“带英文的混合目标”比“纯中文目标”容易命中——不是语义强，是词面撞上了。

## 6. P0 的边界（不夸大）

- 本基线是**单仓库、单版本、10 条任务**的小样本，不代表广义中文能力；表里 2/7 的命中率不能外推。
- P0 **没有**让任何一条“换说法”任务在不传扩展词的情况下命中；它只让失败原因可解释、下一步可执行。
- “只有注释命中”仍不等于实现位置；回执继续分栏，并保留“注释不是实现”的措辞。
- 零命中时 `next_action` 仍是 `code_read` 一个**样本文件**（带 `sample_only` 与 “NOT query hits” 标注）。本次没有改这个动作——改它要先证明“模型读到样本后确实更快定位”，否则只是换一种浪费。

## 7. 后续计划（P1 已完成，P2/P3 待触发）

完整路线图与逐项状态已固化在 **`SEARCH-ROADMAP.md`**（含 CN01–CN12 矩阵与启动门槛），不再只写在对话里。

**P1（已完成）**：`code_search` / `code_query(mode="search")` 新增可选 `search_terms`，与 `code_task` 共用 `search-terms.js` 的同一套校验；扩展词命中进 `expanded_matches` 单列，**不合并进 `results`**；回执新增 `query_interpretation`（原查询 / 使用词 / 来源 / 原查询是否命中 / 丢弃原因）。

同一份 10 条任务复测：CN03/CN04/CN05 在 `code_query(search)` 下仍是 `results=0`，命中全在 `expanded_matches`，与 `code_task` 指向同一文件（跨入口 3/3 一致）。扩展词不参与排序，也不冒充已确认目标。

**P2** 只在出现真实 MISS 并满足 `SEARCH-ROADMAP.md` §3 的触发条件时启动（一跳结构候选 / 项目术语映射）；**P3** 是带 `MALONG_TRACE=all` 的短周期自用复盘。两项都未开始，不在这里提前宣布。
