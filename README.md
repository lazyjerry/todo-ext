# todooo

全域、跨工作區的 TODO List。不管開哪個資料夾，看到的都是同一份清單。

原始碼：<https://github.com/lazyjerry/todo-ext>

## 使用方式

1. 在底部 Panel 點 **todooo** 分頁（勾選清單圖示），或點狀態列左側的 **TODO** 按鈕，或執行指令 `todooo: Open TODO List`。
2. 頂列左邊是 **Collection** 下拉與三顆按鈕（新增、重新命名、刪除），右邊是 **大標題**（預設建立當天的日期，可改）。
3. 左欄按 **＋ 新增 TODO**，右欄會彈開細節、游標停在標題。
4. 點左欄任一項目，右欄切換到它的細節；按 **展開** 讓細節佔滿整個面板，再按 **收合** 回到兩欄。面板高度不夠時右欄可捲動，也可以把 Panel 往上拉高或最大化。
5. 拖曳左右欄中間的分隔線調整比例（預設 6:4，可在 2:8 到 8:2 之間），比例會記住。

## 欄位

| 欄位 | 說明 |
|---|---|
| 標題 | 120 字內，右上角顯示字數。 |
| 狀態 | 固定六種：未完成、已完成、待測試、待回覆、失敗、擱置。一次一個，不可為空。 |
| 分類 | 每個 Collection 自訂，預設「未分類」。一次一個、不可為空、至少保留一個；刪掉分類時底下的項目改掛「未分類」。 |
| 標籤 | Notion 風格的自訂標籤：可多選，九種顏色（灰、棕、橙、黃、綠、藍、紫、粉、紅）與文字自訂。點標籤切換選取，按「管理」新增、改名、換色、刪除。 |
| 內容 | 長文字，欄位隨面板高度伸展。 |
| 創建時間 | 預設建立當下（含時間），可改。 |
| 完成時間 | 狀態切成 **已完成** 或 **失敗** 時自動記下；切回其他狀態就清掉；已完成與失敗之間互切保留原時間。 |

分類與標籤按欄位旁的 **管理** 開啟編輯區：改名稱後按 Enter 或移開焦點即生效，最後一列用來新增。

## 資料存放

- 預設在 `~/.todooo/collections/`，每個 Collection 一份 `<id>.json`，跨工作區、跨 VS Code profile 共用。
- 設定 `todooo.dataFolder` 可換資料夾（支援 `~` 開頭）；只能在使用者設定層級設定，工作區設定不生效。
- 檔案可以手動編輯或用同步工具同步。讀取時逐欄檢查：認不得的狀態退回未完成、指向不存在的分類退回未分類、壞掉的檔案略過並提示。
- 寫入採「先寫暫存檔再改名」，不會留下半份 JSON。多個 VS Code 視窗同時改同一個 Collection 時，後寫的蓋掉先寫的；面板分頁切回前景時會重讀磁碟。

JSON 結構：

```json
{
  "version": 1,
  "id": "col_…",
  "name": "工作",
  "title": "2026-09-26",
  "categories": [{ "id": "cat_…", "name": "未分類" }],
  "tags": [{ "id": "tag_…", "name": "緊急", "color": "red" }],
  "items": [
    {
      "id": "todo_…",
      "title": "寫 README",
      "content": "…",
      "status": "未完成",
      "categoryId": "cat_…",
      "tagIds": ["tag_…"],
      "createdAt": "2026-09-26T01:02:03.000Z",
      "completedAt": null,
      "updatedAt": "2026-09-26T01:02:03.000Z"
    }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

## 安全

- Webview 的 CSP 為 `default-src 'none'`，腳本只認 nonce；畫面全部用 DOM API 組出，不用 `innerHTML`。
- Webview 送回擴充的訊息逐欄驗證型別，指令名稱走白名單。
- Collection id 只接受固定格式，拿來組檔名前再確認落在資料夾內。
- 本擴充不讀取工作區內容，受限模式（Restricted Mode）下照常可用。

## 開發

```bash
npm install
npm run check                 # lint + 建置 + 單元測試
./scripts/install-local.sh    # 打包並安裝到本機 VS Code
./scripts/publish.sh patch    # 發版第一階段（bump 版本、整理 CHANGELOG）
./scripts/publish.sh          # 發版第二階段（打包、稽核、上傳）
```

## 授權

Apache-2.0
