# P3 采集操作单（一页）

**目的**：攒 ≥10 条**真实中文任务**的检索 MISS，按根因聚类，决定 P2（一跳/术语映射）动不动。
**不做什么**：不分析代码、不改工具、不看命中率（命中率归 `SEARCH-BASELINE.md`）。

---

## 1. 开启（重启 opencode 才生效）

MCP 子进程继承宿主环境变量，所以要在**启动 opencode 的脚本**里设（不是在聊天里设）。

2026-11-02 起开关收成**一处**（此前桌面脚本和 DSH 脚本各写两行，必然漂）：

```bash
# 只改这一行档位，然后跑启动脚本
#   all = 轨迹 + 检索MISS | trace = 只轨迹 | misses = 只MISS | off = 关
export MALONG_DEV_COLLECT=all
. /home/chen/1q/0bore/liuhe/malong/scripts/dev-collect.sh
```

桌面 `~/桌面/启动opencode服务器.sh` 与 `~/.dsh/start-dsh-web.sh` 都只调这一句。
**不要再直接写 `MALONG_TRACE` / `MALONG_SEARCH_LOG`**：`dev-collect.sh` 会先 unset 再按档位设，
写在它上面的会被覆盖（故意的——否则“关掉”只是假象，父进程残值会继续采）。

四个档位（`MALONG_DEV_COLLECT`）分别对应哪些内部开关：

| 档位 | `MALONG_TRACE` | `MALONG_SEARCH_LOG` | 含义 |
|---|---|---|---|
| `all` | `all` | `misses` | P3 采集用这个：形状 + 查询原话 |
| `trace` | `all` | （unset） | 只看形状，不留查询词 |
| `misses` | （unset） | `misses` | 只收 MISS 原话 |
| `off`（默认） | （unset） | （unset） | 完全不采；会主动清掉父进程残值 |
| 其它任意值 | （unset） | （unset） | 按 off 处理，并在 stderr 出声（不静默当 all） |

**只在开发机开**。发行版默认关，别给用户开。

### 开采集前先清掉“探针数据”

调工具、跑测试、验证开关这些动作也会写进日志。拿它们当 P3 样本，聚类就是在分析我自己。
开正式采集前把已有日志改名（**不删**——保留可核对，但 `.pre-p3` 后缀不在读取口径内，不计入统计）：

```bash
cd ~/.config/malong/trace
for f in malong-trace.jsonl search-misses.jsonl; do [ -f "$f" ] && mv "$f" "$f.pre-p3"; done
node liuhe/malong/scripts/trace-triage.mjs --search --days 1   # 应报 entries: 0 / files: (none)
```

### 确认真的开了（别把「空日志」当成「没有 MISS」）

1. 进程环境里能看到两个变量：

```bash
PID=$(pgrep -f 'malong/mcp-server.js' | head -1)
tr '\0' '\n' < /proc/$PID/environ | grep -E '^MALONG_(TRACE|SEARCH_LOG)='
```

2. 目录被创建（首次调用工具后）：

```bash
ls -la ~/.config/malong/trace/
#   malong-trace.jsonl          轨迹
#   search-misses.jsonl         MISS（只在 0 命中时才有）
```

3. 聚合脚本自报状态：

```bash
node liuhe/malong/scripts/trace-triage.mjs --search --days 1
#   "MALONG_SEARCH_LOG=misses" + entries: N   = 在采集
#   "not collecting ... does NOT mean"        = 没采集
```

---

## 2. 采集期怎么用（3–5 天）

**照常用，不为此改变提问方式。** 唯一要求：中文任务也直接说出来，不要先自己翻译成英文标识符——那样 MISS 就消失了，等于没采。

每天只做一件事（10 秒）：

```bash
node liuhe/malong/scripts/trace-triage.mjs --search --days 1
```

看三件事：

| 看什么 | 说明 |
|---|---|
| `entries` 有没有涨 | 不涨就说明你根本没用中文查询，或开关没生效 |
| `纯中文 vs 含标识符` | 纯中文占多说明瓶颈在词面，不是用户不给词 |
| `没给 search_terms vs 给了` | 给了还 MISS，说明假设词也救不了——这才是 P2 的证据 |

**别每天读日志原文**。攒够再看，否则会被单条噪音带走。

---

## 3. 结束时怎么看（攒够 ≥10 条）

```bash
node liuhe/malong/scripts/trace-triage.mjs --search --days 7            # 人读
node liuhe/malong/scripts/trace-triage.mjs --search --days 7 --json     # 机器读
```

按三类分（这是根因聚类的最小切法）：

| 类别 | 判据 | 指向 |
|---|---|---|
| A 纯中文、没给假设词 | `has_ascii=false` 且 `search_terms=0` | 提示层没把人教会用 `search_terms`（P1 文案问题，不是能力问题） |
| B 纯中文、给了假设词 | `has_ascii=false` 且 `search_terms>0` | 假设词猜不中 → 才考虑 P2（一跳映射/术语表） |
| C 有标识符仍 MISS | `has_ascii=true` | 索引/采样/排序问题，不是语义问题，先查 `code_query(mode="map")` 与其后 `index_state` |

再把高频原话抄进下面模板（**≥10 条**才够判）：

| 日期 | 查询原话 | 预期正确的目标 | 实际返回 | 类别(A/B/C) | 根因猜测 | 是工具误导还是我判断错 |
|---|---|---|---|---|---|---|
| | | | | | | |

最后一列必须诚实填：**工具确实误导**（回执让人读错）和**我自己判断错**要分开——只有前者才该进代码。

---

## 4. 停止与清理

```bash
# 停：不设变量重启即 off
# 清轨迹+MISS（整个目录）：
rm -rf ~/.config/malong/trace
# 只清 MISS：
rm -f ~/.config/malong/trace/search-misses.jsonl*
```

保留期：轨迹 14 天、MISS 30 天；单文件 1MB–4MB 自动轮转，不需要手动管。

---

## 5. 隐私边界（写清楚，别含糊）

- **MISS 日志会存查询原文**（截 200 字、折叠换行）。这是本机文件，不上报、不联网、不调 LLM。
- **不存**：绝对路径（只存目录指纹 `ws-xxxxxxxx`）、工具返回正文、源码片段、token/key。
- 轨迹（`malong-trace.jsonl`）**不含查询词**，只有工具名/耗时/成败。
- 不想留原话就**别开** `MALONG_SEARCH_LOG`，只用轨迹能拿到形状类信号（但拿不到检索根因）。

---

## 6. 常见误读（先读这段再看数据）

| 误读 | 事实 |
|---|---|
| 「日志是空的 → 没有 MISS」 | 只有开启后、且**代码 0 命中**才写；空的可能是没开 |
| 「MISS 多 → 工具差」 | 日志只记失败，没有命中侧分母；命中率看 `search-baseline.mjs` |
| 「一条 MISS → 该加语义层」 | 单条要能复现、能说清预期目标，才进 P2 触发条件（`SEARCH-ROADMAP` §3） |
| 「`weak_docs_only` 算命中」 | 不算。3 字片段命中只是「文档里出现过这个片段」 |
| 「开了轨迹就能看到查询」 | 看不到。轨迹刻意不含查询词 |

---

## 7. 与其它文档的关系

- `TRACE-GUIDE.md` §9 —— 开关字段与实现细节（本单只管「怎么用」）
- `SEARCH-ROADMAP.md` §4 —— P3 的定义、采集口径与 P2 触发条件
- `SEARCH-BASELINE.md` —— 命中率与前后对比（本单不作此用）
