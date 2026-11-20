import type { Crop, Optics } from "./source";

/** Where the camera looks: `yaw` and `pitch` in radians, `fov` the vertical field of view in radians. */
export type View = { yaw: number; pitch: number; fov: number };

/** A lens as drawn: the stream whose picture it is in, the part of that picture it fills, and how it bends light. */
export type LensGeometry = { stream: number; crop: Crop };

const VERTEX = `#version 300 es
in vec2 position;
out vec2 ndc;
void main() {
  ndc = position;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// The sphere is drawn by casting a ray for every pixel and asking each lens what it saw along it. x is right, y up
// and z forward; lens 0 looks along +z and lens 1 along -z, each upright.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 ndc;
out vec4 color;
uniform int mode;
uniform int lenses;
uniform vec3 right;
uniform vec3 up;
uniform vec3 forward;
uniform vec2 tangent;
uniform sampler2D picture0;
uniform sampler2D picture1;
uniform sampler2D poster;
uniform int stream[2];
uniform mat3 basis[2];
uniform vec4 circle[2];
uniform vec4 bounds[2];
uniform float halfFov;
uniform float band;

const float PI = 3.14159265358979;

vec4 seen(int lens, vec3 ray, out float theta) {
  vec3 local = ray * basis[lens];
  theta = acos(clamp(local.z, -1.0, 1.0));
  float reach = theta / halfFov;
  vec2 direction = length(local.xy) > 1e-6 ? normalize(local.xy) : vec2(0.0);
  // The picture's rows run downward.
  vec2 uv = circle[lens].xy + vec2(direction.x, -direction.y) * reach * circle[lens].zw;
  vec4 box = bounds[lens];
  if (reach > 1.0 || uv.x < box.x || uv.y < box.y || uv.x > box.z || uv.y > box.w) return vec4(0.0, 0.0, 0.0, 1.0);
  return stream[lens] == 0 ? texture(picture0, uv) : texture(picture1, uv);
}

void main() {
  vec3 ray = normalize(right * ndc.x * tangent.x + up * ndc.y * tangent.y + forward);
  if (mode == 1) {
    vec2 uv = vec2(0.5 + atan(ray.x, ray.z) / (2.0 * PI), 0.5 - asin(clamp(ray.y, -1.0, 1.0)) / PI);
    color = vec4(texture(poster, uv).rgb, 1.0);
    return;
  }
  float theta0;
  float theta1;
  vec4 front = seen(0, ray, theta0);
  if (lenses == 1) {
    // One lens shows its half of the sphere, fading out at the edge of what it saw.
    color = vec4(front.rgb * (1.0 - smoothstep(halfFov - 0.05, halfFov, theta0)), 1.0);
    return;
  }
  vec4 back = seen(1, ray, theta1);
  // Where both lenses saw, the picture passes from one to the other, which softens the seam.
  float weight = smoothstep(PI / 2.0 - band, PI / 2.0 + band, theta0);
  color = vec4(mix(front.rgb, back.rgb, weight), 1.0);
}`;

/**
 * Draws the recording on a canvas as the inside of a sphere, stitching the lenses' fisheye pictures together as it
 * goes. Each stream's frames are uploaded into a texture of their own; the frame can be closed once it is.
 */
export class Stitcher {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[];
  private readonly poster: WebGLTexture;
  private readonly sizes: { width: number; height: number }[] = [];
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private hasPicture = false;
  private hasPoster = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly lenses: LensGeometry[],
    private readonly optics: Optics
  ) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL 2 is not available");
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.textures = [texture(gl), texture(gl)];
    this.poster = texture(gl);
    gl.uniform1i(this.uniform("picture0"), 0);
    gl.uniform1i(this.uniform("picture1"), 1);
    gl.uniform1i(this.uniform("poster"), 2);
    gl.uniform1i(this.uniform("lenses"), lenses.length);
    gl.uniform1f(this.uniform("halfFov"), (optics.fov / 2) * (Math.PI / 180));
    gl.uniform1f(this.uniform("band"), Math.min(5 * (Math.PI / 180), 0.8 * ((optics.fov / 2 - 90) * (Math.PI / 180))));
    gl.uniform1iv(this.uniform("stream"), lenses.map((lens) => lens.stream).concat(0, 0).slice(0, 2));
    const bases = lenses.map((_, index) => lensBasis(index, optics.roll[index] ?? 0));
    gl.uniformMatrix3fv(this.uniform("basis"), false, new Float32Array([...bases.flat(), ...Array(9 * (2 - bases.length)).fill(0)]));
  }

  /** Takes a stream's frame into its texture. */
  upload(stream: number, frame: VideoFrame) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + stream);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[stream]!);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    const size = { width: frame.displayWidth, height: frame.displayHeight };
    const known = this.sizes[stream];
    if (!known || known.width !== size.width || known.height !== size.height) {
      this.sizes[stream] = size;
      this.placeLenses();
    }
    this.hasPicture = true;
  }

  /** An equirectangular picture of the whole sphere, shown until the first frames are. */
  uploadPoster(picture: ImageBitmap) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.poster);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    this.hasPoster = true;
  }

  get ready() {
    return this.hasPicture || this.hasPoster;
  }

  draw(view: View) {
    const { gl, canvas } = this;
    const scale = devicePixelRatio;
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    const tanY = Math.tan(view.fov / 2);
    gl.uniform2f(this.uniform("tangent"), tanY * (width / height), tanY);
    const { yaw, pitch } = view;
    const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const up = cross(forward, right);
    gl.uniform3fv(this.uniform("forward"), forward);
    gl.uniform3fv(this.uniform("right"), right);
    gl.uniform3fv(this.uniform("up"), up);
    gl.uniform1i(this.uniform("mode"), this.hasPicture ? 0 : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Where each lens's image circle and crop lie in its stream's texture, now that its size is known. */
  private placeLenses() {
    const circles: number[] = [];
    const bounds: number[] = [];
    for (const lens of this.lenses) {
      const size = this.sizes[lens.stream] ?? { width: 1, height: 1 };
      const { x, y, w, h } = lens.crop;
      const radius = (Math.min(w, h) / 2) * this.optics.radius;
      circles.push((x + w / 2) / size.width, (y + h / 2) / size.height, radius / size.width, radius / size.height);
      bounds.push(x / size.width, y / size.height, (x + w) / size.width, (y + h) / size.height);
    }
    while (circles.length < 8) circles.push(0);
    while (bounds.length < 8) bounds.push(0);
    this.gl.uniform4fv(this.uniform("circle"), circles);
    this.gl.uniform4fv(this.uniform("bounds"), bounds);
  }

  private uniform(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name) ?? null;
  }
}

/** A lens's right, up and forward, as the columns of a matrix that takes a ray into the lens's own terms. */
function lensBasis(lens: number, rollDegrees: number) {
  const roll = rollDegrees * (Math.PI / 180);
  const facing = lens === 0 ? 1 : -1;
  const right = [facing * Math.cos(roll), -Math.sin(roll), 0];
  const up = [facing * Math.sin(roll), Math.cos(roll), 0];
  const forward = [0, 0, facing];
  return [...right, ...up, ...forward];
}

function cross(a: number[], b: number[]) {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function texture(gl: WebGL2RenderingContext) {
  const created = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, created);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return created;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment]
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader did not compile");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program did not link");
  return program;
}
