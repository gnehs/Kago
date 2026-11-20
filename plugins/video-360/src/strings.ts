const en = {
  loading: "Loading",
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
  unsupported: "This browser can’t decode this video ({codec}). Download it and open it in another app."
};

type Strings = typeof en;

// Player controls use the wording Kago's own video player has for them.
const translations: Record<string, Strings> = {
  en,
  "zh-TW": {
    loading: "載入中",
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
    unsupported: "這個瀏覽器無法解碼這段影片（{codec}），請下載後用其他程式開啟。"
  },
  "zh-CN": {
    loading: "加载中",
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
    unsupported: "这个浏览器无法解码这段视频（{codec}），请下载后用其他程序打开。"
  },
  ja: {
    loading: "読み込み中",
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
    unsupported: "このブラウザではこの動画（{codec}）をデコードできません。ダウンロードして別のアプリで開いてください。"
  }
};

export const stringsFor = (locale: string): Strings => translations[locale] ?? en;
