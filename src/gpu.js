// Thin WebGL2 helpers shared by the app and the dev benchmarks.
import { VS } from './shaders.js';

export function createGPU(gl) {
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.bindVertexArray(gl.createVertexArray());

  function program(fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function texture(target = gl.TEXTURE_2D, filter = gl.LINEAR) {
    const tx = gl.createTexture();
    gl.bindTexture(target, tx);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR); // mipmap filters are minification only
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tx;
  }

  // Render target. 32-bit float is not filterable without an extension: it must be NEAREST or it reads as 0.
  function target(internal, w, h, levels = 1) {
    const f32 = internal === gl.RGBA32F || internal === gl.R32F;
    const tex = texture(gl.TEXTURE_2D, f32 ? gl.NEAREST : levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h, internal, free() { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); } };
  }

  // Named, reused render targets (re-created only when size or format changes).
  const targets = {};
  function tgt(name, internal, w, h, levels = 1) {
    const c = targets[name];
    if (c && c.w === w && c.h === h && c.internal === internal) return c;
    c?.free();
    return (targets[name] = target(internal, w, h, levels));
  }
  const free = names => names.forEach(n => { targets[n]?.free(); delete targets[n]; });

  // One full-screen pass: textures as [uniformName, texture] pairs, `set` fills the other uniforms.
  function pass(prog, fb, w, h, tex = [], set = _u => {}) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    tex.forEach(([name, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[name], i); });
    set(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Wait for the GPU to finish producing `tex` (level 0). gl.finish() does not block on every backend (ANGLE/D3D11
  // returns immediately); a 1-pixel readback does. Use only for timing and before handing results to the CPU.
  const px = new Float32Array(4);
  function finish(tex) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
  }

  return { gl, program, texture, target, targets, tgt, free, pass, finish };
}
