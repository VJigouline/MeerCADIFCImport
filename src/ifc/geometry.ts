// Converts IFC geometric representation items into triangle meshes: placements, curves,
// profiles, swept solids, B-reps, tessellated face sets, CSG primitives and booleans.

import { intersect, subtract, union } from '../geometry/csg.js';
import {
  cross, dot, fromAxes, identity, length, multiply, normalize, perpendicular, sub, transformPoint,
  type Mat4, type Vec2, type Vec3,
} from '../geometry/math.js';
import { TriangleMesh } from '../geometry/mesh.js';
import { cleanPolygon, signedArea, triangulate, triangulate3D } from '../geometry/triangulate.js';
import { StepRef, StepTyped, type StepEntity, type StepFile, type StepValue } from '../step/step.js';
import type { IfcSchemaInfo } from './schema.js';
import { bool, deref, derefList, enumValue, list, num, unwrap } from './values.js';

export interface GeometryOptions {
  /** Segments for a full circle. Arcs use a share of them. */
  circleSegments: number;
  /** Largest number of triangle pairs a single boolean may compare before it is skipped. */
  booleanLimit: number;
}

/** A closed 2D profile: an outer boundary and holes, or several of them for composite profiles. */
interface Area {
  outer: Vec2[];
  holes: Vec2[][];
}

/** Collects warnings once per message, with a count. */
export class Warnings {
  readonly counts = new Map<string, number>();
  add(message: string): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([message, count]) => (count > 1 ? `${message} (${count} times)` : message));
  }
}

export class GeometryReader {
  private readonly placementCache = new Map<number, Mat4>();

  constructor(
    private readonly file: StepFile,
    readonly schema: IfcSchemaInfo,
    private readonly options: GeometryOptions,
    private readonly warnings: Warnings,
    /** Plane angle unit in radians. */
    private readonly angleFactor: number,
  ) {}

  // ---------------------------------------------------------------- points and placements

  point(e: StepEntity | null): Vec3 {
    if (!e) return [0, 0, 0];
    const c = list(e.args[0]);
    return [num(c[0], 0), num(c[1], 0), num(c[2], 0)];
  }

  direction(e: StepEntity | null, fallback: Vec3): Vec3 {
    if (!e) return fallback;
    const c = list(e.args[0]);
    const d = normalize([num(c[0], 0), num(c[1], 0), num(c[2], 0)]);
    return d[0] === 0 && d[1] === 0 && d[2] === 0 ? fallback : d;
  }

  /** IfcAxis2Placement3D or IfcAxis2Placement2D as a matrix. */
  axisPlacement(e: StepEntity | null): Mat4 {
    if (!e) return identity();
    const origin = this.point(deref(this.file, e.args[0]));
    if (e.type === 'IFCAXIS2PLACEMENT2D') {
      const x = this.direction(deref(this.file, e.args[1]), [1, 0, 0]);
      const xd = normalize([x[0], x[1], 0]);
      return fromAxes(xd, [-xd[1], xd[0], 0], [0, 0, 1], origin);
    }
    if (e.type === 'IFCAXIS1PLACEMENT') {
      const z = this.direction(deref(this.file, e.args[1]), [0, 0, 1]);
      const x = perpendicular(z);
      return fromAxes(x, cross(z, x), z, origin);
    }
    const z = this.direction(deref(this.file, e.args[1]), [0, 0, 1]);
    // Default x as IfcFirstProjAxis: (1, 0, 0), or (0, 1, 0) when z lies along x.
    let x = this.direction(deref(this.file, e.args[2]), Math.abs(z[0]) > 1 - 1e-9 ? [0, 1, 0] : [1, 0, 0]);
    // Make x perpendicular to z, as IfcBuildAxes does.
    x = normalize(sub(x, [z[0] * dot(x, z), z[1] * dot(x, z), z[2] * dot(x, z)]));
    if (length(x) === 0) x = perpendicular(z);
    return fromAxes(x, cross(z, x), z, origin);
  }

  /** IfcObjectPlacement as a world matrix, following PlacementRelTo. */
  objectPlacement(e: StepEntity | null, depth = 0): Mat4 {
    if (!e || depth > 64) return identity();
    const cached = this.placementCache.get(e.id);
    if (cached) return cached;
    let m: Mat4;
    if (e.type === 'IFCLOCALPLACEMENT') {
      const parent = deref(this.file, e.args[0]);
      m = multiply(this.objectPlacement(parent, depth + 1), this.axisPlacement(deref(this.file, e.args[1])));
    } else if (e.type === 'IFCLINEARPLACEMENT') {
      // IFC4X1+: a placement along an alignment. Its optional CartesianPosition is the result as a
      // plain placement; alignment geometry itself is not evaluated.
      const cartesian = deref(this.file, e.args[2]);
      if (cartesian) {
        m = this.axisPlacement(cartesian);
      } else {
        this.warnings.add('IfcLinearPlacement without CartesianPosition: placed at the origin');
        m = identity();
      }
    } else if (e.type === 'IFCGRIDPLACEMENT') {
      this.warnings.add('IfcGridPlacement is not supported: placed at its parent');
      m = this.objectPlacement(deref(this.file, e.args[0]), depth + 1);
    } else {
      m = identity();
    }
    this.placementCache.set(e.id, m);
    return m;
  }

  /** IfcCartesianTransformationOperator2D/3D (and their non-uniform forms) as a matrix. */
  transformOperator(e: StepEntity | null): Mat4 {
    if (!e) return identity();
    const origin = this.point(deref(this.file, e.args[2]));
    const scale = num(e.args[3], 1);
    const is3D = e.type.includes('3D');
    let z: Vec3 = is3D ? this.direction(deref(this.file, e.args[4]), [0, 0, 1]) : [0, 0, 1];
    if (!is3D) z = [0, 0, 1];
    const a1 = deref(this.file, e.args[0]);
    let x = this.direction(a1, [1, 0, 0]);
    x = normalize(sub(x, [z[0] * dot(x, z), z[1] * dot(x, z), z[2] * dot(x, z)]));
    if (length(x) === 0) x = perpendicular(z);
    const a2 = deref(this.file, e.args[1]);
    let y = a2 ? this.direction(a2, cross(z, x)) : cross(z, x);
    y = normalize(sub(sub(y, [z[0] * dot(y, z), z[1] * dot(y, z), z[2] * dot(y, z)]), [x[0] * dot(y, x), x[1] * dot(y, x), x[2] * dot(y, x)]));
    if (length(y) === 0) y = cross(z, x);
    let sx = scale, sy = scale, sz = scale;
    if (e.type === 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM') {
      sy = num(e.args[5], scale);
      sz = num(e.args[6], scale);
    } else if (e.type === 'IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM') {
      sy = num(e.args[4], scale);
    }
    return fromAxes([x[0] * sx, x[1] * sx, x[2] * sx], [y[0] * sy, y[1] * sy, y[2] * sy], [z[0] * sz, z[1] * sz, z[2] * sz], origin);
  }

  // ---------------------------------------------------------------- curves

  private segments(angle: number): number {
    return Math.max(2, Math.ceil((Math.abs(angle) / (2 * Math.PI)) * this.options.circleSegments));
  }

  /** Points along a curve, in its own coordinates (z = 0 for 2D curves). */
  curve(e: StepEntity | null, depth = 0): Vec3[] {
    if (!e || depth > 32) return [];
    switch (e.type) {
      case 'IFCPOLYLINE':
        return derefList(this.file, e.args[0]).map(p => this.point(p));
      case 'IFCINDEXEDPOLYCURVE':
        return this.indexedPolyCurve(e);
      case 'IFCCIRCLE':
      case 'IFCELLIPSE':
        return this.conic(e, 0, 2 * Math.PI, true);
      case 'IFCTRIMMEDCURVE':
        return this.trimmedCurve(e, depth);
      case 'IFCCOMPOSITECURVE':
      case 'IFCCOMPOSITECURVEONSURFACE': {
        const out: Vec3[] = [];
        for (const segment of derefList(this.file, e.args[0])) {
          let points: Vec3[];
          if (segment.type === 'IFCCOMPOSITECURVESEGMENT' || segment.type === 'IFCREPARAMETRISEDCOMPOSITECURVESEGMENT') {
            points = this.curve(deref(this.file, segment.args[2]), depth + 1);
            if (!bool(segment.args[1], true)) points.reverse();
          } else {
            points = this.curve(segment, depth + 1);
          }
          for (const p of points) {
            const last = out[out.length - 1];
            if (!last || length(sub(last, p)) > 1e-9) out.push(p);
          }
        }
        return out;
      }
      case 'IFCBSPLINECURVEWITHKNOTS':
      case 'IFCRATIONALBSPLINECURVEWITHKNOTS':
        this.warnings.add('B-spline curves are approximated by their control polygon');
        return derefList(this.file, e.args[1]).map(p => this.point(p));
      default:
        this.warnings.add(`${e.type} curves are not supported`);
        return [];
    }
  }

  private indexedPolyCurve(e: StepEntity): Vec3[] {
    const pointList = deref(this.file, e.args[0]);
    const coordinates = list(pointList?.args[0]).map(c => {
      const v = list(c);
      return [num(v[0], 0), num(v[1], 0), num(v[2], 0)] as Vec3;
    });
    const segments = list(e.args[1]);
    if (segments.length === 0) return coordinates;
    const out: Vec3[] = [];
    const push = (p: Vec3) => {
      const last = out[out.length - 1];
      if (!last || length(sub(last, p)) > 1e-9) out.push(p);
    };
    for (const segment of segments) {
      const typed = segment instanceof StepTyped ? segment : null;
      const indices = list(typed ? typed.value : segment).map(i => num(i, 0) - 1);
      const points = indices.map(i => coordinates[i]).filter((p): p is Vec3 => !!p);
      if (typed?.type === 'IFCARCINDEX' && points.length === 3) {
        for (const p of this.arcThrough(points[0]!, points[1]!, points[2]!)) push(p);
      } else {
        for (const p of points) push(p);
      }
    }
    return out;
  }

  /** Points on the circular arc from a through b to c. */
  private arcThrough(a: Vec3, b: Vec3, c: Vec3): Vec3[] {
    const ab = sub(b, a), ac = sub(c, a);
    const n = cross(ab, ac);
    const nn = dot(n, n);
    if (nn < 1e-20) return [a, b, c];
    // Circumcentre of the triangle a, b, c.
    const t1 = cross(n, ab), t2 = cross(ac, n);
    const k1 = dot(ac, ac) / (2 * nn), k2 = dot(ab, ab) / (2 * nn);
    const centre: Vec3 = [a[0] + t1[0] * k1 + t2[0] * k2, a[1] + t1[1] * k1 + t2[1] * k2, a[2] + t1[2] * k1 + t2[2] * k2];
    const radius = length(sub(a, centre));
    const normal = normalize(n);
    const x = normalize(sub(a, centre)), y = cross(normal, x);
    const angleOf = (p: Vec3) => {
      const d = sub(p, centre);
      let angle = Math.atan2(dot(d, y), dot(d, x));
      if (angle < 0) angle += 2 * Math.PI;
      return angle;
    };
    const end = angleOf(c);
    const steps = this.segments(end);
    const out: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (end * i) / steps;
      out.push([centre[0] + radius * (Math.cos(t) * x[0] + Math.sin(t) * y[0]), centre[1] + radius * (Math.cos(t) * x[1] + Math.sin(t) * y[1]), centre[2] + radius * (Math.cos(t) * x[2] + Math.sin(t) * y[2])]);
    }
    return out;
  }

  /** Points on an IfcCircle or IfcEllipse from angle t0 to t1 (radians), counter-clockwise if `ccw`. */
  private conic(e: StepEntity, t0: number, t1: number, ccw: boolean): Vec3[] {
    const m = this.axisPlacement(deref(this.file, e.args[0]));
    const rx = num(e.args[1], 0), ry = e.type === 'IFCELLIPSE' ? num(e.args[2], rx) : rx;
    let sweep = ccw ? t1 - t0 : t0 - t1;
    while (sweep <= 1e-9) sweep += 2 * Math.PI;
    const steps = this.segments(sweep);
    const out: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = t0 + ((ccw ? 1 : -1) * sweep * i) / steps;
      out.push(transformPoint(m, [rx * Math.cos(t), ry * Math.sin(t), 0]));
    }
    return out;
  }

  private trimmedCurve(e: StepEntity, depth: number): Vec3[] {
    const basis = deref(this.file, e.args[0]);
    if (!basis) return [];
    const sense = bool(e.args[3], true);
    const master = enumValue(e.args[4]);
    const trim = (value: StepValue | undefined): { point: Vec3 | null; parameter: number | null } => {
      let point: Vec3 | null = null, parameter: number | null = null;
      for (const v of list(value)) {
        if (v instanceof StepRef) point = this.point(this.file.get(v.id) ?? null);
        else if (typeof unwrap(v) === 'number') parameter = num(v);
      }
      return { point, parameter };
    };
    const a = trim(e.args[1]), b = trim(e.args[2]);
    const useParameter = (t: { point: Vec3 | null; parameter: number | null }) =>
      t.parameter !== null && (master === 'PARAMETER' || t.point === null);
    if (basis.type === 'IFCCIRCLE' || basis.type === 'IFCELLIPSE') {
      const m = this.axisPlacement(deref(this.file, basis.args[0]));
      const rx = num(basis.args[1], 1), ry = basis.type === 'IFCELLIPSE' ? num(basis.args[2], rx) : rx;
      const angleOf = (t: { point: Vec3 | null; parameter: number | null }): number => {
        if (useParameter(t)) return t.parameter! * this.angleFactor;
        if (t.point) {
          const d = sub(t.point, [m[12]!, m[13]!, m[14]!]);
          return Math.atan2(dot(d, [m[4]!, m[5]!, m[6]!]) / ry, dot(d, [m[0]!, m[1]!, m[2]!]) / rx);
        }
        return 0;
      };
      return this.conic(basis, angleOf(a), angleOf(b), sense);
    }
    if (basis.type === 'IFCLINE') {
      const origin = this.point(deref(this.file, basis.args[0]));
      const vector = deref(this.file, basis.args[1]);
      const dir = this.direction(deref(this.file, vector?.args[0]), [1, 0, 0]);
      const magnitude = num(vector?.args[1], 1);
      const at = (t: { point: Vec3 | null; parameter: number | null }): Vec3 =>
        useParameter(t) ? [origin[0] + dir[0] * magnitude * t.parameter!, origin[1] + dir[1] * magnitude * t.parameter!, origin[2] + dir[2] * magnitude * t.parameter!] : t.point ?? origin;
      return [at(a), at(b)];
    }
    // Other basis curves: use the trimming points where given, else the whole curve.
    const points = this.curve(basis, depth + 1);
    if (a.point && b.point && points.length > 1) {
      const nearest = (p: Vec3) => points.reduce((best, q, i) => (length(sub(q, p)) < length(sub(points[best]!, p)) ? i : best), 0);
      const i = nearest(a.point), j = nearest(b.point);
      const part = i <= j ? points.slice(i, j + 1) : points.slice(j, i + 1).reverse();
      return sense ? part : part.reverse();
    }
    return sense ? points : points.reverse();
  }

  // ---------------------------------------------------------------- profiles

  /** Areas of an IfcProfileDef, in the profile's 2D coordinates. */
  profile(e: StepEntity | null, depth = 0): Area[] {
    if (!e || depth > 16) return [];
    const t = e.type;
    if (t === 'IFCARBITRARYCLOSEDPROFILEDEF' || t === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
      const outer = this.closedCurve2D(deref(this.file, e.args[2]));
      if (outer.length < 3) return [];
      const holes = t === 'IFCARBITRARYPROFILEDEFWITHVOIDS'
        ? derefList(this.file, e.args[3]).map(c => this.closedCurve2D(c)).filter(h => h.length >= 3)
        : [];
      return [{ outer, holes }];
    }
    if (t === 'IFCCOMPOSITEPROFILEDEF') {
      return derefList(this.file, e.args[2]).flatMap(p => this.profile(p, depth + 1));
    }
    if (t === 'IFCDERIVEDPROFILEDEF' || t === 'IFCMIRROREDPROFILEDEF') {
      const parent = this.profile(deref(this.file, e.args[2]), depth + 1);
      let m = this.transformOperator(deref(this.file, e.args[3]));
      if (t === 'IFCMIRROREDPROFILEDEF') m = multiply(fromAxes([-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]), m);
      return parent.map(a => transformArea(a, m));
    }
    if (t === 'IFCARBITRARYOPENPROFILEDEF' || t === 'IFCCENTERLINEPROFILEDEF') {
      this.warnings.add(`${t} (open profiles) is not supported`);
      return [];
    }
    const shape = this.parameterizedProfile(e);
    if (!shape) {
      this.warnings.add(`${t} profiles are not supported`);
      return [];
    }
    // Parameterized profiles: Position, optional in IFC4, places the shape.
    const position = deref(this.file, e.args[2]);
    return position ? shape.map(a => transformArea(a, this.axisPlacement(position))) : shape;
  }

  private closedCurve2D(e: StepEntity | null): Vec2[] {
    const points = this.curve(e).map(p => [p[0], p[1]] as Vec2);
    return cleanPolygon(points, 1e-9);
  }

  private parameterizedProfile(e: StepEntity): Area[] | null {
    const a = (i: number, fallback = 0) => num(e.args[i], fallback);
    const rect = (w: number, h: number): Vec2[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const circle = (rx: number, ry = rx): Vec2[] => {
      const n = Math.max(8, this.options.circleSegments);
      return Array.from({ length: n }, (_, i) => [rx * Math.cos((2 * Math.PI * i) / n), ry * Math.sin((2 * Math.PI * i) / n)] as Vec2);
    };
    switch (e.type) {
      case 'IFCRECTANGLEPROFILEDEF':
        return [{ outer: rect(a(3), a(4)), holes: [] }];
      case 'IFCROUNDEDRECTANGLEPROFILEDEF':
        return [{ outer: roundedRect(a(3), a(4), a(5), this.options.circleSegments), holes: [] }];
      case 'IFCRECTANGLEHOLLOWPROFILEDEF': {
        const w = a(3), h = a(4), t = a(5);
        return [{ outer: rect(w, h), holes: [rect(w - 2 * t, h - 2 * t)] }];
      }
      case 'IFCCIRCLEPROFILEDEF':
        return [{ outer: circle(a(3)), holes: [] }];
      case 'IFCCIRCLEHOLLOWPROFILEDEF': {
        const r = a(3), t = a(4);
        return [{ outer: circle(r), holes: r - t > 0 ? [circle(r - t)] : [] }];
      }
      case 'IFCELLIPSEPROFILEDEF':
        return [{ outer: circle(a(3), a(4)), holes: [] }];
      case 'IFCISHAPEPROFILEDEF':
      case 'IFCASYMMETRICISHAPEPROFILEDEF': {
        // Same positions in IFC2X3 and IFC4: width, depth, web, flange (bottom); the asymmetric
        // form adds the top flange's width and thickness at 8 and 9.
        const bw = a(3), d = a(4), tw = a(5), tf = a(6);
        const tw2 = e.type === 'IFCASYMMETRICISHAPEPROFILEDEF' ? a(8, bw) : bw;
        const tft = e.type === 'IFCASYMMETRICISHAPEPROFILEDEF' ? a(9, tf) : tf;
        return [{ outer: [
          [-bw / 2, -d / 2], [bw / 2, -d / 2], [bw / 2, -d / 2 + tf], [tw / 2, -d / 2 + tf], [tw / 2, d / 2 - tft], [tw2 / 2, d / 2 - tft],
          [tw2 / 2, d / 2], [-tw2 / 2, d / 2], [-tw2 / 2, d / 2 - tft], [-tw / 2, d / 2 - tft], [-tw / 2, -d / 2 + tf], [-bw / 2, -d / 2 + tf],
        ], holes: [] }];
      }
      case 'IFCLSHAPEPROFILEDEF': {
        const d = a(3), w = a(4, d), t = a(5);
        return [{ outer: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, -d / 2 + t], [-w / 2 + t, -d / 2 + t], [-w / 2 + t, d / 2], [-w / 2, d / 2]], holes: [] }];
      }
      case 'IFCUSHAPEPROFILEDEF': {
        const d = a(3), b = a(4), tw = a(5), tf = a(6);
        return [{ outer: [[-b / 2, -d / 2], [b / 2, -d / 2], [b / 2, -d / 2 + tf], [-b / 2 + tw, -d / 2 + tf], [-b / 2 + tw, d / 2 - tf], [b / 2, d / 2 - tf], [b / 2, d / 2], [-b / 2, d / 2]], holes: [] }];
      }
      case 'IFCTSHAPEPROFILEDEF': {
        const d = a(3), b = a(4), tw = a(5), tf = a(6);
        return [{ outer: [[-tw / 2, -d / 2], [tw / 2, -d / 2], [tw / 2, d / 2 - tf], [b / 2, d / 2 - tf], [b / 2, d / 2], [-b / 2, d / 2], [-b / 2, d / 2 - tf], [-tw / 2, d / 2 - tf]], holes: [] }];
      }
      case 'IFCCSHAPEPROFILEDEF': {
        const d = a(3), w = a(4), t = a(5), g = a(6);
        return [{ outer: [
          [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, -d / 2 + g], [w / 2 - t, -d / 2 + g], [w / 2 - t, -d / 2 + t], [-w / 2 + t, -d / 2 + t],
          [-w / 2 + t, d / 2 - t], [w / 2 - t, d / 2 - t], [w / 2 - t, d / 2 - g], [w / 2, d / 2 - g], [w / 2, d / 2], [-w / 2, d / 2],
        ], holes: [] }];
      }
      case 'IFCZSHAPEPROFILEDEF': {
        const d = a(3), b = a(4), tw = a(5), tf = a(6);
        return [{ outer: [
          [-b + tw / 2, -d / 2], [tw / 2, -d / 2], [tw / 2, d / 2 - tf], [b - tw / 2, d / 2 - tf], [b - tw / 2, d / 2], [-tw / 2, d / 2],
          [-tw / 2, -d / 2 + tf], [-b + tw / 2, -d / 2 + tf],
        ], holes: [] }];
      }
      case 'IFCTRAPEZIUMPROFILEDEF': {
        const bx = a(3), tx = a(4), y = a(5), off = a(6);
        return [{ outer: [[-bx / 2, -y / 2], [bx / 2, -y / 2], [-bx / 2 + off + tx, y / 2], [-bx / 2 + off, y / 2]], holes: [] }];
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- solids and surfaces

  /** Mesh of a representation item in its representation's coordinates. Null if unsupported. */
  item(e: StepEntity | null, depth = 0): TriangleMesh | null {
    if (!e || depth > 32) return null;
    switch (e.type) {
      case 'IFCEXTRUDEDAREASOLID':
      case 'IFCEXTRUDEDAREASOLIDTAPERED':
        return this.extrusion(e);
      case 'IFCREVOLVEDAREASOLID':
      case 'IFCREVOLVEDAREASOLIDTAPERED':
        return this.revolution(e);
      case 'IFCSWEPTDISKSOLID':
      case 'IFCSWEPTDISKSOLIDPOLYGONAL':
        return this.sweptDisk(e);
      case 'IFCSURFACECURVESWEPTAREASOLID':
      case 'IFCFIXEDREFERENCESWEPTAREASOLID':
        return this.curveSweep(e);
      case 'IFCFACETEDBREP':
      case 'IFCFACETEDBREPWITHVOIDS':
      case 'IFCADVANCEDBREP':
      case 'IFCADVANCEDBREPWITHVOIDS':
      case 'IFCMANIFOLDSOLIDBREP': {
        const mesh = this.shell(deref(this.file, e.args[0]));
        if (e.type.endsWith('WITHVOIDS')) for (const v of derefList(this.file, e.args[1])) mesh.append(this.shell(v));
        return mesh;
      }
      case 'IFCCLOSEDSHELL':
      case 'IFCOPENSHELL':
      case 'IFCCONNECTEDFACESET':
        return this.shell(e);
      case 'IFCSHELLBASEDSURFACEMODEL':
      case 'IFCFACEBASEDSURFACEMODEL': {
        const mesh = new TriangleMesh();
        for (const shell of derefList(this.file, e.args[0])) mesh.append(this.shell(shell));
        return mesh;
      }
      case 'IFCTRIANGULATEDFACESET':
      case 'IFCTRIANGULATEDIRREGULARNETWORK':
        return this.triangulatedFaceSet(e);
      case 'IFCPOLYGONALFACESET':
        return this.polygonalFaceSet(e);
      case 'IFCBOOLEANRESULT':
      case 'IFCBOOLEANCLIPPINGRESULT':
        return this.booleanResult(e, depth);
      case 'IFCCSGSOLID':
        return this.item(deref(this.file, e.args[0]), depth + 1);
      case 'IFCBLOCK':
      case 'IFCRECTANGULARPYRAMID':
      case 'IFCRIGHTCIRCULARCYLINDER':
      case 'IFCRIGHTCIRCULARCONE':
      case 'IFCSPHERE':
        return this.primitive(e);
      case 'IFCBOUNDINGBOX':
      case 'IFCGEOMETRICSET':
      case 'IFCGEOMETRICCURVESET':
      case 'IFCPOLYLINE':
      case 'IFCCOMPOSITECURVE':
      case 'IFCINDEXEDPOLYCURVE':
      case 'IFCTRIMMEDCURVE':
      case 'IFCCARTESIANPOINT':
      case 'IFCANNOTATIONFILLAREA':
      case 'IFCTEXTLITERAL':
      case 'IFCTEXTLITERALWITHEXTENT':
        return null;
      default:
        this.warnings.add(`${e.type} geometry is not supported`);
        return null;
    }
  }

  private extrusion(e: StepEntity): TriangleMesh {
    const areas = this.profile(deref(this.file, e.args[0]));
    const position = this.axisPlacement(deref(this.file, e.args[1]));
    const dir = this.direction(deref(this.file, e.args[2]), [0, 0, 1]);
    const depth = num(e.args[3], 0);
    const v: Vec3 = [dir[0] * depth, dir[1] * depth, dir[2] * depth];
    const mesh = new TriangleMesh();
    let endAreas: Area[] | null = null;
    if (e.type === 'IFCEXTRUDEDAREASOLIDTAPERED') {
      endAreas = this.profile(deref(this.file, e.args[4]));
      if (endAreas.length !== areas.length || endAreas.some((a, i) => a.outer.length !== areas[i]!.outer.length)) {
        this.warnings.add('IfcExtrudedAreaSolidTapered with differently shaped end profiles is extruded without taper');
        endAreas = null;
      }
    }
    areas.forEach((area, k) => {
      const end = endAreas?.[k];
      const top = (p: Vec2, i: number, ring: number): Vec3 => {
        const q = end ? (ring < 0 ? end.outer[i] : end.holes[ring]?.[i]) ?? p : p;
        return [q[0] + v[0], q[1] + v[1], v[2]];
      };
      prism(mesh, area, (p: Vec2) => [p[0], p[1], 0], top);
    });
    orientOutwards(mesh);
    return mesh.transformed(position);
  }

  private revolution(e: StepEntity): TriangleMesh {
    const areas = this.profile(deref(this.file, e.args[0]));
    const position = this.axisPlacement(deref(this.file, e.args[1]));
    const axisPlacement = deref(this.file, e.args[2]);
    const axisOrigin = this.point(deref(this.file, axisPlacement?.args[0]));
    const axisDir = this.direction(deref(this.file, axisPlacement?.args[1]), [0, 1, 0]);
    let angle = num(e.args[3], 2 * Math.PI) * this.angleFactor;
    if (Math.abs(angle) > 2 * Math.PI + 1e-6) angle = (angle * Math.PI) / 180; // Degrees without a unit.
    const steps = this.segments(angle);
    const full = Math.abs(Math.abs(angle) - 2 * Math.PI) < 1e-6;
    const rotate = (p: Vec3, t: number): Vec3 => rotateAround(p, axisOrigin, axisDir, t);
    const mesh = new TriangleMesh();
    for (const area of areas) {
      const rings = [area.outer, ...area.holes];
      for (const ring of rings) {
        for (let s = 0; s < steps; s++) {
          const t0 = (angle * s) / steps, t1 = (angle * (s + 1)) / steps;
          for (let i = 0; i < ring.length; i++) {
            const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
            const a = rotate([p[0], p[1], 0], t0), b = rotate([q[0], q[1], 0], t0), c = rotate([q[0], q[1], 0], t1), d = rotate([p[0], p[1], 0], t1);
            mesh.addTriangle(a, b, c);
            mesh.addTriangle(a, c, d);
          }
        }
      }
      if (!full) {
        const tri = triangulate(area.outer, area.holes);
        const flat = [...area.outer, ...area.holes.flat()].map(p => [p[0], p[1], 0] as Vec3);
        mesh.addIndexed(flat, tri, true);
        mesh.addIndexed(flat.map(p => rotate(p, angle)), tri, false);
      }
    }
    orientOutwards(mesh);
    return mesh.transformed(position);
  }

  private sweptDisk(e: StepEntity): TriangleMesh {
    const path = cleanPolygonOpen(this.curve(deref(this.file, e.args[0])));
    const radius = num(e.args[1], 0);
    const inner = num(e.args[2], 0);
    const mesh = new TriangleMesh();
    if (path.length < 2 || !(radius > 0)) return mesh;
    const n = Math.max(6, Math.round(this.options.circleSegments / 2));
    const circle = (r: number): Vec2[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as Vec2);
    const area: Area = { outer: circle(radius), holes: inner > 0 && inner < radius ? [circle(inner)] : [] };
    sweepAlong(mesh, area, path, null);
    orientOutwards(mesh);
    return mesh;
  }

  private curveSweep(e: StepEntity): TriangleMesh {
    const areas = this.profile(deref(this.file, e.args[0]));
    const position = this.axisPlacement(deref(this.file, e.args[1]));
    const path = cleanPolygonOpen(this.curve(deref(this.file, e.args[2])));
    const fixed = e.type === 'IFCFIXEDREFERENCESWEPTAREASOLID' ? this.direction(deref(this.file, e.args[5]), [1, 0, 0]) : null;
    const mesh = new TriangleMesh();
    if (path.length < 2) return mesh;
    for (const area of areas) sweepAlong(mesh, area, path, fixed);
    orientOutwards(mesh);
    return mesh.transformed(position);
  }

  /** Faces of a shell. Faces with curved surfaces in advanced B-reps are skipped with a warning. */
  private shell(e: StepEntity | null): TriangleMesh {
    const mesh = new TriangleMesh();
    if (!e) return mesh;
    for (const face of derefList(this.file, e.args[0])) {
      if (face.type === 'IFCADVANCEDFACE' || face.type === 'IFCFACESURFACE') {
        const surface = deref(this.file, face.args[1]);
        if (surface && surface.type !== 'IFCPLANE') {
          this.warnings.add(`Faces on ${surface.type} surfaces are not supported and are left out`);
          continue;
        }
      }
      const bounds = derefList(this.file, face.args[0]);
      const loops: { points: Vec3[]; outer: boolean }[] = [];
      for (const bound of bounds) {
        const loop = deref(this.file, bound.args[0]);
        let points = this.loop(loop);
        if (points.length < 3) continue;
        if (!bool(bound.args[1], true)) points = points.slice().reverse();
        loops.push({ points, outer: bound.type === 'IFCFACEOUTERBOUND' });
      }
      if (loops.length === 0) continue;
      let outerIndex = loops.findIndex(l => l.outer);
      if (outerIndex < 0) {
        // No marked outer bound: the largest loop is the outer one.
        outerIndex = 0;
        let best = -1;
        loops.forEach((l, i) => {
          const area = polygonArea(l.points);
          if (area > best) {
            best = area;
            outerIndex = i;
          }
        });
      }
      const outer = loops[outerIndex]!.points;
      const holes = loops.filter((_, i) => i !== outerIndex).map(l => l.points);
      const tri = triangulate3D(outer, holes);
      mesh.addIndexed([...outer, ...holes.flat()], tri);
    }
    return mesh;
  }

  private loop(e: StepEntity | null): Vec3[] {
    if (!e) return [];
    if (e.type === 'IFCPOLYLOOP') return cleanPolygon(derefList(this.file, e.args[0]).map(p => this.point(p)), 1e-12);
    if (e.type === 'IFCEDGELOOP') {
      const out: Vec3[] = [];
      for (const oriented of derefList(this.file, e.args[0])) {
        const edge = deref(this.file, oriented.args[2]);
        const forward = bool(oriented.args[3], true);
        let points: Vec3[];
        if (edge?.type === 'IFCEDGECURVE') {
          const geometry = deref(this.file, edge.args[2]);
          const start = this.vertex(deref(this.file, edge.args[0])), end = this.vertex(deref(this.file, edge.args[1]));
          points = geometry && (geometry.type === 'IFCPOLYLINE' || geometry.type === 'IFCLINE') ? [start, end] : geometry ? this.curve(geometry) : [start, end];
          if (geometry && geometry.type !== 'IFCPOLYLINE' && geometry.type !== 'IFCLINE' && points.length >= 2) {
            // Orient the curve's points from the edge's start vertex to its end vertex.
            if (length(sub(points[0]!, start)) > length(sub(points[points.length - 1]!, start))) points.reverse();
          }
          if (!bool(edge.args[3], true) && geometry?.type === 'IFCPOLYLINE') points.reverse();
        } else {
          points = [this.vertex(deref(this.file, oriented.args[0])), this.vertex(deref(this.file, oriented.args[1]))];
        }
        if (!forward) points = points.slice().reverse();
        for (const p of points) {
          const last = out[out.length - 1];
          if (!last || length(sub(last, p)) > 1e-12) out.push(p);
        }
      }
      return cleanPolygon(out, 1e-12);
    }
    if (e.type === 'IFCVERTEXLOOP') return [];
    this.warnings.add(`${e.type} face bounds are not supported`);
    return [];
  }

  private vertex(e: StepEntity | null): Vec3 {
    return e ? this.point(deref(this.file, e.args[0])) : [0, 0, 0];
  }

  private pointList(e: StepEntity | null): Vec3[] {
    return list(e?.args[0]).map(c => {
      const v = list(c);
      return [num(v[0], 0), num(v[1], 0), num(v[2], 0)] as Vec3;
    });
  }

  /**
   * IfcTriangulatedFaceSet. Its fifth attribute changed meaning between IFC4 releases: the 2013
   * release has NormalIndex (a list of index triples), IFC4 ADD2 and later have PnIndex (a list of
   * point indices that CoordIndex refers through). Both are written under the schema name IFC4, so
   * the form is told apart by the value itself.
   */
  private triangulatedFaceSet(e: StepEntity): TriangleMesh {
    const coordinates = this.pointList(deref(this.file, e.args[0]));
    const fifth = list(e.args[4]);
    const pnIndex = fifth.length > 0 && !Array.isArray(unwrap(fifth[0])) ? fifth.map(i => num(i, 0) - 1) : null;
    const point = (i: number): Vec3 | undefined => coordinates[pnIndex ? pnIndex[i - 1] ?? -1 : i - 1];
    const mesh = new TriangleMesh();
    const colours = this.faceColours.get(e.id);
    list(e.args[3]).forEach((triangle, f) => {
      const t = list(triangle).map(i => num(i, 0));
      const a = point(t[0]!), b = point(t[1]!), c = point(t[2]!);
      if (!a || !b || !c) return;
      const colour = colours?.[f];
      if (colour) mesh.addColoredTriangle(a, b, c, colour);
      else mesh.addTriangle(a, b, c);
    });
    return mesh;
  }

  private polygonalFaceSet(e: StepEntity): TriangleMesh {
    const coordinates = this.pointList(deref(this.file, e.args[0]));
    const pnIndex = list(e.args[3]).map(i => num(i, 0) - 1);
    const point = (i: number): Vec3 | undefined => coordinates[pnIndex.length ? pnIndex[i - 1] ?? -1 : i - 1];
    const mesh = new TriangleMesh();
    const colours = this.faceColours.get(e.id);
    derefList(this.file, e.args[2]).forEach((face, f) => {
      const outer = list(face.args[0]).map(i => point(num(i, 0))).filter((p): p is Vec3 => !!p);
      const holes = face.type === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS'
        ? list(face.args[1]).map(h => list(h).map(i => point(num(i, 0))).filter((p): p is Vec3 => !!p))
        : [];
      const all = [...outer, ...holes.flat()];
      const tri = triangulate3D(outer, holes);
      const colour = colours?.[f];
      for (let i = 0; i + 2 < tri.length; i += 3) {
        const a = all[tri[i]!]!, b = all[tri[i + 1]!]!, c = all[tri[i + 2]!]!;
        if (colour) mesh.addColoredTriangle(a, b, c, colour);
        else mesh.addTriangle(a, b, c);
      }
    });
    return mesh;
  }

  /** Per-face RGBA of tessellated face sets, from IfcIndexedColourMap (IFC4). Filled by the importer. */
  readonly faceColours = new Map<number, number[][]>();

  private primitive(e: StepEntity): TriangleMesh {
    const position = this.axisPlacement(deref(this.file, e.args[0]));
    const mesh = new TriangleMesh();
    const n = Math.max(8, this.options.circleSegments);
    const disc = (r: number): Vec2[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as Vec2);
    switch (e.type) {
      case 'IFCBLOCK': {
        const x = num(e.args[1], 0), y = num(e.args[2], 0), z = num(e.args[3], 0);
        prism(mesh, { outer: [[0, 0], [x, 0], [x, y], [0, y]], holes: [] }, p => [p[0], p[1], 0], p => [p[0], p[1], z]);
        break;
      }
      case 'IFCRIGHTCIRCULARCYLINDER': {
        const h = num(e.args[1], 0), r = num(e.args[2], 0);
        prism(mesh, { outer: disc(r), holes: [] }, p => [p[0], p[1], 0], p => [p[0], p[1], h]);
        break;
      }
      case 'IFCRIGHTCIRCULARCONE': {
        const h = num(e.args[1], 0), r = num(e.args[2], 0);
        const base = disc(r);
        for (let i = 0; i < n; i++) {
          const p = base[i]!, q = base[(i + 1) % n]!;
          mesh.addTriangle([p[0], p[1], 0], [q[0], q[1], 0], [0, 0, h]);
          mesh.addTriangle([0, 0, 0], [q[0], q[1], 0], [p[0], p[1], 0]);
        }
        break;
      }
      case 'IFCRECTANGULARPYRAMID': {
        const x = num(e.args[1], 0), y = num(e.args[2], 0), h = num(e.args[3], 0);
        const apex: Vec3 = [x / 2, y / 2, h];
        const base: Vec3[] = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0]];
        for (let i = 0; i < 4; i++) mesh.addTriangle(base[i]!, base[(i + 1) % 4]!, apex);
        mesh.addTriangle(base[0]!, base[2]!, base[1]!);
        mesh.addTriangle(base[0]!, base[3]!, base[2]!);
        break;
      }
      case 'IFCSPHERE': {
        const r = num(e.args[1], 0);
        const rows = Math.max(4, Math.round(n / 2));
        const at = (i: number, j: number): Vec3 => {
          const theta = (Math.PI * i) / rows, phi = (2 * Math.PI * j) / n;
          return [r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(theta)];
        };
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < n; j++) {
            const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
            if (i > 0) mesh.addTriangle(a, b, d);
            if (i < rows - 1) mesh.addTriangle(b, c, d);
          }
        }
        break;
      }
    }
    orientOutwards(mesh);
    return mesh.transformed(position);
  }

  private booleanResult(e: StepEntity, depth: number): TriangleMesh | null {
    const operator = enumValue(e.args[0]);
    const first = this.item(deref(this.file, e.args[1]), depth + 1);
    if (!first) return null;
    const secondEntity = deref(this.file, e.args[2]);
    // IfcHalfSpaceSolid, IfcBoxedHalfSpace and IfcPolygonalBoundedHalfSpace.
    const second = secondEntity && /HALFSPACE(SOLID)?$/.test(secondEntity.type)
      ? this.halfSpace(secondEntity, first)
      : this.item(secondEntity, depth + 1);
    if (!second) return first;
    if (first.triangleCount * second.triangleCount > this.options.booleanLimit) {
      this.warnings.add('A boolean operation on very detailed geometry was skipped');
      return first;
    }
    if (operator === 'UNION') return union(first, second);
    if (operator === 'INTERSECTION') return intersect(first, second);
    return subtract(first, second);
  }

  /**
   * A half-space as a closed box that covers `around` on the material side of its plane, so it
   * can take part in mesh booleans. Polygonal bounded half-spaces are cut to their boundary prism.
   */
  private halfSpace(e: StepEntity, around: TriangleMesh): TriangleMesh | null {
    const plane = deref(this.file, e.args[0]);
    if (!plane || plane.type !== 'IFCPLANE') {
      this.warnings.add('Half-spaces on non-planar surfaces are not supported');
      return null;
    }
    const frame = this.axisPlacement(deref(this.file, plane.args[0]));
    const agreement = bool(e.args[1], true);
    const b = around.bounds();
    const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 1) * 4 + length(sub([b[0], b[1], b[2]], [frame[12]!, frame[13]!, frame[14]!])) * 2;
    // AgreementFlag TRUE: the plane normal points away from the material, so the solid is below.
    const z0 = agreement ? -size : 0, z1 = agreement ? 0 : size;
    const box = new TriangleMesh();
    prism(box, { outer: [[-size, -size], [size, -size], [size, size], [-size, size]], holes: [] }, p => [p[0], p[1], z0], p => [p[0], p[1], z1]);
    orientOutwards(box);
    let solid = box.transformed(frame);
    if (e.type === 'IFCPOLYGONALBOUNDEDHALFSPACE') {
      const position = this.axisPlacement(deref(this.file, e.args[2]));
      const boundary = this.closedCurve2D(deref(this.file, e.args[3]));
      if (boundary.length >= 3) {
        const prismMesh = new TriangleMesh();
        prism(prismMesh, { outer: boundary, holes: [] }, p => [p[0], p[1], -size], p => [p[0], p[1], size]);
        orientOutwards(prismMesh);
        solid = intersect(solid, prismMesh.transformed(position));
      }
    }
    return solid;
  }

  /** Matrix of an IfcMappedItem: MappingTarget after MappingOrigin. */
  mappedItemTransform(e: StepEntity): { matrix: Mat4; representation: StepEntity | null; map: StepEntity | null } {
    const map = deref(this.file, e.args[0]);
    const origin = this.axisPlacementOrOperator(deref(this.file, map?.args[0]));
    const target = this.transformOperator(deref(this.file, e.args[1]));
    return { matrix: multiply(target, origin), representation: deref(this.file, map?.args[1]), map };
  }

  private axisPlacementOrOperator(e: StepEntity | null): Mat4 {
    if (!e) return identity();
    return e.type.startsWith('IFCCARTESIANTRANSFORMATIONOPERATOR') ? this.transformOperator(e) : this.axisPlacement(e);
  }
}

function transformArea(area: Area, m: Mat4): Area {
  const t = (p: Vec2): Vec2 => {
    const q = transformPoint(m, [p[0], p[1], 0]);
    return [q[0], q[1]];
  };
  return { outer: area.outer.map(t), holes: area.holes.map(h => h.map(t)) };
}

function roundedRect(w: number, h: number, r: number, circleSegments: number): Vec2[] {
  const radius = Math.min(r, w / 2, h / 2);
  if (!(radius > 0)) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const steps = Math.max(2, Math.round(circleSegments / 4));
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [[w / 2 - radius, -h / 2 + radius, -Math.PI / 2], [w / 2 - radius, h / 2 - radius, 0], [-w / 2 + radius, h / 2 - radius, Math.PI / 2], [-w / 2 + radius, -h / 2 + radius, Math.PI]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const t = start + (Math.PI / 2) * (i / steps);
      out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
    }
  }
  return out;
}

/** A closed prism: caps from `bottom` and `top` mappings of the area, and side walls between them. */
function prism(mesh: TriangleMesh, area: Area, bottom: (p: Vec2) => Vec3, top: (p: Vec2, index: number, ring: number) => Vec3): void {
  const outer = signedArea(area.outer) < 0 ? area.outer.slice().reverse() : area.outer;
  const holes = area.holes.map(h => (signedArea(h) > 0 ? h.slice().reverse() : h));
  if (outer.length < 3) return;
  const tri = triangulate(outer, holes);
  const flat = [...outer, ...holes.flat()];
  const ringOf: [number, number][] = [];
  outer.forEach((_, i) => ringOf.push([-1, i]));
  holes.forEach((h, k) => h.forEach((_, i) => ringOf.push([k, i])));
  const b = flat.map(p => bottom(p));
  const t = flat.map((p, i) => top(p, ringOf[i]![1], ringOf[i]![0]));
  mesh.addIndexed(b, tri, true);
  mesh.addIndexed(t, tri, false);
  let offset = 0;
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const bi = b[offset + i]!, bj = b[offset + j]!, ti = t[offset + i]!, tj = t[offset + j]!;
      mesh.addTriangle(bi, bj, tj);
      mesh.addTriangle(bi, tj, ti);
    }
    offset += ring.length;
  }
}

/** Sweeps an area along a polyline, with frames carried along by parallel transport. */
function sweepAlong(mesh: TriangleMesh, area: Area, path: Vec3[], fixedReference: Vec3 | null): void {
  const tangents = path.map((_, i) => {
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!;
    return normalize(sub(b, a));
  });
  const frames: { x: Vec3; y: Vec3 }[] = [];
  let x = fixedReference ? normalize(sub(fixedReference, scaleV(tangents[0]!, dot(fixedReference, tangents[0]!)))) : perpendicular(tangents[0]!);
  for (let i = 0; i < path.length; i++) {
    const t = tangents[i]!;
    if (fixedReference) {
      const fx = normalize(sub(fixedReference, scaleV(t, dot(fixedReference, t))));
      if (length(fx) > 0) x = fx;
    } else {
      x = normalize(sub(x, scaleV(t, dot(x, t))));
      if (length(x) === 0) x = perpendicular(t);
    }
    frames.push({ x, y: cross(t, x) });
  }
  const place = (p: Vec2, i: number): Vec3 => {
    const o = path[i]!, f = frames[i]!;
    return [o[0] + f.x[0] * p[0] + f.y[0] * p[1], o[1] + f.x[1] * p[0] + f.y[1] * p[1], o[2] + f.x[2] * p[0] + f.y[2] * p[1]];
  };
  const outer = signedArea(area.outer) < 0 ? area.outer.slice().reverse() : area.outer;
  const holes = area.holes.map(h => (signedArea(h) > 0 ? h.slice().reverse() : h));
  for (const ring of [outer, ...holes]) {
    for (let s = 0; s + 1 < path.length; s++) {
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        const a = place(ring[i]!, s), b = place(ring[j]!, s), c = place(ring[j]!, s + 1), d = place(ring[i]!, s + 1);
        mesh.addTriangle(a, b, c);
        mesh.addTriangle(a, c, d);
      }
    }
  }
  const tri = triangulate(outer, holes);
  const flat = [...outer, ...holes.flat()];
  mesh.addIndexed(flat.map(p => place(p, 0)), tri, true);
  mesh.addIndexed(flat.map(p => place(p, path.length - 1)), tri, false);
}

function scaleV(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function cleanPolygonOpen(points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || length(sub(last, p)) > 1e-9) out.push(p);
  }
  return out;
}

function polygonArea(points: Vec3[]): number {
  let x = 0, y = 0, z = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const c = cross(points[j]!, points[i]!);
    x += c[0]; y += c[1]; z += c[2];
  }
  return Math.hypot(x, y, z) / 2;
}

function rotateAround(p: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  const v = sub(p, origin);
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = axis;
  const kv = cross(k, v), kdv = dot(k, v);
  return [
    origin[0] + v[0] * c + kv[0] * s + k[0] * kdv * (1 - c),
    origin[1] + v[1] * c + kv[1] * s + k[1] * kdv * (1 - c),
    origin[2] + v[2] * c + kv[2] * s + k[2] * kdv * (1 - c),
  ];
}

/** Flips a closed mesh whose triangles wind inwards, judged by its signed volume. */
export function orientOutwards(mesh: TriangleMesh): void {
  const p = mesh.positions;
  let volume = 0;
  for (let i = 0; i < p.length; i += 9) {
    volume += dot([p[i]!, p[i + 1]!, p[i + 2]!], cross([p[i + 3]!, p[i + 4]!, p[i + 5]!], [p[i + 6]!, p[i + 7]!, p[i + 8]!]));
  }
  if (volume < 0) {
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k]!;
        p[i + 3 + k] = p[i + 6 + k]!;
        p[i + 6 + k] = t;
      }
    }
    if (mesh.colors) {
      const c = mesh.colors;
      for (let i = 0; i < c.length; i += 12) {
        for (let k = 0; k < 4; k++) {
          const t = c[i + 4 + k]!;
          c[i + 4 + k] = c[i + 8 + k]!;
          c[i + 8 + k] = t;
        }
      }
    }
  }
}

