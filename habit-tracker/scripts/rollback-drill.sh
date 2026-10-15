#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 静态托管回滚演练（2026-10-13 Day 26 建立 · 2026-10-14 修正锚点默认值与前提守卫）
# ----------------------------------------------------------------------------
# 用途
#   真实走一遍「线上出事 → 回退到上一版 → 验证 → 恢复当前版本 → 验证」的完整
#   演练，每一步计时并落证据文件。ROLLBACK.md 记录的是手册，本脚本就是把
#   手册里那套命令跑给人看 —— **耗时数据来自真跑，不是估的**。
#   演练记录格式见 ROLLBACK.md §七；填好的实例见 releases/v1.0-rollback-drill-record.md。
#
# 背景：为什么回退 = 重新部署
#   `tcb hosting deploy` 官方说明是 "no version management" —— 静态托管
#   没有版本列表、没有「回上一版」按钮。可回退的唯一锚点是 Git：
#   提交历史里存着每一版前端产物的原始字节，回退 = 把历史那一版重新部署。
#
# 用法
#   bash habit-tracker/scripts/rollback-drill.sh                # 锚点默认 = 最新 tag 的父提交
#   bash habit-tracker/scripts/rollback-drill.sh drill.txt      # 指定证据文件
#   PREV=4bdc079 bash …                                        # 指定回退锚点（更早的提交）
#   SITE=… REPO=… bash …                                       # 覆盖站点地址 / 仓库根
#
# 退出码
#   0 = 四幕全过（回退生效且恢复完整）；1 = 有失败项（输出里标 ✗ 的行）
#
# 三条安全设计
#   1) **只动托管、不动仓库**：上一版产物取自 `git show`（原始字节），落在
#      临时目录，全程不 checkout、不碰工作区 —— 跑完仓库与跑前一模一样。
#   2) **每一步都验指纹**：部署不是「跑了就算」，前后都用 curl 抓线上
#      index.html 的 md5 与本地/历史产物比对，防止"部署了但 CDN 没换"。
#      （测过 `grep -q $'\r'` 判行尾会误报，这里统一用 md5 + 字节数双口径。）
#   3) **前提守卫**：【〇】段先比"锚点产物 vs 当前版本产物"，两者相同就当场
#      失败退出（不做任何部署）—— 否则会跑出一份"看起来全绿其实什么都没验证"
#      的记录。见下方 PREV 默认值的注释。
#
# 已知边界（详见 ROLLBACK.md §六）
#   - 演练期间线上短暂处于「上一版」，约 10~20 秒；不要挑有人正在用的时候跑。
#   - 云函数与数据库**完全不参与**本脚本（云函数回退见 ROLLBACK.md §四，未演练）。
# ============================================================================

set -u

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"   # 仓库根（scripts/ 的上两级）
ENV_ID="${ENV_ID:-habit-tracker-d9gh0mjel767ff0d2}"
SITE="${SITE:-https://$ENV_ID-1499348397.tcloudbaseapp.com}"
# 回退锚点（上一版提交）：默认 = **最新版本 tag 的父提交**，不是 HEAD。
#   ⚠ 2026-10-14 实测修正：原来默认 HEAD。发布当天 HEAD 还停在"上一版"，没问题；
#     可一旦发布提交进了历史，HEAD 就**等于已发布的这一版** —— 于是"回退"部署的是
#     同一份产物，版本标识不会消失，演练变成"退了个寂寞"，还差点让【二】的
#     指纹比对打出一个虚假的 ✓（两边 md5 本来一样）。见【〇】段的守卫。
CUR_TAG="${CUR_TAG:-$(git -C "$REPO" tag -l 'v[0-9]*' 2>/dev/null | sort -V | tail -1)}"
PREV="${PREV:-${CUR_TAG:+$CUR_TAG^}}"
PREV="${PREV:-HEAD^}"
OUT="${1:-rollback-drill-$(date +%F-%H%M).txt}"
FE_DIR="habit-tracker/frontend"

PASS=0; FAIL=0

say() { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$OUT"; }
rule() { say "============================================================"; }
HR_SEP='----------------------------'
HR_SEP="$HR_SEP$HR_SEP"
sec()  { say ""; say "【$1】$2"; say "$HR_SEP"; }
ok()   { PASS=$((PASS+1)); say "  ✓ $1"; }
no()   { FAIL=$((FAIL+1)); say "  ✗ $1"; }
note() { say "      ↳ $1"; }

# 秒级计时：t_now <名字>
T0=0
t_start() { T0=$(date +%s); }
t_stop()  { local d=$(( $(date +%s) - T0 )); say "  ⏱ $1 耗时 ${d}s"; echo "$d" >> "$OUT.time"; }

live_md5()  { curl -s -H "Cache-Control: no-cache" "$SITE/" | md5sum | cut -d' ' -f1; }
live_size() { curl -s -H "Cache-Control: no-cache" "$SITE/" | wc -c; }
live_has()  { curl -s -H "Cache-Control: no-cache" "$SITE/" | grep -q "$1"; }

deploy() {  # deploy <本地目录> —— 目录必须是 Windows 形式的路径（见下 STAGE_WIN）
  local out
  out="$(MSYS_NO_PATHCONV=1 tcb hosting deploy "$1" --env-id "$ENV_ID" 2>&1)"
  if printf '%s' "$out" | grep -q "index.html"; then
    say "  ↳ 部署清单含 index.html（上传成功）"
  else
    say "  ↳ 部署输出（未见到 index.html，疑似失败）："
    printf '%s\n' "$out" | tail -8 >> "$OUT"
    tail -8 <<< "$out"
  fi
}

: > "$OUT"; : > "$OUT.time"
cd "$REPO" || { echo "找不到仓库根：$REPO"; exit 1; }

say " 自律计划 · 静态托管回滚演练"
say " 站点：$SITE"
say " 当前正式版：${CUR_TAG:-（没有版本 tag，按工作区算）}"
say " 回退锚点：$PREV（$(git rev-parse --short "$PREV" 2>/dev/null || echo '取不到')）"
say " 时间：$(date '+%F %T')"

# ---------------------------------------------------------------------------
sec "〇" "基线 —— 线上现在是谁？"
LOCAL_MD5="$(md5sum "$FE_DIR/index.html" | cut -d' ' -f1)"
LOCAL_SZ="$(wc -c < "$FE_DIR/index.html")"
LM="$(live_md5)"; LS="$(live_size)"
if [ "$LM" = "$LOCAL_MD5" ]; then
  ok "线上 = 本地工作区（v1.0）：md5 $LM · ${LS}B"
else
  no "线上（md5 $LM · ${LS}B）≠ 本地工作区（md5 $LOCAL_MD5 · ${LOCAL_SZ}B）—— 工作区有未部署的改动？"
fi
if live_has "app-ver"; then ok "线上含 v1.0 版本标识（app-ver）"; else no "线上没有 v1.0 标识 —— 基线就不是 v1.0，演练前提不成立"; fi
PREV_MD5="$(git show "$PREV:$FE_DIR/index.html" | md5sum | cut -d' ' -f1)"
PREV_SZ="$(git show "$PREV:$FE_DIR/index.html" | wc -c)"
note "上一版指纹：md5 $PREV_MD5 · ${PREV_SZ}B（来自 git show，原始字节）"

# 前提守卫（2026-10-14 加）：锚点产物若与当前版本**完全一样**，这场演练就没有
#   可观测的差异 —— 退回去和退回来长得一模一样，指纹比对还会打出虚假的 ✓。
#   宁可当场失败，也不要跑出一份"看起来全绿其实什么都没验证"的记录。
if [ "$PREV_MD5" = "$LOCAL_MD5" ]; then
  no "回退锚点（$PREV）的产物与当前版本【完全相同】—— 演练前提不成立"
  note "锚点指纹 md5 $PREV_MD5 = 当前版本指纹，退回等于没退，无法证明回退生效"
  note "改法：指定一个更早、产物确实不同的锚点，例如"
  note "      PREV=<更早的提交> bash habit-tracker/scripts/rollback-drill.sh"
  say ""
  say "  结论：演练未开始（前提不成立），**没有做任何部署**，线上未被触碰。"
  exit 1
fi

# ---------------------------------------------------------------------------
sec "一" "回退 —— 部署上一版产物"
STAGE="$(mktemp -d)"
# ⚠ 路径形态坑（Day 26 实测）：MSYS_NO_PATHCONV=1 会连 /tmp/... 的自动转换一起关掉，
# tcb（Windows 程序）会拿到不存在的 C:\tmp\... → 静默失败。所以传给 deploy 的
# 一律是 cygpath -m 出来的 Windows 形式（C:/Users/...）；仓库内相对路径不受影响。
STAGE_WIN="$(cygpath -m "$STAGE")"
git show "$PREV:$FE_DIR/index.html" > "$STAGE/index.html"     # git show = 原始字节；git archive 会被 autocrlf 改写行尾（踩过）
git archive "$PREV" "$FE_DIR/assets" | tar -x --strip-components=2 -C "$STAGE"
SM="$(md5sum "$STAGE/index.html" | cut -d' ' -f1)"
if [ "$SM" = "$PREV_MD5" ]; then
  ok "暂存目录与历史提交指纹一致（防 CRLF 漂移）"
else
  no "暂存目录 md5 $SM ≠ 历史指纹 $PREV_MD5 —— 行尾被改写了，终止"; say "$OUT 证据见 $OUT"; exit 1
fi
t_start
DEPLOY_OUT="$(deploy "$STAGE_WIN")"
t_stop "部署上一版"
say "$DEPLOY_OUT"

# ---------------------------------------------------------------------------
sec "二" "回退验证 —— 线上真的变回上一版了吗？"
RM="$(live_md5)"; RS="$(live_size)"
if [ "$RM" = "$PREV_MD5" ] && [ "$RS" = "$PREV_SZ" ]; then
  ok "线上指纹 = 上一版：md5 $RM · ${RS}B"
else
  no "线上（md5 $RM · ${RS}B）≠ 上一版（md5 $PREV_MD5 · ${PREV_SZ}B）—— CDN 未刷新或部署失败"
fi
if live_has "app-ver"; then
  no "线上仍含 v1.0 标识 —— 回退没有生效"
else
  ok "v1.0 标识已消失（肉眼可见的回退证据）"
fi

# ---------------------------------------------------------------------------
sec "三" "恢复 —— 重新部署 v1.0（工作区产物）"
t_start
DEPLOY_OUT="$(deploy "$FE_DIR")"
t_stop "部署 v1.0"
say "$DEPLOY_OUT"
FM="$(live_md5)"; FS="$(live_size)"
if [ "$FM" = "$LOCAL_MD5" ] && [ "$FS" = "$LOCAL_SZ" ]; then
  ok "线上指纹恢复 = v1.0：md5 $FM · ${FS}B"
else
  no "线上（md5 $FM · ${FS}B）≠ v1.0（md5 $LOCAL_MD5 · ${LOCAL_SZ}B）"
fi
if live_has "app-ver"; then ok "v1.0 标识已回来"; else no "v1.0 标识没回来 —— 恢复不完整"; fi
FC="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/assets/favicon.png")"
if [ "$FC" = "200" ]; then ok "静态资源抽查 favicon.png = 200"; else no "favicon.png = $FC"; fi

# ---------------------------------------------------------------------------
rm -rf "$STAGE"
TOTAL="$(awk '{s+=$1} END{print s}' "$OUT.time")"
sec "四" "结论"
say "  回退部署 + 恢复部署合计耗时：${TOTAL}s（单次部署约 $((TOTAL/2))s）"
say "  通过 $PASS / 失败 $FAIL"
if [ "$FAIL" -eq 0 ]; then
  say ""; say "  结论：演练成功 —— 这套回退流程真实可用，且耗时在 1 分钟内。"
  say "  证据文件：$OUT"
  exit 0
else
  say ""; say "  结论：演练有失败项（✗），先按 ROLLBACK.md §六（已知边界与踩坑）排查再重跑。"
  exit 1
fi
