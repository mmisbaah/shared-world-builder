/**
 * Renderer, camera and input.
 *
 * The camera rig is written here rather than pulled from the addons because the
 * control scheme is part of the spec (right-drag orbits, middle-drag pans) and
 * because placement needs the pointer position in world space on every mousemove,
 * not just on click -- the ghost block follows the cursor continuously.
 *
 * WebGL2 is required, not preferred: the G-buffer is multiple render targets and
 * the occlusion and volumetric passes rely on float render targets with linear
 * filtering. A WebGL1 context would fail at the first pass, so the boot gate
 * checks for it up front and says so plainly.
 */

import * as THREE from 'three';

import { CONFIG } from '../config.js';

/** Just outside the buildable radius, so panning cannot lose the world. */
const WORLD_EDGE = 44;

/** Thrown when the browser cannot run the pipeline at all. */
export class WebGL2Unavailable extends Error {}

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} dom
   */
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3(0, 4, 0);

    this.minDistance = CONFIG.camera.minDistance;
    this.maxDistance = CONFIG.camera.maxDistance;

    // Spherical offset from the target.
    this.theta = Math.atan2(CONFIG.camera.start[0], CONFIG.camera.start[2]);
    this.phi = Math.acos(
      THREE.MathUtils.clamp(CONFIG.camera.start[1] / this._startRadius(), -1, 1),
    );
    this.radius = this._startRadius();

    this._dragging = null;
    this._last = { x: 0, y: 0 };
    this.enabled = true;

    this._bind();
    this.apply();
  }

  _startRadius() {
    const [x, y, z] = CONFIG.camera.start;
    return Math.max(1, Math.hypot(x, y, z));
  }

  /**
   * Begin a drag from a pointer event, if the button maps to a camera action.
   *
   * @returns {'orbit'|'pan'|null}
   */
  beginDrag(e) {
    if (!this.enabled) return null;

    let mode = null;
    if (e.button === 2) mode = 'orbit';
    else if (e.button === 1) mode = 'pan';
    if (!mode) return null;
    return this._begin(mode, e);
  }

  /**
   * Start orbiting at the pointer's *current* position.
   *
   * Used for the left button, where the press and the decision to orbit are
   * separated by a movement threshold. Seeding `_last` from the current position
   * rather than the original press is what stops the camera snapping by the whole
   * threshold distance on the first move.
   */
  startOrbit(e) {
    if (!this.enabled) return null;
    return this._begin('orbit', e);
  }

  _begin(mode, e) {
    this._dragging = mode;
    this._last = { x: e.clientX, y: e.clientY };
    this._pointerId = e.pointerId;
    // Pointer capture keeps the drag alive when the cursor leaves the canvas.
    // Wrapped because it throws for a pointer id the element never received, and
    // a throw here would abort the whole pointerdown handler.
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    return mode;
  }

  /** Finish a drag. Safe to call when no drag is active. */
  endDrag(e) {
    if (!this._dragging) return;
    this._dragging = null;
    try {
      if (e?.pointerId !== undefined && this.dom.hasPointerCapture?.(e.pointerId)) {
        this.dom.releasePointerCapture(e.pointerId);
      }
    } catch { /* not fatal */ }
    this._pointerId = null;
  }

  /** True while the camera is being driven, so main.js can suppress hover. */
  get isDragging() {
    return this._dragging !== null;
  }

  _bind() {
    const dom = this.dom;

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.button === 2) this._dragging = 'orbit';
      else if (e.button === 1) this._dragging = 'pan';
      else return; // left button belongs to placement
      this._last = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last = { x: e.clientX, y: e.clientY };

      if (this._dragging === 'orbit') {
        this.theta -= dx * 0.005;
        // Clamped short of the poles: exactly vertical makes phi degenerate and
        // the up vector ambiguous, which shows up as a camera that spins.
        this.phi = THREE.MathUtils.clamp(this.phi - dy * 0.005, 0.02, Math.PI - 0.02);
      } else {
        this._pan(dx, dy);
      }
      this.apply();
    });

    const end = (e) => {
      if (!this._dragging) return;
      this._dragging = null;
      if (dom.hasPointerCapture?.(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);

    // Keyboard orbit. The mouse bindings above need a right button, a middle
    // button, or a trackpad gesture, and on a plain laptop or a touch screen none
    // of those exist -- which leaves no way to turn the world at all. These are the
    // only bindings guaranteed to be available on every device.
    //
    // Bound to `window`, not the canvas: a canvas-level listener only fires while
    // the canvas holds focus, so arrow keys would silently do nothing until the
    // player happened to click the world first. Text entry is excluded so this
    // cannot swallow typing if an input is ever added.
    const orbitKeys = new Set([
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'KeyA', 'KeyD', 'KeyW', 'KeyS',
    ]);
    const isTextEntry = (el) => el && (
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    );

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEntry(e.target)) return;
      if (!orbitKeys.has(e.code)) return;

      const step = e.shiftKey ? 0.22 : 0.09;
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': this.theta += step; break;
        case 'ArrowRight': case 'KeyD': this.theta -= step; break;
        case 'ArrowUp': case 'KeyW':
          this.phi = THREE.MathUtils.clamp(this.phi - step * 0.7, 0.02, Math.PI - 0.02); break;
        case 'ArrowDown': case 'KeyS':
          this.phi = THREE.MathUtils.clamp(this.phi + step * 0.7, 0.02, Math.PI - 0.02); break;
        default: return;
      }
      this.apply();
      e.preventDefault();
    };
    window.addEventListener('keydown', this._onKeyDown);

    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const scale = Math.exp(e.deltaY * 0.0012);
      this.radius = THREE.MathUtils.clamp(this.radius * scale, this.minDistance, this.maxDistance);
      this.apply();
    }, { passive: false });
  }

  /** Screen-space pan, scaled by distance so it feels the same at any zoom. */
  _pan(dx, dy) {
    const scale = this.radius * 0.0016;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
    this.target.x = THREE.MathUtils.clamp(this.target.x, -WORLD_EDGE, WORLD_EDGE);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -WORLD_EDGE, WORLD_EDGE);
  }

  apply() {
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Remove listeners this rig owns. */
  dispose() {
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    this._onKeyDown = null;
  }

  /** Frame a world point, for the F key and for following another builder. */
  focus(point, distance) {
    this.target.set(point.x, point.y, point.z);
    if (distance) this.radius = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
    this.apply();
  }
}

/**
 * @param {HTMLElement} container
 */
export function createContext(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: false, // the pipeline resolves its own edges with FXAA
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
  } catch (err) {
    throw new WebGL2Unavailable('could not create a WebGL context');
  }

  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new WebGL2Unavailable('this browser reports WebGL1 only');
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 1);

  // Debug view is a scissored viewport quad; it needs the default framebuffer,
  // not the offscreen HDR target.
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far,
  );

  container.appendChild(renderer.domElement);
  renderer.domElement.id = 'gl';

  const rig = new CameraRig(camera, renderer.domElement);

  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // Report the unmasked renderer string when the browser will give it up; it is
  // the single most useful line when a pass is unexpectedly slow.
  let adapter = 'unknown';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    adapter = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* not available; harmless */ }

  return {
    renderer, scene, camera, rig, resize, adapter,
    get size() {
      return new THREE.Vector2(
        Math.floor(container.clientWidth * renderer.getPixelRatio()),
        Math.floor(container.clientHeight * renderer.getPixelRatio()),
      );
    },
    dispose() {
      window.removeEventListener('resize', resize);
      // The rig now owns a window-level keydown listener, so it has to come back
      // off with everything else or a disposed context keeps orbiting the camera.
      rig.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Normalised device coordinates for a pointer event over the canvas. */
export function pointerNdc(event, dom, target = new THREE.Vector2()) {
  const rect = dom.getBoundingClientRect();
  target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  target.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return target;
}