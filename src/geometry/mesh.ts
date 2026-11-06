// Triangle soup used by the geometry code, and the conversion to indexed vertices with normals.

import { cross, determinant3, normalize, sub, transformPoint, type Mat4, type Vec3 } from './math.js';

/** Triangles as a flat list of vertex positions, nine numbers per triangle, wound counter-clockwise outwards. */
export class TriangleMesh {
  positions: number[] = [];
  /** Optional RGBA per vertex, twelve numbers per triangle. */
  colors: number[] | null = null;

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  addTriangle(a: Vec3, b: Vec3, c: Vec3): void {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    if (this.colors) for (let i = 0; i < 3; i++) this.colors.push(1, 1, 1, 1);
  }

  addColoredTriangle(a: Vec3, b: Vec3, c: Vec3, rgba: readonly number[]): void {
    if (!this.colors) this.colors = new Array<number>((this.positions.length / 9) * 12).fill(1);
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.colors.push(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3] ?? 1);
  }

  /** Adds a polygon fan over indices into a point list. */
  addIndexed(points: readonly Vec3[], triangles: readonly number[], flip = false): void {
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const a = points[triangles[i]!]!, b = points[triangles[i + 1]!]!, c = points[triangles[i + 2]!]!;
      if (flip) this.addTriangle(a, c, b);
      else this.addTriangle(a, b, c);
    }
  }

  append(other: TriangleMesh, matrix?: Mat4): void {
    if (other.colors && !this.colors) this.colors = new Array<number>((this.positions.length / 9) * 12).fill(1);
    const flip = matrix ? determinant3(matrix) < 0 : false;
    const p = other.positions;
    for (let t = 0; t < p.length; t += 9) {
      let a: Vec3 = [p[t]!, p[t + 1]!, p[t + 2]!], b: Vec3 = [p[t + 3]!, p[t + 4]!, p[t + 5]!], c: Vec3 = [p[t + 6]!, p[t + 7]!, p[t + 8]!];
      if (matrix) {
        a = transformPoint(matrix, a); b = transformPoint(matrix, b); c = transformPoint(matrix, c);
      }
      if (flip) this.positions.push(...a, ...c, ...b);
      else this.positions.push(...a, ...b, ...c);
      if (this.colors) {
        const k = (t / 9) * 12;
        if (other.colors) {
          const oc = other.colors.slice(k, k + 12);
          if (flip) this.colors.push(...oc.slice(0, 4), ...oc.slice(8, 12), ...oc.slice(4, 8));
          else this.colors.push(...oc);
        } else {
          for (let i = 0; i < 12; i++) this.colors.push(1);
        }
      }
    }
  }

  transformed(matrix: Mat4): TriangleMesh {
    const out = new TriangleMesh();
    out.append(this, matrix);
    return out;
  }

  clone(): TriangleMesh {
    const out = new TriangleMesh();
    out.positions = this.positions.slice();
    out.colors = this.colors ? this.colors.slice() : null;
    return out;
  }

  /** Axis-aligned bounds: min xyz then max xyz. Infinite when empty. */
  bounds(): [number, number, number, number, number, number] {
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k]! < b[k]!) b[k] = p[i + k]!;
        if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!;
      }
    }
    return b;
  }
}

/** Indexed mesh with normals, ready for a three.js BufferGeometry. */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** RGBA per vertex, when the source had per-face colours. */
  colors: Float32Array | null;
}

/**
 * Welds vertices and gives each corner a normal averaged over the faces around it within
 * `creaseAngle` (radians) of its own face, so curved surfaces look smooth and edges stay sharp.
 */
export function toMeshData(mesh: TriangleMesh, creaseAngle: number): MeshData {
  const p = mesh.positions;
  const triangleCount = p.length / 9;
  const faceNormals = new Float64Array(triangleCount * 3);
  const keep: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const n = cross(sub([p[o + 3]!, p[o + 4]!, p[o + 5]!], [p[o]!, p[o + 1]!, p[o + 2]!]), sub([p[o + 6]!, p[o + 7]!, p[o + 8]!], [p[o]!, p[o + 1]!, p[o + 2]!]));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 0)) continue;
    faceNormals[t * 3] = n[0] / l; faceNormals[t * 3 + 1] = n[1] / l; faceNormals[t * 3 + 2] = n[2] / l;
    keep.push(t);
  }
  // Weld positions with a tolerance relative to the mesh's size.
  const b = mesh.bounds();
  const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 1e-12);
  const q = size * 1e-7;
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
  const positionIndex = new Map<string, number>();
  const cornerPosition = new Int32Array(triangleCount * 3);
  const incident: number[][] = [];
  for (const t of keep) {
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const key = keyOf(p[o]!, p[o + 1]!, p[o + 2]!);
      let index = positionIndex.get(key);
      if (index === undefined) {
        index = incident.length;
        positionIndex.set(key, index);
        incident.push([]);
      }
      cornerPosition[t * 3 + c] = index;
      incident[index]!.push(t);
    }
  }
  const cosCrease = Math.cos(creaseAngle);
  const outPositions: number[] = [], outNormals: number[] = [], outColors: number[] = [], outIndices: number[] = [];
  const vertexIndex = new Map<string, number>();
  const colors = mesh.colors;
  for (const t of keep) {
    const fn: Vec3 = [faceNormals[t * 3]!, faceNormals[t * 3 + 1]!, faceNormals[t * 3 + 2]!];
    for (let c = 0; c < 3; c++) {
      const position = cornerPosition[t * 3 + c]!;
      let nx = 0, ny = 0, nz = 0;
      for (const other of incident[position]!) {
        const ox = faceNormals[other * 3]!, oy = faceNormals[other * 3 + 1]!, oz = faceNormals[other * 3 + 2]!;
        if (ox * fn[0] + oy * fn[1] + oz * fn[2] >= cosCrease) {
          nx += ox; ny += oy; nz += oz;
        }
      }
      const n = normalize([nx, ny, nz]);
      const o = t * 9 + c * 3;
      const colorKey = colors ? `,${colors.slice(t * 12 + c * 4, t * 12 + c * 4 + 4).join(',')}` : '';
      // Share a vertex between corners with the same position, normal and colour.
      const key = `${position},${Math.round(n[0] * 1e4)},${Math.round(n[1] * 1e4)},${Math.round(n[2] * 1e4)}${colorKey}`;
      let index = vertexIndex.get(key);
      if (index === undefined) {
        index = outPositions.length / 3;
        vertexIndex.set(key, index);
        outPositions.push(p[o]!, p[o + 1]!, p[o + 2]!);
        outNormals.push(n[0], n[1], n[2]);
        if (colors) outColors.push(...colors.slice(t * 12 + c * 4, t * 12 + c * 4 + 4));
      }
      outIndices.push(index);
    }
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices: new Uint32Array(outIndices),
    colors: colors ? new Float32Array(outColors) : null,
  };
}
