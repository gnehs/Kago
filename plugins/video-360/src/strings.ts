const en = {
  loading: "Loading",
  preparing: "Kago’s server is preparing this video for this browser…",
  play: "Play (Space)",
  pause: "Pause (Space)",
  position: "Playback position",
  mute: "Mute (M)",
  unmute: "Unmute (M)",
  reset: "Reset view (R)",
  hint: "Drag to look around, scroll to zoom",
  touchHint: "Drag to look around, pinch to zoom",
  oneLens: "The other lens’s file wasn’t found, so only this half is shown.",
  notPanorama: "This file has no video this viewer can show.",
  noPanorama: "Kago couldn’t prepare this 360° video for this browser. Download it and open it in another app.",
  insecure: "360° videos play only when Kago is opened over HTTPS: the browser turns off video decoding on plain HTTP pages. Open Kago at an https:// address, or download the file.",
  unsupported: "This browser can’t decode this video ({codec}). Download it and open it in another app."
};

type Strings = typeof en;

// Player controls use the wording Kago's own video player has for them.
const translations: Record<string, Strings> = {
  en,
  "zh-TW": {
    loading: "載入中",
    preparing: "Kago 伺服器正在為這個瀏覽器準備影片…",
    play: "播放（空白鍵）",
    pause: "暫停（空白鍵）",
    position: "播放進度",
    mute: "靜音（M）",
    unmute: "取消靜音（M）",
    reset: "重設視角（R）",
    hint: "拖曳以環顧四周，滾輪縮放",
    touchHint: "拖曳以環顧四周，兩指開合以縮放",
    oneLens: "找不到另一顆鏡頭的檔案，只顯示這一半。",
    notPanorama: "這個檔案裡沒有這個檢視器能顯示的影片。",
    noPanorama: "Kago 無法為這個瀏覽器準備這段 360° 影片，請下載後用其他程式開啟。",
    insecure: "360° 影片只能在用 HTTPS 開啟的 Kago 裡播放：瀏覽器在一般 HTTP 網頁上會關閉影片解碼功能。請改用 https:// 網址開啟 Kago，或下載檔案。",
    unsupported: "這個瀏覽器無法解碼這段影片（{codec}），請下載後用其他程式開啟。"
  },
  "zh-CN": {
    loading: "加载中",
    preparing: "Kago 服务器正在为这个浏览器准备视频…",
    play: "播放（空格键）",
    pause: "暂停（空格键）",
    position: "播放进度",
    mute: "静音（M）",
    unmute: "取消静音（M）",
    reset: "重置视角（R）",
    hint: "拖动以环顾四周，滚轮缩放",
    touchHint: "拖动以环顾四周，双指开合以缩放",
    oneLens: "找不到另一颗镜头的文件，只显示这一半。",
    notPanorama: "这个文件里没有这个查看器能显示的视频。",
    noPanorama: "Kago 无法为这个浏览器准备这段 360° 视频，请下载后用其他程序打开。",
    insecure: "360° 视频只能在用 HTTPS 打开的 Kago 中播放：浏览器在普通 HTTP 网页上会关闭视频解码功能。请改用 https:// 地址打开 Kago，或下载文件。",
    unsupported: "这个浏览器无法解码这段视频（{codec}），请下载后用其他程序打开。"
  },
  ja: {
    loading: "読み込み中",
    preparing: "Kago のサーバーがこのブラウザ向けに動画を準備しています…",
    play: "再生（スペース）",
    pause: "一時停止（スペース）",
    position: "再生位置",
    mute: "ミュート（M）",
    unmute: "ミュート解除（M）",
    reset: "視点をリセット（R）",
    hint: "ドラッグで見回す、スクロールで拡大／縮小",
    touchHint: "ドラッグで見回す、ピンチで拡大／縮小",
    oneLens: "もう一方のレンズのファイルが見つからないため、この半分だけを表示しています。",
    notPanorama: "このファイルには、このビューアで表示できる動画がありません。",
    noPanorama: "Kago はこのブラウザ向けにこの 360° 動画を用意できませんでした。ダウンロードして別のアプリで開いてください。",
    insecure: "360° 動画は HTTPS で開いた Kago でのみ再生できます。ブラウザは通常の HTTP ページで動画のデコードを無効にします。https:// のアドレスで Kago を開くか、ファイルをダウンロードしてください。",
    unsupported: "このブラウザではこの動画（{codec}）をデコードできません。ダウンロードして別のアプリで開いてください。"
  }
};

export const stringsFor = (locale: string): Strings => translations[locale] ?? en;
