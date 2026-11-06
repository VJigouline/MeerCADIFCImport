import { readIfc, type IfcImportOptions, type IfcImportResult, type IfcObject } from '../src/index.js';
import type { MeshData } from '../src/geometry/mesh.js';
import { transformPoint, type Mat4 } from '../src/geometry/math.js';

/**
 * A minimal IFC file: a project with a length unit, a model context and a site, then `data`.
 * Ids from 1 to 99 are used here; tests number their own entities from 100. #6 is the world
 * placement, and #20 the model context's body subcontext, for use by tests.
 */
export function ifcFile(schema: string, data: string, options: { lengthUnit?: string; angleUnit?: string } = {}): string {
  const length = options.lengthUnit ?? "#10=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);";
  const angle = options.angleUnit ?? "#11=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);";
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2026-01-01T00:00:00',('Tester'),('MeerCAD'),'test','test','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Project',$,$,$,$,(#19),#12);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCDIRECTION((1.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#2,#3,#4);
#6=IFCLOCALPLACEMENT($,#5);
${length}
${angle}
#12=IFCUNITASSIGNMENT((#10,#11));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#20=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#19,$,.MODEL_VIEW.,$);
#30=IFCSITE('2YvctVUKr0kugbFTf53O9L',$,'Site',$,$,#6,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCRELAGGREGATES('3YvctVUKr0kugbFTf53O9L',$,$,$,#1,(#30));
${data}
ENDSEC;
END-ISO-10303-21;
`;
}

/** A product with a body representation of the given items, contained in the site. */
export function product(id: number, type: string, items: string, placement = '#6', name = 'Element'): string {
  const guid = `${id}`.padStart(22, '0').slice(0, 22);
  return `#${id}=${type}('${guid}',$,'${name}',$,$,${placement},#${id + 1},$${type.startsWith('IFCSPACE') ? '' : ',$'});
#${id + 1}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id + 2}));
#${id + 2}=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(${items}));
#${id + 3}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid.slice(0, 21)}R',$,$,$,(#${id}),#30);`;
}

export function read(text: string, options: IfcImportOptions = {}): IfcImportResult {
  return readIfc(text, options);
}

/** Every object in the result, depth first. */
export function allObjects(result: IfcImportResult): IfcObject[] {
  const out: IfcObject[] = [];
  const walk = (o: IfcObject) => {
    out.push(o);
    o.children.forEach(walk);
  };
  result.roots.forEach(walk);
  return out;
}

export function findObject(result: IfcImportResult, name: string): IfcObject {
  const found = allObjects(result).find(o => o.name === name);
  if (!found) throw new Error(`no object named ${name}`);
  return found;
}

/** Enclosed volume of a mesh after its matrix, in file units cubed. */
export function volume(data: MeshData, matrix?: Mat4): number {
  const p = data.positions, idx = data.indices;
  const at = (i: number) => {
    const v: [number, number, number] = [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
    return matrix ? transformPoint(matrix, v) : v;
  };
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = at(idx[t]!), b = at(idx[t + 1]!), c = at(idx[t + 2]!);
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
}

/** Total volume of an object's meshes. */
export function objectVolume(object: IfcObject): number {
  return object.meshes.reduce((sum, m) => sum + volume(m.data, m.matrix), 0);
}

/** World-space bounds of an object's meshes. */
export function objectBounds(object: IfcObject): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const m of object.meshes) {
    const p = m.data.positions;
    for (let i = 0; i < p.length; i += 3) {
      const q = transformPoint(m.matrix, [p[i]!, p[i + 1]!, p[i + 2]!]);
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, q[k]!);
        b[k + 3] = Math.max(b[k + 3]!, q[k]!);
      }
    }
  }
  return b;
}
