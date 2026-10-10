#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 核心流程自检（六环全链路）
# ----------------------------------------------------------------------------
# 用途
#   一条命令走完「① 打开检查台 → ② 读 plan_days/checkins → ③ 写入打卡
#   → ④ 刷新确认 → ⑤ 修改 → ⑥ 删除」六环，逐环打印通过/失败，并把完整输出
#   同时写进一份证据文件（默认落在当前目录）。
#
#   **修 Bug 之前跑一次、修完之后再跑一次，两份文件直接 diff** —— 这就是
#   FLOW-TEST.md 里的「前后各留一份证据」。
#
# 用法
#   bash habit-tracker/scripts/core-flow-check.sh                 # 证据文件自动命名
#   bash habit-tracker/scripts/core-flow-check.sh before.txt      # 指定证据文件
#   KEEP=1 bash habit-tracker/scripts/core-flow-check.sh          # 跑完不清理（排查用）
#   BASE=https://xxx/api bash habit-tracker/scripts/core-flow-check.sh   # 换目标接口
#
# 退出码
#   0 = 六环全过；1 = 有失败项（输出里标 ✗ 的行）
#
# 三条设计原则（照 check-secrets.sh 那套）
#   1) **不碰种子数据**：全程只用自己创建的那一条测试行，结束时物理删掉，
#      终态与跑之前完全一致 —— 所以可以反复跑，演示库不会被弄脏。
#   2) **不中断**：某一环失败也让后面的环照跑，一次看完整个链路的全貌。
#   3) **双口径**：每一步都能从 HTTP 看到，也能从真库 SELECT 看到；
#      两边对不上，就说明问题出在"接口层"而不是"数据库层"。
# ============================================================================

set -u

BASE="${BASE:-https://habit-tracker-d9gh0mjel767ff0d2.service.tcloudbase.com/api}"
D="${D:-$(date +%F)}"
OUT="${1:-core-flow-$(date +%F-%H%M).txt}"
KEEP="${KEEP:-0}"
TAG="flowcheck-$$-$(date +%s)"                 # 本次运行专属标记，用于定位/清理自己造的数据
TEXT_PREFIX="[流程自检]"

PY="$(command -v python || command -v python3 || true)"
TCB="$(command -v tcb || true)"

LOG="$OUT"
: > "$LOG" 2>/dev/null || { printf '无法写入证据文件：%s\n' "$OUT"; exit 1; }

PASS=0; FAIL=0; SKIPPED=0

say()  { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$LOG"; }
rule() { say "============================================================"; }
sec()  { say ""; say "【$1】$2"; say "------------------------------------------------------------"; }
ok()   { PASS=$((PASS+1));    say "  ✓ $1"; }
no()   { FAIL=$((FAIL+1));    say "  ✗ $1"; }
skip() { SKIPPED=$((SKIPPED+1)); say "  ⚠ $1"; }
tip()  { say "      ↳ $1"; }

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
api_get()  { curl -s --max-time 12 "$BASE$1"; }
api_post() { curl -s --max-time 12 -X POST   "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }
api_patch(){ curl -s --max-time 12 -X PATCH  "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }
api_del()  { curl -s --max-time 12 -X DELETE "$BASE$1"; }

# 从 stdin 的 JSON 里按路径取标量：  jp data total   /   jp data items 0 id
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
# 真库影响行数
dbrows() {
  sql_run "$1" | "$PY" -c '
import sys, json
raw = sys.stdin.read()
i = raw.find("{")
if i < 0: print("__ERR__"); raise SystemExit
try: d = json.loads(raw[i:])
except Exception: print("__ERR__"); raise SystemExit
d = d.get("data", d)
print(d.get("AffectedRows"))
'
}

# ===========================================================================
rule
say " 自律计划 · 核心流程自检（六环全链路）"
rule
say "  接口地址 : $BASE"
say "  目标日期 : $D"
say "  生成时间 : $(date '+%F %T')"
say "  证据文件 : $OUT"

if [ -z "$PY" ]; then
  say ""
  say "  ✗ 没找到 python（脚本靠它解析 JSON）—— 请先装 python 再跑。"
  say ""; rule; exit 1
fi

DB_OK=0
if [ -n "$TCB" ] && "$TCB" db execute --json --sql "SELECT 1" >/dev/null 2>&1; then
  DB_OK=1
  say "  真库对照 : 可用（tcb db execute）"
else
  say "  真库对照 : 不可用 —— 标「真库」的项会跳过；先在仓库根跑一次 tcb login 再重来"
fi

# ---------------------------------------------------------------------------
# 基线：跑之前的样子（后面每一环都跟它比）
# ---------------------------------------------------------------------------
sec "基线" "跑之前的样子（后面每一环都跟它比）"

BASE_RAW="$(api_get "/checkins?limit=100")"
BASE_CODE="$(printf '%s' "$BASE_RAW" | jp code)"
TODAY_BASE_RAW="$(api_get "/checkins?date=$D")"
if [ "$BASE_CODE" = "0" ]; then
  TOTAL_BEFORE="$(printf '%s' "$BASE_RAW" | jp data total)"          # 全库总条数（所有日期）
  TODAY_TOTAL_BEFORE="$(printf '%s' "$TODAY_BASE_RAW" | jp data total)"  # 本日条数（④⑥ 跟它比）
  TODAY_BEFORE="$(printf '%s' "$BASE_RAW" | "$PY" -c '
import sys, json
d = json.loads(sys.stdin.read()); today = sys.argv[1]
print(sum(1 for i in d["data"]["items"] if i.get("date") == today))
' "$D")"
  say "  今天($D) 打卡项 : $TODAY_BEFORE 条   ← ④/⑥ 跟这个数比"
  say "  库内总条数(未删) : $TOTAL_BEFORE 条   ← 复原时跟这个数比"
else
  TOTAL_BEFORE=""; TODAY_TOTAL_BEFORE=""; TODAY_BEFORE=""
  skip "基线读不到（接口返回 code=$BASE_CODE）—— 六环大概率会连锁失败，看下面的具体项"
fi

if [ "$DB_OK" = "1" ]; then
  DB_LAST_DAY="$(dbval "SELECT max(date) AS lastday FROM checkins WHERE is_deleted = false" lastday)"
  DB_PLAN_ROWS="$(dbval "SELECT count(*) AS n FROM plan_days" n)"
  DB_MOOD_TODAY="$(dbval "SELECT coalesce(mood, '(未打卡)') AS m FROM plan_days WHERE date = DATE '$D' LIMIT 1" m)"
  say "  真库最后一天 : ${DB_LAST_DAY:-（无数据）}"
  say "  plan_days 行数 : ${DB_PLAN_ROWS:-?} 行；今天的心情：${DB_MOOD_TODAY:-（这一天没有记录）}"
  if [ -n "$DB_LAST_DAY" ] && [ "$DB_LAST_DAY" \< "$D" ]; then
    skip "种子日期落后一天以上（库内最后一天 $DB_LAST_DAY < 今天 $D）"
    tip "这是已知的第 1 号卡点：种子数据锚定在「跑脚本那天」，隔天就脱节。"
    tip "想让首页/检查台有真实数字，先跑一次（幂等）：tcb db execute --sql \"\$(cat habit-tracker/db/seed-shift.sql)\""
    tip "注意：本脚本**不会**替你动种子数据，只报告。"
  fi
fi

# ---------------------------------------------------------------------------
# ① 打开检查台
# ---------------------------------------------------------------------------
sec "① 打开检查台" "页面：「我的」页 → 云端检查台卡片（reload 那一下就是这两个请求）"

H_RAW="$(api_get "/health")"
H_OK="$(printf '%s' "$H_RAW" | jp ok)"
H_SVC="$(printf '%s' "$H_RAW" | jp service)"
tip "GET /api/health → $H_RAW"
if [ "$H_OK" = "true" ] && [ "$H_SVC" = "Self discipline plan" ]; then
  ok "健康检查：绿灯 · 服务名对得上（Self discipline plan）"
else
  no "健康检查：没拿到 {\"ok\":true,\"service\":\"Self discipline plan\"} —— 检查台会是红灯"
  tip "先看这个响应属于哪一类：网络层（连不上）/ 服务端故障（5xx）/ 业务拒绝。"
fi

C_RAW="$(api_get "/checkins?limit=100")"
C_CODE="$(printf '%s' "$C_RAW" | jp code)"
if [ "$C_CODE" = "0" ]; then
  C_TOTAL="$(printf '%s' "$C_RAW" | jp data total)"
  printf '%s' "$C_RAW" | "$PY" -c '
import sys, json
d = json.loads(sys.stdin.read()); items = d["data"]["items"]; today = sys.argv[1]
dates = sorted({i.get("date") for i in items if i.get("date")})
todays = [i for i in items if i.get("date") == today]
print("  %-14s %s" % ("数据最后一天 :", dates[-1] if dates else "（无数据）"))
print("  %-14s %s 条" % ("今天打卡项 :", len(todays)))
print("  %-14s %s 条" % ("库内总条数 :", d["data"]["total"]))
tail = (todays or items)[-3:][::-1]
if tail:
    print("      卡片上会列出的最近几条：")
    for it in tail:
        print("        %s %s%s" % (it.get("date"), (it.get("time") + " ") if it.get("time") else "", it.get("text")))
else:
    print("      卡片会显示：checkins 表里还没有数据")
' "$D" | while IFS= read -r line; do say "$line"; done
  ok "检查台的核心表读取：code=0，四个数字都拿得到"
else
  no "检查台的核心表读取失败：GET /api/checkins?limit=100 返回 code=$C_CODE"
  tip "响应原文：$C_RAW"
fi

# ---------------------------------------------------------------------------
# ② 读取 plan_days / checkins
# ---------------------------------------------------------------------------
sec "② 读取 plan_days/checkins" "页面：首页今日页首屏（一次请求取回两张表的东西）"

DAY_RAW="$(api_get "/day?date=$D")"
DAY_CODE="$(printf '%s' "$DAY_RAW" | jp code)"
DAY_DATE="$(printf '%s' "$DAY_RAW" | jp data date)"
DAY_PLAN="$(printf '%s' "$DAY_RAW" | jp data planDay)"
DAY_N="$(printf '%s' "$DAY_RAW" | "$PY" -c '
import sys, json
try: d = json.loads(sys.stdin.read())
except Exception: print("?"); raise SystemExit
print(len((d.get("data") or {}).get("checkins") or []))
')"
if [ "$DAY_CODE" = "0" ]; then
  say "  GET /api/day?date=$D → date=$DAY_DATE"
  say "    plan_days 部分 : ${DAY_PLAN:-null（这一天还没建过记录 —— 这不是错误）}"
  say "    checkins 部分 : $DAY_N 条"
  if [ "$DAY_N" = "$TODAY_BEFORE" ]; then
    ok "两张表合并读取与列表接口口径一致（都是 $DAY_N 条）"
  else
    no "两张表合并读取($DAY_N 条) 与列表接口($TODAY_BEFORE 条) 对不上"
    tip "两个接口读的是同一批数据，对不上说明其中一个的过滤条件有问题（先查 is_deleted 有没有漏带）。"
  fi
else
  no "GET /api/day?date=$D 失败：code=$DAY_CODE"
  tip "响应原文：$DAY_RAW"
fi

if [ "$DB_OK" = "1" ]; then
  DB_CNT="$(dbval "SELECT count(*) AS n FROM checkins WHERE date = DATE '$D' AND is_deleted = false" n)"
  if [ "$DAY_CODE" = "0" ] && [ "$DB_CNT" = "$DAY_N" ]; then
    ok "真库对照：checkins 里今天未删的行数 = 接口返回条数 = $DB_CNT"
  elif [ "$DAY_CODE" = "0" ]; then
    no "真库对照不一致：库里今天未删 $DB_CNT 行，接口返回 $DAY_N 条"
    tip "差值若正好等于「已删除的行数」，就是读取漏带了 is_deleted = false（见 DEPLOY.md 卡点 10）。"
  else
    skip "真库对照跳过（接口这环没读成功）"
  fi
else
  skip "真库对照跳过（tcb 不可用）"
fi

# ---------------------------------------------------------------------------
# ③ 写入打卡
# ---------------------------------------------------------------------------
sec "③ 写入打卡" "页面：首页加一条待办（或检查台 ?debug=1 的写入按钮）"

NEW_TEXT="$TEXT_PREFIX 自检 $TAG"
POST_BODY="{\"date\":\"$D\",\"text\":\"$NEW_TEXT\",\"time\":null,\"quad\":null,\"clientReqId\":\"$TAG\"}"
P_RAW="$(api_post "/checkins" "$POST_BODY")"
P_CODE="$(printf '%s' "$P_RAW" | jp code)"
NEW_ID="$(printf '%s' "$P_RAW" | jp data id)"
NEW_SORT="$(printf '%s' "$P_RAW" | jp data sort)"
if [ "$P_CODE" = "0" ] && [ -n "$NEW_ID" ]; then
  ok "已写入：id=$NEW_ID  sort=$NEW_SORT  done=$(printf '%s' "$P_RAW" | jp data done)"
  tip "服务端补的字段：uid（取身份）· done（恒 false）· sort（当天最大 sort + 1）"
else
  no "写入失败：code=$P_CODE"
  tip "响应原文：$P_RAW"
  tip "409 = 幂等键重复（这是防护，不是 bug，重跑脚本会换新的幂等键）；400 = 参数被拒；500 = 服务端/数据库。"
fi

if [ -n "$NEW_ID" ]; then
  # 幂等复验：同一个幂等键再发一次，必须被挡住
  IDEM_RAW="$(api_post "/checkins" "$POST_BODY")"
  IDEM_CODE="$(printf '%s' "$IDEM_RAW" | jp code)"
  if [ "$IDEM_CODE" = "409" ]; then
    ok "防重复提交生效：同一幂等键再发一次 → 409「$(printf '%s' "$IDEM_RAW" | jp message)」"
  else
    no "防重复提交没拦住：同一幂等键第二次竟然返回 code=$IDEM_CODE"
    tip "响应原文：$IDEM_RAW"
    tip "要去查两层防护：服务层预检 + checkins_uid_reqid_uniq 唯一索引。"
  fi
fi

if [ "$DB_OK" = "1" ] && [ -n "$NEW_ID" ]; then
  DB_HAS="$(dbval "SELECT count(*) AS n FROM checkins WHERE id = $NEW_ID AND is_deleted = false" n)"
  if [ "$DB_HAS" = "1" ]; then
    ok "真库对照：id=$NEW_ID 这一行真的落库了"
  else
    no "真库对照没找到 id=$NEW_ID（接口说写成功了，库里却没有）"
  fi
fi

# ---------------------------------------------------------------------------
# ④ 刷新确认
# ---------------------------------------------------------------------------
sec "④ 刷新确认" "页面：Ctrl + F5 强刷（刷新后那条还在 = 真的存进了数据库）"

AF_RAW="$(api_get "/checkins?date=$D")"
AF_CODE="$(printf '%s' "$AF_RAW" | jp code)"
AF_TOTAL="$(printf '%s' "$AF_RAW" | jp data total)"
if [ "$AF_CODE" = "0" ] && [ -n "$NEW_ID" ]; then
  FOUND="$(printf '%s' "$AF_RAW" | "$PY" -c '
import sys, json
d = json.loads(sys.stdin.read()); want = int(sys.argv[1])
print("yes" if any(int(i.get("id", -1)) == want for i in d["data"]["items"]) else "no")
' "$NEW_ID")"
  if [ "$FOUND" = "yes" ]; then
    ok "刷新后能读到刚写的那条（id=$NEW_ID）—— 数据是真落库的，不是页面假象"
  else
    no "刷新后读不到刚写的那条（id=$NEW_ID）"
    tip "写入成功但读不回来：先看写接口的「写后读回」日志，再查是不是有别的过滤条件把它挡了。"
  fi
  if [ -n "$TODAY_TOTAL_BEFORE" ] && [ "$AF_TOTAL" = "$((TODAY_TOTAL_BEFORE + 1))" ]; then
    ok "本日条数对得上：$TODAY_TOTAL_BEFORE → $AF_TOTAL（+1）"
  else
    no "本日条数对不上：基线 $TODAY_TOTAL_BEFORE → 现在 $AF_TOTAL（期望 +1）"
  fi
else
  no "刷新确认失败：GET /api/checkins?date=$D 返回 code=$AF_CODE"
  tip "响应原文：$AF_RAW"
fi

# ---------------------------------------------------------------------------
# ⑤ 修改
# ---------------------------------------------------------------------------
sec "⑤ 修改" "页面：点勾选待办（PATCH 只传要改的字段，其余原样不动）"

if [ -n "$NEW_ID" ]; then
  B_TEXT="$(printf '%s' "$P_RAW" | jp data text)"
  B_TIME="$(printf '%s' "$P_RAW" | jp data time)"; B_TIME="${B_TIME:-（未安排）}"
  B_DONE="$(printf '%s' "$P_RAW" | jp data done)"
  B_DONEAT="$(printf '%s' "$P_RAW" | jp data doneAt)"; B_DONEAT="${B_DONEAT:-null}"

  NEW_TEXT2="$TEXT_PREFIX 改过 $TAG"
  U_RAW="$(api_patch "/checkins/$NEW_ID" "{\"text\":\"$NEW_TEXT2\",\"time\":\"21:30\",\"done\":true}")"
  U_CODE="$(printf '%s' "$U_RAW" | jp code)"
  if [ "$U_CODE" = "0" ]; then
    A_TEXT="$(printf '%s' "$U_RAW" | jp data text)"
    A_TIME="$(printf '%s' "$U_RAW" | jp data time)"; A_TIME="${A_TIME:-（未安排）}"
    A_DONE="$(printf '%s' "$U_RAW" | jp data done)"
    A_DONEAT="$(printf '%s' "$U_RAW" | jp data doneAt)"; A_DONEAT="${A_DONEAT:-null}"
    A_QUAD="$(printf '%s' "$U_RAW" | jp data quad)"; A_QUAD="${A_QUAD:-（未分类）}"
    say ""
    say "  ── 改前 → 改后 逐字段对照（截图就截这一段）──"
    say "    [text]      改前：$B_TEXT"
    say "                改后：$A_TEXT"
    say "    [time]      改前：$B_TIME"
    say "                改后：$A_TIME"
    say "    [done]      改前：$B_DONE"
    say "                改后：$A_DONE"
    say "    [doneAt]    改前：$B_DONEAT"
    say "                改后：$A_DONEAT"
    say "    [quad]      改后：$A_QUAD  ← 这次没传，所以原样不动（部分更新的证据）"
    say ""
    if [ "$A_DONE" = "true" ] && [ "$A_DONEAT" != "null" ]; then
      ok "修改生效：done 由假变真，服务端同时写了 done_at（两列必须一致）"
    elif [ "$A_DONE" != "true" ]; then
      no "修改没生效：done 期望 true，实际 $A_DONE"
    fi
    # 再读一次，确认不是只存在于响应里
    CHK_RAW="$(api_get "/checkins?date=$D")"
    CHK_OK="$(printf '%s' "$CHK_RAW" | "$PY" -c '
import sys, json
d = json.loads(sys.stdin.read()); want = int(sys.argv[1])
hit = [i for i in d["data"]["items"] if int(i.get("id", -1)) == want]
print("yes" if (hit and hit[0].get("done") is True and hit[0].get("text") == sys.argv[2]) else "no")
' "$NEW_ID" "$NEW_TEXT2")"
    if [ "$CHK_OK" = "yes" ]; then
      ok "重新读取确认：改动已持久化（不是只存在于那一次响应里）"
    else
      no "重新读取确认失败：改动没持久化"
    fi
    if [ "$DB_OK" = "1" ]; then
      DB_TXT="$(dbval "SELECT text FROM checkins WHERE id = $NEW_ID" text)"
      DB_DONEAT="$(dbval "SELECT (done_at IS NOT NULL) AS h FROM checkins WHERE id = $NEW_ID" h)"
      if [ "$DB_TXT" = "$NEW_TEXT2" ] && [ "$DB_DONEAT" = "true" ]; then
        ok "真库对照：text 已更新、done_at 已写入"
      else
        no "真库对照不一致：text=$DB_TXT · done_at 有没有值=$DB_DONEAT"
      fi
    fi
  else
    no "修改失败：PATCH /api/checkins/$NEW_ID 返回 code=$U_CODE"
    tip "响应原文：$U_RAW"
    tip "409「这一天还没到，先别急着打勾」只会在给**未来日期**打勾时出现 —— 若今天是这条的日期，不该出现。"
  fi
else
  skip "⑤ 修改跳过（③ 没写成功，没有可改的对象）"
fi

# ---------------------------------------------------------------------------
# ⑥ 删除
# ---------------------------------------------------------------------------
sec "⑥ 删除" "页面：删除按钮 + 二次确认（软删除：行还在，只打标记）"

if [ -n "$NEW_ID" ]; then
  D_RAW="$(api_del "/checkins/$NEW_ID")"
  D_CODE="$(printf '%s' "$D_RAW" | jp code)"
  D_ID="$(printf '%s' "$D_RAW" | jp data id)"
  if [ "$D_CODE" = "0" ] && [ "$D_ID" = "$NEW_ID" ]; then
    ok "已删除：$D_RAW"
  else
    no "删除失败：code=$D_CODE"
    tip "响应原文：$D_RAW"
  fi

  GONE_RAW="$(api_get "/checkins?date=$D")"
  GONE="$(printf '%s' "$GONE_RAW" | "$PY" -c '
import sys, json
d = json.loads(sys.stdin.read()); want = int(sys.argv[1])
print("gone" if not any(int(i.get("id", -1)) == want for i in d["data"]["items"]) else "still")
' "$NEW_ID")"
  if [ "$GONE" = "gone" ]; then
    ok "删后 GET 不再返回它（对用户而言效果与真删一致）"
  else
    no "删后 GET 还返回它 —— 读取漏带了 is_deleted 过滤"
  fi

  G_TOTAL="$(printf '%s' "$GONE_RAW" | jp data total)"
  if [ -n "$TODAY_TOTAL_BEFORE" ] && [ "$G_TOTAL" = "$TODAY_TOTAL_BEFORE" ]; then
    ok "本日条数回到基线：$G_TOTAL 条（本日 total 也不含已删行）"
  else
    no "本日条数没回到基线：基线 $TODAY_TOTAL_BEFORE → 现在 $G_TOTAL"
  fi

  AGAIN_RAW="$(api_del "/checkins/$NEW_ID")"
  AGAIN_CODE="$(printf '%s' "$AGAIN_RAW" | jp code)"
  if [ "$AGAIN_CODE" = "404" ]; then
    ok "重复删除返回 404「$(printf '%s' "$AGAIN_RAW" | jp message)」—— 幂等的最终状态语义，前端当「已经没了」处理即可"
  else
    no "重复删除期望 404，实际 code=$AGAIN_CODE"
  fi

  if [ "$DB_OK" = "1" ]; then
    DB_ROW="$(dbval "SELECT count(*) AS n FROM checkins WHERE id = $NEW_ID" n)"
    DB_DEL="$(dbval "SELECT is_deleted FROM checkins WHERE id = $NEW_ID" is_deleted)"
    if [ "$DB_ROW" = "1" ] && [ "$DB_DEL" = "true" ]; then
      ok "真库对照：行**还在**、is_deleted=true —— 这就是「软删除」的硬证据（撤标记就能找回）"
    else
      no "真库对照异常：行数=$DB_ROW · is_deleted=$DB_DEL（期望 1 / true）"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 附加：错误路径抽样（不写库，纯只读探测）
# ---------------------------------------------------------------------------
sec "附加" "错误路径抽样（确认失败时给的是中文人话，而不是英文堆栈）"

E1="$(api_patch "/checkins/abc" '{"text":"探针"}')"
E2="$(api_patch "/checkins/999999999" '{"text":"探针"}')"
E3="$(api_get "/day?date=2026-13-45")"
E4="$(api_del "/checkins/999999999")"
for pair in "非法 id:400:$E1" "不存在的 id:404:$E2" "非法日期:400:$E3" "删不存在的 id:404:$E4"; do
  label="${pair%%:*}"; rest="${pair#*:}"; want="${rest%%:*}"; body="${rest#*:}"
  got="$(printf '%s' "$body" | jp code)"
  msg="$(printf '%s' "$body" | jp message)"
  if [ "$got" = "$want" ]; then
    ok "$label → code=$got「$msg」"
  else
    no "$label → 期望 code=$want，实际 code=$got「$msg」"
  fi
done

# ---------------------------------------------------------------------------
# 复原：把本次造的数据清掉，让终态与跑之前一致
# ---------------------------------------------------------------------------
sec "复原" "清掉本次自检造的数据（默认做；KEEP=1 可跳过）"

if [ "$KEEP" = "1" ]; then
  skip "KEEP=1 —— 本次**不清理**，id=$NEW_ID 与 client_req_id=$TAG 留在库里，请手工处置"
elif [ "$DB_OK" = "1" ]; then
  N1="$(dbrows "DELETE FROM checkins WHERE client_req_id LIKE 'flowcheck-%'")"
  say "  物理删除本次及历史自检行：影响 $N1 行"
  LEFT="$(dbval "SELECT count(*) AS n FROM checkins WHERE is_deleted = false" n)"
  say "  库内未删总条数（现在）: $LEFT 条（基线 $TOTAL_BEFORE 条）"
  if [ "$LEFT" = "$TOTAL_BEFORE" ]; then
    ok "终态与基线一致 —— 自检没有留下痕迹"
  else
    no "终态与基线不一致：$TOTAL_BEFORE → $LEFT"
    tip "看看是不是有别人同时也在写库，或者上次用了 KEEP=1 没清理。"
  fi
else
  skip "tcb 不可用，无法自动清理 —— 请手工执行：DELETE FROM checkins WHERE client_req_id LIKE 'flowcheck-%';"
fi

# ---------------------------------------------------------------------------
# 结论
# ---------------------------------------------------------------------------
say ""
rule
if [ "$FAIL" = "0" ]; then
  say " 结论：六环全通过 ✓   通过 $PASS 项 · 跳过 $SKIPPED 项 · 失败 0 项"
else
  say " 结论：有失败项 ✗     通过 $PASS 项 · 跳过 $SKIPPED 项 · 失败 $FAIL 项"
  say " 处理顺序：先把上面标 ✗ 的行抄进 FLOW-TEST.md §四 的问题反馈格式，"
  say "           再按 §五 的诊断协议逐条走（原因排序 → 验证 → 修复 → 回归）。"
fi
rule
say " 证据文件：$OUT"
say ""

if [ "$FAIL" = "0" ]; then exit 0; else exit 1; fi
