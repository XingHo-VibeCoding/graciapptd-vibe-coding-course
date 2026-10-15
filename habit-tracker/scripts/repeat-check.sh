#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 核心流程「重复执行」检测（Day 28 结营）
# ----------------------------------------------------------------------------
# 它回答的一个问题：**同一条核心流程连着跑两遍，会不会留下痕迹？**
#   ├─ 会不会多写出一条（重复提交拦不拦得住）？
#   ├─ 会不会残留测试数据（演示库越跑越脏）？
#   ├─ 第二遍的每一环结论，是否与第一遍完全相同？
#   └─ 终态的库内条数，是否与开跑之前一模一样？
#
# 与 core-flow-check.sh 的分工
#   core-flow-check.sh  = 跑**一遍**六环并逐环留证 ——「这一遍对不对」
#   repeat-check.sh     = 跑**两遍**并逐环比对 + 查副作用 ——「反复跑会不会变」
#
# 用法
#   bash habit-tracker/scripts/repeat-check.sh                  # 证据落临时目录（跑完打印路径）
#   bash habit-tracker/scripts/repeat-check.sh ./ev             # 指定证据目录
#   WITH_BROWSER=1 bash habit-tracker/scripts/repeat-check.sh ./ev   # 追加真浏览器复跑（慢，需 Edge）
#   SKIP_DB=1      bash habit-tracker/scripts/repeat-check.sh ./ev   # 没有 tcb 时只跑 HTTP 层
#
# 退出码
#   0 = 两遍全过且无副作用；1 = 有失败项（输出里标 ✗ 的行）
#
# 演示库安全
#   本脚本自造的数据一律带 `repeatcheck-` 前缀，结束时**物理删除**，并把「未删总条数」
#   与开跑前的基线对比 —— 终态必须与基线一致，否则当场报 ✗。可反复跑。
# ============================================================================

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SELF_DIR/.." && pwd)"          # habit-tracker/
CORE="$SELF_DIR/core-flow-check.sh"
DRIVER="$SELF_DIR/drive-user-flow.js"

BASE="${BASE:-https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api}"
D="${D:-$(date +%F)}"
WITH_BROWSER="${WITH_BROWSER:-0}"
SKIP_DB="${SKIP_DB:-0}"

OUTDIR="${1:-}"
if [ -z "$OUTDIR" ]; then
  OUTDIR="$(mktemp -d 2>/dev/null || echo "/tmp/repeat-check-$$")"
fi
mkdir -p "$OUTDIR" || { printf '无法创建证据目录：%s\n' "$OUTDIR"; exit 1; }

LOG="$OUTDIR/repeat-check-$(date +%F-%H%M).txt"
E1="$OUTDIR/run1-core-flow.txt"
E2="$OUTDIR/run2-core-flow.txt"
EB="$OUTDIR/run3-browser.txt"

PY="$(command -v python || command -v python3 || true)"
TCB="$(command -v tcb || true)"
NODE_BIN="${NODE_BIN:-}"

PASS=0; FAIL=0; SKIPPED=0

say()  { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$LOG"; }
rule() { say "============================================================"; }
# 分隔线写成两段短串拼接（源码里每段都短于 32 个 '-'），避免被 check-secrets.sh
# 的「32 位以上疑似随机串」特征误判 —— 这个坑 Day 24 踩过一次，别再踩。
HR_SEP='----------------------------'
HR_SEP="$HR_SEP$HR_SEP"
sec()  { say ""; say "【$1】$2"; say "$HR_SEP"; }
ok()   { PASS=$((PASS+1));    say "  ✓ $1"; }
no()   { FAIL=$((FAIL+1));    say "  ✗ $1"; }
skip() { SKIPPED=$((SKIPPED+1)); say "  ⚠ $1"; }
tip()  { say "      ↳ $1"; }

api_post() { curl -s --max-time 15 -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

# 从 stdin 的 JSON 里按路径取标量： jp code   /   jp data total
jp() {
  "$PY" -c '
import sys, json
raw = sys.stdin.read()
try:
    cur = json.loads(raw)
except Exception:
    print("__BADJSON__"); raise SystemExit
for k in sys.argv[1:]:
    if isinstance(cur, dict):      cur = cur.get(k)
    elif isinstance(cur, list) and k.lstrip("-").isdigit():
        i = int(k); cur = cur[i] if -len(cur) <= i < len(cur) else None
    else:                          cur = None
    if cur is None: break
if cur is None:                        print("")
elif isinstance(cur, bool):            print("true" if cur else "false")
elif isinstance(cur, (dict, list)):    print(json.dumps(cur, ensure_ascii=False))
else:                                  print(cur)
' "$@"
}

sql_run() { "$TCB" db execute --json --sql "$1" 2>&1; }

# 真库取标量： dbval "<SQL>" <列名>
dbval() {
  sql_run "$1" | "$PY" -c '
import sys, json
raw = sys.stdin.read()
i = raw.find("{")
if i < 0: print("__ERR__"); raise SystemExit
try: d = json.loads(raw[i:])
except Exception: print("__ERR__"); raise SystemExit
d = d.get("data", d)
cols = d.get("Columns") or []
rows = d.get("Rows") or []
if not rows: print(""); raise SystemExit
vals = json.loads(rows[0])
want = sys.argv[1] if len(sys.argv) > 1 else ""
print(vals[cols.index(want)] if want in cols else (vals[0] if vals else ""))
' "${2:-}"
}

# 真库影响行数（注意：tcb 的 Affected rows 不可信，一律以写后 SELECT 复核）
dbrows() { sql_run "$1" | "$PY" -c '
import sys, json
raw = sys.stdin.read()
i = raw.find("{")
if i < 0: print("__ERR__"); raise SystemExit
try: d = json.loads(raw[i:])
except Exception: print("__ERR__"); raise SystemExit
print((d.get("data", d) or {}).get("AffectedRows"))
'; }

# 取一趟证据里的通过 / 失败计数
#
# ⚠ 这里不要写成 `grep -c ... || echo 0`：grep -c 在没有匹配时**会打印 0 但退出码=1**，
#   于是 `|| echo 0` 又补一个 0，捕获到的字符串变成 "0\n0"，跟 "0" 比较必然不等 ——
#   结果就是「三趟全绿」被误报成 3 处 ✗。判据写错会让检查虚报/误报，这是本项目
#   反复踩到的坑（见 verify-project 的「判据自证」组）。这里只取 grep 自己打的那一行。
cnt_match() { local n; n="$(grep -c "$2" "$1" 2>/dev/null)"; printf '%s' "${n:-0}"; }
tally()    { cnt_match "$1" '^  ✓'; }
tally_no() { cnt_match "$1" '^  ✗'; }

# 把一趟证据里的逐环结论归一化（去掉数字，只留"哪些环过/不过"），用于两遍比对
norm() { grep -E '^  [✓✗⚠]' "$1" 2>/dev/null | sed 's/[0-9]\+/#/g'; }

# ===========================================================================
rule
say " 自律计划 · 核心流程「重复执行」检测"
rule
say "  接口地址 : $BASE"
say "  目标日期 : $D"
say "  生成时间 : $(date '+%F %T')"
say "  证据目录 : $OUTDIR"

if [ -z "$PY" ]; then
  say ""
  say "  ✗ 没找到 python（脚本靠它解析 JSON）—— 请先装 python 再跑。"
  say ""; rule; exit 1
fi

DB_OK=0
if [ "$SKIP_DB" = "1" ]; then
  say "  真库对照 : 已按 SKIP_DB=1 关闭"
elif [ -n "$TCB" ] && (cd "$APP_DIR" && "$TCB" db execute --json --sql "SELECT 1" >/dev/null 2>&1); then
  DB_OK=1
  say "  真库对照 : 可用（tcb db execute）"
else
  say "  真库对照 : 不可用 —— 标「真库」的项会跳过；先在 habit-tracker/ 跑一次 tcb login 再重来"
fi

# ---------------------------------------------------------------------------
sec "自证" "先证明判据本身是对的（否则后面每一栏 ✓ 都不可信）"

PROBE="$OUTDIR/.probe.txt"
printf '  ✓ 假通过\n  ✗ 假失败\n' > "$PROBE"
SA="$(tally "$PROBE")"; SB="$(tally_no "$PROBE")"
if [ "$SA" = "1" ] && [ "$SB" = "1" ]; then
  ok "必然命中的样本被正确计数（✓=1 ✗=1）"
else
  no "判据计数不对（✓=$SA ✗=$SB，期望 1/1）—— 后面所有结论都不可信"
fi
printf '  ✓ 只有通过，一个失败都没有\n' > "$PROBE"
SZ="$(tally_no "$PROBE")"
if [ "$SZ" = "0" ]; then
  ok "没有 ✗ 的样本被正确判为 0（反向验证：不会把全绿误报成失败）"
else
  no "没有 ✗ 却被判为 $SZ —— 会误报失败（grep -c 那个老坑又犯了）"
fi
rm -f "$PROBE"

# ---------------------------------------------------------------------------
sec "〇" "开跑之前：基线与残留（后面所有比对都以它为锚）"

BASE_TOTAL=""; BASE_TODAY=""; BASE_LEFTOVER=""
if [ "$DB_OK" = "1" ]; then
  BASE_TOTAL="$(dbval "SELECT count(*) AS n FROM checkins WHERE is_deleted = false" n)"
  BASE_TODAY="$(dbval "SELECT count(*) AS n FROM checkins WHERE is_deleted = false AND date = DATE '$D'" n)"
  BASE_LEFTOVER="$(dbval "SELECT count(*) AS n FROM checkins WHERE client_req_id LIKE 'flowcheck-%' OR client_req_id LIKE 'repeatcheck-%'" n)"
  say "  未删总条数（基线）: $BASE_TOTAL 条"
  say "  今天条数（基线）  : $BASE_TODAY 条"
  say "  历史自检残留      : $BASE_LEFTOVER 条"
  if [ "$BASE_LEFTOVER" = "0" ]; then
    ok "开跑前没有上一轮的自检残留（说明这个脚本真的每次都清干净了）"
  else
    no "开跑前已有 $BASE_LEFTOVER 条自检残留 —— 说明上一轮没清理干净，本次结论不可信"
    tip "先手工清理：DELETE FROM checkins WHERE client_req_id LIKE 'flowcheck-%' OR client_req_id LIKE 'repeatcheck-%';"
  fi
  if [ "$BASE_TOTAL" -gt 0 ] 2>/dev/null; then
    ok "库里本来就有数据（$BASE_TOTAL 条）—— 重复执行检测才有对照意义"
  else
    skip "库是空的（0 条）—— 建议先跑 db/seed-shift.sql，再重跑本脚本"
  fi
else
  skip "跳过基线与残留检查（真库不可用）"
fi

# ---------------------------------------------------------------------------
sec "一" "第 1 遍：完整跑一次六环（core-flow-check.sh）"

R1=1
if [ -f "$CORE" ]; then
  (cd "$APP_DIR" && bash "$CORE" "$E1" >/dev/null 2>&1) && R1=0
  P1="$(tally "$E1")"; F1="$(tally_no "$E1")"
  say "  第 1 遍：通过 $P1 项 · 失败 $F1 项"
  if [ "$R1" = "0" ] && [ "$F1" = "0" ]; then
    ok "第 1 遍六环全过（证据：run1-core-flow.txt）"
  else
    no "第 1 遍有失败项 —— 先修这个，重复检测暂时没有意义"
    tip "打开 $E1 看标 ✗ 的行，按 FLOW-TEST.md §五 四步协议诊断"
  fi
else
  no "找不到 $CORE"
fi

# ---------------------------------------------------------------------------
sec "二" "第 2 遍：同一命令再跑一次（这才是「重复」检测）"

R2=1
if [ -f "$CORE" ]; then
  (cd "$APP_DIR" && bash "$CORE" "$E2" >/dev/null 2>&1) && R2=0
  P2="$(tally "$E2")"; F2="$(tally_no "$E2")"
  say "  第 2 遍：通过 $P2 项 · 失败 $F2 项"
  if [ "$R2" = "0" ] && [ "$F2" = "0" ]; then
    ok "第 2 遍六环全过（证据：run2-core-flow.txt）"
  else
    no "第 2 遍有失败项 —— 同一条流程跑第二遍就挂，是最危险的一类问题"
    tip "把两遍证据 diff 一下：diff $E1 $E2"
  fi
fi

# ---------------------------------------------------------------------------
sec "三" "两遍一致性：逐环结论必须逐字相同"

if [ -f "$E1" ] && [ -f "$E2" ]; then
  norm "$E1" > "$OUTDIR/run1-normalized.txt"
  norm "$E2" > "$OUTDIR/run2-normalized.txt"
  if diff -q "$OUTDIR/run1-normalized.txt" "$OUTDIR/run2-normalized.txt" >/dev/null 2>&1; then
    ok "两遍逐环结论完全一致（$(wc -l < "$OUTDIR/run1-normalized.txt" | tr -d ' ') 行完全相同）"
  else
    no "两遍逐环结论不一致 —— 说明流程存在「时好时坏」的不稳定项"
    say "      ↳ 差异明细见：$OUTDIR/run1-normalized.txt vs run2-normalized.txt"
    diff "$OUTDIR/run1-normalized.txt" "$OUTDIR/run2-normalized.txt" | sed 's/^/        /' | head -20
  fi
  if [ "${P1:-0}" = "${P2:-0}" ]; then
    ok "两遍通过项数相同（$P1 = $P2）—— 没有「第一次过了第二次没过」"
  else
    no "两遍通过项数不同（$P1 → $P2）"
  fi
else
  skip "跳过一致性比对（缺少某一遍的证据文件）"
fi

# ---------------------------------------------------------------------------
sec "四" "副作用：库里的痕迹必须被清干净"

if [ "$DB_OK" = "1" ]; then
  LEFT="$(dbval "SELECT count(*) AS n FROM checkins WHERE client_req_id LIKE 'flowcheck-%' OR client_req_id LIKE 'repeatcheck-%'" n)"
  TOTAL="$(dbval "SELECT count(*) AS n FROM checkins WHERE is_deleted = false" n)"
  say "  自检残留（现在）  : $LEFT 条"
  say "  未删总条数（现在）: $TOTAL 条（基线 $BASE_TOTAL 条）"
  if [ "$LEFT" = "0" ]; then
    ok "两遍跑完零残留 —— 自造数据全部物理删除"
  else
    no "残留 $LEFT 条自检数据没清掉"
  fi
  if [ "$TOTAL" = "$BASE_TOTAL" ]; then
    ok "未删总条数回到基线（$BASE_TOTAL = $BASE_TOTAL）—— 反复跑不改变库的终态"
  else
    no "未删总条数漂移：基线 $BASE_TOTAL → 现在 $TOTAL"
    tip "先确认没有别人同时在写库；若只有你，那就是清理逻辑漏了。"
  fi
else
  skip "跳过副作用检查（真库不可用）"
fi

# ---------------------------------------------------------------------------
sec "五" "重复提交保护：同一个幂等键发两次，只能落库一条"

KEY="repeatcheck-$$-$(date +%s)"
BODY="{\"date\":\"$D\",\"text\":\"[重复检测] $KEY\",\"time\":null,\"quad\":null,\"clientReqId\":\"$KEY\"}"
C1="$(api_post "/checkins" "$BODY" | jp code)"
C2="$(api_post "/checkins" "$BODY" | jp code)"
say "  第 1 次提交 code = $C1（期望 0）"
say "  第 2 次提交 code = $C2（期望 409）"
if [ "$C1" = "0" ]; then
  ok "首次提交写成功"
else
  no "首次提交没成功（code=$C1）—— 后面的结论都不可信"
fi
if [ "$C2" = "409" ]; then
  ok "重复提交被幂等键拦住（409 请勿重复提交）"
elif [ "$C2" = "0" ]; then
  no "重复提交又写进去了一条！幂等键失效 —— 这是必须修的问题"
  tip "查 checkins_uid_reqid_uniq 索引是否还在：ls db/schema-2.sql"
else
  no "重复提交返回了意外结果（code=$C2，期望 409）"
fi

if [ "$DB_OK" = "1" ]; then
  ROWS="$(dbval "SELECT count(*) AS n FROM checkins WHERE client_req_id = '$KEY'" n)"
  say "  库内该幂等键的物理行数: $ROWS 行（期望 1）"
  if [ "$ROWS" = "1" ]; then
    ok "物理行数 = 1 —— 幂等键真的在数据库层挡住了重复"
  else
    no "物理行数 = $ROWS（期望 1）—— 接口层拦住了但库层没拦住，或反之"
  fi
  CLEAN="$(dbrows "DELETE FROM checkins WHERE client_req_id = '$KEY'")"
  AFTER="$(dbval "SELECT count(*) AS n FROM checkins WHERE client_req_id = '$KEY'" n)"
  say "  清理本次测试行：影响 $CLEAN 行，复查剩余 $AFTER 行"
  if [ "$AFTER" = "0" ]; then
    ok "测试行已物理删除（幂等键 $KEY）"
  else
    no "测试行没删干净，还剩 $AFTER 行 —— 请手工删：client_req_id = '$KEY'"
  fi
else
  skip "跳过库层物理行数核对（真库不可用）"
fi

# ---------------------------------------------------------------------------
sec "六" "真浏览器复跑（可选，WITH_BROWSER=1 开启）"

if [ "$WITH_BROWSER" != "1" ]; then
  skip "未开启浏览器复跑 —— 需要时加 WITH_BROWSER=1（要本机有 Edge，约 1–2 分钟）"
elif [ ! -f "$DRIVER" ]; then
  no "找不到 $DRIVER"
else
  NB="$NODE_BIN"
  if [ -z "$NB" ]; then
    NB="$(command -v node || true)"
  fi
  if [ -z "$NB" ]; then
    skip "找不到 node —— 跳过浏览器复跑"
  else
    SHOTS="$OUTDIR/browser-shots"
    (cd "$APP_DIR" && "$NB" "$DRIVER" --width=390 --out="$SHOTS" > "$EB" 2>&1)
    RB=$?
    PB="$(tally "$EB")"
    FB="$(tally_no "$EB")"
    say "  真浏览器（390px 手机宽度）：通过 $PB 项 · 失败 $FB 项"
    if [ "$RB" = "0" ] && [ "$FB" = "0" ]; then
      ok "真浏览器复跑全过（截图：$SHOTS）"
    else
      no "真浏览器复跑有失败项 —— 打开 $EB 看是哪一步"
    fi
  fi
fi

# ---------------------------------------------------------------------------
sec "七" "结论"

say ""
rule
if [ "$FAIL" = "0" ]; then
  say " 结论：核心流程可重复执行 ✓   通过 $PASS 项 · 跳过 $SKIPPED 项 · 失败 0 项"
  say " 含义：连着跑两遍，逐环结论相同、零残留、库的终态与开跑前完全一致。"
else
  say " 结论：有失败项 ✗   通过 $PASS 项 · 跳过 $SKIPPED 项 · 失败 $FAIL 项"
  say " 处理顺序：把标 ✗ 的行抄进 FLOW-TEST.md §四 的问题反馈格式，"
  say "           再按 §五 四步协议走（原因排序 → 验证 → 修复 → 回归）。"
fi
rule
say " 证据目录：$OUTDIR"
say ""

if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
