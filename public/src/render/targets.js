/**
 * Render target allocation.
 *
 * All sizes come from one place so a resize cannot leave a pass reading a target
 * that is a frame out of date -- the classic cause of a one-frame ghosting trail
 * on a minimised window.
 *
 * Depth handling is the subtle part. The G-buffer owns a float depth *texture* so
 * the lighting, occlusion and volumetric passes can all read scene depth as a
 * sampled value. That same texture is attached to the HDR target, which lets the
 * forward glass pass depth-test against the G-buffer without re-rendering
 * geometry, and keeps glass correctly behind opaque surfaces.
 */

import * as THREE from 'three';

/** Depth format that is both sampleable and usable as a depth attachment. */
const DEPTH_TYPE = THREE.FloatType;

function makeTarget(width, height, opts) {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  rt.texture.name = opts?.name ?? 'target';
  return rt;
}

export class Targets {
  /**
   * @param {number} width @param {number} height drawing-buffer pixels
   */
  constructor(width, height, config) {
    this.config = config;
    this.width = width;
    this.height = height;

    // --- G-buffer -----------------------------------------------------------
    // Three attachments: albedo+roughness, normal+unused, emissive+fx mode.
    // Normal is stored in .xy as 0..1 and reconstructed as n = v * 2 - 1, which
    // loses nothing for the shading maths and keeps the attachment half-empty.
    this.gbuffer = makeTarget(width, height, { count: 3, depthBuffer: true, name: 'gbuffer' });
    this.depthTexture = new THREE.DepthTexture(width, height, DEPTH_TYPE);
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.gbuffer.depthTexture = this.depthTexture;

    // --- HDR lighting result ------------------------------------------------
    // The forward glass pass needs the G-buffer depth to occlude it. Rather than
    // sharing one DepthTexture across two targets -- which makes the second
    // framebuffer's clear raise GL_INVALID_OPERATION, and whose depth the clear
    // would then wipe -- the HDR target gets its own depth attachment and glass is
    // depth-tested against the scene depth read back as a *sampler*.
    this.hdr = makeTarget(width, height, { name: 'hdr', depthBuffer: true });
    this.hdrDepth = new THREE.DepthTexture(width, height, DEPTH_TYPE);
    this.hdrDepth.minFilter = THREE.NearestFilter;
    this.hdrDepth.magFilter = THREE.NearestFilter;
    this.hdr.depthTexture = this.hdrDepth;

    // --- Half resolution effect targets -------------------------------------
    const hw = Math.max(1, Math.floor(width * 0.5));
    const hh = Math.max(1, Math.floor(height * 0.5));

    this.halfA = makeTarget(hw, hh, { name: 'halfA' });
    this.halfB = makeTarget(hw, hh, { name: 'halfB' });
    this.halfC = makeTarget(hw, hh, { name: 'halfC' });
    this.halfD = makeTarget(hw, hh, { name: 'halfD' });

    // --- Occlusion pyramid --------------------------------------------------
    // The first level is the scene depth itself; the rest are min-reduced by
    // successive halvings, so a distant object can be rejected against a very
    // large area of depth with one tap.
    this.hzbLevels = [];
    this._buildHzb(width, height);
  }

  _buildHzb(width, height) {
    for (const t of this.hzbLevels) t.dispose();
    this.hzbLevels = [];

    let w = width;
    let h = height;
    // Cap the depth of the pyramid; beyond this the mip is 1x1 and the reduction
    // costs more in state changes than it saves.
    while (w > 1 && h > 1 && this.hzbLevels.length < 12) {
      this.hzbLevels.push(makeTarget(w, h, { name: `hzb${this.hzbLevels.length}` }));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  /** G-buffer attachments, in the order the chunk fragment shader writes them. */
  get gAlbedo() { return this.gbuffer.textures[0]; }
  get gNormal() { return this.gbuffer.textures[1]; }
  get gMaterial() { return this.gbuffer.textures[2]; }

  setSize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;

    this.gbuffer.setSize(width, height);
    this.depthTexture.image.width = width;
    this.depthTexture.image.height = height;
    this.depthTexture.needsUpdate = true;

    this.hdr.setSize(width, height);
    this.hdrDepth.image.width = width;
    this.hdrDepth.image.height = height;
    this.hdrDepth.needsUpdate = true;

    const hw = Math.max(1, Math.floor(width * 0.5));
    const hh = Math.max(1, Math.floor(height * 0.5));
    for (const t of [this.halfA, this.halfB, this.halfC, this.halfD]) t.setSize(hw, hh);

    this._buildHzb(width, height);
  }

  dispose() {
    this.gbuffer.dispose();
    this.depthTexture.dispose();
    this.hdr.dispose();
    this.hdrDepth.dispose();
    for (const t of [this.halfA, this.halfB, this.halfC, this.halfD]) t.dispose();
    for (const t of this.hzbLevels) t.dispose();
    this.hzbLevels = [];
  }
}