# Changelog

本檔案記錄 todooo 的版本變更，格式依循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.1.0] - 2026-09-26

### Added

- 全域、跨工作區的 TODO List：資料存在 `~/.todooo/collections/`，每個 Collection 一份 JSON，任何工作區開啟都是同一份。
- Collection：下拉切換、新增、重新命名、刪除；至少保留一個。大標題預設為建立當天的日期。
- 兩欄面板：左側 TODO 列表、右側細節，預設 6:4，拖曳中間分隔線調整並記住；細節可「展開」成滿版。
- TODO 項目：標題（120 字內）、內容、狀態、分類、自訂標籤、創建時間（預設現在、可改）、完成時間（切成已完成或失敗時自動記下）。
- 狀態固定六種：未完成、已完成、待測試、待回覆、失敗、擱置。
- 分類：每個 Collection 自訂，預設「未分類」，一次只能選一個、至少保留一個。
- 自訂標籤：Notion 風格，多選、九種顏色、文字自訂，每個 Collection 各自一組。
- 狀態列左側的 `TODO` 按鈕與指令 `todooo: Open TODO List` 開啟面板。
- 設定 `todooo.dataFolder` 更換資料夾。
