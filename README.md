# Shared World Builder

A collaborative chunk-based voxel world builder: WebGL2 client + real socket.io
authoritative server, sharing one greedy-meshed voxel column format.

```
npm install
npm start          # http://localhost:5173
npm test           # node --test test/
```

The port is overridable, which is worth knowing the hard way:

```
PORT=5174 npm start
```

**5173 is the default and it collides.** Another project in this workspace held it
while this one was being verified, and the symptom was not an error — it was the
*wrong application* answering on the expected port. `curl`ing the served HTML and
checking it contains this project's markup is the fastest way to tell the difference
from a broken build, because a page from a different app still loads fine and still
renders a frame loop.

Requires WebGL2. Boot fails with an explicit message on WebGL1 rather than
silently degrading.

---

---

## The world is an atoll now

The seed used to be a hand-written **plaza**: a dished disc of stone and slate, a raised
dais, and a short starter wall. That shape was chosen for a real reason — builds read
against a silhouette — and it is the wrong shape here, because a plaza is a flat disc and
the entire appeal of a lagoon is the transition between depths.

Terrain now comes from `shared/atoll.js`, which generates:

```
cay        dry sand, five units proud of the water
beach      wet sand, sloping to the waterline
lagoon     shallow turquoise, sand still visible through it
reef       broken rock, breaking the surface in patches
deep       ocean, dropping away
```

plus a bay, sandbars, coral placed by noise so it clumps, and palm groves. The island is
96% a single connected landmass; the rest is genuine sandbars.

It is a **generator** rather than a hand-authored island, and that is the load-bearing
decision. "Is the lagoon actually shallower than the ocean?" is then a question with an
answer, stated in `test/atoll.test.js` as a relationship, instead of a matter of taste.
The profile is a table of `(radius, height)` stops, so the island can be made wider,
shallower or more broken by editing numbers rather than by editing geometry.

### The colours came from Atollingo

`atollingo.com` is a kids' learning platform with an island theme. Its palette was read
out of the live page's design tokens and CSS rather than guessed from a screenshot I could
not see:

| token | value | used for |
|---|---|---|
| `--wash` | `#fff0df` | the idea of dry sand |
| primary | `#086d75` | lagoon water |
| — | `#087b83` | bright turquoise shallows |
| `--teal` | `#003b42` | deep water |
| `--accent` | `#9b4b28` | driftwood |
| — | `#684313` | palm trunk |
| — | `#48636e` | reef rock |

`oceanhub` from your GitHub, and your Cloudflare account, I cannot reach at all — there
are no credentials here for either. If oceanhub has a palette you want folded in, point
me at the repo and I will read it the same way.

### The value of every one of those colours had to be thrown away

Every atoll material was authored at the hex that looked right, and every one of them was
too bright to render. Sand at `#f2e4c9` has a linear albedo of 0.89 — roughly 3.5×
stone's — so under a sun strong enough to model anything it lands deep in the ACES
shoulder. Measured: lit 0.949 against 0.550 in shadow, a ratio of **1.24**, which on a
flat-shaded voxel face is *no form at all*.

This is the same lesson the gold material already carried, for the same reason, and the
rule it produced is the one worth keeping:

> A colour that looks correct as a hex is not a colour that renders. Voxel faces are
> flat-shaded — one normal, one brightness — so the contrast between a face pointing at
> the sun and one pointing away is the only thing that shows form. If that contrast is
> under about 2.2×, the geometry is a slab with the shape painted out.

`tools/tone-probe.js` measures it, by running the real chain (albedo → the lighting rig →
`CONFIG.exposure` → ACES → sRGB) against materials read out of `materials.js` and an
environment parsed out of `pipeline.js`. `test/lighting.test.js` asserts the result, so
the palette cannot silently drift back into the shoulder. Run the probe after touching
either file:

```
node tools/probe-run.mjs
```

### Three bugs this change surfaced, none of which reported itself

**The GLSL material table was sized `[10]` and the palette became 17.** Every material
from 10 upward read out of bounds, and GLSL leaves that *undefined* — this driver returns
the last in-bounds element, so the entire atoll rendered as material 9, Cyan Glass. The
CPU-side table was correct, the geometry carried the right ids, the world data was right,
and the shape was right: correct coastline, correct lagoon, correct palms. Every aggregate
check passed. It took reading the G-buffer back off the GPU and fingerprinting by
roughness — a value unique per material — to find that the surface was glass everywhere.
The array size is now derived from `MAX_MATERIAL_ID`, and `test/shaders.test.js` asserts
the two agree.

**The tone probe hardcoded `exposure = 1.0` when `CONFIG.exposure` is 1.25.** The whole
palette was tuned against numbers that were too optimistic, and the lagoon rendered at
255,255,255. It now reads the real config, and a test asserts the probe and the renderer
agree — a probe that silently disagrees with the renderer is worse than no probe, because
it looks authoritative.

**The bots treated the water surface as buildable ground.** Their core heuristic is
"scan down from the sky and build on the first solid thing", which was written when the
world had no liquid. On an atoll the first solid thing is the sea surface about a third
of the time, so every bot stacked its district on top of the lagoon. `_surfaceY` now
refuses columns whose top cell is water, and the bot anchors are derived from the terrain
instead of hardcoded at ±10 per quadrant — two of which sat in the water.

### Looking at it, finally

Headless Chromium here refuses `requestAnimationFrame` *and* screenshots, which is why
the lighting work in this project was driven by numbers alone for so long. Two
affordances make an eye possible:

- `window.swb.renderOnce(now)` runs one simulation + render step by hand, with the same
  try/catch the real loop uses.
- `SWB_CAPTURE=1` exposes `POST /__capture`, which writes a PNG the page sends after
  reading the default framebuffer back with `gl.readPixels`. It is off unless the
  environment variable is set, only ever writes into `data/captures/` under a filename
  the server generates, checks the PNG magic and caps the body at 4 MB.

That combination is what turned "the lagoon is white" from an assertion into a picture,
and it is how the sand value, the sky stops and the water alpha were each corrected. The
water's minimum alpha was 0.13, which is right for a window and badly wrong for a lagoon:
fresnel is near zero when you look *straight down* at water, which is exactly how this
game is played, so the lagoon came out as pale sand with a faint blue cast.

### Still not right

- The cay crown is a flat top face pointing straight up at a 51° sun, so it is the
  brightest thing in the frame and reads as a pale plateau. The relief is there and the
  shading is correct; it wants either a lower sun or a domed crown.
- The bots build the `beacon` towers out of slate capped with gold, and against bright
  sand those read as dark spikes. That is the objective ladder working as designed rather
  than a rendering fault, but it dominates the frame.
- Deep water is a flat single cell beyond the reef, so the open ocean has no motion and
  no depth cue of any kind.

## Status: honest summary

The **simulation, networking, meshing and deferred rendering** layers are all
implemented and verified in a real browser. Verified end to end: 12 columns
received from the server, 12 mesh jobs dispatched to the worker pool and completed
with 0 failures at ~6 ms/column, 1143 quads / 2286 triangles of geometry in GPU
buffers, and a framebuffer containing a correctly lit scene — measured by
`readPixels`, giving ~8,800 non-black sampled pixels, a vertical luminance gradient
(41 → 77 → 38 → 0 top to bottom) and a spread histogram rather than a flat field.

**Not visually confirmed**: development runs headless on an Intel HD 620 and
refuses both `requestAnimationFrame` and screenshots, so the lighting work was
driven by framebuffer measurements and one screenshot taken by hand. Numbers are
verified; whether the result *looks* right is still an open question — see
"Lighting" below for the specific things that need an eye on them.

Decor (lanterns, torches, chairs, plants) now renders as instanced geometry with
per-builder tinting, verified by toggling the group off and watching pixels
change. **The point lights those props emit are not yet contributing** — see
"Known defect" below.

All three tools work end to end through the real pointer and socket path,
verified in a browser: build places a block (accepted by the server, block
present in the world), decor places a prop on top of it (accepted, prop present,
instanced mesh incremented), and destroy removes the block that was pointed at
(accepted, block gone, the prop above it untouched).

Not yet done: GPU particle pools, SSGI, volumetric fog, LOD tiers, remote cursor
interpolation, zone claim UX. An HZB occlusion pyramid exists in `targets.js` but
is never called. The architecture leaves room for the rest; none are implemented.

## Bots hold territory, and claims finally exclude somebody

Territory existed but had no consequences, and the reason was one missing line.
`commitAs` and `commitPropAs` never called `preflight`, so **bots built straight
through player claims**. Every zone on the map was decoration: you could claim a
district and watch it fill with bot blocks anyway. Measured before the fix: a bot
commit inside a live claim was *allowed*.

Two changes, and the second is what makes the first matter.

**Claims exclude everyone**, bots included. A claim reserves ground — if bots could
build inside one it would protect nothing. The accepted cost is that a busy claim
carves the swarm out of that region, which is felt only when players claim
everything, and that is the claim working correctly.

**Bots now hold their own districts.** Four claims, one per quadrant, sized 8×8
against a player's 12×12 — four bots at player size would cover most of a 40-unit
radius and leave nowhere to expand. Claims are renewed by the same rule players get,
so a bot standing idle visibly loses ground rather than holding it forever.

### Three more bugs found by measuring

- **Pausing the swarm left its districts held forever.** Claims live in the authority
  keyed by builder id, not in the worker map, so clearing the workers orphaned four
  districts owned by bots that no longer existed — ground nobody could ever build on
  again. `dispose()` and `setEnabled(false)` now release them.
- **Two claims could sit on identical ground**, and which owner got locked out of
  their own district then depended on `Map` iteration order — so it changed between
  restarts. Claims now refuse to overlap.
- **Making bots respect claims stopped them building at all.** Their site search
  ranged over the whole quadrant while their claim was an 8×8 block near the middle,
  so nearly every pick fell outside it, was refused, and the bot did nothing. Measured:
  **400 steps produced 0 block commits and 1 prop.** They now search their own
  district first and fall back to open ground. After: **78 of 84 commits in-district,
  0 in anyone else's**, spread 19/19/18/18 across the four bots.

### On writing that exclusion rule

It took four attempts and two of them had tests that had existed for days, so the
tests did their job and I did not. The predicate's *direction* was the whole content
and I inverted it twice: `!isBot(id)` let every human into every claim, and `isBot(id)`
behind a guard that skipped on `true` let bots walk through every one. There is now no
exemption predicate at all — `preflight` rejects on `zone.ownerId !== actor.id` and
nothing consults whether the actor is a bot. A rule that nobody can express is a rule
nobody can get backwards.

## Onboarding: the first objective was the tutorial, and nobody was told

The ladder's first goal — *place a lantern* — is the whole tutorial, and nothing
said so. A new player opened this to a sky, some terrain, and eight goals in a panel
they may never have read. Worse, **the goal is not what a new player's hand does
first**: putting a block down is the obvious action, and reaching for the decor
palette is not. So the tutorial's opening instruction was effectively invisible.

The coach walks the actual loop in the order a player experiences it, and **advances
only on evidence that the player did the thing** — never on a timer. A tutorial that
advances on a clock teaches the player to ignore it.

Nothing is modal. A player who ignores all of it can build happily and it simply never
appears again: it is remembered per browser, permanently.

### Three defects, all of which the tests found and none of which looked wrong

- **The step table's ids and requirements were crossed.** The step titled "Others are
  building" waited on a claim, and the step about holding ground waited on the goal
  panel arriving. Nothing errored: the coach sat on a step whose evidence could never
  arrive, which presents as a tutorial that works for most people and then stops.
- **A step depended on something the player does not control.** It completed when the
  swarm had committed a block — which is exactly what does *not* happen when the ladder
  is already finished and the bots have correctly stood down. On a returning player's
  world the coach waited forever, for someone doing everything right. Every step now
  asks for a click the player makes or a key they can always press.
- **The coach covered the screen centre**, which is where the cursor sits by default
  and where it was telling the player to click. An instruction to click the ground
  that sits on top of the ground is worse than no instruction — and it would have
  swallowed the first click. Moved to the top of the viewport; measured clear of the
  click path, both HUD rails and the palette.

Also worth recording: **one step per pump**, deliberately. A player who arrives already
holding ground satisfies every requirement at once, and collapsing that into a single
call made the entire tutorial flash and vanish in one frame — which reads as a glitch
rather than as anything having been taught.

## Territory: the mechanic that makes claims mean something

Claims, locks and zones all worked server-side from early on. The problem was that
**nothing could reach them**: `claimZone` and `requestLock` sat on the client
connection with no button, key, or code path calling either. The whole ownership
system was state no player could touch.

Wiring it up is not the interesting part. The interesting part is that **a claim you
cannot lose is not a claim**, it is a decoration. Claim once and the ground is yours
forever, so there is no reason to return to it, no reason to defend it, and no reason
for a second player to matter. Everything else in this game is about *building*;
nothing in it was about *stakes*.

So a claim decays on **inactivity**, and building inside it renews it. Three
consequences follow, and they are the whole design:

- **The clock tracks work, not attendance.** `touchZone` is called from the commit
  path, so tending a district holds it indefinitely and walking away loses it. It is
  maintenance, not a timer you watch.
- **A refused edit cannot hold ground open.** The renewal lives after the commit, not
  on the op, so spamming invalid requests cannot keep a district alive.
- **Decay frees space; it does not destroy work.** The blocks stay exactly where they
  are. What is lost is the exclusive right to build there. That distinction is what
  lets decay be tense without being punishing — and it is what makes taking a district
  worth the trouble.

Two grace values, deliberately generous: 90 s of visible warning inside a 180 s
lifetime. Decay must never be a surprise, or it reads as unfair rather than as
pressure, and a shorter fuse turns a two-minute break into a disaster.

**A restart does not renew a claim.** Claims persist; the clock does not, and a
restored claim starts *already fading*. A claim is a statement that you are still
here, and restarting the server is not that — otherwise "shut down for three minutes"
becomes a strategy.

### Two things found by measuring rather than reading

- **Renewal was real but invisible for up to five seconds.** The only `EV.ZONES`
  broadcast was the 5 s decay tick, so a player watching the bar fall while building
  would conclude the mechanic was broken. The server had renewed correctly the whole
  time; the client was reading a verdict from before the build. Renewal is now emitted
  to the owner immediately on a successful build.
- **A probe of mine picked cells outside the claim** and reported that another builder
  *could* build there, which looked like the permission check failing entirely. It was
  my test aiming badly: refused while held, allowed once decayed. Recorded because the
  false reading was more alarming than the truth.

`SWB_ZONE_TTL_MS` / `SWB_ZONE_HOLD_MS` override the timings, because a three-minute
clock cannot be watched failing in a test or a demo.

## The blank world: three bugs that hid behind each other

The game reported "there is no world" while the socket was connected, the HUD was
updating, and the server reported 14 chunks and 12,573 voxels. Every number in the
UI — `chunks 0 · quads 0 · verts 0`, "reconnecting…" — was stale initial text. One
throw in the first frame killed the render loop permanently.

### 1. The frame loop could die (the reason nothing rendered)

`requestAnimationFrame(frame)` sat at the **bottom** of the frame. Any throw in any
subsystem — a prop with no geometry recipe, a malformed delta, a NaN uniform —
permanently stopped the loop. The symptom is indistinguishable from a failed load:
the DOM is present, the HUD still has text, and only the absence of motion gives it
away. The reschedule now happens **first**, with the body in a `try`/`catch`, so one
bad frame is one bad frame. `frameErrors` is counted and surfaced.

This was the single highest-value change in the project, and it is the reason the
other two took so long to find.

### 2. `_grow` recovered a bucket's prop kind by identity search

```js
const kind = [...this.buckets].find(([, v]) => v === bucket)?.[0];
```

When that came back `undefined`, `propGeometry(undefined)` threw — from inside
`_insert`, from inside `sync`, from inside the frame loop. Any prop bucket
outgrowing its initial capacity killed rendering. The kind now lives on the bucket
(`bucket.kind`), and `propGeometry` returns `null` for an unknown kind instead of
throwing, because a missing prop is invisible and a dead frame loop is a blank world.

Related, in the same function: `bucket.live` maps **key → slot**, so
`for (const [key, record] of ids)` re-inserted a bare *number* as a prop record.

### 3. An index entry is not a live instance

`sync()` skipped a record when `this.index.get(key)` matched its `rot` and `color`.
Those are true for all 9,650 lanterns, so once any key had lost its GPU slot while
keeping its index entry, it was skipped forever, on every frame, with no warning.

Measured on the real world: **9,650 props in the world, 9,650 in the index, 1,522
actually drawn.** 84% of the world's props were invisible, `dropped: 0`, and nothing
anywhere said so. The skip now requires *both* an index entry and a live slot in the
owning bucket. After the fix: 9,650 drawn, 0 dropped.

`MAX_CAPACITY` was also 2,048 — reached by a real session and silently truncating.
It is now 65,536 (an `InstancedMesh` costs 64 bytes per instance, so this is 4 MiB),
and overflow increments `stats.dropped` rather than vanishing.

### 4. Bots placed 9,650 lanterns

A third, unrelated defect, found in the same status readout: `propCommits: 9093`,
`commits: 0`. The satisfaction guard read `tracker.wire.active[index].current`, which
**only `evaluate()` refreshes** — so whether the guard worked at all depended on
whether an unrelated 1 Hz timer happened to have fired. It was also wrong on its own
terms: with the human-contributor gate, an objective whose metric is met but which no
human has touched stays *active* forever, so bots polled a goal that could never
complete.

The swarm now pulls a verdict when the world has moved under the one it holds. This
is keyed on **revisions, not elapsed time** — a wall-clock interval was tried first
and is wrong in both directions: longer than a bot's step and it goes stale (1,200
prop commits against a goal of one), shorter and four bots mean four world scans per
step. A satisfied objective means stand down, whether satisfied-but-locked or
satisfied-and-waiting. Result: **1 prop for a goal of 1**, with no host timer.

### 5. A timer leak that made the test file unrunnable

`step()` reschedules itself, and `schedule()` overwrote `worker.timer` without
clearing it — so only the most recent timer per worker was cancellable. `dispose()`
emptied the worker map and cleared nothing that was still armed. Found by a script
that printed `workers: 0` after dispose and then still would not exit. `schedule()`
now clears the previous timer, and `dispose()` nulls `timer` so a test can assert it.

## Bots with goals and identity

Bots used to pick a random material, a random shape, and a random anchor within 24
voxels of the origin. Three of them did that for ten minutes and produced a pile of
unrelated stubs serving no goal — in a *cooperative* world, the other builders are
supposed to be pulling on the same objective as you, and they were pulling on
nothing.

They now read the active objective and derive a concrete intent from it
(`shared/botGoals.js`). Four properties matter:

- **The objective is never diverted from.** All four bots work the same goal as
  every human. That is the entire cooperative premise, and a test asserts it for
  every objective × every specialism — divergence here is exactly the old bug.
- **Specialism varies the *method*, not the target.** An architect, a mason, an
  electrician and a gardener all serve "place six lanterns", each framing it
  differently. Variety without fragmentation.
- **Each bot owns a district.** Anchors come from a per-bot quadrant rather than a
  shared random pool. Measured: 100% of each bot's builds land in its own
  quadrant. This is the difference between a town with neighbourhoods and a heap.
- **They stand down when only people can help.** `distinctBuilders` resolves to
  `idle`, so the bots wait rather than doing busy work that does not advance the
  goal — and that wait is a readable signal that this one needs other humans.

The roster publishes each bot's specialism, current intent and blocks placed, and
the builder panel renders it. A bot that says it is raising a beacon and then
erects a random wall reads as broken; a bot visibly working the shared objective
reads as a collaborator. Client and server derive the intent from the same
objective id, so they cannot disagree.

### Three defects found by measuring instead of reading

- **Bots never started.** `enabled` was true but workers were only created inside
  `setEnabled()`, which nothing called at boot. The flag said "enabled" the entire
  time, which is the worst version of that bug.
- **The seed satisfied two objectives for free.** The plaza dais was material 6
  (gold), putting 98 gold blocks in the world — so "Something Gold" and "Ten Gold"
  were both complete before anyone touched the game. The rule: any material an
  objective targets must stay out of the seed, or the objective is not an
  objective. The dais is slate now.
- **Bots spammed props with no check against the goal.** Measured 1600 prop
  commits against a goal of one: four bots each placing roughly once a second, with
  nothing consulting the tracker's verdict. A bot now reads `current` vs `goal`
  before planning. Towers are exempt, because a beacon is judged on height rather
  than on how many blocks exist, and the guard would otherwise freeze a half-built
  tower forever. After the fix: 8 prop commits against a goal of 7.

## Minimap

`public/src/ui/minimap.js`. Top-down view of the whole buildable radius, redrawn
at ~7 Hz with the surface scan on a slower ~2.5 Hz timer. Click or drag to move
the camera there.

Three things it deliberately does:

- **Topmost-surface rasterisation.** For each (x, z) it shows the highest non-air
  voxel, not a slice at a fixed height. A slice shows you bedrock and none of what
  you built.
- **It reads the client's world, including predictions.** A block you just placed
  appears immediately rather than one round trip later. The map is a navigation
  aid, not game state, so it should agree with the view you are looking at.
- **Zone outlines over fills.** A filled region hides the geometry underneath,
  which is the thing you are actually inspecting.

Two performance notes, both measured:

- The surface scan was **16.6 ms** when it walked every column top-down on every
  redraw — 80×80×48 probes, nearly all of them descending through empty air. That
  is 12% of the frame budget at 7 Hz. Caching a heightmap dropped it to ~3–5 ms and
  the blit to **0.4 ms**.
- The canvas backing size is **derived** from the tile grid (`span*TILE + 2*PAD`),
  never set by hand. A hand-picked 156 against a 160px world clipped 2px off each
  side, and because the clipped part is the buildable boundary it hid the outer
  ring of the world rather than looking obviously wrong. A unit test pins this.

### Where it lives, and why that took three attempts

It started as a fixed box in the bottom-left and immediately overlapped the
Pipeline panel. Moving it into the left rail fixed the overlap but squeezed the
delta log to a 19px body — a panel that fits and is useless is worse than no panel.
Putting it in the footer beside the toolbar fixed the log but made the footer 150px
taller, which pushed its bounding box into the rail.

The working answer was to give the map a rail slot and **move the Pipeline pass
list behind the F key**. It was a static readout ("shadow / gbuffer / lighting /
...") that never changed during play, and every number it showed was already in
the frame-stats overlay. Trading it for a map was strictly better use of the space.

Layout offsets are measured rather than guessed, because two of them were wrong:
the top bar ends at 84px (the rail was set to 66 and overlapped it by 18px) and
the footer starts at 477px (the rail was set to 96 and overlapped it by 9px). Both
rails now also scroll, so a viewport too short for their content degrades to a
scroll rather than a collision.

## Lighting: what a screenshot actually taught me

The previous revision of this file claimed the lighting was fixed because mean
luminance was in a reasonable range and nothing was clipping. A screenshot showed
the sky rendering **near black**, the terrain as one flat grey disc, and the
colours as pure saturated primaries. Luminance was in range and the image was
still wrong.

What that revealed is that mean brightness is a useless diagnostic for this scene,
because two errors cancel: too little light in the fill and too much in the sky.

The real lever is the **key-to-fill ratio**, and the reason it matters more than any
other number here is that voxel faces are flat-shaded. A face has exactly one
normal and therefore exactly one brightness. The only thing that communicates
form on a terraced surface is the contrast between a face pointing at the sun and
one pointing away. At fill 1.5 against sun 2.45, every face landed within a stop of
every other face and the terraces read as a single disc.

The rig now runs sun 6.2 against fill 0.52 — roughly 12:1 — which measured a
**4.35:1** lit-to-shadow luminance ratio across the terraces (232 vs 53), with
lit faces warm (140,131,131) and shadow faces cool (52,52,63). Mean luma moved
50 → 100. The sky grades blue to warm across a real zenith-to-horizon range, and
the horizon stop is close to the fog colour so distant geometry dissolves rather
than ending at a visible line.

The lesson is about method: **an aggregate number is not a picture.** Everything in
the lighting rig was previously verified with mean luminance, per-pixel sampling of
hand-picked points, and histograms — none of which can distinguish "well exposed"
from "flat and featureless", because both have the same average.

## Camera controls: why rotation looked broken, twice

The orbit maths was never wrong in any version — driving it programmatically moved
`theta` and `phi` correctly every time. Both bugs were about *which gestures the
app was willing to accept*, and neither was findable by testing the maths.

**First bug:** the only way to orbit was a right-drag. Undiscoverable, absent on
many trackpads, impossible on a touchscreen. Fixed by adding sky-drag, middle-drag
and keyboard bindings.

**Second bug, which the first fix created and which is the one that actually
matched the report:** left-drag only orbited when the press missed all geometry.
The reasoning was that a press on terrain "means" placement. That is wrong —
every 3D builder and editor treats left-drag *anywhere* as look-around, and a
player who grabs the world to turn it gets nothing at all. Pressing and dragging
on terrain was silently a no-op.

The fix decides on **movement, not on what was under the cursor**. The press is
always recorded; it becomes a camera drag once it travels past 5px; only a press
that never travels that far is treated as a click and places a block. The orbit is
seeded from the pointer's position at the moment of promotion, so the camera does
not jump by the threshold distance on the first move.

| input | action |
|---|---|
| left-drag anywhere | orbit |
| left-click | place / break |
| right-drag | orbit |
| middle-drag | pan |
| wheel | zoom |
| arrows or `WASD`, `shift` for bigger steps | orbit |

Two details that matter:

- **`pointercancel` clears the drag.** A cancelled press (window blur, a touch
  gesture being taken over) would otherwise leave the rig stuck mid-drag, which
  silently kills every later click-to-place with no error anywhere.
- **The key handler is on `window`, not the canvas.** A canvas-level listener only
  fires while the canvas holds focus, so arrow keys would do nothing until the
  player happened to click the world first.

`setPointerCapture` is wrapped in try/catch: it throws for a pointer id the element
never received, and an uncaught throw there aborts the whole `pointerdown` handler.

**The general lesson:** a camera that does not respond is almost never a camera
bug. It is a gesture-recognition bug, and testing the maths proves nothing about
it. What the maths test *did* do was rule out the one hypothesis that was cheap to
check and would have wasted the rest of the time otherwise.

## Lighting: why the frame looked like programmer art

A screenshot of the running game showed four problems at once — a flat saturated
blue sky, terrain with no directional form, saturated albedos clipping to pure
primaries, and an island floating in a void. All four had one root cause.

`createEnvironment` used to read `new Color(0x2b3a5c).convertSRGBToLinear()` and
multiply by **90**. A dark hex tint converts to about 0.02 in linear space, so a
1.0 ambient would have been invisible, and a large multiplier was the obvious
wrong-looking fix. But that uniform was doing two jobs at once:

- it was the **fill light**, so a value that had to be bright enough to see also
  sat at 1.0 -- brighter than the sun's contribution on anything not facing it,
  which erases directional form and reads as flat;
- it was also the **sky**, so the sky rendered at 1.0 and clipped to flat blue.

The mistake was treating "make it visible" and "make it correct" as the same
problem. Only one of them is solved by a bigger number.

What actually changed:

- **Environment radiance is authored in linear directly**, as explicit numbers
  rather than hex tints plus a scale factor. These are now the light.
- **Fill light and sky radiance are separate uniforms** (`skyColor` vs
  `skyZenith`/`skyHorizon`). They are only the same thing while both are dim, and
  they stop being the same thing the moment the rig is bright enough to light the
  terrain: a fill reaching ~1.5 makes a 0.8 zenith clip again.
- **The sun is low** (`0.62, 0.38, 0.29`) rather than high. Raking light is what
  makes stepped voxel terrain read as three-dimensional; the old high sun
  flattened the terraces into a silhouette.
- **The fill is nearly neutral.** A saturated blue fill times an already
  blue-grey stone albedo drove the whole terrain to (73, 83, 114) — blue
  everywhere, including sunlit faces. Colour should come from the key light.
- **The fill level was measured, not guessed.** Stone's linear albedo is
  (0.13, 0.17, 0.26), which is physically right and means any scene lit it looks
  dim. A framebuffer sweep put lit terrain at 141 and shadow at 59 — the range a
  dusk scene wants — where the previous level had everything under 60.
- **Gold's albedo came down.** At `0xeab308` it converted to (0.82, 0.45, 0.002),
  about 3x stone's value. No single exposure can hold both, so the dais pinned at
  255 with all its shading gone. It is treated as a diffuse albedo, not a
  metallic F0, because the renderer has no metallic path.
- **Fog is a real colour.** It was `0x0a1122` → linear (0, 0, 0.001), effectively
  black, so the world's edge cut off hard against the sky. Now it is a pale haze at
  a density that actually shows (verified by painting it red: 9.1% of the frame
  responds).

Two measurement traps worth remembering, both of which cost real time here:

- **`uExposure` and `uFogDensity` cannot be swept from a console.** The pipeline
  rewrites both from `CONFIG` every frame, so setting the uniform directly does
  nothing and reads as "this knob is broken". Change `CONFIG` and reload.
- **A point sample proves nothing about a full-screen effect.** Fog at a handful
  of screen points showed zero delta and looked broken; a whole-frame diff showed
  it affecting 9.1% of pixels. The points happened to be near geometry.

## The game: shared objectives

A sandbox with no goal is not a game, so there is a ladder of eight cooperative
objectives in `shared/objectives.js`, evaluated by `server/objectives.js` and
pushed to clients over `EV.OBJECTIVES`.

The load-bearing property is that **progress is measured, never reported**. Each
objective is a pure function of authoritative world state, so there is no
client->server progress message to forge — a client that lies gets nothing,
because it never sends anything. A few consequences that are deliberate:

- **Progress is derived from world state, not accumulated from ops.** This kills
  two problems at once: a client cannot claim credit, and progress cannot drift
  out of sync when someone demolishes the evidence.
- **Tallest-column measures the longest *contiguous* vertical run**, not the span
  from the lowest to the highest block. A tower with a gap in it is two shorter
  things, and counting the span would let a free stack of disconnected voxels
  satisfy a height goal.
- **Completion is monotonic.** An objective stays met for the session even if the
  blocks are later removed. Retroactively un-completing a shared goal because one
  builder demolished the evidence feels like a bug to everyone watching, and the
  achievement did happen.
- **The advance loop is bounded and steps repeatedly**, so finishing two
  objectives in one tick cannot leave the ladder parked on an already-satisfied
  goal.
- **One world scan feeds all eight objectives**, rather than eight world walks.

The ladder is ordered rather than a board, because a board makes the optimal
strategy "ignore the hard ones" while a ladder forces a shared order and gives a
reason to come back.

Verified in a browser end to end: a lantern placed through the socket was
accepted, measured by the server, advanced the ladder, fired the completion
banner, and the panel rolled on to the next objective carrying the correct
progress (1/6) including the lantern that had just been placed.

## Audio: procedural, and built around attribution

There was no audio at all. It is now entirely synthesised — oscillators and one
shared noise buffer, no assets, nothing to download.

The design question was what sound is *for* here. The answer is **attribution**. In
a co-op builder the most useful thing audio can tell you is *who just changed the
world near me*, so a remote edit is not a quieter copy of a local one. It is panned
to where the edit happened, attenuated by distance, and detuned three cents so it
reads as a different voice in the same key rather than as the same event played
quieter. Three cents is far below the threshold of sounding "wrong" and far enough
that a dozen of them do not fuse into one drone.

Materials are driven off their own `roughness` rather than a hand-written table, so
roughness already controlling specular response means the sound cannot disagree with
the surface. Brick (0.92) is a low dull thud; glass (0.08) rings. Verified: all nine
materials produce distinct measured amplitudes, and the ordering is strictly
monotonic in roughness.

Falloff is inverse-square over a 16-unit reference, because that is the only curve
that makes a builder across the plaza read as *across* the plaza. Measured on the
real master bus: 0.232 at the source, 0.054 at 20 units, 0.0084 at 60.

### The parts that took the most care

**Bots are not players.** Four bots commit roughly once a second each. At one
voice per commit that is a machine gun that drowns the one thing audio is here to
report. They get a lower ceiling (0.24×), a longer cooldown (220 ms vs 40 ms), and
sit a fifth below pitch — which reads as *further off in the room* without changing
gain. A test asserts a minute of realistic bot traffic stays inside the voice
ceiling.

**The double-strike guard.** The server broadcasts every delta to every client
*including its author*, so one of your own placements arrives as both an `accepted`
event and a `delta` carrying your own id. Sounding both double-strikes the most
common event in the game. `accepted` is the authoritative "you did this" signal, so
deltas are only sounded for other builders. Bot intent announcements are silent for
the same reason: the resulting delta is the real event. Verified on live socket
traffic — 1 `accepted` + 1 self-authored delta produced exactly **1** sound.

**Loud conflicts, quiet denials.** A lost race is the only thing that reports
something you did not do, so it is the only startling sound. A plain refusal stays
quiet, because you have other feedback for it and need to keep hearing the world.

### Two things that were a bug before they were a feature

The event→sound mapping started life inline in the `requestAnimationFrame`
closure, which made it **completely untestable** — rAF does not run headless, so the
only way to exercise it was to read it. It is now `public/src/audio/events.js`,
takes its sound function by injection, and is driven directly in tests with a
recorder. That is how the double-strike guard was pinned.

`VoiceBudget` originally exposed `allow()` and `start()` as separate calls. That is
a footgun with a nasty failure: a caller that passes the gate and forgets to
register leaves the live count understated, so the ceiling stops applying and the mix
quietly gets busier — and the symptom looks like "the budget is too tight" rather
than like a missing release. `tryStart` now pairs the two, and the common path uses
a single id space so `onVoiceEnd` can hand the same token back.

Verification used a tap on the master bus and read real amplitude back, because
"the graph is wired up" and "sound is coming out" are different claims. One honest
correction: the first measurement pass showed `place` at exactly 0 while `remove` —
the same code path — read fine. That was the audio thread warming up, not a bug; it
was confirmed by re-measuring on a second pass. Noise offset is randomised per hit
so repeated placements are not bit-identical.

There is also a quiet ambient bed — except that "a wind bed" was the whole story
until it stopped being true. Silence reads as "the game is broken" rather than as
"the world is quiet", but a *constant* floor reads as a hum, and an atoll that
sounds identical whether you are standing in the lagoon or on the crown is a
missed cue rather than an atmosphere.

The bed is now **three layers that crossfade to whatever is under the camera**:

| under the camera | wind | surf | water |
| --- | --- | --- | --- |
| open water (14/15/16/17) | 0 | 0 | **0.013** |
| shore (`sand_wet`, or `sand` ≤ `PALM_MAX_GROUND`) | 0.0056 | **0.024** | 0 |
| crown / anything built | **0.016** | 0 | 0 |

The decision lives in `voice.ambienceFor(mat, y)` next to the reasoning, and the
height test deliberately reuses `PALM_MAX_GROUND` — the generator's own beach/crown
split — rather than a second magic number, so the ear and the terrain cannot drift
apart. Without it the whole island would sound like a beach, because the crown is
mostly bare sand with scrub growing on it.

All three read the same noise buffer through *different* filters, which is what
makes them distinguishable with no assets: wind is a lowpass drone, surf is a
bandpass with real top end in it (plus a slow swell, because waves arrive and leave,
and constant surf reads as hiss), open water sits between the two. Measured on the
real bus with the camera moved column by column, crossing each boundary in both
directions:

```
open water   wind 0.00010   surf 0.00010   water 0.01300
shore        wind 0.00549   surf 0.02351   water 0.00036
crown        wind 0.01573   surf 0.00010   water 0.00032
```

And the claim that it is actually *audible* rather than merely scheduled: peak RMS
0.00514 with the bed up, **0** with the same bed muted — so the number is the bed
and not artefacts of the measurement. Muting also confirms the multi-layer bed did
not break the one control that has to keep working.

One honest measurement trap: `renderOnce()` with no argument reuses the last
timestamp, so a pumped frame never advances time and the 350 ms sample gate never
reopens — the first sample fires and then the bed freezes. Passing a real
`performance.now()` fixed the harness. The production loop is unaffected; this only
bites headless verification.

## Point lights: three silent decode bugs

Lanterns rendered for the entire life of this feature and lit nothing. There were
**three separate bugs, all the same mistake**: treating values read from an RGBA8
texture as if they were the byte values the CPU had written. An RGBA8 texture
reads back *normalised to 0..1*.

1. **Positions.** `posRadius.xyz` was used as a byte, so a position of 128 became
   0.502 and then `0.502 * 1.99 - 64 = -63`. Every light sat at roughly
   `(-63,-63,-63)`, so `dist >= r` was true for every pixel and every light was
   skipped.
2. **The sentinel.** `int(packed.x)` on a normalised float gives `0` or `1`, never
   `255`, so the empty-slot guard never fired and unused slots read as a valid
   light index.
3. **Colour row offset.** The data texture is `MAX_LIGHTS` wide and 2 tall, so its
   storage is row-major: texel `(i,0)` is at `i*4` and texel `(i,1)` is at
   `MAX_LIGHTS*4 + i*4`. Colour was written at `o + 4`, interleaved into row 0, so
   every colour fetch returned zero — and zero multiplied through the whole
   lighting term is exactly zero. Meanwhile the *position* fetch, which was at an
   offset that happened to be right, still succeeded, which made the entire cluster
   path look healthy.
4. **Intensity.** `colorInt.a` is in byte units after the rescale, and was being
   multiplied by `INTENSITY_RANGE` rather than scaled by `1/255` first — 255x too
   bright, which is why a lamp rendered as a white hole rather than a pool.

All four failed the same way: no GL error, a correct-looking image, and a
contribution of exactly zero. The cluster grid reported 4,389 lit tiles, every
shader linked, the attenuation arithmetic was verified by hand in JavaScript and
came out right. **Everything was verified except the one thing that mattered: what
the GPU actually returned.** Checking the CPU's byte array proved the *encoder*;
the bug was always in the *decoder on the GPU side*, and no amount of inspecting
the encoder would ever have found it.

There is now a static test asserting that `lights.js` and `passes.js` agree on the
row-1 offset and that every light fetch rescales from 0..1. It cannot be a unit
test — `lights.js` imports three.js, which is a browser CDN module — so the
agreement is checked directly, which is what actually failed.

Falloff is now inverse-square near the source, windowed so it still reaches zero
at the radius. Tuned by sweeping a single lamp and reading the rendered floor
near-versus-far: production intensity gives a visible tint without clipping
anything (three lanterns in a closed room raise mean luminance by 5.2 with 0% blown
pixels). The remaining taste call is best made by eye.

**Every one of those fixes was real, and together they still made no
difference.** Re-rendering an identical frozen frame with the light data texture
blanked — same camera, same time, all three captures taken synchronously so no
server message could land between them — changes **0 pixels**, and the control
(A against A again) is also 0, so the measurement is not buried in noise. See
"Known defect" below. This section used to be titled "Fixed", which was not true.

## Known defect: point lights do not light

Lanterns and torches render, and the cluster grid reports them correctly — 1,554
tiles lit, the light's index found by `texelFetch`, the radius decoded to within
0.04 of the authored 9. **The rendered image is identical with the lights on and
off**, so the lights are not actually lighting anything.

Everything in the chain was verified individually and passes:

- the CPU cluster grid fills correctly, nearest-light-first, with a per-tile cap
- `UnsignedByteType` DataTextures upload and read back exactly (verified 77→77)
- all seven shader programs link with `runnable: true`
- the lighting shader's fetch expression is present in the compiled source
- the attenuation arithmetic, recomputed on the CPU, yields a visible 0.186

So the bug is in a step I failed to isolate. Two findings are worth recording
regardless, because both were real:

- **`FloatType` *and* `HalfFloatType` DataTextures read back as all zeros** on
  this driver, verified down to a 1×1 texture with hand-encoded values. Both were
  replaced with `UnsignedByteType` and a fixed-point encoding. Worth remembering:
  an upload that silently no-ops produces no GL error at all.
- **Colour and intensity must be separate channels.** Pre-multiplying then
  storing as a byte clamps a cyan lantern at intensity 3.3 to `(0, 2, 3)` — wrong
  hue and effectively unlit. This one is fixed.

The original measurement averaged a small central band, which may not have
overlapped any lit tile, so the claim rested on a weak test. It no longer does:
blanking `lights.dataTexture` and re-rendering an identical frozen frame — same
camera, same time, all captures taken synchronously so no server message could
land between them — changes **0 pixels** across the whole image, and the control
of A against A again is also 0, so the result is not buried in noise. The defect
is proven, not suspected.

It also rules out the obvious explanation. These lights are not merely *dim*; with
the real data the framebuffer is bit-identical to having no lights at all, while
the cluster grid cheerfully reports 1,554 tiles lit. So the grid is reporting on a
path whose output never reaches `color +=`, which narrows the fault to the loop
not running (an empty `packed` index, or every id rejected by `id >= 255`) or
every light being culled at `dist >= r`. Isolating which of those two it is is the
next step.

---

## Resolved image defects

Three of these were reported as "the picture looks wrong" while every metric
claimed otherwise. All three were real, and all three are fixed.

### The residual `GL_INVALID_OPERATION`

It had two sources.

**The overlay** (fixed first). A built-in `LineBasicMaterial` declares a single
fragment output, and against this three-attachment MRT three r170 raised
`INVALID_OPERATION` on the line draw and rasterised *nothing*: the draw was
issued, counted in `renderer.info.render.lines`, and produced zero pixels. Since
every line in the overlay shares one buffer and one draw, that one material made
the ghost, the lock boxes, the claim volumes and the remote cursors all invisible
at once — with the world still looking entirely correct, which is why nothing
reported it. It now writes all three outputs the way any other G-buffer material
does.

**Glass** was the entire remainder: 24 draws per frame, every one rejected.
Instrumenting `renderer.renderBufferDirect` and draining `gl.getError()` around
each draw gave `errBefore: 0`, `errAfter: 1282` on the glass draw and nothing
else; hiding the `glass` group took the frame to zero. Split by pass:

| pass | glass draws | result |
|---|---|---|
| shadow maps | 75 | 0 failures |
| **G-buffer** | 24 | **24 failures** |
| forward HDR | 24 | 0 failures |

Glass had two independent causes, and needed both:

- **Output count.** The G-buffer is a three-attachment MRT and glass declared a
  single `out vec4 fragColor`. A trivial two-line GLSL3 program fails 35/35 with
  one output and passes 35/35 with three — same vertex shader, same geometry, same
  render state, nothing else altered.
- **A feedback loop.** The glass shader samples `uSceneDepth`, which *is* the
  G-buffer's depth attachment, so the draw reads a texture bound to the
  framebuffer being rendered. Proven independently of the first cause: take the
  minimal three-output program that passes 0/35, add one
  `texture(uSceneDepth, …)` fetch, and it goes 35/35.

Ruled out by experiment rather than assumption: render state (glass fails under
*every* state — blending, depth test, side and `transparent` ablated one at a
time, and it fails even when given the chunk material's own state), geometry (the
chunk material on glass geometry draws clean), linking (`LINK_STATUS` and
`VALIDATE_STATUS` true with an empty info log in every variant), index and vertex
ranges, and framebuffer completeness (`FRAMEBUFFER_COMPLETE` at draw time).

**The fix is that glass should never have been in that pass at all.** Its own doc
comment says so — *"Glass cannot go in the G-buffer"* — and `main.js` even claims
it is hidden there, but nothing implemented it: `glassGroup` is a child of `scene`,
and `renderer.render(scene, camera)` draws every child. It is now hidden for
exactly that render and restored immediately after. The rejected draws had always
written nothing, so the frame is pixel-identical while the error count goes
24/frame → 0 and 24 wasted draw calls go with it.

### FXAA filtering linear HDR instead of the display buffer

Reported as "71.9% of the ground clips at ≥254" while exposure turned out to be
innocent. The composite's FXAA compared a centre pixel taken post-ACES/sRGB
against corner taps that re-read raw `uScene` (linear 0.6–2.3), so the edge test
fired on nearly every pixel and then wrote raw HDR into the display framebuffer.
All taps and both directional blends now go through one `compose()` helper —
bloom, exposure, ACES, saturation, vignette, sRGB — so edge detection runs on
exactly the data being filtered. Model error against an FXAA-off reference went
99.78 → 17.48 levels (reference 17.45); clipped ground went 71.86% → 1.91%.
Exposure was never wrong and stays at 1.25.

### A milky frame at 2.6% clipping

Reported as "the ground looks washed out" while every metric said the tone curve
was correct. It was, and the second cause was bloom. The bright-pass threshold was
`0.9`, but the scene's pre-exposure HDR histogram reads p50 0.76, p90 2.26,
**p95 2.70 — then jumps to p99 6.02**, a separate ~4.4% population of emissive
blocks. With the knee at `0.6 × 0.9`, anything above 0.36 cleared the bright-pass,
so **48.7% of the frame** was feeding **~25% of total frame brightness** into the
blur — and because the composite sums bloom in *before* exposure, that lands on the
diffuse range as a milky lift rather than as glare. It cost 18% of measured
saturation (16.2 against 19.7 with bloom off) while clipping stayed flat at 2.62%
in every configuration, which is exactly why the numbers said "fine" and the
picture did not.

Threshold is now `3.0`, in the gap between diffuse and emissive, with the knee
rescaled to `0.30` so pulsing blocks still cross smoothly without the knee
re-admitting the diffuse range. Strength went to `0.85` because there is now far
less to lift: saturation recovers to 18.6 (against 19.7 bloom off) at 2.61%
clipping, unchanged.

---

## Architecture

```
shared/          imported verbatim by BOTH server and browser
  protocol.js    chunk math, wire protocol, snapshot transport
  materials.js   material + prop catalogue, visibility classes

server/
  authority.js   the only thing allowed to mutate settled state
  bots.js        server-side builders that commit through the authority
  index.js       socket.io, presence, 50 ms delta batching

public/src/
  world/         greedyMesher, world, quadDiff, chunkMesh, meshManager, worker
  net/           connection.js  (prediction + reconciliation)
  interact/      picking.js (DDA), overlay.js (ghost/cursors/zones)
  render/        context, shaders, targets, csm, passes, pipeline
  ui/hud.js
```

`shared/` is served to the browser as-is, so the client and server cannot drift
on chunk math or the wire format.

### A chunk is a column, not a cube

Chunks tile horizontally only; a column spans the full `CHUNK_SIZE x MAX_Y x
CHUNK_SIZE` (16 × 48 × 16). `voxelIndex` keys on **world** `y`, so a cubic buffer
drops every write above y=15 — typed-array out-of-bounds writes are silent no-ops,
and reads return `undefined`, which compares unequal to 0 and makes the entire
upper world read as permanently occupied. `COLUMN_VOLUME` (12288) is the correct
size; `test/authority.test.js` pins this down.

### Greedy meshing

Pure and dependency-free, so it runs identically in the Web Worker and under
`node --test` — which is what lets correctness be proven before any rendering
exists. 16-byte interleaved vertices (see `greedyMesher.js` for the full table).

Three rules worth knowing:

- **Opaque always wins seam ownership.** At a material boundary only one cell may
  own the face; resolving towards opaque makes it deterministic regardless of
  sweep direction, and guarantees glass never ends up coplanar with the opaque
  surface behind it.
- **Glass never casts AO**, and glass-to-glass is culled, so translucent geometry
  can never be sandwiched against a coincident opaque quad.
- **Greedy merging is content-keyed.** Adding one block to a pillar splits that
  pillar's merged face into two, and removing a block re-merges it. A
  purely subtractive edit can legitimately *add* a quad. The dual-buffer FX diffs
  by quad content (corner + extent + normal + material) precisely because
  positions in the buffer are not stable across rebuilds.

### Dual buffer + content-addressed animation

Meshing is asynchronous, so geometry lags the world. Each rebuild diffs two
generations and routes every quad down one of three paths: unchanged (settle in
the new geometry only), new (spawn dissolve), or vanished (re-pack into a
retiring mesh that melts away).

Vanished quads are *extracted* rather than kept as a second live copy, because a
quad present in both generations must not be drawn twice — coincident surfaces
z-fight. Animation is entirely data-driven via a per-vertex `aFx` attribute
(`progress, mode, seed, _`), so one material serves settled, spawning and melting
geometry with no material clones and no per-mesh uniforms.

### Prediction and reconciliation

| outcome | what the client does |
|---|---|
| accepted | writes the server's `result` into settled state **and** clears the prediction |
| denied | drops the prediction; adopts `winner.mat` when the denial names one |
| no response in 4 s | drops the prediction, falls back to settled state |

Writing the authoritative value *on the ack* rather than waiting for the broadcast
delta is deliberate: the delta and the ack race each other, and either arrival
order must land on the same picture. Writing on the ack makes the later delta a
no-op instead of a one-frame flicker.

Two subtleties that are easy to get wrong and are covered by tests:

- **Your own echo is not a conflict.** The server's broadcast of *your* accepted
  placement travels the same path as a rival's. The conflict check keys on
  `d.by !== selfId`, otherwise a delta beating its own ack shatters a ghost over
  a build that succeeded.
- **Accepted ops must carry the revision back.** Without it the client's view of
  the voxel stays at rev 0 and every follow-up removal silently skips the server's
  stale-write check.

Conflict rejection is *real*: `forceRace` makes the server commit a rival block at
the target voxel and then deny the client, so there is genuine authoritative state
to reconcile against rather than a synthesised error.

### Snapshot transport

Snapshots carry thousands of voxels at once. They were originally sent as raw
`ArrayBuffer`s, which works from Node but raises a **parse error** in the browser's
socket.io client — dropping the connection immediately and looping forever, with
the server logging a cheerful `[join]` each time. Snapshots are base64-encoded
instead. Since a material id is a single digit, 12288 voxels compress to 12288
bytes and then 16 KB of text — *smaller* than JSON for an array of numbers.

---

## GLSL failures are nearly invisible

Worth recording, because it cost most of the debugging time and shaped the test
suite. GLSL fails at *link* time, not import time, and three.js surfaces a broken
program only as a numeric `GL_INVALID_OPERATION` at draw time. Five separate real
bugs all presented as "the screen is black":

1. `COMMON` declared material decoders, so every post pass that included it
   without `MATERIAL_TABLE` failed with "undeclared identifier".
2. **A trailing comma in a call argument list.** Legal in JavaScript, a syntax
   error in GLSL — and the driver points at the closing paren several lines below
   the actual mistake.
3. `uint * float`. GLSL ES 3.00 has no implicit conversion, so the material-id tint
   was rejected outright.
4. **`COMMON` redefined `luminance`, which three.js's own `ShaderChunk.common`
   already declares** for every `ShaderMaterial`. Only the chunk materials broke;
   the post passes used `RawShaderMaterial` and got no injection, so they compiled
   fine — which is what made this so hard to spot.
5. **`aMat` declared `uint`, so three.js bound it with `vertexAttribIPointer`**
   against a `Uint16Array`, reading 4 bytes per component out of a 2-byte-per-
   element buffer. Changed to a `float` varying, converted in the shader.

Two further lessons:

- **three.js injects `#version 300 es` into both stages of a `RawShaderMaterial`.**
  Writing one by hand is a hard error ("must occur before anything else"). My first
  attempt added it because a manual compile appeared to fail without it — the manual
  compile was not reproducing three's prefix. Verify against the real pipeline, not
  a stripped-down reproduction.
- **Geometry needs a `position` attribute.** three.js reads
  `geometry.attributes.position` internally for `computeBoundingBox`, raycasting
  and shadow-camera paths. The custom `aPos` alias was needed, costing no extra
  buffer since both names read the same interleaved data.

`test/shaders.test.js` now statically checks for all of these — redefinition of
three.js-provided names, trailing commas, uint/float mixing, missing GLSL3
declarations, and that every module parses. It also runs `node --check` over the
whole source tree, which caught a duplicate `const` declaration within a minute of
being introduced.

## JavaScript failures are invisible too, in a different way

The same pattern showed up in plain JS, and it is worth separating out because the
symptom is so misleading. **Build and Destroy both placed blocks, and Decor placed
blocks instead of props.** Neither the console nor any GL error mentioned it.

Three defects stacked:

1. `state.tool` and the palette's internal `tool` were separate variables. A tool
   button click updated only the palette, so `state.tool` stayed at its initial
   `'build'` and `act()` never saw the switch. Keyboard shortcuts set it, which is
   why the feature appeared to work intermittently. Fixed by collapsing them into
   one callback that reports tool *and* selection together, so they cannot drift.
2. Destroy used `placementCell`, the cell **adjacent** to what was hit. Build and
   decor legitimately place beside the hit surface; destroy must remove the hit
   voxel. It was consistently trying to remove air and being denied.
3. My first fix for (1) introduced the bug that actually hid everything: the click
   handler called a bare `setTool(...)`, but `setTool` only existed as a method on
   the object's own return value. Every click threw `ReferenceError: setTool is not
   defined`, swallowed by the event dispatch, and the tool silently never changed.

The lesson generalises past this bug: **a handler that references an undefined
name does not fail visibly — it fails by doing nothing.** `node --check` passes it
and no test exercises a click. There is now a static check that collects every
name declared in a file and asserts inline event handlers only call names that
resolve, which catches (3) directly; I verified it by reintroducing the original
defect and confirming the test goes red.

Decor additionally now checks the server's own rule — a prop needs solid ground
beneath it — so the ghost turns red with a reason instead of the server denying it
afterwards. The two rules are checked in the same place precisely so the client's
prediction of the server's answer cannot diverge.

Development servers should send `Cache-Control: max-age=0` for assets. Browser
caching of ES modules makes an edited shader appear not to take effect, which
mimics a fix that did not work.

## Deliberate approximations

Stated plainly rather than overclaimed:

- **Clustered point lights, SSGI and volumetrics are designed but not
  implemented.** `CONFIG.render` carries the tuning knobs; there is no code behind
  them. Do not read `render.ssgi`, `volumetricSteps` or `clusterTilePx` as working
  features.
- **GPGPU-style effects would be fragment-shader ping-pong over float render
  targets**, not `dispatchCompute` — three.js exposes no compute API. Nothing here
  pretends otherwise because nothing here implements it.
- **Shadow casting uses an override material** with colour writes off. Much
  cheaper than evaluating the dissolve per shadow texel, at the cost of blocks
  mid-dissolve casting a full shadow for a few hundred ms.
- **Specular is Blinn-Phong**, not GGX — indistinguishable at this texel density on
  a voxel world.
- **Glass does a manual depth test against a sampled scene-depth texture** rather
  than using a shared depth attachment. Sharing one `DepthTexture` across the
  G-buffer and the HDR target made the second framebuffer's `clear` raise
  `GL_INVALID_OPERATION`; giving the HDR target its own depth and comparing
  `gl_FragCoord.z` against the G-buffer's depth as a sampler keeps the two
  framebuffers independent.
- **Ambient tints are scaled by large factors** (60–90×) in `createEnvironment`.
  A hex like `0x2b3a5c` is ~0.02 in linear space, so a "1.0" ambient multiplier
  is imperceptible and reads as a broken renderer rather than a night scene.
- **A single-block test buffer will render as 0 quads** if every apron cell is
  also solid — that is correct interior culling, not a bug. Worth knowing before
  writing the next mesher test.
- **Latency probes use a disjoint id space** from real ops. They used to both
  start at 1, so a probe answer could delete a pending placement; the RTT read also
  sat after an early return for unknown ids, so 107 of 112 probes went unmeasured
  and the HUD read 27002 ms. RTT is now the best recent sample, not an average.

---

## Tests

469 tests, `node --test test/`, all passing. They cover the layers that are easy
to get subtly wrong:

- `coach` (33) - every step's requirement being something the player can always do, ids matching what they wait for, no two consecutive steps sharing a signal, one step per pump rather than collapsing, per-step independence, clicks on a re-rendered panel, and persistence through an injected store
- `bots` (59) - goal derivation and district ownership, a specialism never diverting from the shared objective, prop-site legality, the satisfaction guard, the timer leak that hung this file, bots counting as distinct builders so a solo player is not stuck at `Room For Everyone`, and the territory work: each bot claiming a distinct quarter, staying inside it (78 of 84 commits), relocating when its ground is taken, and releasing claims on pause and dispose. It also covers the three renderer faults above, because `props.js` and `bots.js` were the two halves of one bug: the bots produced the 9,650 props that the renderer then failed to draw
- `territory` (32) - what a claim does and does not cover, the grace window appearing
  before expiry, renewal from the commit path (and *only* from a successful commit),
  a claimed district being freed but its blocks left standing, another builder taking
  the ground afterwards, the warning being long enough to cover a coffee break, and
  every restored-claim shape — malformed entries dropped, size clamped, clock not
  resumed

- `objectives` (26) — the world scan (full-height columns, contiguous runs,
  per-chunk indexing), every metric, monotonic completion, bounded ladder advance,
  and the wire format surviving a JSON round-trip

- `audioEvents` (20) — the event-to-sound mapping: the double-strike guard that keeps
  one placement from sounding twice, block-versus-prop, bot intent announcements
  staying silent, a lost race sounding once, unknown event types not throwing inside
  the frame loop, and the attribution tally staying honest when the budget refuses a
  sound
- `audio` (37) — material timbre driven off roughness, inverse-square falloff, voice
  budget cooldowns and release (including double-release), stereo pan clamping, a
  minute of realistic bot traffic staying inside the ceiling, and the ambient bed:
  open water dropping the wind entirely, the waterline reading as surf, the same
  bare sand sounding like beach below the palm line and dry crown above it, no
  surface producing total silence, no layer exceeding its own ceiling, and
  `surfaceUnder` stopping at the water surface rather than at the sea floor
- `persistence` (17) — round-trip fidelity at chunk boundaries, revision safety,
  corrupt/version-mismatched quarantine, debounce, and atomic replace
- `minimap` (15) — the surface rule (topmost, not a slice), chunk-boundary
  indexing, predictions appearing immediately including predicted removals, the
  derived canvas size that prevents clipping the world edge, and scan idempotence
- `shaders` (19) — static GLSL checks: no trailing commas, no uint/float mixing,
  no redefinition of three.js-provided names, GLSL3 declared on every material,
  `node --check` over the entire source tree, and a scope check that inline event
  handlers never call an identifier they cannot see (see below)
- `props` (16) — catalogue/renderer agreement (a placeable prop must have a recipe
  or it renders nothing), the geometry merge contract, world-side prop storage, and
  the catalogue numbers that keep a prop placeable: unique names, a Font Awesome
  icon on every entry, and a light whose reach is larger than its own height
- `greedyMesher` (17) — seam ownership, glass culling, AO, greedy invariants, and
  full-height columns
- `quadDiff` (18) — quad identity, subset extraction and its vertex/quad
  invariant, fx bytes, visibility partitioning
- `world` (20) — prediction overlay, dirty propagation including **diagonal**
  neighbours at corners, and an apron/mesher stride-agreement check that asserts
  against the mesher's own index formula rather than re-deriving it
- `picking` (27) — DDA traversal, entry normals, zero-component rays, non-finite
  direction rejection, prop AABBs, placement always landing in air, and a prop hit
  carrying the face it was entered through rather than undefined
- `connection` (43) — every reconciliation path, out-of-order answers, timeouts,
  disconnects, snapshot round trip, probe/op id disjointness
- `authority` (17) — races, optimistic concurrency, locks, zones, rate limiting,
  full-height columns
