// Thin glTF 2.0 writer on top of @gltf-transform/core for skinned, morphing character meshes.
import { Document, NodeIO } from '@gltf-transform/core';

export class CharacterGltf {
  constructor(name) {
    this.doc = new Document();
    this.doc.getRoot().getAsset().generator = 'Model-3D character pipeline';
    this.buffer = this.doc.createBuffer();
    this.scene = this.doc.createScene(name);
    this.materials = new Map();
    this.textures = new Map();
  }

  acc(array, type, { sparse = false, normalized = false } = {}) {
    const a = this.doc.createAccessor().setType(type).setArray(array).setBuffer(this.buffer);
    if (sparse) a.setSparse(true);
    if (normalized) a.setNormalized(true);
    return a;
  }

  /** Builds the joint node hierarchy from rig.bones (parents first) with local bind TRS. */
  addSkeleton(rig, locals, armatureName = 'Armature') {
    this.armature = this.doc.createNode(armatureName);
    this.scene.addChild(this.armature);
    this.jointNodes = rig.bones.map((b, i) => {
      const n = this.doc.createNode(b.name);
      const [t, r, s] = decompose(locals[i]);
      n.setTranslation(t).setRotation(r).setScale(s);
      if (b.role !== 'deform' && b.role !== 'root') n.setExtras({ role: b.role });
      return n;
    });
    rig.bones.forEach((b, i) => {
      if (b.parentIndex >= 0) this.jointNodes[b.parentIndex].addChild(this.jointNodes[i]);
      else this.armature.addChild(this.jointNodes[i]);
    });
    const ibm = new Float32Array(rig.bones.length * 16);
    rig.bones.forEach((b, i) => ibm.set(b.world.clone().invert().elements, i * 16));
    this.skin = this.doc.createSkin(`${armatureName}_Skin`).setSkeleton(this.jointNodes[0]).setInverseBindMatrices(this.acc(ibm, 'MAT4'));
    for (const n of this.jointNodes) this.skin.addJoint(n);
    return this.jointNodes;
  }

  texture(key, image, mimeType = 'image/png') {
    if (!this.textures.has(key)) this.textures.set(key, this.doc.createTexture(key).setImage(image).setMimeType(mimeType));
    return this.textures.get(key);
  }

  material(name, def = {}) {
    if (this.materials.has(name)) return this.materials.get(name);
    const m = this.doc.createMaterial(name);
    if (def.color) m.setBaseColorFactor(def.color);
    m.setRoughnessFactor(def.roughness ?? 0.6).setMetallicFactor(def.metallic ?? 0);
    if (def.alphaMode) m.setAlphaMode(def.alphaMode);
    if (def.alphaCutoff != null) m.setAlphaCutoff(def.alphaCutoff);
    if (def.doubleSided) m.setDoubleSided(true);
    if (def.baseColorTexture) m.setBaseColorTexture(def.baseColorTexture);
    if (def.normalTexture) m.setNormalTexture(def.normalTexture);
    if (def.metallicRoughnessTexture) m.setMetallicRoughnessTexture(def.metallicRoughnessTexture);
    if (def.occlusionTexture) m.setOcclusionTexture(def.occlusionTexture);
    if (def.extras) m.setExtras(def.extras);
    this.materials.set(name, m);
    return m;
  }

  /**
   * mesh: {name, positions, normals, uvs, tangents?, joints, weights, indices, material,
   *        morphs?: [{name, position: Float32Array, normal?: Float32Array}], extras?, parent?}
   */
  addMesh(mesh) {
    const prim = this.doc
      .createPrimitive()
      .setAttribute('POSITION', this.acc(mesh.positions, 'VEC3'))
      .setIndices(this.acc(mesh.indices, 'SCALAR'))
      .setMaterial(mesh.material);
    if (mesh.normals) prim.setAttribute('NORMAL', this.acc(mesh.normals, 'VEC3'));
    if (mesh.uvs) prim.setAttribute('TEXCOORD_0', this.acc(mesh.uvs, 'VEC2'));
    if (mesh.uvs1) prim.setAttribute('TEXCOORD_1', this.acc(mesh.uvs1, 'VEC2'));
    if (mesh.tangents) prim.setAttribute('TANGENT', this.acc(mesh.tangents, 'VEC4'));
    if (mesh.colors) prim.setAttribute('COLOR_0', this.acc(mesh.colors, 'VEC4'));
    for (const [name, a] of Object.entries(mesh.custom ?? {})) prim.setAttribute(name, this.acc(a.array, a.type));
    if (mesh.joints) {
      prim.setAttribute('JOINTS_0', this.acc(mesh.joints, 'VEC4'));
      prim.setAttribute('WEIGHTS_0', this.acc(mesh.weights, 'VEC4'));
    }
    const m = this.doc.createMesh(mesh.name).addPrimitive(prim);
    if (mesh.morphs?.length) {
      for (const t of mesh.morphs) {
        const target = this.doc.createPrimitiveTarget(t.name).setAttribute('POSITION', this.acc(t.position, 'VEC3', { sparse: true }));
        if (t.normal) target.setAttribute('NORMAL', this.acc(t.normal, 'VEC3', { sparse: true }));
        prim.addTarget(target);
      }
      m.setWeights(mesh.morphs.map(() => 0));
      m.setExtras({ ...(mesh.extras ?? {}), targetNames: mesh.morphs.map((t) => t.name) });
    } else if (mesh.extras) m.setExtras(mesh.extras);
    const node = this.doc.createNode(mesh.name).setMesh(m);
    if (mesh.joints) node.setSkin(this.skin);
    (mesh.parent ?? this.armature ?? this.scene).addChild(node);
    if (mesh.nodeExtras) node.setExtras(mesh.nodeExtras);
    return node;
  }

  async write() {
    return new NodeIO().writeBinary(this.doc);
  }
}

function decompose(m) {
  // three.js Matrix4 -> [t, r(quat xyzw), s] without importing three here
  const e = m.elements;
  const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
  const m11 = e[0] / sx, m12 = e[4] / sy, m13 = e[8] / sz;
  const m21 = e[1] / sx, m22 = e[5] / sy, m23 = e[9] / sz;
  const m31 = e[2] / sx, m32 = e[6] / sy, m33 = e[10] / sz;
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
  const r = [x, y, z, w];
  const l = Math.hypot(...r);
  const round = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v);
  return [[e[12], e[13], e[14]], r.map((v) => v / l), [round(sx), round(sy), round(sz)]];
}
