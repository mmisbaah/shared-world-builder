/**
 * Cascaded shadow maps.
 *
 * A single shadow map over this world would either waste all its resolution on the
 * far end or clip the near end, because the world spans a 40-voxel playable radius
 * against a 48-tall ceiling. Splitting the view frustum into four cascades and
 * giving each a tight orthographic box buys roughly an order of magnitude in
 * effective texel density at the near plane, which is where contact shadows -- the
 * ones that make a voxel read as a solid -- actually live.
 *
 * Split selection blends a logarithmic and a uniform split. Pure uniform starves
 * the near cascades and wastes resolution on distant ground; pure logarithmic
 * gives the far cascades so little texel density that they shimmer as the camera
 * moves. The blend is the standard practical compromise.
 *
 * The cascade box centre is snapped to whole texels. That is what stops the
 * shadow edges from crawling as the camera slides, which is the single most
 * visible CSM artefact.
 */

import * as THREE from 'three';

import { CONFIG } from '../config.js';

const CASCADES = CONFIG.render.cascades;

/** Blend of logarithmic (0) and uniform (1) split selection. */
const BLEND = 0.68;

/** Distance the shadow camera is pulled back from the fitted sphere. */
const SUN_STANDOFF = 2.0;

export class CSM {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} size per-cascade edge length in texels
   */
  constructor(renderer, size = CONFIG.render.shadowMapSize) {
    this.renderer = renderer;
    this.size = size;

    // All cascades live in one 2x2 atlas: a single texture means one sampler and
    // one bind for the whole shadow lookup, instead of four texture units.
    this.atlasSize = size * 2;
    this.atlas = new THREE.WebGLRenderTarget(this.atlasSize, this.atlasSize, {
      format: THREE.RedFormat,
      type: THREE.FloatType,
      // Nearest, not linear: linear filtering of a full float texture needs
      // OES_texture_float_linear and is an INVALID_OPERATION without it. The
      // lighting pass already takes a 3x3 filter over the atlas, so the hardware
      // filter was buying nothing anyway.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this.cascades = [];
    for (let i = 0; i < CASCADES; i++) {
      this.cascades.push({
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
        near: 0,
        far: 0,
        texel: 0,
        offsetX: (i % 2) * 0.5,
        offsetY: Math.floor(i / 2) * 0.5,
      });
    }

    /** Far distance of each cascade, in view space. */
    this.splits = new THREE.Vector4();
    /** World size of one shadow texel per cascade, for normal-offset bias. */
    this.texels = new THREE.Vector4();
    this.enabled = true;

    /** Depth-only material for the shadow pass; see {@link CSM#render}. */
    this._override = new THREE.MeshBasicMaterial({ colorWrite: false });
  }

  /**
   * Split distance for the end of cascade `i`, blended logarithmic/uniform.
   * @private
   */
  _split(i, near, far) {
    const p = (i + 1) / CASCADES;
    const log = near * Math.pow(far / near, p);
    const uni = near + (far - near) * p;
    return THREE.MathUtils.lerp(log, uni, BLEND);
  }

  /**
   * Fit every cascade to the current camera.
   *
   * @param {THREE.PerspectiveCamera} camera
   * @param {THREE.Vector3} sunDir normalised, pointing towards the sun
   */
  update(camera, sunDir) {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

    let prevNear = camera.near;
    const centre = new THREE.Vector3();

    for (let i = 0; i < CASCADES; i++) {
      const far = this._split(i, camera.near, camera.far);
      const c = this.cascades[i];
      c.near = prevNear;
      c.far = far;

      const mid = (prevNear + far) * 0.5;
      const halfHeight = tanHalf * mid;
      const halfWidth = halfHeight * camera.aspect;

      // A sphere around the sub-frustum: bounding it by a box would need the box's
      // diagonal and so throw away texel density for the corners that never have
      // geometry in them.
      const r = Math.hypot(halfWidth, halfHeight) + 2;
      const texel = (r * 2) / this.size;
      c.texel = texel;

      centre.copy(camera.position).addScaledVector(forward, mid);
      centre.x = Math.round(centre.x / texel) * texel;
      centre.y = Math.round(centre.y / texel) * texel;

      const cam = c.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      // The sub-frustum is a sphere of radius r centred `mid` away; the sun
      // direction can put casters anywhere within it, so the near plane only has
      // to clear the sphere itself.
      cam.near = Math.max(0.1, r * 0.05);
      cam.far = r * (2 + SUN_STANDOFF * 2);
      cam.position.copy(centre).addScaledVector(sunDir, r * SUN_STANDOFF);
      cam.up.set(0, 1, 0);
      cam.lookAt(centre);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      prevNear = far;
    }

    // Split distances and texel sizes are packed into Vector4s because that is
    // what a uniform sampler can carry, while the cascade count is whatever
    // CONFIG says. Slots past the last cascade are filled with sentinels: Infinity
    // for a split, so the shader's linear search falls through instead of matching
    // a real depth against garbage, and 1.0 for a texel size, so a mis-selected
    // cascade cannot produce a zero normal-offset that would self-shadow everything.
    const SPLIT_SENTINEL = Infinity;
    const TEXEL_SENTINEL = 1.0;
    const far = new Array(4).fill(SPLIT_SENTINEL);
    const texel = new Array(4).fill(TEXEL_SENTINEL);
    for (let i = 0; i < CASCADES; i++) {
      far[i] = this.cascades[i].far;
      texel[i] = this.cascades[i].texel;
    }
    this.splits.set(far[0], far[1], far[2], far[3]);
    this.texels.set(texel[0], texel[1], texel[2], texel[3]);
  }

  /**
   * Render the cascades depth-only.
   *
   * An override material with colour writes disabled is used rather than the real
   * chunk material. That is much cheaper -- the chunk fragment shader would
   * otherwise evaluate the dissolve and the material tables for every shadow
   * texel -- at the cost of blocks mid-dissolve casting a full shadow for the few
   * hundred milliseconds they are visible. A deliberate trade, not an oversight.
   */
  render(scene) {
    if (!this.enabled) return;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    const prevViewport = renderer.getViewport(new THREE.Vector4());

    // White means "nothing occludes": a texel no geometry reached stays lit,
    // which is the safe direction for a missed write.
    renderer.setClearColor(0xffffff, 1);
    renderer.autoClear = false;
    scene.overrideMaterial = this._override;

    for (let i = 0; i < CASCADES; i++) {
      const x = (i % 2) * this.size;
      const y = Math.floor(i / 2) * this.size;
      renderer.setViewport(x, y, this.size, this.size);
      renderer.setScissor(x, y, this.size, this.size);
      renderer.setScissorTest(true);
      renderer.setRenderTarget(this.atlas);
      renderer.clear(true, true, false);
      renderer.render(scene, this.cascades[i].camera);
    }

    renderer.setScissorTest(false);
    renderer.setViewport(prevViewport);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
  }

  get atlasTexture() {
    return this.atlas.texture;
  }

  dispose() {
    this.atlas.dispose();
    this._override.dispose();
    for (const c of this.cascades) c.camera.clearProjectionMatrix();
  }
}