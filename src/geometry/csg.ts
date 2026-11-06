// Constructive solid geometry on triangle meshes with binary space partitioning trees, after
// Evan Wallace's csg.js (MIT). Used for IFC boolean results, half-space clippings and openings.

import { cross, dot, normalize, sub, type Vec3 } from './math.js';
import { TriangleMesh } from './mesh.js';

const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Plane {
  constructor(public normal: Vec3, public w: number) {}

  static fromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return null;
    return new Plane(n, dot(n, a));
  }

  flip(): void {
    this.normal = [-this.normal[0], -this.normal[1], -this.normal[2]];
    this.w = -this.w;
  }

  clone(): Plane {
    return new Plane([...this.normal], this.w);
  }

  /** Splits a polygon by this plane into the four output lists. */
  split(polygon: Polygon, eps: number, coplanarFront: Polygon[], coplanarBack: Polygon[], front: Polygon[], back: Polygon[]): void {
    let type = 0;
    const types: number[] = [];
    for (const v of polygon.vertices) {
      const t = dot(this.normal, v) - this.w;
      const kind = t < -eps ? BACK : t > eps ? FRONT : COPLANAR;
      type |= kind;
      types.push(kind);
    }
    switch (type) {
      case COPLANAR:
        (dot(this.normal, polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      default: {
        const f: Vec3[] = [], b: Vec3[] = [];
        const n = polygon.vertices.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ti = types[i]!, tj = types[j]!;
          const vi = polygon.vertices[i]!, vj = polygon.vertices[j]!;
          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(vi);
          if ((ti | tj) === SPANNING) {
            const t = (this.w - dot(this.normal, vi)) / dot(this.normal, sub(vj, vi));
            const v: Vec3 = [vi[0] + (vj[0] - vi[0]) * t, vi[1] + (vj[1] - vi[1]) * t, vi[2] + (vj[2] - vi[2]) * t];
            f.push(v);
            b.push([...v]);
          }
        }
        if (f.length >= 3) front.push(new Polygon(f, polygon.plane));
        if (b.length >= 3) back.push(new Polygon(b, polygon.plane));
      }
    }
  }
}

class Polygon {
  constructor(public vertices: Vec3[], public plane: Plane) {}

  clone(): Polygon {
    return new Polygon(this.vertices.map(v => [...v] as Vec3), this.plane.clone());
  }

  flip(): void {
    this.vertices.reverse();
    this.plane.flip();
  }
}

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];

  constructor(private readonly eps: number, polygons?: Polygon[]) {
    if (polygons) this.build(polygons);
  }

  invert(): void {
    // Iterative, so deep trees can't overflow the stack.
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      for (const p of node.polygons) p.flip();
      node.plane?.flip();
      const t = node.front;
      node.front = node.back;
      node.back = t;
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  /** Removes the parts of `polygons` inside this tree's solid. */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return polygons.slice();
    let front: Polygon[] = [], back: Polygon[] = [];
    for (const p of polygons) this.plane.split(p, this.eps, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  clipTo(other: Node): void {
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      node.polygons = other.clipPolygons(node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  allPolygons(): Polygon[] {
    const out: Polygon[] = [];
    const stack: Node[] = [this];
    while (stack.length) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
    return out;
  }

  build(polygons: Polygon[]): void {
    const work: [Node, Polygon[]][] = [[this, polygons]];
    while (work.length) {
      const [node, list] = work.pop()!;
      if (!list.length) continue;
      if (!node.plane) node.plane = list[0]!.plane.clone();
      const front: Polygon[] = [], back: Polygon[] = [];
      for (const p of list) node.plane.split(p, this.eps, node.polygons, node.polygons, front, back);
      if (front.length) {
        if (!node.front) node.front = new Node(this.eps);
        work.push([node.front, front]);
      }
      if (back.length) {
        if (!node.back) node.back = new Node(this.eps);
        work.push([node.back, back]);
      }
    }
  }
}

function toPolygons(mesh: TriangleMesh): Polygon[] {
  const out: Polygon[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 9) {
    const a: Vec3 = [p[i]!, p[i + 1]!, p[i + 2]!], b: Vec3 = [p[i + 3]!, p[i + 4]!, p[i + 5]!], c: Vec3 = [p[i + 6]!, p[i + 7]!, p[i + 8]!];
    const plane = Plane.fromPoints(a, b, c);
    if (plane) out.push(new Polygon([a, b, c], plane));
  }
  return out;
}

function fromPolygons(polygons: Polygon[]): TriangleMesh {
  const mesh = new TriangleMesh();
  for (const polygon of polygons) {
    const v = polygon.vertices;
    for (let i = 1; i + 1 < v.length; i++) mesh.addTriangle(v[0]!, v[i]!, v[i + 1]!);
  }
  return mesh;
}

function tolerance(a: TriangleMesh, b: TriangleMesh): number {
  const ba = a.bounds(), bb = b.bounds();
  let size = 0;
  for (let k = 0; k < 6; k++) {
    if (Number.isFinite(ba[k]!)) size = Math.max(size, Math.abs(ba[k]!));
    if (Number.isFinite(bb[k]!)) size = Math.max(size, Math.abs(bb[k]!));
  }
  return Math.max(size * 1e-9, 1e-9) * 100;
}

function boundsOverlap(a: TriangleMesh, b: TriangleMesh): boolean {
  const ba = a.bounds(), bb = b.bounds();
  for (let k = 0; k < 3; k++) if (ba[k + 3]! < bb[k]! || bb[k + 3]! < ba[k]!) return false;
  return true;
}

/** a minus b. Both should be closed. */
export function subtract(a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  if (a.triangleCount === 0) return new TriangleMesh();
  if (b.triangleCount === 0 || !boundsOverlap(a, b)) return a.clone();
  const eps = tolerance(a, b);
  const A = new Node(eps, toPolygons(a)), B = new Node(eps, toPolygons(b));
  A.invert();
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.allPolygons());
  A.invert();
  return fromPolygons(A.allPolygons());
}

/** a joined with b. */
export function union(a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  if (a.triangleCount === 0) return b.clone();
  if (b.triangleCount === 0) return a.clone();
  if (!boundsOverlap(a, b)) {
    const out = a.clone();
    out.append(b);
    return out;
  }
  const eps = tolerance(a, b);
  const A = new Node(eps, toPolygons(a)), B = new Node(eps, toPolygons(b));
  A.clipTo(B);
  B.clipTo(A);
  B.invert();
  B.clipTo(A);
  B.invert();
  A.build(B.allPolygons());
  return fromPolygons(A.allPolygons());
}

/** The part of a inside b. */
export function intersect(a: TriangleMesh, b: TriangleMesh): TriangleMesh {
  if (a.triangleCount === 0 || b.triangleCount === 0 || !boundsOverlap(a, b)) return new TriangleMesh();
  const eps = tolerance(a, b);
  const A = new Node(eps, toPolygons(a)), B = new Node(eps, toPolygons(b));
  A.invert();
  B.clipTo(A);
  B.invert();
  A.clipTo(B);
  B.clipTo(A);
  A.build(B.allPolygons());
  A.invert();
  return fromPolygons(A.allPolygons());
}
