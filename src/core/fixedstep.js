// Fixed-timestep driver: simulations always advance in identical steps (default 120 Hz) no matter
// the render frame rate; inputs (bone transforms) are interpolated to each substep's time and the
// rendered state is interpolated between the last two simulated states. The same input motion
// therefore produces the same simulation at 30, 60 or 120 FPS.

export class FixedStep {
  constructor(dt = 1 / 120, maxSteps = 12) {
    this.dt = dt;
    this.maxSteps = maxSteps;
    this.acc = 0;
  }
  /**
   * @param frameDt  real seconds since the previous frame
   * @param step     (t01) => void, called per substep with the substep time as a fraction (0..1]
   *                 of this frame interval (for interpolating inputs between the last two frames)
   * @returns alpha  fraction of a step left over (for render interpolation)
   */
  advance(frameDt, step) {
    const dt = this.dt;
    frameDt = Math.min(frameDt, dt * this.maxSteps); // spiral-of-death guard (also on tab resume)
    const start = this.acc;
    this.acc += frameDt;
    let k = 0;
    while (this.acc >= dt) {
      this.acc -= dt;
      k++;
      // time of this substep's end, measured from the previous frame
      const t = (k * dt - start) / frameDt;
      step(Math.min(1, Math.max(0, t)));
    }
    return this.acc / dt;
  }
}

/** Column-major 4x4 rigid interpolation (lerp translation, nlerp rotation basis). */
export function lerpRigid(a, b, t, out = new Array(16)) {
  // quaternion slerp on the rotation part
  const qa = matToQuat(a), qb = matToQuat(b);
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) for (let i = 0; i < 4; i++) qb[i] = -qb[i];
  const q = qa.map((v, i) => v + (qb[i] - v) * t);
  const l = Math.hypot(...q);
  for (let i = 0; i < 4; i++) q[i] /= l;
  quatToMat(q, out);
  out[12] = a[12] + (b[12] - a[12]) * t;
  out[13] = a[13] + (b[13] - a[13]) * t;
  out[14] = a[14] + (b[14] - a[14]) * t;
  return out;
}

export function matToQuat(m) {
  const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

function quatToMat([x, y, z, w], o) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
  o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
  o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
  o[15] = 1;
  return o;
}
