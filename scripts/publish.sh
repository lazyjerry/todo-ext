#!/usr/bin/env bash
# 發布 todooo 到 VS Code Marketplace。
#
# 兩階段。版本準備與上傳分開，中間必須有一個 commit，
# 這樣每個發布出去的版本都對應得到可追溯的 commit。
#
#   ./scripts/publish.sh patch        # 階段一：bump 版本並搬移 CHANGELOG，不上傳
#   ./scripts/publish.sh minor|major
#   git commit ...                    # 由你決定訊息與時機
#   ./scripts/publish.sh              # 階段二：檢查、打包、稽核、上傳、驗證
#   DRY_RUN=1 ./scripts/publish.sh    # 階段二止於上傳前
#
# 與 build 分離：npm run check / package:vsix 只產生本機 artifact，
# 不因為環境中存在 VSCE_PAT 就隱含上傳。上傳只發生在本腳本。
#
# 認證：先 `npx vsce login <publisher>`，或設定 VSCE_PAT 環境變數。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

bump="${1:-}"
dry_run="${DRY_RUN:-0}"
release_date="$(date +%Y-%m-%d)"

fail() {
  echo "publish: $1" >&2
  exit 1
}

case "$bump" in
  "" | patch | minor | major) ;;
  *) fail "版本參數只接受 patch / minor / major，收到 '$bump'" ;;
esac

for command_name in git node npm npx unzip shasum curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少指令：$command_name"
done

# 版本一旦發布無法覆蓋，工作區必須乾淨才能對應到可追溯的 commit。
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  fail "工作區有未提交的變更，請先提交或暫存"
fi

# ---------- 階段一：版本準備 ----------

if [ -n "$bump" ]; then
  echo "==> 準備 $bump 版本"
  versions="$(node - package.json package-lock.json CHANGELOG.md "$bump" "$release_date" <<'NODE'
const fs = require('fs');
const [manifestPath, lockPath, changelogPath, bump, releaseDate] = process.argv.slice(2);
const die = (message) => { console.error(message); process.exit(1); };
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const match = String(manifest.version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) die(`需要穩定版 SemVer，讀到 ${manifest.version}`);

const numbers = match.slice(1).map(Number);
if (bump === 'major') { numbers[0] += 1; numbers[1] = 0; numbers[2] = 0; }
else if (bump === 'minor') { numbers[1] += 1; numbers[2] = 0; }
else { numbers[2] += 1; }
const nextVersion = numbers.join('.');

// [Unreleased] 的內容整段搬到新版本號下，標題留空給下一輪。
const changelog = fs.readFileSync(changelogPath, 'utf8');
const heading = '## [Unreleased]';
const start = changelog.indexOf(heading);
if (start < 0) die('CHANGELOG.md 必須包含 ## [Unreleased]');
const notesStart = start + heading.length;
const nextHeading = changelog.slice(notesStart).match(/\n## \[/);
const notesEnd = nextHeading ? notesStart + nextHeading.index + 1 : changelog.length;
const notes = changelog.slice(notesStart, notesEnd).trim();
if (!notes) die('CHANGELOG.md 的 [Unreleased] 是空的，沒有可發布的內容');

manifest.version = nextVersion;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = nextVersion;
  if (lock.packages && lock.packages['']) lock.packages[''].version = nextVersion;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

const block = `## [Unreleased]\n\n## [${nextVersion}] - ${releaseDate}\n\n${notes}\n\n`;
fs.writeFileSync(changelogPath, `${changelog.slice(0, start)}${block}${changelog.slice(notesEnd)}`);

process.stdout.write(`${match[0]}\n${nextVersion}`);
NODE
)" || fail "版本準備失敗"

  echo "    $(printf '%s' "$versions" | sed -n '1p') -> $(printf '%s' "$versions" | sed -n '2p')"
  echo "==> 已修改 package.json、package-lock.json、CHANGELOG.md，未提交也未上傳。"
  echo "    檢查 diff 後提交，再執行不帶參數的 ./scripts/publish.sh 發布。"
  exit 0
fi

# ---------- 階段二：發布 ----------

echo "==> 驗證 package.json"
manifest="$(node - package.json <<'NODE'
const fs = require('fs');
const die = (message) => { console.error(message); process.exit(1); };
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const key of ['name', 'displayName', 'publisher', 'version', 'license', 'icon']) {
  if (typeof pkg[key] !== 'string' || pkg[key].trim() === '') die(`package.json.${key} 必填`);
}
if (pkg.private === true) die('package.json.private 不得為 true');
if (!pkg.engines || typeof pkg.engines.vscode !== 'string') die('package.json.engines.vscode 必填');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) die(`不支援的 SemVer：${pkg.version}`);
console.log(JSON.stringify({name: pkg.name, publisher: pkg.publisher, version: pkg.version}));
NODE
)" || fail "package.json 未通過驗證"

read_field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]));' "$manifest" "$1"; }
name="$(read_field name)"
publisher="$(read_field publisher)"
version="$(read_field version)"
extension_id="$publisher.$name"

echo "==> 比對 Marketplace 版本"
remote_json="$(mktemp "${TMPDIR:-/tmp}/publish-remote.XXXXXX")"
trap 'rm -f "$remote_json"' EXIT
npx --no-install vsce show "$extension_id" --json >"$remote_json" || fail "查詢 Marketplace 失敗"

remote_version="$(node - "$remote_json" <<'NODE'
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!raw || raw === 'undefined') process.exit(0);
process.stdout.write(JSON.parse(raw).versions?.[0]?.version || '');
NODE
)" || fail "Marketplace 回應無法解析"

if [ -z "$remote_version" ]; then
  echo "    遠端尚無此 extension，視為首次發布"
else
  node -e '
    const parse = (v) => v.match(/^(\d+)\.(\d+)\.(\d+)$/).slice(1, 4).map(Number);
    const [local, remote] = [parse(process.argv[1]), parse(process.argv[2])];
    for (let i = 0; i < 3; i += 1) {
      if (local[i] !== remote[i]) process.exit(local[i] > remote[i] ? 0 : 1);
    }
    process.exit(1);
  ' "$version" "$remote_version" || fail "本機版本 $version 必須大於遠端版本 $remote_version"
  echo "    $remote_version -> $version"
fi

echo "==> 檢查與建置"
npm run check

echo "==> 打包 vsix"
npx --no-install vsce package --no-dependencies

vsix="$root/${name}-${version}.vsix"
[ -f "$vsix" ] || fail "找不到 $vsix"

echo "==> 稽核 vsix 內容"
packaged_manifest="$(unzip -p "$vsix" extension/package.json)" || fail "無法讀取 vsix 內的 package.json"
node -e '
  const [local, packed] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2])];
  for (const field of ["name", "publisher", "version"]) {
    if (local[field] !== packed[field]) {
      console.error(`${field} 不一致: 本機=${local[field]} 打包=${packed[field]}`);
      process.exit(1);
    }
  }
' "$manifest" "$packaged_manifest" || fail "vsix 內的 manifest 與 package.json 不符"

# vsce 會打包任何未列進 .vscodeignore 的檔案，與 git 是否追蹤無關。
excluded='^extension/(\.agents/|\.claude/|\.git/|\.vscode-test/|node_modules/|src/|test/|scripts/|docs/|CLAUDE\.md$|AGENTS\.md$)|\.vsix$'
if unzip -Z1 "$vsix" | grep -E "$excluded" >&2; then
  fail "vsix 含有不該發布的檔案，請檢查 .vscodeignore"
fi

sha256="$(shasum -a 256 "$vsix" | awk '{print $1}')"
echo "    $(unzip -Z1 "$vsix" | wc -l | tr -d ' ') 個檔案，sha256=$sha256"

echo "==> 安裝 vsix 到本機 VS Code 驗證"
if command -v code >/dev/null 2>&1; then
  code --install-extension "$vsix" --force
  # bash 3.2.57 的 echo 會在變數展開緊接全形字元時吃掉一個位元組，改用 printf 傳參數。
  printf '    已安裝 %s，請執行指令 todooo: Open TODO List 確認後再繼續。\n' "$vsix"
else
  echo "    找不到 code CLI，請手動安裝 $vsix 驗證（VS Code 內執行 Shell Command: Install 'code' command in PATH）。"
fi

if [ "$dry_run" = "1" ]; then
  echo "==> DRY_RUN=1，止於此，未上傳"
  exit 0
fi

read -r -p "確認上傳 $vsix 到 Marketplace？版本發布後無法覆蓋。輸入 yes 繼續：" answer
[ "$answer" = "yes" ] || fail "已取消"

# 上傳稽核過的那一份，不讓 vsce 重新打包出另一個 artifact。
echo "==> 發布"
npx --no-install vsce publish --packagePath "$vsix"

echo "==> 驗證上架結果（Marketplace 需數分鐘驗證）"
deadline="$(( $(date +%s) + 600 ))"
while :; do
  published="$(npx --no-install vsce show "$extension_id" --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "undefined") return;
      const found = (JSON.parse(trimmed).versions || []).find((item) => item.version === process.argv[1]);
      if (!found) return;
      const sha = (found.properties || []).find((item) => item.key === "Microsoft.VisualStudio.Services.VsixSha256");
      process.stdout.write(sha?.value || "");
    });
  ' "$version" || true)"

  if [ "$published" = "$sha256" ]; then
    echo "    版本 $version 已上架，sha256 相符"
    break
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf '    逾時：Marketplace 尚未顯示 %s，或 sha256 不符（讀到 %s）。\n' "$version" "'${published:-missing}'" >&2
    echo "    不要重複上傳，到管理頁查看驗證狀態。" >&2
    exit 1
  fi

  echo "    等待驗證中…"
  sleep 15
done

public_url="https://marketplace.visualstudio.com/items?itemName=$extension_id"
http_status="$(curl -L -sS -o /dev/null -w '%{http_code}' "$public_url" || true)"
echo "==> 完成"
echo "    extension: $extension_id@$version"
echo "    sha256:    $sha256"
echo "    公開頁:    $public_url (HTTP $http_status)"
