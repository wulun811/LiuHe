#!/usr/bin/env bash
# 六合自用采集开关（**开发机专用**，发行版不引用本文件）
#
# 为什么要有这个文件（2026-11-02 自用实测）：
#   桌面 opencode 启动脚本和 DSH 启动脚本各写了两行 export。两处同时维护，
#   必然漂——一边加了新变量、另一边没加，或者一边注释掉了另一条。
#   最贵的那种失败是「以为在采、其实 off」：三天的 P3 样本白等。
#
# 现在只留一个旋钮：MALONG_DEV_COLLECT。改档位只改它，不要再去改 export 行。
#
# 用法（在启动脚本里）：
#   export MALONG_DEV_COLLECT=all
#   . /path/to/malong/scripts/dev-collect.sh
#
# 档位：
#   off     （默认）两个开关都**主动 unset**——不是“不设置”。
#            父进程里残留的 MALONG_TRACE 会被清掉，否则「关掉」只是假象。
#   trace   只记轨迹（MALONG_TRACE=all）
#   misses  只记检索 MISS（MALONG_SEARCH_LOG=misses）
#   all     轨迹 + MISS 都开（P3 采集用这个）
#
# 本文件是**唯一真相**：先 unset 再按档位设置，因此调用方不要在上面再写 export
# MALONG_TRACE / MALONG_SEARCH_LOG，写了也会被覆盖。

_malong_dev_collect_mode="$(printf '%s' "${MALONG_DEV_COLLECT:-off}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

unset MALONG_TRACE
unset MALONG_SEARCH_LOG

case "$_malong_dev_collect_mode" in
  all)
    export MALONG_TRACE=all
    export MALONG_SEARCH_LOG=misses
    ;;
  trace)
    export MALONG_TRACE=all
    ;;
  misses)
    export MALONG_SEARCH_LOG=misses
    ;;
  off|'')
    : # 已 unset，什么都不做
    ;;
  *)
    # 无法识别的档位一律按 off 处理，并在 stderr 说明一次——不要静默当成 all
    printf 'dev-collect: unknown MALONG_DEV_COLLECT=%s → treated as off\n' "$_malong_dev_collect_mode" >&2
    ;;
esac

unset _malong_dev_collect_mode
# 恒返回 0：启动脚本带 set -e，source 失败会让服务起不来
true
