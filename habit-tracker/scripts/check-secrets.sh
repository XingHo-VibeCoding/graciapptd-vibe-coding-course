#!/usr/bin/env bash
# ============================================================================
# 自律计划 · 密钥排查脚本（Day 23 建立）
# ----------------------------------------------------------------------------
# 用途：一条命令回答"这个仓库里有没有密钥"，并给出可直接截图的干净结果。
#
#   bash habit-tracker/scripts/check-secrets.sh
#
# 为什么只扫「被 git 跟踪的文件」：只有它们会被推到 GitHub。
# 工作区里那些没入库的临时文件不构成泄露风险，混进来只会让结果变脏。
#
# 退出码：0 = 通过（无真密钥、敏感文件都没入库）；1 = 有高危发现。
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

echo ""
echo "=================================================================="
echo " 自律计划 · 密钥排查（只扫被 git 跟踪的文件 = 会上 GitHub 的那些）"
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
  out="$(git grep -I -n -E "$pattern" -- . 2>/dev/null || true)"
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
    printf '  %-40s 【已跟踪 ✗】 %s\n' "$f" "$note"
    FAIL=1
  else
    printf '  %-40s 未跟踪 ✓   %s\n' "$f" "$note"
  fi
}

check_tracked() {
  local f="$1" note="$2"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    printf '  %-40s 已跟踪 ✓   %s\n' "$f" "$note"
  elif [ -f "$f" ]; then
    # 文件在磁盘上但还没 git add —— 这是新建模板时的正常中间态，提醒而不判失败
    printf '  %-40s 待入库 ⚠   %s（文件已存在，记得 git add）\n' "$f" "$note"
  else
    printf '  %-40s 【缺少 ✗】 %s\n' "$f" "$note"
    FAIL=1
  fi
}

check_untracked "habit-tracker/.env"            "真实私密配置，只能待在本地"
check_untracked "habit-tracker/.env.local"      "同上"
check_untracked "habit-tracker/cloudbaserc.json" "含函数环境变量（内有 API Key）"
check_tracked   "habit-tracker/.env.example"     "占位符模板，应当入库"
check_tracked   "habit-tracker/cloudbaserc.example.json" "占位符模板，应当入库"

# ---------------------------------------------------------------------------
# 【三】需要人工确认的命中 —— 列出上下文，由人眼判断是不是说明性文字
# ---------------------------------------------------------------------------
echo ""
echo "【三】需要人工确认的命中（多为文档/注释里的说明文字）"
echo "------------------------------------------------------------------"

for kw in 'service_role' 'CLOUDBASE_API_KEY' 'DEMO_UID'; do
  out="$(git grep -I -n -E "$kw" -- . 2>/dev/null || true)"
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
echo "=================================================================="
if [ "$FAIL" = "0" ]; then
  echo " 结论：通过 ✓  —— 全仓库搜不到密钥特征词，敏感文件均未入库。"
  echo "=================================================================="
  echo ""
  exit 0
else
  echo " 结论：不通过 ✗ —— 上面标了 ✗ 的项必须先解决。"
  echo "=================================================================="
  echo ""
  exit 1
fi
