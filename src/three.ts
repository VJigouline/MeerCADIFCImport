// Builds a three.js scene graph from an imported IFC model.

import * as THREE from 'three';
import type { IfcImportResult, IfcMesh, IfcObject, IfcStyle } from './ifc/importer.js';

export interface IfcThreeOptions {
  /** Scale the model to metres. Default true; false keeps the file's length unit. */
  metres?: boolean;
  /** Turn IFC's Z-up coordinates into three.js's Y-up. Default true. */
  yUp?: boolean;
  /** Render both sides of faces, as IFC faces are often not consistently oriented. Default true. */
  doubleSided?: boolean;
}

/** What each three.js object made from an IFC object carries in userData.ifc. */
export interface IfcUserData {
  expressId: number;
  type: string;
  globalId: string | null;
  name: string | null;
  description: string | null;
  objectType: string | null;
  typeObject: string | null;
  materials: string[];
  properties: Record<string, Record<string, unknown>>;
}

/**
 * The IFC model as a THREE.Group: one child group per IFC object in its spatial structure
 * (project, site, building, storey, element), and meshes for each object's geometry, one per
 * colour. Repeated mapped geometry shares one BufferGeometry, and equal colours share a material.
 */
export function toThree(result: IfcImportResult, options: IfcThreeOptions = {}): THREE.Group {
  const metres = options.metres ?? true;
  const yUp = options.yUp ?? true;
  const side = options.doubleSided ?? true ? THREE.DoubleSide : THREE.FrontSide;
  const root = new THREE.Group();
  root.name = result.header.fileName || 'IFC model';
  root.userData.ifcSchema = result.schema;
  if (metres && result.lengthUnit !== 1) root.scale.setScalar(result.lengthUnit);
  if (yUp) root.rotation.x = -Math.PI / 2;

  const geometries = new Map<object, THREE.BufferGeometry>();
  const materials = new Map<string, THREE.Material>();
  const geometryOf = (mesh: IfcMesh): THREE.BufferGeometry => {
    let geometry = geometries.get(mesh.data);
    if (!geometry) {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.data.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.data.normals, 3));
      if (mesh.data.colors) geometry.setAttribute('color', new THREE.BufferAttribute(mesh.data.colors, 4));
      geometry.setIndex(new THREE.BufferAttribute(mesh.data.indices, 1));
      geometry.computeBoundingSphere();
      geometries.set(mesh.data, geometry);
    }
    return geometry;
  };
  const materialOf = (style: IfcStyle, vertexColors: boolean): THREE.Material => {
    const key = `${style.name}|${style.color.join(',')}|${style.opacity}|${vertexColors}`;
    let material = materials.get(key);
    if (!material) {
      const standard = new THREE.MeshStandardMaterial({
        name: style.name,
        color: vertexColors ? 0xffffff : new THREE.Color().setRGB(style.color[0], style.color[1], style.color[2], THREE.SRGBColorSpace),
        roughness: 0.8,
        metalness: 0,
        side,
        transparent: style.opacity < 1,
        opacity: style.opacity,
        vertexColors,
        depthWrite: style.opacity >= 1,
      });
      material = standard;
      materials.set(key, material);
    }
    return material;
  };

  const build = (object: IfcObject): THREE.Group => {
    const group = new THREE.Group();
    group.name = object.name ? `${object.name}` : object.type;
    const data: IfcUserData = {
      expressId: object.expressId,
      type: object.type,
      globalId: object.globalId,
      name: object.name,
      description: object.description,
      objectType: object.objectType,
      typeObject: object.typeObject,
      materials: object.materials,
      properties: object.properties,
    };
    group.userData.ifc = data;
    for (const mesh of object.meshes) {
      const three = new THREE.Mesh(geometryOf(mesh), materialOf(mesh.style, mesh.vertexColors));
      three.name = `${group.name} (${mesh.style.name})`;
      const matrix = new THREE.Matrix4().fromArray(mesh.matrix);
      matrix.decompose(three.position, three.quaternion, three.scale);
      // Shear can't be decomposed; check the round trip and keep the matrix itself if needed.
      const check = new THREE.Matrix4().compose(three.position, three.quaternion, three.scale);
      if (!check.equals(matrix) && !nearlyEqual(check, matrix)) {
        three.matrixAutoUpdate = false;
        three.matrix.copy(matrix);
      }
      three.userData.ifc = data;
      three.castShadow = true;
      three.receiveShadow = true;
      group.add(three);
    }
    for (const child of object.children) group.add(build(child));
    return group;
  };
  for (const object of result.roots) root.add(build(object));
  // World matrices ready for measuring, such as with Box3.setFromObject, before the first render.
  root.updateMatrixWorld(true);
  return root;
}

function nearlyEqual(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  let scale = 0;
  for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(b.elements[i]!));
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i]! - b.elements[i]!) > 1e-9 * Math.max(1, scale)) return false;
  return true;
}
