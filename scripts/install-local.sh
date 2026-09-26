#!/usr/bin/env bash
# 打包目前工作區並安裝到本機 VS Code，用來在真的 VS Code 裡確認版面與行為。
#
#   ./scripts/install-local.sh                  # lint + 單元測試 + 打包 + 安裝到預設 profile
#   ./scripts/install-local.sh --fast           # 跳過 lint 與測試，只打包安裝（改 CSS 這類純版面調整用）
#   ./scripts/install-local.sh --all-profiles   # 裝到預設 profile 與本機所有自訂 profile
#
# 與 publish.sh 分開：這支不碰版本號、不查 Marketplace、不上傳，
# 工作區髒的也能跑——本機驗證本來就發生在提交之前。
# 安裝的版本號與工作區一致，重裝同版本靠 code --install-extension --force。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fast=0
all_profiles=0
for arg in "$@"; do
  case "$arg" in
    --fast) fast=1 ;;
    --all-profiles) all_profiles=1 ;;
    *) echo "install-local: 只接受 --fast 與 --all-profiles，收到 '$arg'" >&2; exit 1 ;;
  esac
done

command -v code >/dev/null 2>&1 || {
  echo "install-local: 找不到 code CLI，請在 VS Code 執行 Shell Command: Install 'code' command in PATH" >&2
  exit 1
}

if [ "$fast" = "0" ]; then
  echo "==> lint 與單元測試"
  npm run lint
  npm run test:unit
fi

echo "==> 打包 vsix"
# vsce package 會跑 vscode:prepublish（typecheck + 兩份 esbuild bundle）。
npx --no-install vsce package --no-dependencies

read_field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("package.json","utf8"))[process.argv[1]]));' "$1"; }
vsix="$root/$(read_field name)-$(read_field version).vsix"
[ -f "$vsix" ] || { echo "install-local: 找不到 $vsix" >&2; exit 1; }

echo "==> 安裝到預設 profile"
code --install-extension "$vsix" --force

if [ "$all_profiles" = "1" ]; then
  # profile 名稱只在執行時從 VS Code 自己的設定讀出來，不寫進這個檔案。
  storage="$HOME/Library/Application Support/Code/User/globalStorage/storage.json"
  [ -f "$storage" ] || storage="$HOME/.config/Code/User/globalStorage/storage.json"
  if [ -f "$storage" ]; then
    while IFS= read -r profile; do
      [ -n "$profile" ] || continue
      echo "==> 安裝到自訂 profile"
      code --profile "$profile" --install-extension "$vsix" --force
    done < <(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const p of j.userDataProfiles??[])console.log(p.name);' "$storage")
  else
    echo "install-local: 找不到 VS Code 的 globalStorage/storage.json，只裝了預設 profile" >&2
  fi
fi

printf '==> 已安裝 %s\n' "$(basename "$vsix")"
echo "    VS Code 需要重載視窗才會換成新的一份：Cmd+Shift+P → Developer: Reload Window，"
echo "    再執行指令 todooo: Open TODO List 確認。"
