const en = {
  loading: "Loading",
  progress: "Loading… {percent}%",
  touchOrbit: "Drag to orbit, pinch to zoom",
  orbit: "Drag to orbit, right-drag to pan, scroll to zoom",
  fly: "W A S D to move, drag to look around",
  orbitButton: "Orbit (1)",
  flyButton: "Fly (2)",
  speed: "Movement speed",
  frame: "Frame scene (F)",
  reset: "Reset camera (R)",
  notSplat: "This PLY file isn’t a Gaussian splat. Download it and open it in another app."
};

type Strings = typeof en;

// The same wording as Kago's own dictionaries had for these, when the viewer was part of the interface.
const translations: Record<string, Strings> = {
  en,
  "zh-TW": {
    loading: "載入中",
    progress: "載入中… {percent}%",
    touchOrbit: "拖曳以環繞，兩指開合以縮放",
    orbit: "拖曳以環繞，右鍵拖曳以平移，滾輪縮放",
    fly: "W A S D 移動，拖曳以環顧四周",
    orbitButton: "環繞（1）",
    flyButton: "飛行（2）",
    speed: "移動速度",
    frame: "顯示整個場景（F）",
    reset: "重設鏡頭（R）",
    notSplat: "這個 PLY 檔不是高斯潑濺場景，請下載後用其他程式開啟。"
  },
  "zh-CN": {
    loading: "加载中",
    progress: "加载中… {percent}%",
    touchOrbit: "拖动以环绕，双指开合以缩放",
    orbit: "拖动以环绕，右键拖动以平移，滚轮缩放",
    fly: "W A S D 移动，拖动以环顾四周",
    orbitButton: "环绕（1）",
    flyButton: "飞行（2）",
    speed: "移动速度",
    frame: "显示整个场景（F）",
    reset: "重置镜头（R）",
    notSplat: "这个 PLY 文件不是高斯泼溅场景，请下载后用其他程序打开。"
  },
  ja: {
    loading: "読み込み中",
    progress: "読み込み中… {percent}%",
    touchOrbit: "ドラッグで回転、ピンチで拡大／縮小",
    orbit: "ドラッグで回転、右ドラッグで移動、スクロールで拡大／縮小",
    fly: "W A S D で移動、ドラッグで見回す",
    orbitButton: "オービット（1）",
    flyButton: "フライ（2）",
    speed: "移動速度",
    frame: "シーン全体を表示（F）",
    reset: "カメラをリセット（R）",
    notSplat: "この PLY ファイルはガウシアンスプラットではありません。ダウンロードして別のアプリで開いてください。"
  }
};

export const stringsFor = (locale: string): Strings => translations[locale] ?? en;
