import JSZip from "jszip";

const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const ACCENTS = 6;
const SLICED = /^(pie|pie3D|doughnut)Chart$/;

/**
 * Writes out what PowerPoint leaves for itself to decide. A series whose colour is "automatic" has no fill in the
 * file, and a chart's automatic title has no text; the renderer draws only what is written, so such a chart comes
 * out with invisible bars under a placeholder heading. The theme's accents, in order, are what PowerPoint picks.
 */
export async function completeCharts(data: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/charts\/[^/]+\.xml$/.test(name)) continue;
    const xml = new DOMParser().parseFromString(await zip.file(name)!.async("string"), "application/xml");
    if (xml.querySelector("parsererror") || !completeChart(xml)) continue;
    zip.file(name, new XMLSerializer().serializeToString(xml));
    changed = true;
  }
  // Entries left alone keep the compressed bytes they came with, so a deck full of pictures is not squeezed again.
  return changed ? zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }) : data;
}

const child = (parent: Element, namespace: string, name: string) => [...parent.children].find((element) => element.namespaceURI === namespace && element.localName === name);

function completeChart(xml: Document) {
  const chart = xml.getElementsByTagNameNS(C, "chart")[0];
  const plot = chart && child(chart, C, "plotArea");
  if (!chart || !plot) return false;
  const series = [...plot.getElementsByTagNameNS(C, "ser")];
  if (series.length === 0) return false;
  const sliced = SLICED.test(series[0]!.parentElement?.localName ?? "");
  let changed = false;
  series.forEach((entry, position) => {
    // A pie is coloured slice by slice; everything else, series by series.
    const done = sliced ? completeSlices(entry) : ensureFill(entry, indexOf(entry) ?? position);
    changed = done || changed;
  });
  // A pie is headed by the name of its series, which is always written.
  return (!sliced && ensureTitle(chart, series)) || changed;
}

function indexOf(owner: Element) {
  const value = Number(child(owner, C, "idx")?.getAttribute("val") ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Gives a series or a slice the accent PowerPoint would, unless the file says how it is filled, or that it is not. */
function ensureFill(owner: Element, index: number) {
  const document = owner.ownerDocument;
  let shape = child(owner, C, "spPr");
  if (shape && (child(shape, A, "solidFill") || child(shape, A, "noFill"))) return false;
  if (!shape) {
    shape = document.createElementNS(C, "c:spPr");
    owner.append(shape);
  }
  const fill = document.createElementNS(A, "a:solidFill");
  const colour = document.createElementNS(A, "a:schemeClr");
  colour.setAttribute("val", `accent${(index % ACCENTS) + 1}`);
  fill.append(colour);
  shape.prepend(fill);
  return true;
}

/** One coloured point for every slice, in order: the renderer hands colours out by position, not by index. */
function completeSlices(series: Element) {
  const document = series.ownerDocument;
  const values = child(series, C, "val");
  if (!values) return false;
  const declared = Number(values.getElementsByTagNameNS(C, "ptCount")[0]?.getAttribute("val"));
  const total = Math.min(Number.isInteger(declared) && declared > 0 ? declared : values.getElementsByTagNameNS(C, "pt").length, 1000);
  const written = [...series.children].filter((element) => element.namespaceURI === C && element.localName === "dPt");
  const byIndex = new Map(written.map((point) => [indexOf(point), point]));
  let changed = false;
  const ordered = Array.from({ length: total }, (_, index) => {
    let point = byIndex.get(index);
    if (!point) {
      point = document.createElementNS(C, "c:dPt");
      const position = document.createElementNS(C, "c:idx");
      position.setAttribute("val", String(index));
      point.append(position);
    }
    changed = ensureFill(point, index) || changed;
    return point;
  });
  if (!changed && ordered.length === written.length && ordered.every((point, index) => point === written[index])) return false;
  for (const point of written) point.remove();
  values.before(...ordered);
  return true;
}

/** The heading PowerPoint supplies when none is typed: the name of a lone series, and otherwise nothing. */
function ensureTitle(chart: Element, series: Element[]) {
  const document = chart.ownerDocument;
  let title = child(chart, C, "title");
  if (title && [...title.getElementsByTagNameNS(A, "t")].some((text) => text.textContent)) return false;
  const automatic = child(chart, C, "autoTitleDeleted")?.getAttribute("val") !== "1";
  const label = child(series[0]!, C, "tx");
  const name = series.length === 1 && automatic ? label?.getElementsByTagNameNS(C, "v")[0]?.textContent : "";
  if (!title) {
    title = document.createElementNS(C, "c:title");
    chart.prepend(title);
  }
  child(title, C, "tx")?.remove();
  const text = document.createElementNS(A, "a:t");
  // The renderer puts a placeholder where it finds no text at all; a space is a heading that shows nothing.
  text.textContent = name || " ";
  let node: Element = text;
  for (const [namespace, tag] of [[A, "a:r"], [A, "a:p"], [C, "c:rich"], [C, "c:tx"]] as const) {
    const parent = document.createElementNS(namespace, tag);
    parent.append(node);
    node = parent;
  }
  title.prepend(node);
  return true;
}
