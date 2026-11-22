import assert from "node:assert/strict";
import test from "node:test";
import { chooseBackend } from "../src/backends.ts";

const lens = { kind: "video", codec: "hvc1.2.4.H156.B0" };
const lenses = [lens, lens];
const plays = (...codecs) => (mime) => codecs.some((codec) => mime.includes(codec));

test("a browser with WebCodecs that decode the lenses decodes them itself", async () => {
  assert.equal(await chooseBackend({ decodes: async () => true, plays: plays("hvc1") }, lenses), "decoders");
});

test("a plain http:// page, without WebCodecs, plays the lenses as videos when Media Source plays their codec", async () => {
  assert.equal(await chooseBackend({ decodes: null, plays: plays("hvc1") }, lenses), "lens-videos");
});

test("WebCodecs that can't decode a lens give way to the lens videos", async () => {
  assert.equal(await chooseBackend({ decodes: async () => false, plays: plays("hvc1") }, lenses), "lens-videos");
});

test("a lens codec Media Source can't play leaves the panorama Kago's server stitches", async () => {
  assert.equal(await chooseBackend({ decodes: null, plays: plays("avc1") }, lenses), "panorama");
  assert.equal(await chooseBackend({ decodes: null, plays: plays("hvc1") }, [lens, { kind: "video", codec: null }]), "panorama");
});

test("a browser without Media Source or WebCodecs has no way to play the recording", async () => {
  assert.equal(await chooseBackend({ decodes: null, plays: null }, lenses), null);
});
