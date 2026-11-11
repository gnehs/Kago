import type { WindowControlsPref } from "@/lib/prefs";

/**
 * The few colours a desktop is told apart by, in each theme. They are copied rather than read from the tokens:
 * a picture of the light desktop has to look light while the page around it is dark, and the reverse.
 */
const palettes = {
  light: {
    canvas: "linear-gradient(#eef0f3, #dde1e6)",
    topbar: "#d4d8de",
    window: "#ffffff",
    edge: "#c5cad2",
    chrome: "linear-gradient(#f7f8fa, #e7e9ed)",
    sidebar: "#f2f3f6",
    line: "#dde0e5",
    text: "#c3c8d0",
    control: "#ffffff",
    controlEdge: "#c5cad2",
    tile: "#eef0f3"
  },
  dark: {
    canvas: "linear-gradient(#1d2025, #0e1012)",
    topbar: "#1b1d21",
    window: "#1e2125",
    edge: "#4c5058",
    chrome: "linear-gradient(#3a3e44, #2e3136)",
    sidebar: "#25282d",
    line: "#32363c",
    text: "#4a4f57",
    control: "#4a4e55",
    controlEdge: "#5a5f67",
    tile: "#2a2d32"
  }
} as const;

type Palette = (typeof palettes)[keyof typeof palettes];

/** A small picture of the Kago desktop: the top bar, and one window with its sidebar and a few icons. */
export function DesktopPreview({ theme, side, accentControls }: { theme: "light" | "dark" | "system"; side: WindowControlsPref; accentControls?: boolean }) {
  if (theme === "system") {
    return (
      <span className="relative block size-full">
        <Desktop palette={palettes.light} side={side} accentControls={accentControls} />
        {/* The dark half takes the lower right, cut along the diagonal. */}
        <span className="absolute inset-0" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}>
          <Desktop palette={palettes.dark} side={side} accentControls={accentControls} />
        </span>
      </span>
    );
  }
  return <Desktop palette={palettes[theme]} side={side} accentControls={accentControls} />;
}

function Desktop({ palette: p, side, accentControls }: { palette: Palette; side: WindowControlsPref; accentControls?: boolean }) {
  const bar = (width: string) => <span className="block h-1 rounded-full" style={{ width, background: p.text }} />;
  return (
    <span className="absolute inset-0 block" style={{ background: p.canvas }} aria-hidden>
      <span className="absolute inset-x-0 top-0 block h-[7%]" style={{ background: p.topbar }} />
      <span
        className="absolute top-[17%] right-[8%] bottom-[-8%] left-[8%] flex flex-col overflow-hidden rounded-[7px]"
        style={{ background: p.window, boxShadow: `0 0 0 1px ${p.edge}, 0 4px 14px rgb(0 0 0 / 0.14)` }}
      >
        <span
          className="flex h-[16%] shrink-0 items-center gap-[2.5%] px-[3.5%]"
          style={{ background: p.chrome, borderBottom: `1px solid ${p.edge}`, flexDirection: side === "right" ? "row-reverse" : "row" }}
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="block aspect-square h-[46%] rounded-[2px]"
              style={accentControls ? { background: "var(--kago-accent)" } : { background: p.control, boxShadow: `0 0 0 0.5px ${p.controlEdge}` }}
            />
          ))}
          <span className="flex flex-1 justify-center">{bar("26%")}</span>
          {/* Balances the controls, as the window's own title bar does. */}
          <span className="block h-px w-[17%]" />
        </span>
        <span className="flex min-h-0 flex-1">
          <span className="flex w-[27%] flex-col gap-1.5 px-[4%] py-[6%]" style={{ background: p.sidebar, borderRight: `1px solid ${p.line}` }}>
            {bar("80%")}
            {bar("62%")}
            {bar("72%")}
          </span>
          <span className="grid flex-1 grid-cols-3 content-start gap-[5%] p-[5%]">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className="block aspect-[4/3] rounded-[3px]" style={{ background: index === 0 ? "var(--kago-folder)" : p.tile }} />
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
