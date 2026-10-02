// Runtime hair: loads the groom (hair.bin), drives the guide simulation from the head bone and
// the body colliders on a fixed 120 Hz clock, and publishes interpolated guide positions.
import { StrandSim } from '../physics/strands.js';
import { FixedStep, lerpRigid } from '../core/fixedstep.js';

// Simulation zones: roots nearly fixed, mid-lengths moderately flexible, tips free.
// Profiles are [root, mid, tip] (per-substep constraint fractions at 120 Hz).
export const HAIR_ZONES = {
  bangs: { global: [0.92, 0.1, 0.012], bend: [0.9, 0.5, 0.22], damping: [0.14, 0.05, 0.035], drag: 1.3, radius: 0.003, inertia: 0.8 },
  side: { global: [0.9, 0.05, 0.004], bend: [0.88, 0.38, 0.16], damping: [0.12, 0.04, 0.025], drag: 1.1, radius: 0.0035, inertia: 0.82 },
  top: { global: [0.92, 0.06, 0.004], bend: [0.9, 0.36, 0.14], damping: [0.12, 0.035, 0.022], drag: 1.0, radius: 0.0045, inertia: 0.84 },
  back: { global: [0.9, 0.045, 0.003], bend: [0.88, 0.33, 0.13], damping: [0.12, 0.035, 0.02], drag: 1.0, radius: 0.0045, inertia: 0.84 },
  nape: { global: [0.9, 0.06, 0.006], bend: [0.88, 0.38, 0.16], damping: [0.14, 0.04, 0.028], drag: 1.1, radius: 0.004, inertia: 0.82 },
};

export class HairSim {
  static async load(base, meta) {
    const buf = await fetch(`${base}${meta.file}`).then((r) => r.arrayBuffer());
    return new HairSim(buf, meta);
  }

  constructor(buffer, meta) {
    this.meta = meta;
    const arr = (name) => new Float32Array(buffer, meta.layout[name].offset, meta.layout[name].length);
    this.data = {
      guideRest: arr('guideRest'),
      guides: arr('guides'),
      weights: arr('weights'),
      rootOffset: arr('rootOffset'),
      params: arr('params'),
      shape: arr('shape'),
    };
    const G = meta.guides, N = meta.points;
    const guides = [];
    for (let g = 0; g < G; g++) guides.push({ rest: this.data.guideRest.subarray(g * N * 3, (g + 1) * N * 3), zone: meta.zones[g], seed: 7000 + g });
    this.sim = new StrandSim(guides, HAIR_ZONES, { iterations: 3 });
    this.sim.neighbors = meta.neighbors;
    this.clock = new FixedStep(this.sim.dt);
    this.prevPos = new Float32Array(this.sim.pos.length);
    this.out = new Float32Array(G * N * 4); // RGBA float texture data
    this.prevHead = null;
    this.prevColliders = null;
    this.enabled = true;
  }

  get G() {
    return this.meta.guides;
  }
  get N() {
    return this.meta.points;
  }

  reset(head) {
    this.sim.reset(head);
    this.prevPos.set(this.sim.pos);
    this.prevHead = head.slice();
  }

  /**
   * @param frameDt    seconds since last frame
   * @param head       head bone world matrix (16 floats, column-major) for this frame
   * @param colliders  world colliders for this frame [{type, c|a,b, r}]
   * @param wind       world wind vector (m/s)
   */
  update(frameDt, head, colliders, wind) {
    if (!this.prevHead) this.reset(head);
    this.sim.wind = wind;
    const prevHead = this.prevHead;
    const prevCol = this.prevColliders ?? colliders;
    const h = new Array(16);
    let alpha = 1;
    if (this.enabled) {
      alpha = this.clock.advance(frameDt, (t) => {
        this.prevPos.set(this.sim.pos);
        lerpRigid(prevHead, head, t, h);
        const cols = colliders.map((c, i) => lerpCollider(prevCol[i] ?? c, c, t));
        this.sim.step(h, cols);
      });
    } else this.sim.reset(head);
    this.prevHead = head.slice();
    this.prevColliders = colliders.map((c) => ({ ...c, c: c.c?.slice(), a: c.a?.slice(), b: c.b?.slice() }));
    // render interpolation between the last two simulated states
    const { pos } = this.sim;
    const prev = this.prevPos;
    const out = this.out;
    for (let i = 0, n = pos.length / 3; i < n; i++) {
      out[i * 4] = prev[i * 3] + (pos[i * 3] - prev[i * 3]) * alpha;
      out[i * 4 + 1] = prev[i * 3 + 1] + (pos[i * 3 + 1] - prev[i * 3 + 1]) * alpha;
      out[i * 4 + 2] = prev[i * 3 + 2] + (pos[i * 3 + 2] - prev[i * 3 + 2]) * alpha;
      out[i * 4 + 3] = 1;
    }
    return out;
  }
}

function lerpCollider(a, b, t) {
  const L = (x, y) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  return b.type === 'sphere' ? { type: 'sphere', c: L(a.c, b.c), r: b.r, friction: b.friction } : { type: 'capsule', a: L(a.a, b.a), b: L(a.b, b.b), r: b.r, friction: b.friction };
}
