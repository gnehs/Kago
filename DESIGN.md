# Kago 設計規格

Kago 是瀏覽器裡的 NAS 桌面檔案管理器。視覺與互動以 requirements.md §28 為準：

- 像 Finder 一樣直覺
- 像 NAS File Station 一樣完整
- 像 Dropover 一樣有中轉區
- 像現代設計工具一樣細緻

這份文件只記錄設計上的決定；實際數值以 `apps/web/src/styles.css` 為唯一來源。

## 原則

1. **內容優先**：畫面的主角是檔案清單。外框只有一個側欄加畫布，不再加頂部列，視窗內也不放第二個側欄。
2. **一件事一個入口**：每個功能只有一個主要位置。Root 管理在設定頁，分享與標籤在資訊面板，檔案操作在右鍵選單與選取列。
3. **安靜的介面**：中性色為主，強調色只用在選取、主要按鈕與焦點。不用漸層、毛玻璃與裝飾性陰影。
4. **淺色為預設**，深色跟隨系統或由使用者切換。兩種主題都必須可用。
5. **系統字體**：不載入網路字體，使用各平台的系統字體與中文字體。

## 版面

```txt
┌──────────┬──────────────────────────────┬───────────┐
│ Sidebar  │ Canvas                       │ Inspector │
│          │  ┌ FileWindow ─────────────┐ │ （可關閉） │
│ 位置      │  │ 標題列（紅黃綠控制鈕）    │ │           │
│ 最近      │  │ 工具列：導覽／路徑／檢視  │ │ 預覽       │
│ 工作區    │  │ 檔案清單                │ │ 一般資訊   │
│ 管理      │  │ 狀態列／選取操作         │ │ 標籤       │
│          │  └────────────────────────┘ │ 分享       │
│ 使用者    │        中轉區   任務中心     │ 權限       │
└──────────┴──────────────────────────────┴───────────┘
```

- **Sidebar**：寬 224px，可收合成 48px 的圖示列。管理區塊只對管理員顯示。
- **Canvas**：視窗座標相對於畫布，不是整個瀏覽器視窗。空白時顯示位置選擇器。
- **Inspector**：停靠在右側，顯示作用中視窗的選取項目；沒有選取時顯示目前資料夾。
- **頁面**（任務、分享、垃圾桶、管理、設定）：取代畫布顯示，內容置中、最大寬度 768px。

## Design tokens

所有顏色、圓角、密度都定義成 `--kago-*` CSS 變數，再透過 Tailwind `@theme` 對應成語意名稱。元件裡不可以寫死色碼。

| Tailwind 名稱 | 變數 | 用途 |
|---|---|---|
| `canvas` | `--kago-bg` | 畫布底色 |
| `surface` | `--kago-surface` | 視窗、卡片、頁面 |
| `elevated` | `--kago-surface-elevated` | 側欄、標題列、工具列 |
| `line` / `line-strong` | `--kago-border` / `--kago-border-strong` | 分隔線、輸入框邊框 |
| `ink` / `muted` / `faint` | `--kago-text` / `--kago-text-muted` / `--kago-text-faint` | 三層文字 |
| `accent` / `accent-fg` / `accent-soft` | `--kago-accent…` | 選取、主要按鈕、非作用中視窗的選取 |
| `hover` | `--kago-hover` | 滑過與按下的底色 |
| `danger` / `warning` / `success` | `--kago-danger…` | 狀態色 |
| `folder` | `--kago-folder` | 資料夾圖示 |

圓角：`sm` 4px（清單列、小標籤）、`md` 6px（按鈕、輸入框）、`lg` 10px（視窗、卡片、浮層）。

密度由 `<html data-density>` 控制，影響列高、控制項高度與字級：

| | 列高 | 控制項 | 字級 |
|---|---|---|---|
| 舒適 `comfortable` | 32px | 30px | 13px |
| 緊湊 `compact` | 26px | 26px | 12px |

## 層級

| 層 | z-index |
|---|---|
| 檔案視窗 | 100–499 |
| 最小化視窗列 | 550 |
| 中轉區 | 600 |
| 任務中心 | 700 |
| 右鍵選單 | 800 |
| 對話框 | 900 |
| 通知、提示 | 1000 |

## 元件

- `components/ui/`：Button、Input、Select、Field、Checkbox 等基礎表單元件。
- `components/kago/`：包裝 Base UI 的 Kago 元件（`KagoContextMenu`、`KagoDialog`、`KagoTooltip`、`KagoIconButton`、`KagoBadge`、`KagoEmptyState`、`KagoToaster`）。feature 程式碼不直接使用 Base UI primitive。
- `features/`：依功能分資料夾，每個畫面一個檔案。

規則：

- 只有圖示的按鈕一律用 `KagoIconButton`，它同時提供 tooltip 與無障礙名稱。
- 需要使用者輸入或確認時用 `promptText` / `confirmAction`，不用瀏覽器的 `prompt()` / `confirm()`。
- 操作失敗一律用 toast 告知，包在 `run()` 裡，不讓錯誤靜默消失。
- 每個清單都要有載入中與空狀態。

## 動態

動畫只用在顏色與側欄寬度的過渡，時間 150ms 以內。拖曳、縮放視窗不加動畫。尊重 `prefers-reduced-motion`。
