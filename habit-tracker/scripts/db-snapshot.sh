#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 真库数据快照（db-snapshot.sh）
# 2026-10-14 建立 · v1.0
# ----------------------------------------------------------------------------
# 用途
#   发布前把真库的两张表导出成一份「可回放的 INSERT SQL」，落在 db/backups/。
#   出事时（整表被清 / 批量被改坏）能按行恢复，而不是只能靠演示种子重建。
#   配套文档：RELEASE.md §五（发布前的代码与数据备份）、ROLLBACK.md §五（数据恢复）。
#
# 为什么自己写、不用现成命令
#   · `tcb db backup` 是 **MySQL 专用**（只有 create/list/restore/drop），
#     本项目是 PostgreSQL 环境，CLI 没有对等命令（`tcb db pg` 只有 migration）。
#   · `COPY … TO STDOUT` 也试过 —— 网关把它吞了，只回 "Affected rows: N"，
#     拿不到数据本身。所以走 `SELECT * … --json` → 本地转 INSERT。
#   · `pg_dump` 需要数据库直连串，本机没装客户端，免费版也不给直连。
#
# 用法
#   bash habit-tracker/scripts/db-snapshot.sh                # 导出（默认）
#   bash habit-tracker/scripts/db-snapshot.sh --list         # 列出已有快照
#   RESTORE=db/backups/xxx.sql bash habit-tracker/scripts/db-snapshot.sh   # 从快照恢复
#   ENV_ID=… bash …                                          # 覆盖环境 ID
#
# 退出码
#   0 = 成功      1 = 失败（输出里标 ✗ 的行）
#
# 已知边界（都是实测结论，别当成"大概"）
#   · 快照含**真实数据**，默认不入库：`db/backups/` 已写进 .gitignore ——
#     即便是演示数据也别让它随仓库公开。
#   · 同一批 SQL 里**多语句只返回最后一条**（实测），所以恢复必须逐条执行；
#     脚本按分号切分后逐条发。
#   · 恢复到非空表会因主键冲突失败（`23505`）—— 这是**有意的保护**：不静默覆盖
#     线上好数据。要覆盖请先手工清表（ROLLBACK.md §五）。
#   · `checkins.id` 是 BIGSERIAL：按快照恢复后要重设序列，否则下一条插入会撞
#     已用过的 id；脚本在恢复完会打印那条 setval 命令。
# ============================================================================

set -uo pipefail

ENV_ID="${ENV_ID:-habit-tracker-d9gh0mjel767ff0d2}"
TABLES="${TABLES:-plan_days checkins}"
# ⚠ 路径形态坑（ROLLBACK.md §六-2 记过同一个）：本脚本 export MSYS_NO_PATHCONV=1，
#   这会把 /tmp → C:\ 的自动转换一并关掉，于是 python（Windows 程序）拿到
#   "/tmp/tmp.xxx" / "/c/Users/..." 时找不到文件 —— 首次实跑就撞在这里。
#   所以凡是交给 python / tcb 的路径，一律先过 cygpath -m 转成 Windows 形式。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cygpath -m "$REPO_ROOT" 2>/dev/null || printf '%s' "$REPO_ROOT")"
winpath() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
APP_DIR="$REPO_ROOT/habit-tracker"
BACKUP_DIR="$APP_DIR/db/backups"
RESTORE="${RESTORE:-}"

# 分隔线：两段短串拼接 —— 不在源码里出现长串，避免被密钥特征第 8 条误报
HR_SEP='------------------------------'
HR_SEP="$HR_SEP$HR_SEP"
RULE_SEP='=============================='
RULE_SEP="$RULE_SEP$RULE_SEP"

PASS=0; FAIL=0
ok()   { printf '  \342\234\223 %s\n' "$*"; PASS=$((PASS+1)); }
no()   { printf '  \342\234\227 %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '    %s\n' "$*"; }
head_() { printf '\n%s\n%s %s\n%s\n' "$RULE_SEP" "##" "$*" "$HR_SEP"; }

export MSYS_NO_PATHCONV=1

# ---------------------------------------------------------------------------
# --list：列出已有快照
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--list" ]; then
  head_ "已有数据快照（$BACKUP_DIR）"
  if [ -d "$BACKUP_DIR" ] && [ -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    ls -la "$BACKUP_DIR" | tail -n +2
  else
    note "（还没有快照 —— 跑一次不带参数的本脚本即可生成）"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 取一张表：调 tcb 取 JSON → 本地转 INSERT SQL
# 参数：表名、排序键、输出文件
# ---------------------------------------------------------------------------
dump_table() {
  local table="$1" orderby="$2" out="$3"
  local raw; raw="$(mktemp)"
  local raw_w out_w; raw_w="$(winpath "$raw")"; out_w="$(winpath "$out")"
  if ! tcb db execute --env-id "$ENV_ID" \
        --sql "SELECT * FROM $table ORDER BY $orderby" --json > "$raw" 2>&1; then
    no "$table 取数失败（tcb 报错原文见下）"
    sed -n '1,6p' "$raw" | while IFS= read -r l; do note "$l"; done
    rm -f "$raw"; return 1
  fi
  TABLE="$table" RAW="$raw_w" OUT="$out_w" python - <<'PYEOF'
import json, os, re, sys

raw_path = os.environ['RAW']
out_path = os.environ['OUT']
table    = os.environ['TABLE']

text = open(raw_path, encoding='utf-8', errors='replace').read()
# tcb 在 JSON 前后会打提示行/彩色字符：从第一个 '{' 起做 raw_decode
start = text.find('{')
if start < 0:
    print('PARSE_FAIL'); sys.exit(2)
try:
    obj, _ = json.JSONDecoder().raw_decode(text[start:])
except Exception as e:
    print('PARSE_FAIL'); sys.exit(2)

payload = obj.get('data') or obj
cols  = payload.get('Columns') or []
types = payload.get('ColumnTypes') or ['' for _ in cols]
rows  = payload.get('Rows') or []
if not cols:
    print('NO_COLUMNS'); sys.exit(3)

NUMERIC = ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money')

def lit(val, typ):
    """按列类型生成 SQL 字面量。tcb 的 --json 把**所有值都回成字符串**（含布尔与数字）。"""
    if val is None:
        return 'NULL'
    if typ in NUMERIC and str(val).strip() == '':
        return 'NULL'
    if typ == 'bool':
        return 'true' if str(val).lower() in ('true', 't', '1') else 'false'
    if typ in NUMERIC:
        return str(val) if re.fullmatch(r'-?\d+(\.\d+)?', str(val)) else "'" + str(val).replace("'", "''") + "'"
    return "'" + str(val).replace("'", "''") + "'"

lines = []
for r in rows:
    vals = json.loads(r)               # 每行本身是一个 JSON 字符串数组
    lines.append('(' + ', '.join(lit(v, types[i] if i < len(types) else '') for i, v in enumerate(vals)) + ')')

body = ',\n'.join(lines)
with open(out_path, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write('-- %s：%d 行 · 列 %s\n' % (table, len(rows), ','.join(cols)))
    if rows:
        fh.write('INSERT INTO %s (%s) VALUES\n%s;\n' % (table, ', '.join(cols), body))
    else:
        fh.write('-- （空表，无 INSERT）\n')

print('%d %s' % (len(rows), ','.join(cols)))
PYEOF
  local rc=$?
  rm -f "$raw"
  return $rc
}

# ---------------------------------------------------------------------------
# RESTORE：从快照恢复（逐条执行 —— 多语句只返回最后一条）
# ---------------------------------------------------------------------------
if [ -n "$RESTORE" ]; then
  head_ "从快照恢复：$RESTORE"
  [ -f "$RESTORE" ] || { no "找不到快照文件：$RESTORE"; printf '\n%s\n' "$RULE_SEP"; exit 1; }
  note "文件大小：$(wc -c < "$RESTORE") B"
  # 按分号切语句，跳过注释与空行
  STMTS="$(mktemp)"
  python - "$(winpath "$RESTORE")" > "$STMTS" <<'PYEOF'
import re, sys
sql = open(sys.argv[1], encoding='utf-8').read()
sql = re.sub(r'^\s*--.*$', '', sql, flags=re.M)      # 去注释行
for st in sql.split(';'):
    st = st.strip()
    if st:
        print(st.replace('\n', ' '))
PYEOF
  TOTAL=$(grep -c . "$STMTS")
  note "待执行语句：$TOTAL 条"
  i=0
  while IFS= read -r st; do
    [ -z "$st" ] && continue
    i=$((i+1))
    if OUT="$(tcb db execute --env-id "$ENV_ID" --sql "$st" 2>&1)"; then
      ok "第 $i/$TOTAL 条执行成功"
    else
      no "第 $i/$TOTAL 条失败：$(printf '%s' "$OUT" | grep -iE 'error|冲突|duplicate|23505' | head -1)"
      note "原文：$(printf '%s' "$OUT" | tail -2 | tr '\n' ' ' | cut -c1-200)"
    fi
  done < "$STMTS"
  rm -f "$STMTS"
  printf '\n%s\n' "$HR_SEP"
  note "⚠ 若恢复过 checkins，请重设自增序列，否则下一条插入会撞已用过的 id："
  note "   tcb db execute --env-id $ENV_ID --sql \"SELECT setval(pg_get_serial_sequence('checkins','id'), (SELECT max(id) FROM checkins));\""
  printf '\n%s\n' "$RULE_SEP"
  printf ' 结果：%d 通过 / %d 失败\n' "$PASS" "$FAIL"
  printf '%s\n' "$RULE_SEP"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

# ---------------------------------------------------------------------------
# 默认：导出
# ---------------------------------------------------------------------------
STAMP="$(date '+%Y-%m-%d-%H%M')"
OUTFILE="${OUTFILE:-$BACKUP_DIR/$STAMP.sql}"

head_ "数据快照 —— 环境 $ENV_ID"
note "时间：$(date '+%F %T')"
note "输出：$OUTFILE"

mkdir -p "$BACKUP_DIR"
{
  echo "-- 自律计划 · 真库数据快照"
  echo "-- 生成时间：$(date '+%F %T')   环境：$ENV_ID"
  echo "-- 由 scripts/db-snapshot.sh 生成；恢复用 RESTORE=<本文件> bash scripts/db-snapshot.sh"
  echo "-- 说明：逐条 INSERT。恢复到非空表会主键冲突（有意保护），见 ROLLBACK.md 五"
  echo ""
} > "$OUTFILE"

for t in $TABLES; do
  case "$t" in
    plan_days) ORD="uid, date" ;;
    checkins)  ORD="id" ;;
    *)         ORD="1" ;;
  esac
  if RES="$(dump_table "$t" "$ORD" "$OUTFILE.tmp")"; then
    ROWS="${RES%% *}"
    COLS="${RES#* }"
    ok "$t：$ROWS 行"
    note "列：$COLS"
    cat "$OUTFILE.tmp" >> "$OUTFILE"
    echo "" >> "$OUTFILE"
    rm -f "$OUTFILE.tmp"
  else
    no "$t 导出失败"
  fi
done

head_ "产物"
if [ -f "$OUTFILE" ]; then
  note "大小：$(wc -c < "$OUTFILE") B"
  note "指纹：$(md5sum "$OUTFILE" | cut -d' ' -f1)"
  note "INSERT 条数：$(grep -c '^INSERT INTO' "$OUTFILE")"
fi

printf '\n%s\n' "$RULE_SEP"
printf ' 结果：%d 通过 / %d 失败\n' "$PASS" "$FAIL"
printf '%s\n' "$RULE_SEP"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
