// UV-space rasterizer for texture baking. Triangles are given in glTF UV convention (v = 0 at the
// top row of the image). For every covered texel the callback receives the triangle index and
// barycentric weights; attribute interpolation is left to the caller (keeps this allocation-free).

/**
 * @param N      texture size
 * @param uv     Float32Array(triCount * 6): u0 v0 u1 v1 u2 v2 per triangle
 * @param texel  (pixelIndex, tri, w0, w1, w2) => void
 */
export function rasterize(N, uv, texel, triFilter) {
  const triCount = uv.length / 6;
  for (let t = 0; t < triCount; t++) {
    if (triFilter && !triFilter(t)) continue;
    const x0 = uv[t * 6] * N, y0 = uv[t * 6 + 1] * N;
    const x1 = uv[t * 6 + 2] * N, y1 = uv[t * 6 + 3] * N;
    const x2 = uv[t * 6 + 4] * N, y2 = uv[t * 6 + 5] * N;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(N - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(N - 1, Math.ceil(Math.max(y0, y1, y2)));
    const inv = 1 / area;
    const eps = -1e-7;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        texel(y * N + x, t, w0, w1, w2);
      }
    }
  }
}

/**
 * Fills uncovered texels with the average of covered neighbours, ring by ring, so mip-maps and
 * bilinear filtering never pull in background colour across UV seams. Texels beyond the gutter
 * get the buffer's mean value.
 * @param bufs   [{data: TypedArray, channels}]
 * @param mask   Uint8Array(N*N), 1 = covered (updated in place)
 */
export function dilate(N, bufs, mask, iterations = 16) {
  const acc = bufs.map((b) => new Float64Array(b.channels));
  const neighbours = (i, out) => {
    const x = i % N, y = (i / N) | 0;
    out.length = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N) out.push(yy * N + xx);
      }
    return out;
  };
  const nb = [];
  let frontier = new Set();
  for (let i = 0; i < N * N; i++) {
    if (mask[i]) continue;
    for (const j of neighbours(i, nb))
      if (mask[j] === 1) {
        frontier.add(i);
        break;
      }
  }
  for (let it = 0; it < iterations && frontier.size; it++) {
    const filled = [];
    for (const i of frontier) {
      let n = 0;
      for (const a of acc) a.fill(0);
      for (const j of neighbours(i, nb)) {
        if (mask[j] !== 1) continue;
        n++;
        for (let k = 0; k < bufs.length; k++) {
          const b = bufs[k];
          for (let c = 0; c < b.channels; c++) acc[k][c] += b.data[j * b.channels + c];
        }
      }
      if (!n) continue;
      for (let k = 0; k < bufs.length; k++) {
        const b = bufs[k];
        for (let c = 0; c < b.channels; c++) b.data[i * b.channels + c] = acc[k][c] / n;
      }
      filled.push(i);
    }
    for (const i of filled) mask[i] = 1;
    const next = new Set();
    for (const i of filled) for (const j of neighbours(i, nb)) if (!mask[j]) next.add(j);
    frontier = next;
  }
  // background: mean of covered texels
  for (const b of bufs) {
    const mean = new Float64Array(b.channels);
    let n = 0;
    for (let i = 0; i < N * N; i++) {
      if (!mask[i]) continue;
      n++;
      for (let c = 0; c < b.channels; c++) mean[c] += b.data[i * b.channels + c];
    }
    for (let c = 0; c < b.channels; c++) mean[c] /= Math.max(1, n);
    for (let i = 0; i < N * N; i++) if (!mask[i]) for (let c = 0; c < b.channels; c++) b.data[i * b.channels + c] = mean[c];
  }
}
