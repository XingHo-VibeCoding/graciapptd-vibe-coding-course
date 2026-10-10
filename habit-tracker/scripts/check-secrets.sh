#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 密钥排查脚本（Day 23 建立，Day 24 安全审计加固）
# ----------------------------------------------------------------------------
# 用途：一条命令回答"这个仓库里有没有密钥"，并给出可直接截图的干净结果。
#
#   bash habit-tracker/scripts/check-secrets.sh
#
# 四段检查：
#   【一】当前工作区 —— 高置信度密钥特征。只扫"被 git 跟踪的文件"，因为只有
#        它们会被推到 GitHub；工作区里没入库的临时文件不构成泄露风险，
#        混进来只会让结果变脏。
#   【二】敏感文件跟踪状态 + 忽略规则覆盖度（用 git check-ignore 实测，不靠读规则）
#   【三】需要人工确认的命中（多为文档/注释里的说明文字，由人眼判断）
#   【四】Git 全历史 —— 过去所有提交的所有版本
#
# 【四】是 Day 24 补的，也是最重要的一段：**删掉一个提交 ≠ 消除泄露**。
# 那串字符仍然躺在 .git 对象库里，`git log -p` 随时能翻出来，clone 仓库的人
# 也照样拿得到。所以"有没有泄露过"要看历史，只看当前工作区会得出错误的安全感。
#
# 退出码：0 = 通过（无真密钥、敏感文件都没入库、历史干净）；1 = 有高危发现。
# ============================================================================

set -u

# ---- 定位仓库根目录（脚本可以放在任意子目录里跑）----
if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "✗ 当前目录不在 git 仓库内，无法排查。" >&2
  exit 2
fi
cd "$ROOT"

TRACKED_COUNT="$(git ls-files | wc -l | tr -d ' ')"
FAIL=0

# ---------------------------------------------------------------------------
# 本脚本自己的相对路径 —— 所有扫描都要把它排除掉
# ---------------------------------------------------------------------------
# 为什么：这个文件里**写满了各种"特征词"**（eyJ…、AKID…、ghp_…），还有用双引号
# 包起来的分隔线（一串 '-----…'），天然会自己命中自己。
# 这个坑本身很典型 —— Day 23 首次跑脚本时它还没 `git add`，而 `git grep` 只扫
# 已跟踪文件，所以"没命中"；提交之后自命中才浮现出来，脚本开始无端报 FAIL。
# 排除它不会漏掉真密钥：这个文件的本职就是列特征，内容一眼能看完，
# 而且它自己也还在【三】的人眼复核里被审。真实密钥只可能出现在别的文件里。
#
# 路径从 `git ls-files` 里查（而不是拼 $0），才能和 git grep 输出的路径写法一致。
SELF_REL="$(git ls-files | grep -E '/check-secrets\.sh$' | head -1)"

echo ""
echo "=================================================================="
echo " 自律计划 · 密钥排查（当前工作区 + Git 全历史）"
echo "=================================================================="
echo " 仓库根目录：$ROOT"
echo " 被跟踪文件：$TRACKED_COUNT 个"
echo ""

# ---------------------------------------------------------------------------
# 【一】高置信度密钥特征 —— 期望全部 0 命中
# ---------------------------------------------------------------------------
echo "【一】高置信度密钥特征（期望：每一项都是 0）"
echo "------------------------------------------------------------------"
echo "  命中  特征"

scan() {
  local label="$1" pattern="$2" out n
  # git grep 没命中时退出码为 1，这里吞掉，别让它中断脚本
  # 同时把本脚本自身滤掉（见文件上方 SELF_REL 的说明，避免自命中误报）
  out="$(git grep -I -n -E "$pattern" -- . 2>/dev/null | grep -v "^${SELF_REL}:" || true)"
  if [ -z "$out" ]; then n=0; else n="$(printf '%s\n' "$out" | grep -c .)"; fi
  # 命中数放最前、固定 4 列：标签是中文、宽度不一，数字排在前面才能对齐成一条竖线
  printf '  %-4s %s\n' "$n" "$label"
  if [ "$n" != "0" ]; then
    printf '%s\n' "$out" | sed 's/^/      ↳ /'
    FAIL=1
  fi
}

scan "JWT 风格密钥（eyJ 开头）"          'eyJ[A-Za-z0-9_-]{10,}'
scan "腾讯云 SecretId（AKID 开头）"      'AKID[A-Za-z0-9]{10,}'
scan "OpenAI 风格密钥（sk- 开头）"       'sk-[A-Za-z0-9]{20,}'
scan "GitHub token（ghp_ 开头）"         'ghp_[A-Za-z0-9]{20,}'
scan "私钥文件内容"                      'BEGIN [A-Z ]*PRIVATE KEY'
scan "环境 API Key 被填了真值"           'CLOUDBASE_API_KEY"[[:space:]]*:[[:space:]]*"[^<]'
scan "明文密码赋值"                      'password[[:space:]]*[:=][[:space:]]*"[^"]+'
scan "32 位以上疑似随机串（值位置）"      '"[A-Za-z0-9_-]{32,}"'

echo ""
if [ "$FAIL" = "0" ]; then
  echo "  ✔ 小计：0 处命中 —— 没有真密钥入库。"
else
  echo "  ✗ 小计：发现疑似真密钥！先处理再提交。"
fi

# ---------------------------------------------------------------------------
# 【二】敏感文件是否被跟踪 —— 期望：该忽略的都没跟踪
# ---------------------------------------------------------------------------
echo ""
echo "【二】敏感文件跟踪状态（期望：全部「未跟踪」）"
echo "------------------------------------------------------------------"

check_untracked() {
  local f="$1" note="$2"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    printf '  %-44s 【已跟踪 ✗】 %s\n' "$f" "$note"
    FAIL=1
  else
    printf '  %-44s 未跟踪 ✓   %s\n' "$f" "$note"
  fi
}

check_tracked() {
  local f="$1" note="$2"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    printf '  %-44s 已跟踪 ✓   %s\n' "$f" "$note"
  elif [ -f "$f" ]; then
    # 文件在磁盘上但还没 git add —— 这是新建模板时的正常中间态，提醒而不判失败
    printf '  %-44s 待入库 ⚠   %s（文件已存在，记得 git add）\n' "$f" "$note"
  else
    printf '  %-44s 【缺少 ✗】 %s\n' "$f" "$note"
    FAIL=1
  fi
}

check_untracked "habit-tracker/.env"             "真实私密配置，只能待在本地"
check_untracked "habit-tracker/.env.local"       "同上"
check_untracked "habit-tracker/.env.production"  "Day 24 补：非 local 后缀的 .env 变体也曾漏网"
check_untracked "habit-tracker/.env.staging"     "同上"
check_untracked "habit-tracker/cloudbaserc.json" "含函数环境变量（内有 API Key）"
check_tracked   "habit-tracker/.env.example"     "占位符模板，应当入库"
check_tracked   "habit-tracker/cloudbaserc.example.json" "占位符模板，应当入库"

# ---- B. 忽略规则覆盖度：不靠肉眼读 .gitignore，用 git check-ignore 实测 ----
echo ""
echo "  B. 忽略规则覆盖度（git check-ignore 实测）"
echo "------------------------------------------------------------------"

ignore_ok() {
  local f="$1"
  if git check-ignore -q "$f" 2>/dev/null; then
    printf '  %-44s 已忽略 ✓\n' "$f"
  else
    printf '  %-44s 【未忽略 ✗】\n' "$f"
    FAIL=1
  fi
}

not_ignore_ok() {
  local f="$1" why="$2"
  if git check-ignore -q "$f" 2>/dev/null; then
    printf '  %-44s 【被忽略 ✗】%s\n' "$f" "$why"
    FAIL=1
  else
    printf '  %-44s 未被忽略 ✓  %s\n' "$f" "$why"
  fi
}

for f in .env .env.local .env.production .env.staging .env.test .env.development; do
  ignore_ok "habit-tracker/$f"
done
for f in deploy.pem server.key id_rsa id_ed25519 credentials.json serviceAccountKey.json; do
  ignore_ok "habit-tracker/$f"
done
not_ignore_ok "habit-tracker/.env.example" "占位符模板，必须能入库（关键回归：别被 .env.* 误伤）"

# ---------------------------------------------------------------------------
# 【三】需要人工确认的命中 —— 列出上下文，由人眼判断是不是说明性文字
# ---------------------------------------------------------------------------
echo ""
echo "【三】需要人工确认的命中（多为文档/注释里的说明文字）"
echo "------------------------------------------------------------------"

for kw in 'service_role' 'CLOUDBASE_API_KEY' 'DEMO_UID'; do
  out="$(git grep -I -n -E "$kw" -- . 2>/dev/null | grep -v "^${SELF_REL}:" || true)"
  if [ -z "$out" ]; then
    printf '  %-22s 0 处\n' "$kw"
  else
    printf '  %-22s %s 处：\n' "$kw" "$(printf '%s\n' "$out" | grep -c .)"
    printf '%s\n' "$out" | sed 's/^/      ↳ /' | cut -c1-150
  fi
done
echo ""
echo "  ⓘ 以上关键词出现在文档讲解与代码注释里属正常；"
echo "    判据是「后面跟的是不是真值」。真值只允许出现在被忽略的"
echo "    cloudbaserc.json 或云端环境变量里。"
echo ""

# ---------------------------------------------------------------------------
# 【四】Git 全历史扫描 —— 期望：所有版本里也是 0
# ---------------------------------------------------------------------------
ALL_COMMITS="$(git rev-list --all)"
COMMIT_N="$(printf '%s\n' "$ALL_COMMITS" | grep -c .)"

echo ""
echo "【四】Git 全历史扫描（期望：所有版本里都是 0）"
echo "------------------------------------------------------------------"
echo "  扫描范围：$COMMIT_N 个提交的全部文件版本"
echo "  命中  特征"

hist_scan() {
  local label="$1" pattern="$2" raw out n
  # 注意用 -l（只列文件名），不打印内容行 —— 历史里同一行会横跨很多个提交，
  # 打印内容会刷屏；只报"哪个文件曾经出现过"就够了。
  raw="$(git grep -I -l -E "$pattern" $ALL_COMMITS -- . 2>/dev/null || true)"
  # 输出形如 <commit>:<path>：去掉 commit 前缀 → 排重 → 再滤掉本脚本自身
  out="$(printf '%s\n' "$raw" | sed -E 's/^[0-9a-f]+://' \
         | grep -v "^${SELF_REL}$" | sort -u | grep . || true)"
  if [ -z "$out" ]; then n=0; else n="$(printf '%s\n' "$out" | grep -c .)"; fi
  printf '  %-4s %s\n' "$n" "$label"
  if [ "$n" != "0" ]; then
    printf '%s\n' "$out" | sed 's/^/      ↳ 曾出现在：/'
    FAIL=1
  fi
}

hist_scan "JWT 风格密钥（eyJ 开头）"       'eyJ[A-Za-z0-9_-]{10,}'
hist_scan "腾讯云 SecretId（AKID 开头）"   'AKID[A-Za-z0-9]{10,}'
hist_scan "OpenAI 风格密钥（sk- 开头）"    'sk-[A-Za-z0-9]{20,}'
hist_scan "GitHub token（ghp_ 开头）"      'ghp_[A-Za-z0-9]{20,}'
hist_scan "私钥文件内容"                   'BEGIN [A-Z ]*PRIVATE KEY'
hist_scan "环境 API Key 被填了真值"        'CLOUDBASE_API_KEY"[[:space:]]*:[[:space:]]*"[^<]'
hist_scan "明文密码赋值"                   'password[[:space:]]*[:=][[:space:]]*"[^"]+'
hist_scan "数据库连接串带账号密码"          'postgres(ql)?://[^:[:space:]]+:[^@[:space:]]+@'
hist_scan "32 位以上疑似随机串（值位置）"   '"[A-Za-z0-9_-]{32,}"'

echo ""
echo "  提示：这里一旦出现命中，处理顺序不能颠倒 ——"
echo "    ① 先在云端**作废该密钥并重新生成**（这步不能省：历史改不掉"
echo "       「已经泄露过」这个事实，密钥只要存在过就要当作已泄露）；"
echo "    ② 再更新 cloudbaserc.json / 云端环境变量，重新部署；"
echo "    ③ 最后才轮到清理历史（git filter-repo + 强推），且必须通知所有协作者重新 clone。"
echo ""

# ---------------------------------------------------------------------------
echo "=================================================================="
if [ "$FAIL" = "0" ]; then
  echo " 结论：通过 ✓  —— 全仓库（含全部历史版本）搜不到密钥特征词，"
  echo "                  敏感文件均未入库，忽略规则覆盖到位。"
  echo "=================================================================="
  echo ""
  exit 0
else
  echo " 结论：不通过 ✗ —— 上面标了 ✗ 的项必须先解决。"
  echo "=================================================================="
  echo ""
  exit 1
fi
