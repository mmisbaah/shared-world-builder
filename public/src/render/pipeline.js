/**
 * Frame graph.
 *
 * Passes are built once and switched by flags, never torn down and rebuilt --
 * recompiling shaders mid-session causes a multi-frame stall that reads as a
 * hitch, and toggling quality is expected to be interactive.
 *
 *   1  shadow        four depth cascades into one atlas
 *   2  g-buffer      opaque geometry -> three MRT attachments + depth
 *   3  lighting      sun + shadows + ambient + emissive -> HDR
 *   4  forward       glass, depth-tested against the G-buffer's depth texture
 *   5  bright/blur   threshold and blur for bloom
 *   6  composite     tonemap, bloom, vignette, FXAA, sRGB encode -> screen
 *
 * The G-buffer owns a float depth texture and the HDR target shares it. That is
 * what lets step 4 test against step 2's depth without re-rendering geometry, and
 * keeps glass correctly occluded by opaque surfaces for free.
 */

import * as THREE from 'three';

import { CONFIG, QUALITY } from '../config.js';
import { Targets } from './targets.js';
import { CSM } from './csm.js';
import { LightClusterer, collectPropLights } from './lights.js';
import { createLightingPass, createCompositePass, createBlurPass, createBrightPass } from './passes.js';

/**
 * Lighting environment shared by the chunk materials and every post pass.
 *
 * The ambient tints are authored as sRGB and converted to linear exactly once,
 * here. Note that a hex like 0x2b3a5c is already very dark in linear space
 * (~0.02), so multiplying it by a small intensity lands at effectively black --
 * which reads as a broken renderer rather than a night scene. They are scaled to
 * a usable range instead.
 */
/**
 * Linear-space environment for the deferred lighting pass.
 *
 * Values are authored as **linear radiance directly**, not as sRGB hex tints with
 * a scale factor bolted on. That distinction is the whole story of this file's
 * previous revision.
 *
 * It used to be `new Color(0x2b3a5c).convertSRGBToLinear().multiplyScalar(90)`.
 * A dark hex tint converts to roughly 0.02 in linear space, so a multiplier of 1.0
 * would be invisible and someone (me) reached for 90. The consequences were all
 * visible in one frame and none of them were about "the ambient was too low":
 *
 *   - the same `uSkyColor` fed the sky shader, so the sky was 90x too bright and
 *     clipped to a flat saturated blue with no gradient;
 *   - ambient reached ~1.0 while the sun sat at 3.1, so the blue fill dominated
 *     the surfaces and killed all directional form -- the flat "programmer art"
 *     look;
 *   - saturated albedos (gold, brick) clipped to pure primaries with no shading
 *     left inside them.
 *
 * The trap is that "make it visible" and "make it correct" are different problems,
 * and only one of them is solved by a big multiplier. Authoring in linear means
 * these numbers are the light, and the balance between them is explicit.
 *
 * The palette is now a tropical noon over an atoll: a near-white sun, cyan sky fill,
 * and a warm sand bounce. It replaced a low dusk, and the reason is measurable rather
 * than aesthetic -- see `tools/tone-probe.js`, which runs the real chain
 * (albedo -> sun + hemi -> exposure -> ACES -> sRGB) and reports what each material
 * actually looks like.
 *
 * The dusk rig measured with every bright material buried in the tone curve's
 * shoulder: gold at 3.2, amber neon at 6.1, glass at 3.2, and sand -- at a beach-photo
 * 0xf2e4c9 -- at 6.0. A face in the shoulder has no gradient left in it, so the light
 * could not model it: sand measured a lit/shadow ratio of 1.24, which on a
 * flat-shaded voxel is a flat cream slab with the form painted out.
 *
 * Dropping the sun from 6.2 to 2.3 and rebalancing the fill brings every material back
 * under 2.3 in the shoulder and lifts the worst lit/shadow ratio from 1.24 to 2.34,
 * with stone at 3.44. The key-to-fill ratio is held near 12:1 throughout, which is the
 * dominant quality lever for this renderer: voxel faces are flat-shaded, so contrast
 * between a face pointing at the sun and one pointing away is the *only* thing that
 * shows form.
 *
 * Authored in linear space, as ever. These numbers are the light.
 */
export function createEnvironment() {
  return {
    // Elevation is the single most consequential number in this file, and it is not
    // about taste.
    //
    // Voxel terrain is made of horizontal terraces and vertical risers. A face's
    // brightness is its normal dotted with the sun, so the ratio between the two kinds
    // of face is set entirely by the sun's elevation -- and that ratio *is* whether the
    // terrain reads as three-dimensional:
    //
    //   elevation   sun-facing wall vs flat ground
    //     60 deg        0.58x     walls are nearly black next to the ground
    //     51 deg        0.81x     the ground wins -- a pale plateau
    //     45 deg        1.00x     worst case: everything the same brightness
    //     32 deg        1.60x     terraces separate
    //     20 deg        2.75x     strong raking form
    //
    // At 51 degrees this sun made the cay crown the brightest thing in the frame and
    // every terrace step read as a bright plane above a *darker* riser, so the island
    // looked like a flat sand-coloured table with a rim. The relief was there and the
    // shading was correct; the light was simply pointing the wrong way for the geometry.
    //
    // 30 degrees is mid-morning rather than noon, and that is the cost: it is no longer
    // "tropical midday" literally. Nothing else about the rig changes.
    //
    // The floor on this ratio is about 0.95x rather than 1.0x, because at 45 degrees a
    // wall and a tread are exactly equal and the terracing vanishes completely, which is
    // worse than either extreme. `test/lighting.test.js` asserts the ratio directly: a
    // comment cannot fail, and this one number silently undoes the entire terrain
    // generator.
    sunDir: new THREE.Vector3(0.706, 0.500, 0.502).normalize(),

    /**
     * Key light. Warm, and deliberately several times the fill.
     *
     * The ratio is the whole ballgame. Voxel faces are flat-shaded, so a face gets
     * exactly one normal and therefore exactly one brightness -- the only thing that
     * communicates form on a terraced surface is the contrast between a face pointing
     * at the sun and one pointing away. With the fill near the sun, every face lands
     * within a stop of every other face and the terrain reads as a single flat grey
     * disc no matter how the maths is arranged.
     *
     * Much lower in absolute terms than it used to be (6.2 -> 2.30) and whiter. The
     * whiteness is physical -- a high sun scatters more through the atmosphere, so its
     * direct beam is far less orange than a low one -- and it also stops the lagoon
     * being lit by an orange key, which fought the turquoise rather than warming it.
     */
    sunColor: new THREE.Vector3(2.30, 2.05, 1.72),

    /**
     * Fill light. Weak, cool, and warm-ish from the ground bounce.
     *
     * Weak on purpose: its job is to keep shadowed faces from going pure black,
     * not to light the scene.
     *
     * The "ground" half is bright warm sand rather than the dark earth it used to be,
     * which is what a beach actually bounces back up. That asymmetry -- cool sky above,
     * warm sand below -- is what keeps a shadowed face from going dead grey.
     */
    skyColor: new THREE.Vector3(0.175, 0.255, 0.315),
    groundColor: new THREE.Vector3(0.150, 0.128, 0.100),

    /** Flat ambient term used by the forward chunk/glass materials. */
    ambient: new THREE.Vector3(0.20, 0.26, 0.30),

    // ---------------------------------------------------------------------
    // Sky radiance, kept separate from the fill light on purpose.
    // ---------------------------------------------------------------------
    //
    // These two used to be the same uniform. That is only defensible while both
    // are dim, and it stops being defensible the moment the lighting rig is bright
    // enough to light the terrain: a fill that has to reach ~1.5 to lift stone
    // would drive a 0.8 sky zenith, and the sky clips to flat blue again. The sky
    // is a *background*, not a light source -- its level is chosen so the tone
    // curve lands it in the upper-middle of the display range, not so it lights
    // anything.
    //
    // These values were previously 10x darker, which turned the sky black. The sky
    // is the largest area on screen; leaving it empty is the single most expensive
    // thing the renderer can do.
    //
    // Brightened for the atoll, and the *horizon* more than the zenith: tropical haze
    // scatters light along the ground far more than it does overhead, so the sky is
    // near-white where you look towards the sea and only deepens overhead. A dusk rig
    // with a muddy brown horizon inverts that and makes an ocean look like a desert.
    //
    // Scaled up ~1.36x against `CONFIG.exposure` dropping from 1.7 to 1.25, so the sky
    // lands where it did before while the terrain gains the highlight headroom it was
    // missing. The sky is a background; its brightness is a display decision, and it has
    // no business being coupled to how brightly the sand is lit.
    skyZenith: new THREE.Vector3(0.122, 0.279, 0.598),
    skyHorizon: new THREE.Vector3(0.816, 0.870, 0.898),

    /**
     * Atmosphere. Must be a real colour: fog blends toward it, so a near-black fog
     * makes the world's edge cut off hard against the sky and the terrain reads as an
     * island floating in a void. It is close to the horizon sky stop so distant
     * geometry dissolves into the sky instead of ending at a visible line.
     *
     * This matters more here than anywhere else in the project. The world is now a
     * small island ringed by ocean, and the ocean is exactly the geometry that has to
     * fade rather than stop: the horizon is most of the frame, and a hard edge across
     * it would give the whole illusion away.
     */
    fogColor: new THREE.Vector3(0.680, 0.762, 0.802),

    far: CONFIG.camera.far,
  };
}

export class Pipeline {
  /**
   * @param {import('./context.js').createContext extends any ? any : any} ctx
   * @param {object} quality one of QUALITY
   */
  constructor(ctx, quality = QUALITY.high, chunkMaterials = null) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.env = createEnvironment();
    /** Set by main.js once the chunk materials exist; shared with glass. */
    this.glassUniforms = chunkMaterials ? chunkMaterials.uniforms : null;

    this.quality = quality;
    const size = ctx.size;
    this.targets = new Targets(size.x, size.y, CONFIG);

    // Translucent geometry lives in its own group so the deferred passes can hide
    // it: a G-buffer has nowhere to put a blend, and glass is drawn forward
    // against the G-buffer's depth instead.
    this.glassGroup = new THREE.Group();
    this.glassGroup.name = 'glass';
    ctx.scene.add(this.glassGroup);

    this.csm = new CSM(this.renderer);
    this.lighting = createLightingPass(this.env);
    /** Rebuilds the tile -> light index grid each frame. */
    this.lights = new LightClusterer(size.x, size.y);
    this.composite = createCompositePass();
    this.bright = createBrightPass();
    this.blur = createBlurPass();

    this.stats = { passes: 0, drawCalls: 0, triangles: 0 };
    this._invViewProj = new THREE.Matrix4();
  }

  setQuality(quality) {
    this.quality = quality;
    this.csm.enabled = quality.shadows;
    this.composite.uniforms.uFxaa.value = quality.fxaa ? 1 : 0;
  }

  setSize(width, height) {
    this.targets.setSize(width, height);
    this.lights.setSize(width, height);
    this.lighting.uniforms.uTilePx.value = CONFIG.render.clusterTilePx;
    this.composite.uniforms.uResolution.value.set(width, height);
    this.composite.uniforms.uResolution.value.set(width, height);
  }

  /**
   * Render one frame.
   *
   * @param {number} now performance.now()
   */
  render(now) {
    const { renderer, scene, camera, env, quality } = this;
    const t = this.targets;
    const u = this.lighting.uniforms;

    this.stats.passes = 0;

    // --- 1. shadows ----------------------------------------------------------
    this.csm.update(camera, env.sunDir);
    if (quality.shadows) {
      this.csm.render(scene);
      this.stats.passes++;
    }

    const composite = this.composite.uniforms;
    composite.uExposure.value = CONFIG.exposure;
    composite.uVignette.value = 0.35;
    composite.uSaturation.value = 1.05;
    // From CONFIG rather than a literal, so bloom can be bisected at runtime. It used
    // to be hardcoded here, and that made one class of bug undiagnosable: the composite
    // adds bloom *before* the exposure multiply, so a single non-finite texel in the
    // bloom chain becomes Inf -- and Inf survives any exposure, so the frame reads
    // pure white and lowering the exposure does nothing at all. With the strength in
    // CONFIG, "is it the bloom?" is answerable in one line.
    composite.uBloomStrength.value = CONFIG.bloomStrength;
    composite.uFxaa.value = quality.fxaa ? 1 : 0;
    composite.uResolution.value.set(t.width, t.height);

    // --- 2. G-buffer ---------------------------------------------------------
    renderer.setRenderTarget(t.gbuffer);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    this.stats.passes++;

    const info = renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;

    // --- 3. lighting ---------------------------------------------------------
    u.uGAlbedo.value = t.gAlbedo;
    u.uGNormal.value = t.gNormal;
    u.uGMaterial.value = t.gMaterial;
    u.uDepth.value = t.depthTexture;
    u.uShadowAtlas.value = this.csm.atlasTexture;

    // --- clustered point lights ---------------------------------------------
    // Rebuilt every frame: the grid is a function of the camera, and there are far
    // too few lights for that to be worth caching.
    if (this.propLights && this.propLights.length > 0) {
      this.lights.update(this.propLights, camera);
      u.uLightIndex.value = this.lights.indexTexture;
      u.uLightData.value = this.lights.dataTexture;
    } else {
      // No lights: clear the samplers rather than leaving stale ones bound, which
      // would keep the previous frame's lanterns lit.
      this.lights.update([], camera);
      u.uLightIndex.value = this.lights.indexTexture;
      u.uLightData.value = this.lights.dataTexture;
    }
    u.uShadowTexel.value = 1 / this.csm.atlasSize;
    u.uCameraPos.value.copy(camera.position);
    u.uSplits.value.copy(this.csm.splits);
    u.uTexels.value.copy(this.csm.texels);
    u.uFogDensity.value = CONFIG.fogDensity;

    this._invViewProj
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    u.uInvViewProj.value.copy(this._invViewProj);
    u.uView.value.copy(camera.matrixWorldInverse);

    // Cascade matrices stay pure view-projections; the shader maps the cascade
    // index onto its quadrant of the 2x2 atlas, which is far clearer than
    // folding an offset into the matrix's translation rows.
    for (let i = 0; i < this.csm.cascades.length; i++) {
      const c = this.csm.cascades[i];
      u.uCascadeMat.value[i].multiplyMatrices(
        c.camera.projectionMatrix, c.camera.matrixWorldInverse,
      );
    }

    renderer.setRenderTarget(t.hdr);
    renderer.clear(true, true, false);
    this.lighting.render(renderer, t.hdr);
    this.stats.passes++;

    // --- 4. forward glass ---------------------------------------------------
    // The HDR target shares the G-buffer depth texture, so glass depth-tests
    // against solid geometry without a second geometry pass.
    if (this.glassGroup.children.length > 0) {
      // Glass tests against the G-buffer depth in its own shader, so the HDR
      // target keeps its own depth attachment and the two framebuffers stay
      // independent.
      this.glassUniforms.uSceneDepth.value = t.depthTexture;
      this.glassUniforms.uResolution.value.set(t.width, t.height);

      renderer.setRenderTarget(t.hdr);
      renderer.autoClear = false;
      renderer.render(this.glassGroup, camera);
      renderer.autoClear = true;
      this.stats.passes++;
    }

    // --- 5. bloom -----------------------------------------------------------
    composite.uScene.value = t.hdr.texture;

    this.bright.uniforms.uSource.value = t.hdr.texture;
    this.bright.render(renderer, t.halfA);

    // Two separable passes, the second at double the stride to widen the kernel
    // without another chain of targets.
    const bu = this.blur.uniforms;
    bu.uSource.value = t.halfA.texture;
    bu.uDirection.value.set(1 / t.halfA.width, 0);
    this.blur.render(renderer, t.halfB);

    bu.uSource.value = t.halfB.texture;
    bu.uDirection.value.set(0, 1 / t.halfA.height);
    this.blur.render(renderer, t.halfC);

    bu.uSource.value = t.halfC.texture;
    bu.uDirection.value.set(2 / t.halfA.width, 0);
    this.blur.render(renderer, t.halfD);

    composite.uBloom.value = t.halfD.texture;
    this.stats.passes += 4;

    // --- 6. composite -------------------------------------------------------
    this.composite.render(renderer, null);
    this.stats.passes++;
    renderer.setRenderTarget(null);
  }

  dispose() {
    this.targets.dispose();
    this.csm.dispose();
    this.lights.dispose();
    this.lighting.dispose();
    this.composite.dispose();
    this.bright.dispose();
    this.blur.dispose();
  }
}