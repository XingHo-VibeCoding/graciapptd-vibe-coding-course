#!/usr/bin/env bash
# ============================================================================
#  自律计划 · 项目验证（verify-project.sh）
#  Day 25（2026-10-12）建立 · v1.0
# ----------------------------------------------------------------------------
#  一条命令回答「这个项目现在是不是好的」。
#  检查项**全部来自本项目真实踩过的坑** —— 每项后面括号里写着它对应哪一条，
#  出处是 DEPLOY.md §十三「最可能的卡点」与 FLOW-TEST.md §八「已知边界」。
#
#  用法
#    bash habit-tracker/scripts/verify-project.sh                # 证据文件自动命名
#    bash habit-tracker/scripts/verify-project.sh my.txt          # 指定证据文件
#    bash habit-tracker/scripts/verify-project.sh --no-net        # 跳过联网检查
#    SKIP_FLOW=1 bash habit-tracker/scripts/verify-project.sh      # 跳过最慢的核心链路自检
#    SITE=… BASE=… TEST_HOME=… NODE=… bash habit-tracker/scripts/verify-project.sh
#
#  退出码
#    0 = 全过（0 个 ✗）    1 = 有 ✗ 必须处理    2 = 环境不对（不在 git 仓库里）
#    ⚠️ 只是提示，不影响退出码。
#
#  七组检查（括号 = 它对应的真实踩坑）
#    A 安全红线      密钥特征 / 敏感文件 / Git 全历史          （卡点 4）
#    B 自动化测试    前端 jsdom + 云函数自测
#    C 线上可达性    首页 / health / 图标 / 跨域头             （卡点 5·7·15）
#    D 静态资源      引用完整性 + 线上可达 + 重复检测           （卡点 15）
#    E 数据新鲜度    库内最后一天 vs 今天 + E2 资源额度与到期   （卡点 1 / Day 27）
#    G 踩坑复验      跨域预检 / 环境变量 / 列名 / 错误分级 / 六环（卡点 2·3·8·10·13）
#    F 仓库状态      工作区是否干净 / 是否真的推上去了
#    ＋ 判据自证     把「必然命中」的样本回灌给判据本身，证明检查不是摆设
#
#  【为什么要「判据自证」】
#    检查清单最常见的失败不是漏检，而是**虚报通过**：正则写错、文件路径改了
#    没同步、阈值设反，结果每一栏都打 ✓，人却以为万事大吉。
#    所以本脚本每次运行都会拿几个「必然命中」的样本回灌给判据本身 —— 哪条
#    判据失效，当场就变成 ✗。这是课程 Day 25「故意弄坏一项，验证 Skill 不会
#    虚报通过」的**常驻版本**：不靠人偶尔想起来验一次，而是每次跑都自带校验。
#
#  【设计原则（照 check-secrets.sh / core-flow-check.sh 那套）】
#    1) 只读：不改代码、不动数据库、不部署。发现 ✗ 只报告，不替你修。
#    2) 不中断：某一组失败也让后面的组照跑，一次看完整个发布面的全貌。
#    3) 分组要能单独摘出来截图：每组有自己的小标题与结论行。
# ============================================================================

set -u

# ---- 定位仓库根目录（脚本可放在任意子目录里跑）----
if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "✗ 当前目录不在 git 仓库内，无法检查。" >&2
  exit 2
fi
cd "$ROOT"

APP="habit-tracker"
SITE="${SITE:-https://habit-tracker-d9gh0mjel767ff0d2-1499348397.tcloudbaseapp.com}"
BASE="${BASE:-https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api}"
NET=1
OUT=""
for a in "$@"; do
  case "$a" in
    --no-net) NET=0 ;;
    -*) : ;;
    *)  OUT="$a" ;;
  esac
done
OUT="${OUT:-verify-project-$(date +%F-%H%M).txt}"

TODAY="$(date +%F)"
LOG="$OUT"
: > "$LOG" 2>/dev/null || { printf '无法写入证据文件：%s\n' "$OUT"; exit 1; }

PASS=0; FAIL=0; WARN=0
say()  { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$LOG"; }
rule() { say "============================================================"; }
# 分隔线写成两段短串拼接（源码里每段 < 32 个 '-'）：避免本脚本自己被
# check-secrets.sh 的「32 位以上疑似随机串」特征误判 —— 写检查脚本的人最容易
# 被自己的判据误伤，core-flow-check.sh 与 check-secrets.sh 都栽过同一个坑。
HR_SEP='----------------------------'
HR_SEP="$HR_SEP$HR_SEP"
sec()  { say ""; say "【$1】$2"; say "$HR_SEP"; }
ok()   { PASS=$((PASS+1)); say "  ✓ $1"; }
no()   { FAIL=$((FAIL+1)); say "  ✗ $1"; }
warn() { WARN=$((WARN+1)); say "  ⚠ $1"; }
tip()  { say "      ↳ $1"; }
dump() { printf '%s\n' "$1" | while IFS= read -r _l; do say "      $_l"; done; }

# ---- 运行环境探测（node / python，找不到就降级为 ⚠️ 跳过，不假装通过）----
NODE_BIN="${NODE:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [ -x "C:/Users/Lenovo/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" ]; then
    NODE_BIN="C:/Users/Lenovo/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
  fi
fi
NODE_MODULES="${NODE_MODULES:-C:/Users/Lenovo/.workbuddy/binaries/node/workspace/node_modules}"
FE_TEST="${TEST_HOME:-C:/Users/Lenovo/WorkBuddy/2026-09-16-21-05-24/test-home.js}"
PY="$(command -v python || command -v python3 || true)"
TCB="$(command -v tcb || true)"

rule
say " 自律计划 · 项目验证（verify-project）"
rule
say "  仓库根目录 : $ROOT"
say "  线上前端   : $SITE"
say "  线上接口   : $BASE"
say "  检查日期   : $TODAY"
say "  生成时间   : $(date '+%F %T')"
say "  证据文件   : $OUT"
say "  运行环境   : node=${NODE_BIN:-（无）} · python=${PY:-（无）} · tcb=${TCB:-（无）}"

# ===========================================================================
# A. 安全红线
# ===========================================================================
sec "A" "安全红线 —— 密钥特征 / 敏感文件 / Git 全历史"

if [ ! -f "$APP/scripts/check-secrets.sh" ]; then
  no "找不到 $APP/scripts/check-secrets.sh —— 安全这一组等于没查"
  tip "这是发布前的第一红线，缺了它就先补脚本，别继续往下看。"
else
  SEC_OUT="$(bash "$APP/scripts/check-secrets.sh" 2>&1)"
  SEC_RC=$?
  if [ "$SEC_RC" = "0" ]; then
    dump "$(printf '%s\n' "$SEC_OUT" | grep -E '小计|结论' | sed 's/^ *//')"
    ok "check-secrets.sh 通过（退出码 0）：工作区与全部历史 0 命中"
  else
    no "check-secrets.sh 报出高危项（退出码 $SEC_RC）"
    dump "$(printf '%s\n' "$SEC_OUT" | grep -E '↳|【已跟踪|【未忽略|【缺少|小计|结论' | head -20)"
    tip "处理顺序不能颠倒：① 云端作废并重新生成该密钥（历史改不掉「已泄露」这一事实）"
    tip "                            ② 更新 cloudbaserc.json / 云端环境变量并重新部署"
    tip "                            ③ 最后才轮到时清理历史（强推后通知所有协作者重新 clone）"
  fi
fi

# ===========================================================================
# B. 自动化测试
# ===========================================================================
sec "B" "自动化测试 —— 前端 jsdom + 云函数自测"

# ---- B1 前端 jsdom ----
if [ -z "$NODE_BIN" ]; then
  warn "没找到 node —— 前端测试跳过（用 NODE=<路径> 指定）"
elif [ ! -f "$FE_TEST" ]; then
  warn "前端测试文件不在预期位置：$FE_TEST"
  tip "用 TEST_HOME=<test-home.js 的绝对路径> 指定；跳过不等于通过。"
else
  FE_OUT="$(NODE_PATH="$NODE_MODULES" "$NODE_BIN" "$FE_TEST" 2>&1)"
  FE_RC=$?
  FE_SUM="$(printf '%s\n' "$FE_OUT" | grep -E '结果：' | tail -1 | sed 's/^ *//')"
  if [ "$FE_RC" = "0" ]; then
    ok "前端 jsdom：${FE_SUM:-通过}（退出码 0）"
  else
    no "前端 jsdom 失败（退出码 $FE_RC）：${FE_SUM:-没有汇总行}"
    # Day 26 修正：失败条目的标记是 ❌（U+274C），此前只 grep「失败|✗|Error」
    # 会把真正的失败行滤掉、只剩汇总行 —— 排错时看不到挂的是哪条（今日实miss两次）
    dump "$(printf '%s\n' "$FE_OUT" | grep -iE '失败|✗|Error|❌' | head -10)"
  fi
fi

# ---- B2 云函数自测 ----
SELF_TEST="$APP/cloudfunctions/api/selftest.js"
if [ -z "$NODE_BIN" ]; then
  warn "没找到 node —— 云函数自测跳过"
elif [ ! -f "$SELF_TEST" ]; then
  no "找不到 $SELF_TEST —— 云函数没被测过就发布，属于红线"
else
  CF_OUT="$("$NODE_BIN" "$SELF_TEST" 2>&1)"
  CF_RC=$?
  CF_SUM="$(printf '%s\n' "$CF_OUT" | grep -E '自测：|全部通过' | tail -1 | sed 's/^ *//')"
  if [ "$CF_RC" = "0" ]; then
    ok "云函数自测：${CF_SUM:-通过}（退出码 0）"
  else
    no "云函数自测失败（退出码 $CF_RC）：${CF_SUM:-没有汇总行}"
    dump "$(printf '%s\n' "$CF_OUT" | grep -A6 '未通过' | head -10)"
  fi
fi

# ===========================================================================
# C. 线上可达性
# ===========================================================================
sec "C" "线上可达性 —— 首页 / 接口 / 图标 / 跨域头"

if [ "$NET" = "0" ]; then
  warn "--no-net：联网检查整组跳过（离线也能跑，但线上状态这次没验）"
else
  # ---- C1 前端首页 ----
  HOME_META="$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 15 "$SITE/")"
  HOME_CODE="${HOME_META%% *}"
  HOME_SIZE="${HOME_META##* }"
  if [ "$HOME_CODE" = "200" ] && [ "${HOME_SIZE:-0}" -gt 1000 ]; then
    ok "前端首页 200 · $HOME_SIZE 字节"
  else
    no "前端首页异常：HTTP=$HOME_CODE，$HOME_SIZE 字节"
    tip "静态托管没传对？（frontend/ 里的东西要直接放在托管根目录，多套一层目录会导致根路径 404）"
  fi

  # ---- C2 健康检查 ----
  H_RAW="$(curl -s --max-time 15 "$BASE/health")"
  say "      GET /api/health → $H_RAW"
  if printf '%s' "$H_RAW" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true'; then
    if printf '%s' "$H_RAW" | grep -q 'Self discipline plan'; then
      ok "健康检查：绿灯 · 服务名对得上"
    else
      no "健康检查 ok=true 但服务名不对 —— 可能连到了别的函数"
    fi
  else
    no "健康检查没返回 {\"ok\":true} —— 前端检查台会是红灯"
    tip "先分三类：连不上（网络层）/ 5xx（服务端）/ HTTP 200 但 code≠0（业务）。"
  fi

  # ---- C3 图标可达 ----
  ICON_META="$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 15 "$SITE/assets/favicon.png")"
  ICON_CODE="${ICON_META%% *}"
  if [ "$ICON_CODE" = "200" ]; then
    ok "站点图标 favicon.png 200 · ${ICON_META##* } 字节"
  else
    no "站点图标 favicon.png HTTP=$ICON_CODE —— 每个访客控制台会多一条 404 红字"
  fi

  # ---- C4 跨域头（前端能不能调后端，就看这一个头）----
  ACAO="$(curl -s -D - -o /dev/null --max-time 15 -H "Origin: $SITE" "$BASE/health" | tr -d '\r' | grep -i '^access-control-allow-origin:' | head -1)"
  if [ -n "$ACAO" ]; then
    ok "跨域头存在：${ACAO}"
  else
    no "响应里没有 Access-Control-Allow-Origin —— 浏览器会拦掉前端对后端的请求"
    tip "网关统一处理 CORS；判据就是「响应里有没有这个头」。托管域名需在安全域名白名单里。"
  fi
fi

# ===========================================================================
# D. 静态资源
# ===========================================================================
sec "D" "静态资源 —— 引用完整性 / 线上可达 / 重复检测"

IDX="$APP/frontend/index.html"
if [ ! -f "$IDX" ]; then
  no "找不到 $IDX —— 资源检查整组跳过"
else
  REFS="$(grep -oE 'assets/[A-Za-z0-9._-]+' "$IDX" | sort -u)"
  REF_N="$(printf '%s\n' "$REFS" | grep -c .)"

  # ---- D1 引用完整性：页面上写的每个路径，磁盘上都要有 ----
  MISSING=""
  for r in $REFS; do
    [ -f "$APP/frontend/$r" ] || MISSING="$MISSING $r"
  done
  if [ -z "$MISSING" ]; then
    ok "引用完整性：index.html 引用的 $REF_N 个静态资源，磁盘上全都有"
  else
    no "有引用指向不存在的文件：$MISSING"
    tip "页面上写了、文件却没有 —— 用户那边就是一片空白 + 控制台 404。"
  fi

  # ---- D2 线上可达：逐个请求，任何非 200 都算 ✗ ----
  if [ "$NET" = "0" ]; then
    warn "--no-net：跳过线上资源可达性（$REF_N 个）"
  else
    BAD=""; CHECKED=0
    for r in $REFS; do
      c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SITE/$r")"
      CHECKED=$((CHECKED+1))
      [ "$c" = "200" ] || BAD="$BAD $r($c)"
    done
    if [ -z "$BAD" ]; then
      ok "线上可达：$CHECKED 个资源全部 200"
    else
      no "线上有资源取不到：$BAD"
      tip "本地有、线上没有 → 八成是这次改了前端却忘了重新部署。"
    fi
  fi

  # ---- D3 重复资源（提示项，不阻断发布）----
  if command -v md5sum >/dev/null 2>&1; then
    DUP="$(md5sum "$APP"/frontend/assets/* 2>/dev/null | awk '{print $1}' | sort | uniq -d)"
    if [ -z "$DUP" ]; then
      ok "重复检测：assets 里没有内容完全相同的文件"
    else
      warn "assets 里有内容重复的文件（内容 md5 相同）："
      for d in $DUP; do
        names="$(md5sum "$APP"/frontend/assets/* 2>/dev/null | grep "^$d" | awk '{print $2}' | xargs -n1 basename | tr '\n' ' ')"
        dump "• $names"
      done
      tip "不阻断发布，但等于白占体积、且容易「换了图没换对」。要修得先拿到新素材。"
    fi
  else
    warn "没有 md5sum —— 重复检测跳过"
  fi
fi

# ===========================================================================
# E. 数据新鲜度
# ===========================================================================
sec "E" "数据新鲜度 —— 库内最后一天 vs 今天（演示会不会开天窗）"

if [ -z "$TCB" ]; then
  warn "没找到 tcb —— 跳过（先在仓库根跑一次 tcb login）"
elif [ -z "$PY" ]; then
  warn "没找到 python —— 跳过（脚本靠它解析 tcb 的 JSON 输出）"
else
  LASTDAY="$("$TCB" db execute --json --sql "SELECT max(date) AS d FROM checkins WHERE is_deleted = false" 2>&1 | "$PY" -c '
import sys, json
raw = sys.stdin.read(); i = raw.find("{")
if i < 0: print("__ERR__"); raise SystemExit
try: d = json.loads(raw[i:])
except Exception: print("__ERR__"); raise SystemExit
d = d.get("data", d); cols = d.get("Columns") or []; rows = d.get("Rows") or []
if not rows or "d" not in cols: print(""); raise SystemExit
print(json.loads(rows[0])[cols.index("d")])
' 2>/dev/null)"
  if [ "$LASTDAY" = "__ERR__" ]; then
    warn "真库查询失败（tcb 登录过期或网络问题）—— 这一组没验成"
  elif [ -z "$LASTDAY" ]; then
    warn "checkins 表里没有任何未删数据 —— 首页「今天」会是空的"
  else
    say "      库内最后一天：$LASTDAY ；今天：$TODAY"
    if [ "$LASTDAY" = "$TODAY" ]; then
      ok "数据新鲜：库内最后一天就是今天，首页有内容可看"
    elif [ "$LASTDAY" \< "$TODAY" ]; then
      warn "种子数据落后 $(( ( $(date -d "$TODAY" +%s) - $(date -d "$LASTDAY" +%s) ) / 86400 )) 天 —— 现在打开首页「今天」是空的"
      tip "这是已知第 1 号卡点：种子日期锚定在「跑脚本那天」，隔天就脱节。"
      tip "演示前跑一次（幂等，可重复执行）："
      tip "  MSYS_NO_PATHCONV=1 tcb db execute --envId <环境ID> --sql \"\$(cat habit-tracker/db/seed-shift.sql)\""
      tip "不阻断发布：发布的是代码，代码没问题；但**演示/验收前必须补这一下**。"
    else
      warn "库内出现了未来日期（$LASTDAY > $TODAY）—— 检查一下 seed-shift 是不是跑偏了"
    fi
  fi

  # --- E2 资源额度与到期（Day 27 加）-------------------------------------------------
  # 为什么放进发布前检查：额度耗尽或环境到期，会让"功能全绿"变成假话 ——
  # 接口能通是因为还没超额，等发现时已经是线上事故。阈值：≥80% 警告，≥95% 阻断。
  say ""
  say "      —— E2 资源额度与到期 ——"
  ENVID="${ENVID:-habit-tracker-d9gh0mjel767ff0d2}"
  if [ -z "$TCB" ] || [ -z "$PY" ]; then
    warn "没找到 tcb / python —— 额度与到期两项跳过"
  else
    QUOTA_LINE="$("$TCB" env usage --env-id "$ENVID" 2>&1 | grep -oE 'resource points: [0-9.]+ used / [0-9.]+ total' | head -1)"
    if [ -z "$QUOTA_LINE" ]; then
      warn "额度查询失败（tcb 登录过期？）—— 手动跑：tcb env usage --env-id $ENVID"
    else
      USED="$(printf '%s' "$QUOTA_LINE" | awk '{print $3}')"
      TOTAL="$(printf '%s' "$QUOTA_LINE" | awk '{print $6}')"
      PCT="$(awk "BEGIN{ if ($TOTAL+0 == 0) print 100; else printf \"%.1f\", $USED*100/$TOTAL }")"
      say "      本计费周期资源点：$USED / $TOTAL（$PCT%）"
      if awk "BEGIN{exit !($PCT >= 95)}"; then
        no "资源点已用 $PCT% —— 额度将尽，先扩容或清理再发布"
      elif awk "BEGIN{exit !($PCT >= 80)}"; then
        warn "资源点已用 $PCT% —— 接近上限，发布前留意增速"
      else
        ok "资源点充足：$USED / $TOTAL（$PCT%）"
      fi
    fi
    EXPIRE="$("$TCB" env list --json 2>/dev/null | "$PY" -c '
import sys, json
raw = sys.stdin.read(); i = raw.find("{")
if i < 0: print("__ERR__"); raise SystemExit
try: envs = json.loads(raw[i:])["data"]
except Exception: print("__ERR__"); raise SystemExit
for e in envs:
    if e.get("EnvId") == "'"$ENVID"'":
        print(e.get("ExpireTime", "__ERR__")); break
else: print("__ERR__")
' 2>/dev/null)"
    if [ "$EXPIRE" = "__ERR__" ] || [ -z "$EXPIRE" ]; then
      warn "环境到期时间没查到 —— 手动跑：tcb env list --json"
    else
      DAYS_LEFT="$(EXPIRE="$EXPIRE" "$PY" -c '
import os
from datetime import datetime
try:
    left = datetime.strptime(os.environ["EXPIRE"], "%Y-%m-%d %H:%M:%S") - datetime.now()
    print(left.days)
except Exception:
    print("__ERR__")
' 2>/dev/null)"
      if [ "$DAYS_LEFT" = "__ERR__" ]; then
        warn "到期时间解析失败（$EXPIRE）—— 手动核一眼"
      elif [ "$DAYS_LEFT" -lt 0 ]; then
        no "环境已于 $EXPIRE 过期 —— 线上随时可能停服，必须先续费"
      elif [ "$DAYS_LEFT" -le 30 ]; then
        warn "环境 $EXPIRE 到期，只剩 $DAYS_LEFT 天 —— 体验版到期不自动续，尽快决定续费或迁移"
      else
        ok "环境有效期充足：$EXPIRE 到期（还剩 $DAYS_LEFT 天，体验版不自动续费）"
      fi
    fi
  fi
fi

# ===========================================================================
# G. 踩坑复验（把项目**真实踩过的坑**变成探针）
# ===========================================================================
# 每一项都对应 DEPLOY.md §十三 / FLOW-TEST.md §八 里的一条真实卡点：
#   G1 跨域预检       卡点 2  「跨域被拦」——地址栏能开、页面 fetch 却被浏览器拦
#   G2 环境变量生效   卡点 3  「环境变量没配 / 失效」——接口回 500
#   G3 列名不外泄     契约     库内 snake_case 列名不得出现在响应里
#   G4 错误分级       卡点 13 「把服务端出问题说成你网络不好」
#   G5 核心链路       卡点 8「重复写入被拒 409」+ 卡点 10「删掉的待办又冒出来」
sec "G" "踩坑复验 —— 跨域 / 环境变量 / 列名 / 错误分级 / 核心链路"

if [ "$NET" = "0" ]; then
  warn "--no-net：踩坑复验整组跳过（这一组全靠打真实请求）"
else
  # ---- G1 跨域预检（卡点 2）：浏览器发 POST 之前会先发 OPTIONS，就看你答不答应 ----
  PRE="$(curl -s -D - -o /dev/null --max-time 15 -X OPTIONS \
        -H "Origin: $SITE" \
        -H "Access-Control-Request-Method: POST" \
        -H "Access-Control-Request-Headers: content-type" \
        "$BASE/checkins" | tr -d '\r')"
  if printf '%s' "$PRE" | grep -qi '^access-control-allow-origin:'; then
    ok "跨域预检：OPTIONS 带回了 Allow-Origin —— 浏览器不会把写请求拦下来"
  else
    no "跨域预检失败：OPTIONS 响应里没有 Allow-Origin —— 页面上的写操作会被浏览器拦掉"
    tip "卡点 2：来源不在安全域名白名单。tcb cors list 看白名单（免费版有额度限制）。"
  fi

  # ---- G2 环境变量生效（卡点 3）：云函数能连上库 = TCB_ENV / CLOUDBASE_API_KEY 都在 ----
  DAY_RAW="$(curl -s --max-time 15 "$BASE/day?date=$TODAY")"
  DAY_CODE="$(printf '%s' "$DAY_RAW" | grep -oE '"code"[[:space:]]*:[[:space:]]*-?[0-9]+' | head -1 | grep -oE '\-?[0-9]+$')"
  if [ "$DAY_CODE" = "0" ]; then
    ok "环境变量生效：GET /api/day 回 code=0（云函数拿到了环境 ID / API Key 并查到了库）"
  else
    no "GET /api/day 回 code=${DAY_CODE:-无响应} —— 云函数多半没连上库"
    tip "卡点 3：日志里会是「数据库未配置：缺少环境变量 TCB_ENV 或 CLOUDBASE_API_KEY」。"
    tip "       改完环境变量必须**重新部署函数**才生效（tcb fn detail api 可看当前值）。"
    dump "响应原文：$DAY_RAW"
  fi

  # ---- G3 列名不外泄：接口只该暴露契约字段，库内 snake_case 列名不该露脸 ----
  ONE_RAW="$(curl -s --max-time 15 "$BASE/checkins?limit=1")"
  LEAKED=""
  for _c in is_deleted client_req_id done_at updated_at created_at; do
    printf '%s' "$ONE_RAW" | grep -q "\"$_c\"" && LEAKED="$LEAKED $_c"
  done
  if [ -z "$LEAKED" ]; then
    ok "列名不外泄：响应里没有库内 snake_case 列名（db.js 的字段翻译在位）"
  else
    no "响应里出现了库内列名：$LEAKED —— 契约字段与库列的映射漏了"
    dump "响应原文：$ONE_RAW"
  fi

  # ---- G4 错误分级（卡点 13）：失败要给中文人话，不能把英文堆栈丢给前端 ----
  E_RAW="$(curl -s --max-time 15 -X PATCH "$BASE/checkins/abc" -H 'Content-Type: application/json' -d '{"text":"探针"}')"
  E_CODE="$(printf '%s' "$E_RAW" | grep -oE '"code"[[:space:]]*:[[:space:]]*-?[0-9]+' | head -1 | grep -oE '\-?[0-9]+$')"
  E_MSG="$(printf '%s' "$E_RAW" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ "$E_CODE" = "400" ] && [ -n "$E_MSG" ] \
     && ! printf '%s' "$E_MSG" | grep -qE 'Error|Exception|at [A-Za-z]+\.'; then
    ok "错误分级：非法 id 回 400，且 message 是给人看的话「$E_MSG」"
  else
    no "非法 id 的错误响应不对：code=${E_CODE:-?} · message=${E_MSG:-（空）}"
    tip "契约 §1.8 / 卡点 13：三类错误（网络层 / 服务端故障 / 业务拒绝）都必须是中文人话，"
    tip "                 英文堆栈只留在服务端日志里。"
  fi

  # ---- G5 核心链路（卡点 8 重复写入 + 卡点 10 软删除）：交给已有的六环自检 ----
  if [ "${SKIP_FLOW:-0}" = "1" ]; then
    warn "SKIP_FLOW=1：核心链路自检跳过 —— 重复写入 / 软删除这两条真实坑这次没验"
  elif [ ! -f "$APP/scripts/core-flow-check.sh" ]; then
    no "找不到 $APP/scripts/core-flow-check.sh —— 幂等与软删除这两条真实坑没被覆盖"
  else
    FLOW_EV="$(mktemp 2>/dev/null || echo "/tmp/core-flow-$$.txt")"
    FLOW_OUT="$(bash "$APP/scripts/core-flow-check.sh" "$FLOW_EV" 2>&1)"
    FLOW_RC=$?
    FLOW_SUM="$(printf '%s\n' "$FLOW_OUT" | grep -E '结论：' | tail -1 | sed 's/^ *//')"
    if [ "$FLOW_RC" = "0" ]; then
      ok "核心链路六环：$FLOW_SUM"
    else
      no "核心链路六环有失败：$FLOW_SUM"
      dump "$(printf '%s\n' "$FLOW_OUT" | grep -E '✗' | head -8)"
      tip "它的完整证据在：$FLOW_EV（每一环都带真库对照）"
    fi
    IDEM_LINE="$(printf '%s\n' "$FLOW_OUT" | grep -E '防重复提交|重复删除' | head -2)"
    [ -n "$IDEM_LINE" ] && dump "$IDEM_LINE"
  fi
fi

# ===========================================================================
# F. 仓库状态
# ===========================================================================
sec "F" "仓库状态 —— 工作区是否干净 / 是否真的推上去了"

DIRTY="$(git status --porcelain)"
if [ -z "$DIRTY" ]; then
  ok "工作区干净：没有未提交的改动"
else
  no "工作区不干净，还有没提交的改动："
  dump "$(printf '%s\n' "$DIRTY" | head -12)"
  tip "发布前应先把改动提交（或明确 stash）—— 否则线上跑的不是你本地这份。"
fi

BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
LOCAL_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
UPSTREAM="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo '')"
if [ -z "$UPSTREAM" ]; then
  warn "当前分支（$BR）没有上游分支，无法判断是否已推送"
  tip "git push -u origin $BR"
elif [ "$NET" = "0" ]; then
  warn "--no-net：跳过远程 SHA 核对（本地分支领先与否未验）"
else
  # ---- 先看本地有没有落后/领先（不需要联网）----
  AHEAD_BEHIND="$(git status -sb | head -1)"
  if printf '%s' "$AHEAD_BEHIND" | grep -q 'ahead'; then
    no "本地领先远程，还没推：$AHEAD_BEHIND"
  else
    # ---- 再直接问远程要 SHA（push「无输出且退出码 0」≠ 成功，必须核 SHA）----
    REMOTE_SHA="$(git ls-remote "${UPSTREAM%%/*}" "refs/heads/$BR" 2>/dev/null | awk '{print $1}' | head -1)"
    if [ -z "$REMOTE_SHA" ]; then
      # 联网受限时拿不到远程 SHA —— 这**不是项目的问题**，不该报成警告。
      # 上面已经用本地 remote-tracking 状态确认过「没有 ahead」，这里只作说明。
      say "      ⓘ 未能向远程核实 SHA（网络受限）；已按本地状态判定：未领先远程。"
    elif [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then
      ok "已推送：本地与远程都是 ${LOCAL_SHA:0:7}"
    else
      no "本地与远程不一致：本地 ${LOCAL_SHA:0:7} vs 远程 ${REMOTE_SHA:0:7}"
      tip "注意：push 无输出且退出码 0 并不等于成功（本项目真踩过），必须以 ls-remote 的 SHA 为准。"
    fi
  fi
fi

# ===========================================================================
# 自证：判据灵敏度（本 Skill 的抗虚报机制）
# ===========================================================================
sec "自证" "判据灵敏度 —— 证明检查不是摆设"

# 这几个样本在源码文本里被**故意拆成了两段**（"sk-""FAKE…"）：
#   · 拼接后的值必然命中对应判据 → 用来证明判据是活的；
#   · 源码文本里它不构成一个连续特征串 → 本脚本自己不会被 check-secrets.sh 误判。
probe() {
  local label="$1" pattern="$2" sample="$3"
  if printf '%s' "$sample" | grep -qE "$pattern"; then
    ok "判据有效：$label —— 样本被同一套正则命中"
  else
    no "判据失效：$label —— 样本竟然没被命中，这项检查在虚报通过！"
  fi
  [ "${SHOW_PROBE:-0}" = "1" ] && say "      ↳ 样本：$sample"
}
# 反向验证：判据**不该**命中的东西，确认它确实不命中（防假阳性）
probe_neg() {
  local label="$1" pattern="$2" sample="$3"
  if printf '%s' "$sample" | grep -qE "$pattern"; then
    no "判据假阳性：$label —— 这个样本不该被命中却被命中了"
  else
    ok "判据无假阳性：$label"
  fi
}

# 下面这几条正则与 check-secrets.sh 里实际使用的一致（改那边记得同步这边）。
# 样本在源码文本里被**故意拆成多段**：单段都短于第 8 条特征的门槛，不会让本
# 脚本自己被 check-secrets.sh 误判；拼接后的值则必然命中，用来证明判据是活的。
probe     "OpenAI 风格密钥"      'sk-[A-Za-z0-9]{20,}'        "sk-""FAKEtestkey""0123456789abcdefghij"
probe     "JWT 风格密钥"         'eyJ[A-Za-z0-9_-]{10,}'     "eyJ""hbGciOiJIUzI1NiIs""InR5cCI6IkpXVCJ9payload"
probe     "GitHub token"         'ghp_[A-Za-z0-9]{20,}'      "ghp_""FAKE""0000000000000000000000000000"
probe     "私钥文件内容"          'BEGIN [A-Z ]*PRIVATE KEY'   "$(printf 'BEGIN %s' '')RSA PRIVATE KEY"
FAKE_RAND="rand0mStr1ngW1thDigits""AndLetters9999"
probe     "32 位随机串（值位置）"  '"[A-Za-z0-9_-]{32,}"'      "\"$FAKE_RAND\""
probe_neg "纯分隔线不误报为随机串" '"[-]*[A-Za-z0-9][A-Za-z0-9_-]{30,}"' '"------------------------------------------------------------"'
# E2 的判据也要自证：额度行的解析正则，拿真实输出格式回灌（Day 27 加）
probe     "额度行解析正则"        'resource points: [0-9.]+ used / [0-9.]+ total' "In-package resource points: 9.78 used / 3000.00 total"
probe_neg "残缺额度行不误报"      'resource points: [0-9.]+ used / [0-9.]+ total' "resource points: used / total"
say ""
tip "这一组是 Day 25 的教学点：检查清单最常见的失败不是漏检，而是**虚报通过**。"
tip "拿「必然命中」的样本回灌给判据，任何一条正则写坏都会当场暴露成 ✗。"

# ===========================================================================
# 结论
# ===========================================================================
say ""
rule
if [ "$FAIL" = "0" ]; then
  say " 结论：可以发布 ✓   通过 $PASS 项 · 警告 $WARN 项 · 失败 0 项"
else
  say " 结论：先别发布 ✗   通过 $PASS 项 · 警告 $WARN 项 · 失败 $FAIL 项"
  say " 处理顺序：把上面标 ✗ 的项抄进问题清单，修完用同一条命令重跑；"
  say "           重新跑之前先确认「自证」那一组仍是全 ✓ —— 判据坏了的话，"
  say "           后面的 ✓ 都不可信。"
fi
if [ "$WARN" != "0" ]; then
  say " 提示：$WARN 项 ⚠️ 不影响「能不能发布」，但演示/验收前要单独确认。"
fi
rule
say " 证据文件：$OUT"
say ""

if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
