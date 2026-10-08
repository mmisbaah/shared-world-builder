/**
 * Greedy mesher worker.
 *
 * Deliberately thin: it owns no state and does no caching. The authority for
 * what a column looks like lives in `World` on the main thread, which gathers a
 * padded apron and hands it over; this worker only transforms that snapshot.
 *
 * The request carries a *copy* of the apron and the reply transfers the result
 * buffers back, so neither side ever shares a typed array with the other and
 * there is no possibility of the main thread mutating memory a mesh is being
 * built from.
 */

import { greedyMesh } from './greedyMesher.js';

self.onmessage = (event) => {
  const { jobId, cx, cz, padded, size, sizeY } = event.data;

  let result;
  try {
    // Transferring detaches the buffer, so what arrives here is a raw
    // ArrayBuffer. It has to be wrapped before use: indexing an ArrayBuffer
    // yields undefined rather than throwing, which would make every neighbour
    // sample look like air and silently cull the entire chunk.
    const voxels = new Uint16Array(padded);
    result = greedyMesh(voxels, size, undefined, sizeY);
  } catch (err) {
    self.postMessage({ jobId, cx, cz, error: String((err && err.stack) || err) });
    return;
  }

  // Transfer rather than copy: these buffers are freshly allocated per job and
  // the worker has no further use for them.
  self.postMessage(
    { jobId, cx, cz, ...result },
    [result.vertex, result.index, result.quads],
  );
};
