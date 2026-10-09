/**
 * Application entry point.
 *
 * Boot order matters and is explicit:
 *   context -> pipeline -> world -> mesh pool -> socket
 *
 * The socket comes last because the snapshot it delivers is what gives the mesh
 * pool anything to build. Connecting first would mean meshing an empty world and
 * then re-meshing everything one tick later.
 */

import * as THREE from 'three';

import { CONFIG, QUALITY, QUALITY_ORDER, MATERIALS, PROPS } from './config.js';
import { World } from './world/world.js';
import { MeshManager } from './world/meshManager.js';
import { createChunkMaterials } from './render/shaders.js';
import { createEnvironment } from './render/pipeline.js';
import { createContext, pointerNdc, WebGL2Unavailable } from './render/context.js';
import { Pipeline } from './render/pipeline.js';
import { Connection } from './net/connection.js';
import { pick, placementCell } from './interact/picking.js';
import { WorldOverlay } from './interact/overlay.js';
import { PropRenderer } from './world/props.js';
import { collectPropLights } from './render/lights.js';
import { HUD, escapeHtml } from './ui/hud.js';
import { ObjectivePanel, ObjectiveBanner } from './ui/objectivePanel.js';
import { Minimap } from './ui/minimap.js';
import { ClaimPanel } from './ui/claimPanel.js';
import { Coach, wasCoached, rememberCoached } from './ui/coach.js';
import { Sfx } from './audio/sfx.js';
import { playEvents } from './audio/events.js';
import { SFX, VoiceBudget, ambienceFor, surfaceUnder } from './audio/voice.js';

const hud = new HUD();

async function main() {
  hud.boot(0.05, 'Checking WebGL2 support…');

  // --- context --------------------------------------------------------------
  let ctx;
  try {
    ctx = createContext(document.getElementById('viewport'));
  } catch (err) {
    if (err instanceof WebGL2Unavailable) {
      hud.fatal('This build needs WebGL2.', err.message);
      return;
    }
    hud.fatal('Could not create a renderer.', String(err));
    return;
  }

  hud.boot(0.2, 'Building deferred pipeline…');
  const env = createEnvironment();
  // The chunk materials are built before the pipeline so their shared uniform
  // object -- which the pipeline's forward glass pass writes scene depth into --
  // is the same object both stages see.
  const materials = createChunkMaterials(env);

  let quality = QUALITY.high;
  let pipeline;
  try {
    pipeline = new Pipeline(ctx, quality, materials);
  } catch (err) {
    hud.fatal('Shader pipeline failed to build.', String(err?.stack || err));
    throw err;
  }

  hud.boot(0.4, 'Preparing chunk meshers…');
  const world = new World();

  const opaqueGroup = new THREE.Group();
  opaqueGroup.name = 'opaque';
  ctx.scene.add(opaqueGroup);

  const meshManager = new MeshManager(
    world,
    { opaque: opaqueGroup, glass: pipeline.glassGroup },
    materials,
    CONFIG,
  );

  // The overlay draws in world space and must survive the deferred passes, so it
  // is hidden from the G-buffer like glass and drawn forward with it.
  ctx.scene.add(pipeline.glassGroup);

  hud.boot(0.6, 'Connecting to the world…');
  const conn = new Connection(world, CONFIG);
  await conn.connect();

  const overlay = new WorldOverlay(ctx.scene);
  const props = new PropRenderer(ctx.scene);

  // --- claim panel ---------------------------------------------------------
  // Reads the server's decay verdict rather than counting down locally. Two clients
  // would otherwise disagree about whether a claim is still alive, and the client
  // that is wrong is the one that matters.
  const claimPanel = new ClaimPanel(document.getElementById('claim'));

  // --- first-run coach -----------------------------------------------------
  // Advances only on real actions, never on a timer. See ui/coach.js for why the
  // first instruction is "click the ground" rather than the ladder's own "place a
  // lantern": the goal is the tutorial, but a new player's hand does not go to the
  // decor palette first.
  const coach = new Coach({ started: wasCoached() });
  const coachEl = document.getElementById('coach');
  /** Set once an objective payload has arrived, so the coach can wait for one. */
  let sawObjective = false;

  function renderCoach() {
    if (!coachEl) return;
    if (!coach.active) {
      coachEl.classList.add('gone');
      if (!coach.finishedSeen) { coach.finishedSeen = true; rememberCoached(); }
      return;
    }
    const step = coach.current();
    coachEl.classList.remove('gone');
    coachEl.innerHTML = `
      <div class="coach-step">${escapeHtml(step.title)}</div>
      <div class="coach-body">${escapeHtml(step.body)}</div>
      <button class="coach-skip" type="button">skip</button>
    `;
    const skip = coachEl.querySelector('.coach-skip');
    if (skip) skip.onclick = () => { coach.dismiss(); renderCoach(); rememberCoached(); };
  }
  renderCoach();

  /**
   * Offer the coach the current world state; it decides whether that is enough.
   *
   * `pump` asks whether the *current step* is satisfied, rather than being told which
   * signal fired. That is what keeps it from stalling when a later step's evidence
   * arrives before its own.
   */
  function pumpCoach() {
    if (!coach.active) return;
    const r = coach.pump({
      accepted: conn.stats.accepted,
      clicked: coachClicked,
      hasClaim: !!conn.myClaim,
      sawObjective,
    });
    if (!r.changed) return;
    renderCoach();
    if (r.finished) {
      hud.toast('You have the hang of it', 'good');
      sfx.play(SFX.OBJECTIVE, { gain: 0.6 });
    }
  }

  /**
   * Blocks the swarm has committed, for the coach's "watch the bots" step.
   *
   * Read from the server rather than counted client-side: the client never sees a
   * bot's commit as an accepted op of its own, so any local count would be zero and
   * that step would never complete.
   */
  /**
   * Anchors the player has activated, for the steps that ask them to click something.
   *
   * Delegated from `document` rather than bound per element, because the panels are
   * re-rendered (the objective panel rebuilds on every server payload) and a listener
   * bound to a node that gets replaced stops firing. That is a silent, maddening
   * failure: the coach would sit on a step forever waiting for a click that the game
   * had stopped listening for.
   */
  const coachClicked = new Set();
  document.addEventListener('pointerdown', (e) => {
    const hit = e.target?.closest?.('#builders, #objectives');
    if (hit) coachClicked.add('#' + hit.id);
  }, true);

  // --- audio ---------------------------------------------------------------
  // Created before the connection so nothing that happens during load is missed,
  // but *started* on the first user gesture, because no browser will run an
  // AudioContext without one.
  const sfx = new Sfx();
  const budget = new VoiceBudget();
  sfx.onVoiceEnd = (id) => budget.release(id);

  /** Bot ids, rebuilt each frame from the live roster. */
  const botIds = new Set();

  /**
 * Play one sound, subject to the budget.
   *
   * The budget gates first so a refused sound costs nothing. The SFX voice id is
   * then used directly as the budget's token, which keeps a single id space: when
   * the sound finishes, `onVoiceEnd` hands the very same id back and the slot
   * frees. If synthesis refuses after the budget admitted, nothing was registered,
   * so there is deliberately nothing to release.
   */
  function sound(name, opts, who) {
    if (!budget.allow(name, who, performance.now())) return false;
    const voice = sfx.play(name, { ...opts, who });
    if (!voice) return false;
    budget.start(voice);
    return true;
  }

  // World point -> view space. Kept as a closure over one scratch vector so the
  // audio path never allocates during a burst of edits.
  const _audioV = new THREE.Vector3();
  sfx.locator = (x, y, z) => {
    _audioV.set(x, y, z).applyMatrix4(ctx.camera.matrixWorldInverse);
    return { x: _audioV.x, dist: Math.hypot(_audioV.x, _audioV.y, -_audioV.z) };
  };

  // Mute is a preference, so it survives a reload. Without this, every refresh
  // blasts a burst of bot placement noise at someone who has already muted it.
  const MUTE_KEY = 'swb.muted';
  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch { muted = false; }
  sfx.muted = muted;

  function setMuted(next) {
    muted = !!next;
    sfx.setMuted(muted);
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    hud.setAudioLabel(muted);
    hud.log(muted ? 'audio muted' : 'audio on');
    return muted;
  }

  const audioButton = document.getElementById('btn-audio');
  if (audioButton) {
    audioButton.onclick = () => {
      setMuted(!muted);
      // Unmuting is also the gesture that starts the context, so the first sound
      // is the one that proves it works.
      if (!muted) sfx.unlock().then((ok) => { if (ok) sfx.play(SFX.UI); });
    };
  }
  hud.setAudioLabel(muted);

  // The first gesture of any kind starts audio. Four separate listeners rather than
  // one on the canvas, because the player might only ever press a key.
  let audioStarted = false;
  const startAudio = () => {
    if (audioStarted) return;
    audioStarted = true;
    sfx.unlock().then((ok) => {
      if (ok && !muted) sfx.play(SFX.READY);
    });
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(ev, startAudio);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, startAudio, { passive: true });
  }

  // --- interaction state ---------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const state = {
    tool: 'build',
    selection: { id: 1, kind: 'block' },
    hover: null,
    ghost: null,
    propRot: 0,
    botsEnabled: true,
    showGrid: false,
    qualityIndex: QUALITY_ORDER.indexOf('high'),
    /** Half-width of a claim, so C2 and C4 are different-sized districts. */
    claimHalf: 6,
  };

  let latestEvents = [];
  /**
   * Ephemeral cursors from other builders, keyed by builder id. Fed to the overlay;
   * pruned on a TTL each frame so an idle player's box fades instead of sticking.
   */
  const peerCursors = new Map();

  /**
   * Timestamp of the last ambient-bed sample. Starts at -Infinity so the very first
   * frame picks a bed rather than sitting on the default until the interval elapses.
   */
  let lastAmbienceAt = -Infinity;

  conn.on('welcome', (msg) => {
    hud.log(`joined as ${msg.you.name}`, 'good');
    hud.toast(`Welcome, ${msg.you.name}`, 'good');
    ctx.rig.focus(new THREE.Vector3(0, 4, 0), 46);
  });
  conn.on('presence', () => {
    hud.setPresence([...conn.builders.values()], conn.bots, conn.selfId);
  });
  conn.on('zones', () => hud.log('claimed-zone list updated'));
  conn.on('locks', () => { /* redrawn every frame from conn.locks */ });

  // --- objectives ----------------------------------------------------------
  // The payload is a server verdict. Rendering it is the client's only job, and
  // the banner fires when the server says an objective completed rather than when
  // progress merely changed -- so the celebration cannot fire early.
  const objectivePanel = new ObjectivePanel(document.getElementById('objectives'));
  const objectiveBanner = new ObjectiveBanner();

  conn.on('objectives', () => {
    // The coach waits for a real objective payload before pointing at the panel. An
    // empty panel that fills in a second later is not something to say "read this"
    // about.
    sawObjective = true;
    const completedId = objectivePanel.update(conn.objectives);
    if (completedId) {
      const p = conn.objectives;
      const def = p?.active?.find((o) => o.id === completedId);
      objectiveBanner.show(def);
      hud.log(`objective complete: ${def?.title ?? completedId}`, 'good');
      // Deliberately outside the voice budget: this is the reward, it is not
      // something the player caused directly, and a busy stretch of bot building
      // must never be able to swallow it.
      sfx.play(SFX.OBJECTIVE, { gain: 1 });

      // Crossing out of the scripted campaign into the endless tail is the one
      // transition that only ever happens once, so it gets its own sting and its
      // own banner. Both are *chained* onto the normal reward rather than placed
      // beside it: two celebrations at the same instant read as one louder
      // noise, and neither sentence gets read. The id check is what keeps a
      // routine tail completion from ever re-triggering this.
      const doneIdx = p?.active?.findIndex((o) => o.id === completedId) ?? -1;
      const campaign = typeof p?.campaign === 'number' ? p.campaign : -1;
      if (campaign >= 0 && doneIdx === campaign - 1) {
        setTimeout(() => sfx.play(SFX.VICTORY, { gain: 1 }), 550);
        hud.log('campaign complete — endless objectives begin', 'good');
        setTimeout(() => objectiveBanner.showCampaign(), 4400);
      }
    }
  });

  // --- palette / buttons ---------------------------------------------------
  // The palette reports the tool and the selection together, so these can never
  // disagree. Previously `state.tool` was only set by the keyboard shortcuts,
  // which made clicking Build and Destroy behave identically.
  const palette = hud.buildPalette((entry, tool) => {
    state.selection = entry;
    state.tool = tool;
    // Palette picks are pure feedback, so they bypass the budget: a cooldown that
    // dropped the second click in a fast selection would feel like a broken UI.
    sfx.play(SFX.UI, { gain: 0.8, pitch: tool === 'destroy' ? 0.75 : 1 });
  });

  document.getElementById('btn-conflict').onclick = () => {
    if (!state.ghost) {
      hud.toast('Point at a buildable cell first', 'warn');
      return;
    }
    // The server commits a rival block at the target voxel and then denies us,
    // producing a genuine OCCUPIED to reconcile against rather than a fake error.
    const cell = state.ghost;
    conn.placeBlock(cell.x, cell.y, cell.z, MATERIALS[cell.pendingMat ?? 1]?.id ?? 1, {
      forceRace: true,
    });
    hud.log('forced a race at the ghost cell', 'warn');
  };

  // --- territory ------------------------------------------------------------
  // Claim and release used to exist on the connection with no way to reach them,
  // which meant the entire ownership system was server state no player could touch.
  // Decay only matters once a player can actually hold something.
  function claimAtCentre(size) {
    // Anchored on the camera target, not the cursor: a claim is about a district,
    // and the cursor is usually pointing at a detail inside one.
    const { x, z } = ctx.rig.target;
    conn.claimZone(Math.round(x), Math.round(z), size);
    hud.log(`claimed ${size * 2}x${size * 2} at ${Math.round(x)},${Math.round(z)}`, 'good');
  }

  const btnClaim = document.getElementById('btn-claim');
  if (btnClaim) btnClaim.onclick = () => claimAtCentre(state.claimHalf);

  function syncClaimButton() {
    if (!btnClaim) return;
    const mine = conn.myClaim;
    btnClaim.classList.toggle('btn-indigo', !mine);
    btnClaim.classList.toggle('is-held', !!mine);
    const label = btnClaim.querySelector('span');
    if (label) label.textContent = mine ? 'Release' : 'Claim';
    btnClaim.title = mine
      ? 'Release your territory (C)'
      : `Claim ${state.claimHalf * 2}x${state.claimHalf * 2} around the camera (C, or Shift+C to resize)`;
    btnClaim.setAttribute('aria-pressed', mine ? 'true' : 'false');
  }

  conn.on('zones', () => {
    syncClaimButton();
    const others = conn.zones.filter((z) => z.ownerId !== conn.selfId).length;
    claimPanel.update(conn.myClaim, others);
  });
  conn.on('claimLost', (msg) => {
    hud.log(`claim on ${msg.x},${msg.z} decayed -- build there to hold ground`, 'warn');
    hud.toast('Your claim expired. Build there to hold it again.', 'warn');
    sound(SFX.CONFLICT, { x: msg.x, y: 4, z: msg.z }, 'self');
    syncClaimButton();
  });
  syncClaimButton();

  document.getElementById('btn-bots').onclick = (e) => {
    state.botsEnabled = !state.botsEnabled;
    conn.setBotsEnabled(state.botsEnabled);
    hud.setBotsLabel(state.botsEnabled ? 'Pause bots' : 'Resume bots');
    hud.log(state.botsEnabled ? 'bots resumed' : 'bots paused');
    e.currentTarget.classList.toggle('btn-indigo', !state.botsEnabled);
  };

  document.getElementById('btn-quality').onclick = () => {
    state.qualityIndex = (state.qualityIndex + 1) % QUALITY_ORDER.length;
    const key = QUALITY_ORDER[state.qualityIndex];
    quality = QUALITY[key];
    pipeline.setQuality(quality);
    hud.setQualityLabel(key, QUALITY[key].label);
    hud.log(`quality: ${QUALITY[key].label}`);
  };
  hud.setQualityLabel('high', QUALITY.high.label);

  // --- pointer -------------------------------------------------------------
  const canvas = ctx.renderer.domElement;

  function updateHover(event) {
    pointerNdc(event, canvas, ndc);
    raycaster.setFromCamera(ndc, ctx.camera);
    origin.copy(raycaster.ray.origin);
    direction.copy(raycaster.ray.direction);

    const hit = pick(world, origin, direction, { maxDist: 120 });
    state.hover = hit;
    if (hit) conn.sendCursor(hit);
    if (!hit) { state.ghost = null; return; }

    // Build and decor place *beside* what was hit; destroy removes *what* was
    // hit. Using placementCell for all three made destroy target the empty cell
    // next to a block, so it always tried to remove air and was always denied.
    const removing = state.tool === 'destroy';
    const cell = removing
      ? { x: hit.x, y: hit.y, z: hit.z }
      : placementCell(hit);
    if (!cell) { state.ghost = null; return; }

    let mat = 1;
    if (state.tool === 'build') mat = Number(state.selection.id);
    else if (state.tool === 'destroy') mat = 0;

    const inBounds = cell.y >= 0 && cell.y < CONFIG.worldHeight;
    const free = !world.isSolid(cell.x, cell.y, cell.z) && !world.getProp(cell.x, cell.y, cell.z);
    const locked = !!conn.lockHolder(cell.x, cell.y, cell.z);
    const zone = conn.zoneAt(cell.x, cell.z);
    const mine = !zone || zone.ownerId === conn.selfId;

    // The server refuses a prop with nothing beneath it. Checking the same rule
    // here means the ghost is red before the click rather than the server
    // silently denying it afterwards.
    const propOk = state.tool !== 'decor'
      || (cell.y > 0 && world.isSolid(cell.x, cell.y - 1, cell.z));

    let reason = null;
    if (locked) reason = 'locked by another builder';
    else if (!mine) reason = 'inside another builder\'s claim';
    else if (!inBounds) reason = 'outside build bounds';
    else if (state.tool === 'decor' && !propOk) reason = 'props need solid ground beneath';

    state.ghost = {
      ...cell,
      valid: inBounds && (removing ? hit.kind !== 'ground' : free) && !locked && mine && propOk,
      locked,
      pending: world.hasPrediction(cell.x, cell.y, cell.z),
      // Carry the material only for Build. Decor places a prop, not a block, so leaving a
      // material id here would make the ghost preview 'stone' -- which reads as wrong
      // after a material-preview was added to the build ghost.
      pendingMat: state.tool === 'build' ? mat : 0,
      // Decor carries the prop itself so the ghost can be drawn at the prop's real
      // size and facing instead of as a generic cube. Empty string for Build --
      // `String('')` is falsy, so the overlay's lookup is skipped outright.
      prop: state.tool === 'decor' ? String(state.selection.id) : '',
      rot: state.tool === 'decor' ? state.propRot : 0,
      reason,
    };
  }

  // Left button: place on click, orbit on drag.
  //
  // This is decided on *movement*, not on what was under the cursor. An earlier
  // version only orbited when the press missed all geometry, on the reasoning that
  // a press on terrain "means" placement -- which is wrong, because every 3D
  // builder and editor treats left-drag anywhere as look-around, and a player who
  // grabs the world to turn it gets nothing. From their side that is identical to
  // rotation being broken, which is exactly how it was reported.
  //
  // So the press is always recorded, and it becomes a drag once it travels past a
  // threshold. Only a press that never travels that far is treated as a click.
  const DRAG_THRESHOLD = 5;

  let downAt = null;

  canvas.addEventListener('pointermove', (e) => {
    if (downAt && downAt.button === 0) {
      const travelled = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt.travelled = Math.max(downAt.travelled, travelled);

      if (!downAt.orbiting && downAt.travelled > DRAG_THRESHOLD) {
        // Promoted to a camera drag. Seeding from the current position keeps the
        // camera from jumping by the threshold distance on this first move.
        downAt.orbiting = ctx.rig.startOrbit(e) !== null;
        state.ghost = null;
      }
      // Once orbiting, the rig owns the motion; the ghost is hidden anyway.
      return;
    }
    if (!ctx.rig.isDragging) updateHover(e);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || e.button === 2) return; // the rig binds these itself
    if (e.button !== 0) return;
    downAt = {
      button: e.button, x: e.clientX, y: e.clientY,
      travelled: 0, orbiting: false, t: performance.now(),
    };
    updateHover(e);
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 1 || e.button === 2) return;
    if (e.button !== 0 || !downAt) return;

    const wasDrag = downAt.orbiting;
    downAt = null;
    if (wasDrag) {
      ctx.rig.endDrag(e);
      // Re-pick under the cursor so the ghost is correct for wherever the camera
      // ended up, rather than left showing nothing.
      updateHover(e);
      return;
    }
    act(e);
  });

  // A pointer cancelled mid-press (window blur, touch gesture taken over) must
  // not leave the rig stuck in a drag, which would silently kill every later
  // click-to-place.
  canvas.addEventListener('pointercancel', (e) => {
    downAt = null;
    ctx.rig.endDrag(e);
  });

  function act(event) {
    updateHover(event);
    const g = state.ghost;
    if (!g) return;
    if (g.locked) { hud.toast('another builder holds that voxel', 'warn'); return; }

    if (state.tool === 'destroy') {
      if (world.getProp(g.x, g.y, g.z)) conn.removeProp(g.x, g.y, g.z);
      else conn.removeBlock(g.x, g.y, g.z);
      return;
    }

    if (state.tool === 'decor') {
      if (!g.valid) { hud.toast('no room for that prop here', 'warn'); return; }
      conn.placeProp(g.x, g.y, g.z, state.selection.id, state.propRot);
      return;
    }

    if (!g.valid) { hud.toast(g.reason ?? 'cannot build there', 'warn'); return; }
    conn.placeBlock(g.x, g.y, g.z, Number(state.selection.id));
  }

  // --- undo ---------------------------------------------------------------
  // The server owns the history. The count here exists only so the control can
  // say whether there is anything to send -- a client that named the voxel to
  // revert would be reaching work it did not do.
  const btnUndo = document.getElementById('btn-undo');
  let shownUndoDepth = -1;

  function syncUndoButton() {
    if (conn.undoDepth === shownUndoDepth) return;
    shownUndoDepth = conn.undoDepth;
    btnUndo.disabled = conn.undoDepth <= 0;
    btnUndo.title = conn.undoDepth > 0
      ? `Undo your last edit (Z) - ${conn.undoDepth} left`
      : 'Nothing to undo yet (Z)';
  }

  function doUndo() {
    // Answered rather than ignored: a key that appears to do nothing is worse
    // than one that says why it could not.
    if (!conn.undo()) {
      hud.toast('nothing to undo', 'warn');
      sound(SFX.DENY, {}, 'self');
      syncUndoButton();
    }
  }

  btnUndo.onclick = doUndo;
  syncUndoButton();

  window.addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
      case 'z': doUndo(); break;
      case 'r': state.propRot = (state.propRot + 1) % 4; break;
      case 'g': state.showGrid = !state.showGrid; break;
      case 'f': hud.toggleStats(); break;
      case 'm': setMuted(!muted); break;
      case 'c': {
        // Shift+C resizes first, because "claim" and "resize" are the same verb and
        // forcing a release to change size would be tedious.
        if (e.shiftKey) {
          state.claimHalf = state.claimHalf >= 10 ? 4 : state.claimHalf + 2;
          hud.log(`claim size: ${state.claimHalf * 2}x${state.claimHalf * 2}`);
        }
        if (conn.myClaim) {
          conn.releaseZone();
          hud.log('released your claim', 'warn');
        } else {
          claimAtCentre(state.claimHalf);
        }
        syncClaimButton();
        break;
      }
      // setTool redraws the palette but does not notify, so state.tool is set
      // explicitly here and the callback picks it up on the next interaction.
      case '1': state.tool = 'build'; palette.setTool('build'); break;
      case '2': state.tool = 'decor'; palette.setTool('decor'); break;
      case '3': state.tool = 'destroy'; palette.setTool('destroy'); break;
      default: return;
    }
    e.preventDefault();
  });

  // --- resize --------------------------------------------------------------
  const onResize = () => {
    ctx.resize();
    const s = ctx.size;
    pipeline.setSize(s.x, s.y);
  };
  window.addEventListener('resize', onResize);

  // --- minimap -------------------------------------------------------------
  // Redraws at a fixed low rate rather than every frame. The map changes only when
  // someone builds, and rasterising 80x80 columns every frame at 60 Hz would spend
  // real time producing identical pixels.
  const minimap = new Minimap(document.getElementById('minimap-host'), {
    onPick: (cell) => ctx.rig.focus(
      new THREE.Vector3(cell.x, ctx.rig.target.y, cell.z),
    ),
  });

  // --- frame loop ----------------------------------------------------------
  hud.boot(1, 'Ready');
  hud.bootDone();
  hud.setPresence([...conn.builders.values()], conn.bots, conn.selfId);
  hud.log(`adapter: ${String(ctx.adapter).slice(0, 48)}`);

  let last = performance.now();
  let pingClock = 0;
  let minimapClock = 0;
  let minimapSurfaceClock = 0;

  /**
   * Count of frames that threw, for the console and the HUD.
   *
   * Kept because the alternative -- a frame loop that dies silently -- is the worst
   * failure mode this client has: the HUD keeps updating, so every number in it
   * looks alive, while nothing is actually being rendered. It cost a real debugging
   * session to diagnose a blank world whose stats read 0 and whose socket read
   * "reconnecting".
   */
  let frameErrors = 0;

  function frame(now) {
    const dt = now - last;
    last = now;

    // Always reschedule, whatever happens below.
    //
    // `requestAnimationFrame` used to sit at the *bottom* of the frame, so any throw
    // in any subsystem -- a prop with no recipe, a malformed delta, a shader
    // uniform that went NaN -- permanently stopped the loop. The symptom is
    // indistinguishable from "the world failed to load": the DOM is still there, the
    // HUD still shows text, and only the absence of motion gives it away.
    //
    // Rescheduling first costs nothing and makes the loop survive anything. The catch
    // is there so one bad frame degrades to one bad frame rather than a frozen one.
    requestAnimationFrame(frame);

    try {
      step(now, dt);
    } catch (err) {
      frameErrors++;
      console.error('[frame]', err);
      // Report once rather than every frame, so a persistent fault does not bury
      // the console and make the original error harder to find.
      if (frameErrors === 1) hud.log('a render frame failed; see the console', 'bad');
    }
  }

  function step(now, dt) {

    conn.update(now);
    if (now - pingClock > 1000) { pingClock = now; if (conn.connected) conn.ping(); }

    // The coach is pumped here rather than on individual events, because what it cares
  // about is *state* ("has the player built anything yet"), not transitions. A signal
  // that arrived while a step was not yet waiting would be missed by an event-driven
  // version, and the step would then never complete.
  pumpCoach();

  // Drain network events into the sound, the log, and the conflict counters.
    // The mapping lives in audio/events.js so it can be tested without a
    // requestAnimationFrame, which does not run in every environment this has to
    // be verifiable in.
    latestEvents = conn.drainEvents();
    // The count moves when an edit is acknowledged or an undo lands, neither of
    // which the player clicks for, so the control is re-evaluated here. The
    // early return makes it a comparison on the common path.
    syncUndoButton();

    // Ephemeral remote cursors. Each incoming cursor stamps the sender's cell; the
    // boxes then age out on a TTL, because a cursor that is never re-aimed by idling out
    // must fade rather than freeze mid-jump -- otherwise the last known box hangs there
    // like a second selection box.
    for (const ev of latestEvents) {
      if (ev.type === 'cursor' && ev.id) {
        peerCursors.set(ev.id, { id: ev.id, name: ev.name, color: ev.color, x: ev.x, y: ev.y, z: ev.z, at: now });
      }
    }
    for (const [id, p] of peerCursors) {
      if (now - p.at > 2600) peerCursors.delete(id);
    }

    // Rebuilt each frame from four entries: cheap, and it means a bot that joins or
    // leaves is classified correctly from the very next delta.
    botIds.clear();
    for (const b of conn.bots) botIds.add(b.id);

    playEvents(latestEvents, {
      play: sound,
      selfId: conn.selfId,
      botIds,
      log: (text, kind) => hud.log(text, kind),
      toast: (text, kind) => hud.toast(text, kind),
    });

    materials.uniforms.uTime.value = now * 0.001;

    meshManager.update(now, ctx.rig.target.x, ctx.rig.target.z);
    meshManager.cull(ctx.camera.position.x, ctx.camera.position.z, CONFIG.meshRadius);

    // The ambient bed follows what is under the camera -- surf on the shore, a low
    // rumble over the lagoon, wind on the crown -- so the island sounds like where
    // you are looking rather than like one continuous drone.
    //
    // Sampled a few times a second rather than per frame. A column scan is cheap
    // (one read per level of one column) but the value it produces changes a handful
    // of times a minute, so paying for it sixty times a second only buys jitter.
    if (now - lastAmbienceAt > 350) {
      lastAmbienceAt = now;
      const top = surfaceUnder(
        (x, y, z) => world.getVoxel(x, y, z),
        Math.round(ctx.rig.target.x),
        Math.round(ctx.rig.target.z),
      );
      sfx.setAmbience(ambienceFor(top.mat, top.y));
    }

    // Props are instanced and rebuilt wholesale, which is cheaper than diffing at
    // this scale and cannot drift out of sync with a missed add or remove.
    props.sync(world);
    pipeline.propLights = collectPropLights(props.collect(), conn.builders);

    // Minimap: the surface scan is the expensive half and runs at ~2.5 Hz; the
    // blit is cheap and runs at ~7 Hz so camera movement stays smooth.
    if (now - minimapSurfaceClock > 400) {
      minimapSurfaceClock = now;
      minimap.refreshSurface(world);
    }
    if (now - minimapClock > 140) {
      minimapClock = now;
      minimap.render(world, ctx.rig, conn);
      if (minimap.hoverCell) minimap.setLabel(minimap.hoverCell);
    }

    // Overlay reads the same predicted state the world does, so the ghost and
    // the mesh can never disagree about what is pending.
    overlay.update({
      ghost: state.ghost,
      locks: conn.locks,
      zones: conn.zones,
      cursors: [...peerCursors.values()],
      selfId: conn.selfId,
    });

    pipeline.render(now);

    const w = world.stats();
    hud.update({
      frameErrors,
      chunks: meshManager.meshes.size,
      quads: meshManager.stats.quads,
      verts: meshManager.stats.quads * 4,
      connected: conn.connected,
      name: conn.self?.name ?? '',
      ping: conn.rtt,
      inflight: conn.stats.inflight,
      passes: [
        { name: 'shadow', on: quality.shadows },
        { name: 'gbuffer', on: true },
        { name: 'lighting', on: true },
        { name: 'glass', on: pipeline.glassGroup.children.length > 0 },
        { name: 'bloom', on: true },
        { name: 'composite', on: true },
      ],
      drawCalls: meshManager.stats.drawCalls,
      triangles: meshManager.stats.triangles,
      props: props.stats.live,
      propCapacity: props.stats.capacity,
      lights: pipeline.lights.activeCount,
      lightsDropped: pipeline.lights.droppedByTile,
      occupied: w.occupied,
      predictions: w.predictions,
      meshBusy: meshManager.stats.busy,
      meshDispatched: meshManager.stats.dispatched,
      meshStale: meshManager.stats.stale,
      meshMs: meshManager.stats.lastBuildMs,
      accepted: conn.stats.accepted,
      denied: conn.stats.denied,
      timedOut: conn.stats.timedOut,
      conflicts: conn.stats.conflicts,
      deltas: conn.stats.deltasApplied,
      deltasVoxels: conn.stats.voxelsApplied,
      adapter: ctx.adapter,
    }, dt);
  }

  requestAnimationFrame(frame);

  // Handy for poking at state from the console.
  window.swb = {
    ctx, world, conn, meshManager, pipeline, overlay, props, minimap, hud, state, THREE,
    sfx, budget, setMuted, coach, coachClicked, pumpCoach,
  /**
   * Run one simulation + render step by hand.
   *
   * Not a debug leftover: `requestAnimationFrame` does not fire in every environment
   * this has to run in (headless Chromium on a software GL stack never calls it), so
   * without this there is no way to render a single frame there and no way to check
   * that the renderer works at all. The HUD reads "-- fps" in those environments for
   * the same reason.
   *
   * Exposed with the same try/catch the real loop uses, so a pumped frame reports
   * failures the same way rather than throwing into the caller.
   */
  renderOnce(now) {
    const t = typeof now === 'number' ? now : last;
    const dt = Math.max(1, t - last);
    last = t;
    try {
      step(t, dt);
      return { ok: true, frameErrors };
    } catch (err) {
      frameErrors++;
      console.error('[frame:pumped]', err);
      return { ok: false, frameErrors, error: String(err && err.message || err) };
    }
  },
  };
}

main().catch((err) => {
  console.error(err);
  hud.fatal('Startup failed.', String(err?.stack || err));
});