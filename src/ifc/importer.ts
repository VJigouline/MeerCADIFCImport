// Reads an IFC file into a plain model: objects in their spatial structure, each with meshes,
// colours and properties. The model is independent of three.js; see three.ts for that step.

import { subtract } from '../geometry/csg.js';
import { determinant3, identity, invert, multiply, type Mat4 } from '../geometry/math.js';
import { toMeshData, TriangleMesh, type MeshData } from '../geometry/mesh.js';
import { StepFile, stepText, type StepEntity, type StepHeader } from '../step/step.js';
import { GeometryReader, Warnings } from './geometry.js';
import { typeName } from './names.js';
import { detectSchema, typeInSchema, type IfcSchemaInfo } from './schema.js';
import { deref, derefList, enumValue, list, num, plainValue, refId, str, unwrap } from './values.js';

export interface IfcImportOptions {
  /** Segments for a full circle in curved geometry. Default 24. */
  circleSegments?: number;
  /** Subtract openings (IfcRelVoidsElement) from the elements they void. Default true. */
  openings?: boolean;
  /** Include IfcSpace volumes. Default false: rooms would hide what is inside them. */
  spaces?: boolean;
  /** Include IfcOpeningElement volumes as objects. Default false. */
  openingElements?: boolean;
  /** Angle, in degrees, below which adjacent faces are shaded smoothly. Default 30. */
  creaseAngle?: number;
  /** Read property and quantity sets. Default true. */
  properties?: boolean;
  /** Called with progress from 0 to 1 while products are converted. */
  onProgress?: (fraction: number) => void;
}

/** A colour, from a surface style, a material's style or the element type's default. */
export interface IfcStyle {
  name: string;
  /** sRGB components 0 to 1, as IFC stores them. */
  color: [number, number, number];
  /** 1 opaque, 0 invisible. */
  opacity: number;
  /** Where the colour came from. */
  source: 'style' | 'material' | 'default';
}

export interface IfcMesh {
  /** Shared between objects when the same mapped geometry is reused. */
  data: MeshData;
  /** From the mesh's coordinates to the model's, in file units. */
  matrix: Mat4;
  style: IfcStyle;
  /** Mesh data carries per-vertex colours (IfcIndexedColourMap). */
  vertexColors: boolean;
}

export interface IfcObject {
  expressId: number;
  /** Schema spelling of the entity type, such as IfcWallStandardCase. */
  type: string;
  globalId: string | null;
  name: string | null;
  description: string | null;
  objectType: string | null;
  /** True for IfcProject, IfcSite, IfcBuilding, IfcBuildingStorey, IfcSpace and the like. */
  spatial: boolean;
  meshes: IfcMesh[];
  children: IfcObject[];
  /** Property and quantity sets: { 'Pset_WallCommon': { 'IsExternal': true } }. */
  properties: Record<string, Record<string, unknown>>;
  materials: string[];
  /** Name of the type object (IfcWallType and so on), if any. */
  typeObject: string | null;
}

export interface IfcImportResult {
  schema: IfcSchemaInfo;
  header: StepHeader;
  /** Multiply file lengths by this to get metres. */
  lengthUnit: number;
  /** Multiply file plane angles by this to get radians. */
  angleUnit: number;
  /** Top-level objects: the project, and anything not in its spatial structure. */
  roots: IfcObject[];
  warnings: string[];
  statistics: { entities: number; products: number; meshes: number; triangles: number; milliseconds: number };
}

const DEFAULT_COLOURS: [RegExp, [number, number, number], number][] = [
  [/^IFC(WINDOW|WINDOWSTANDARDCASE|CURTAINWALL)$/, [0.55, 0.75, 0.9], 0.4],
  [/^IFCPLATE/, [0.55, 0.75, 0.9], 0.5],
  [/^IFCDOOR/, [0.6, 0.45, 0.3], 1],
  [/^IFCSLAB|^IFCROOF|^IFCCOVERING/, [0.65, 0.65, 0.65], 1],
  [/^IFCWALL/, [0.9, 0.9, 0.88], 1],
  [/^IFC(BEAM|COLUMN|MEMBER|FOOTING|PILE)/, [0.7, 0.7, 0.72], 1],
  [/^IFCSTAIR|^IFCRAMP|^IFCRAILING/, [0.75, 0.72, 0.68], 1],
  [/^IFCSPACE/, [0.6, 0.8, 0.6], 0.25],
  [/^IFCOPENING/, [0.9, 0.5, 0.5], 0.3],
  [/^IFCSITE|^IFCGEOGRAPHICELEMENT/, [0.5, 0.65, 0.4], 1],
  [/^IFC(PIPE|DUCT|FLOW|CABLE)/, [0.6, 0.65, 0.75], 1],
  [/^IFCFURN/, [0.7, 0.55, 0.4], 1],
];

function defaultStyle(type: string): IfcStyle {
  for (const [pattern, color, opacity] of DEFAULT_COLOURS) {
    if (pattern.test(type)) return { name: typeName(type), color, opacity, source: 'default' };
  }
  return { name: 'Default', color: [0.8, 0.8, 0.8], opacity: 1, source: 'default' };
}

/** Largest product of two meshes' triangle counts a boolean may work on before it is skipped. */
const BOOLEAN_LIMIT = 4e6;

const SPATIAL = /^IFC(PROJECT|SITE|BUILDING|BUILDINGSTOREY|SPACE|SPATIALZONE|EXTERNALSPATIALELEMENT|FACILITY|FACILITYPART|FACILITYPARTCOMMON|BRIDGE|BRIDGEPART|ROAD|ROADPART|RAILWAY|RAILWAYPART|MARINEFACILITY|MARINEPART|BUILDINGSYSTEM)$/;
const PLACEMENT_TYPES = new Set(['IFCLOCALPLACEMENT', 'IFCGRIDPLACEMENT', 'IFCLINEARPLACEMENT']);

/** Reads an IFC file. Throws for files that aren't STEP, or whose schema isn't supported. */
export function readIfc(input: string | ArrayBuffer | Uint8Array, options: IfcImportOptions = {}): IfcImportResult {
  const start = Date.now();
  const file = new StepFile(stepText(input));
  const schema = detectSchema(file.header.schemas);
  return new Importer(file, schema, options).run(start);
}

class Importer {
  private readonly warnings = new Warnings();
  private readonly geometry: GeometryReader;
  private readonly lengthUnit: number;
  private readonly angleUnit: number;
  private readonly itemStyles = new Map<number, IfcStyle>();
  private readonly materialStyles = new Map<number, IfcStyle>();
  private readonly objectMaterials = new Map<number, number[]>();
  private readonly objectType = new Map<number, number>();
  private readonly voids = new Map<number, number[]>();
  private readonly properties = new Map<number, number[]>();
  private readonly mappedCache = new Map<string, { data: MeshData; colors: boolean } | null>();
  private readonly options: Required<Omit<IfcImportOptions, 'onProgress'>> & Pick<IfcImportOptions, 'onProgress'>;
  private triangles = 0;
  private meshCount = 0;

  constructor(private readonly file: StepFile, private readonly schema: IfcSchemaInfo, options: IfcImportOptions) {
    this.options = {
      circleSegments: Math.max(6, Math.round(options.circleSegments ?? 24)),
      openings: options.openings ?? true,
      spaces: options.spaces ?? false,
      openingElements: options.openingElements ?? false,
      creaseAngle: options.creaseAngle ?? 30,
      properties: options.properties ?? true,
      onProgress: options.onProgress,
    };
    if (schema.guessed) this.warnings.add(`Schema identifier ${schema.identifier} is not known exactly; read as ${schema.id}`);
    const units = this.readUnits();
    this.lengthUnit = units.length;
    this.angleUnit = units.angle;
    this.geometry = new GeometryReader(file, schema, { circleSegments: this.options.circleSegments, booleanLimit: BOOLEAN_LIMIT }, this.warnings, this.angleUnit);
    this.checkSchemaTypes();
  }

  run(start: number): IfcImportResult {
    this.indexStyles();
    this.indexColourMaps();
    this.indexRelations();
    const objects = new Map<number, IfcObject>();
    const products = this.findProducts();
    let done = 0;
    for (const id of products) {
      const entity = this.file.get(id);
      if (entity) {
        const object = this.object(entity);
        if (object) objects.set(id, object);
      }
      done++;
      if (this.options.onProgress && done % 50 === 0) this.options.onProgress(done / products.length);
    }
    // Spatial objects without geometry (projects, buildings, storeys) still belong in the tree.
    for (const [type] of this.file.typeCounts()) {
      if (!SPATIAL.test(type)) continue;
      for (const id of this.file.idsOfType(type)) {
        if (objects.has(id)) continue;
        const entity = this.file.get(id);
        if (!entity) continue;
        if (type === 'IFCSPACE' && !this.options.spaces) continue;
        objects.set(id, this.bareObject(entity));
      }
    }
    const roots = this.buildTree(objects);
    this.options.onProgress?.(1);
    return {
      schema: this.schema,
      header: this.file.header,
      lengthUnit: this.lengthUnit,
      angleUnit: this.angleUnit,
      roots,
      warnings: this.warnings.list(),
      statistics: { entities: this.file.size, products: products.length, meshes: this.meshCount, triangles: this.triangles, milliseconds: Date.now() - start },
    };
  }

  // ---------------------------------------------------------------- set-up

  /** Length and plane angle units from IfcProject.UnitsInContext. */
  private readUnits(): { length: number; angle: number } {
    let length = 1, angle = 1, angleFound = false;
    const project = this.file.get(this.file.idsOfType('IFCPROJECT')[0] ?? -1);
    const assignment = project ? deref(this.file, project.args[8]) : null;
    for (const unit of derefList(this.file, assignment?.args[0])) {
      const unitType = enumValue(unit.args[1]);
      if (unitType === 'LENGTHUNIT') length = this.unitFactor(unit, 'length');
      if (unitType === 'PLANEANGLEUNIT') {
        angle = this.unitFactor(unit, 'angle');
        angleFound = true;
      }
    }
    if (!assignment) this.warnings.add('No units assigned: lengths are read as metres');
    if (!angleFound) angle = 1;
    return { length, angle };
  }

  private unitFactor(unit: StepEntity, kind: 'length' | 'angle', depth = 0): number {
    if (depth > 8) return 1;
    if (unit.type === 'IFCSIUNIT') {
      const prefix = enumValue(unit.args[2]);
      const prefixes: Record<string, number> = {
        EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10,
        DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
      };
      return prefix ? prefixes[prefix] ?? 1 : 1;
    }
    if (unit.type === 'IFCCONVERSIONBASEDUNIT' || unit.type === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
      const measure = deref(this.file, unit.args[3]);
      const value = num(measure?.args[0], NaN);
      const base = deref(this.file, measure?.args[1]);
      const name = (str(unit.args[2]) ?? '').toUpperCase();
      if (Number.isFinite(value)) return value * (base ? this.unitFactor(base, kind, depth + 1) : 1);
      if (kind === 'angle' && name.startsWith('DEG')) return Math.PI / 180;
      if (kind === 'length' && name.includes('FOOT')) return 0.3048;
      if (kind === 'length' && name.includes('INCH')) return 0.0254;
    }
    return 1;
  }

  /** Warns about entity types that don't belong to the detected schema. */
  private checkSchemaTypes(): void {
    for (const [type, count] of this.file.typeCounts()) {
      if (!typeInSchema(type, this.schema.id)) {
        this.warnings.add(`${type} is not part of ${this.schema.id} but appears ${count} times; it is read anyway`);
      }
    }
  }

  // ---------------------------------------------------------------- styles

  /** Colour and opacity of an IfcStyledItem's styles. */
  private styleOf(styledItem: StepEntity): IfcStyle | null {
    // IFC2X3 wraps styles in IfcPresentationStyleAssignment; IFC4 may reference them directly.
    const styles: StepEntity[] = [];
    for (const s of derefList(this.file, styledItem.args[1])) {
      if (s.type === 'IFCPRESENTATIONSTYLEASSIGNMENT') styles.push(...derefList(this.file, s.args[0]));
      else styles.push(s);
    }
    for (const style of styles) {
      if (style.type !== 'IFCSURFACESTYLE') continue;
      const name = str(style.args[0]) ?? str(styledItem.args[2]) ?? 'Style';
      for (const element of derefList(this.file, style.args[2])) {
        if (element.type === 'IFCSURFACESTYLERENDERING' || element.type === 'IFCSURFACESTYLESHADING') {
          const colour = deref(this.file, element.args[0]);
          if (!colour) continue;
          // Transparency is Rendering's second attribute; IFC4 also gives Shading one.
          const transparency = num(element.args[1], 0);
          return {
            name,
            color: [clamp01(num(colour.args[1], 0.8)), clamp01(num(colour.args[2], 0.8)), clamp01(num(colour.args[3], 0.8))],
            opacity: 1 - clamp01(Number.isFinite(transparency) ? transparency : 0),
            source: 'style',
          };
        }
      }
    }
    return null;
  }

  private indexStyles(): void {
    for (const id of this.file.idsOfType('IFCSTYLEDITEM')) {
      const styled = this.file.get(id);
      const item = refId(styled?.args[0]);
      if (!styled || item === null) continue;
      const style = this.styleOf(styled);
      if (style) this.itemStyles.set(item, style);
    }
    // Material styles: IfcMaterialDefinitionRepresentation -> IfcStyledRepresentation -> IfcStyledItem.
    for (const id of this.file.idsOfType('IFCMATERIALDEFINITIONREPRESENTATION')) {
      const definition = this.file.get(id);
      const material = refId(definition?.args[3]);
      if (!definition || material === null) continue;
      for (const representation of derefList(this.file, definition.args[2])) {
        for (const item of derefList(this.file, representation.args[3])) {
          const style = item.type === 'IFCSTYLEDITEM' ? this.styleOf(item) : null;
          if (style && !this.materialStyles.has(material)) this.materialStyles.set(material, { ...style, source: 'material' });
        }
      }
    }
  }

  /** IFC4 IfcIndexedColourMap: per-face colours of tessellated face sets. */
  private indexColourMaps(): void {
    for (const id of this.file.idsOfType('IFCINDEXEDCOLOURMAP')) {
      const map = this.file.get(id);
      const target = refId(map?.args[0]);
      if (!map || target === null) continue;
      const opacity = num(map.args[1], 1);
      const colours = list(deref(this.file, map.args[2])?.args[0]).map(c => list(c).map(v => num(v, 1)));
      const faces = list(map.args[3]).map(i => {
        const c = colours[num(i, 0) - 1];
        return c ? [c[0]!, c[1]!, c[2]!, Number.isFinite(opacity) ? opacity : 1] : [1, 1, 1, 1];
      });
      this.geometry.faceColours.set(target, faces);
    }
  }

  // ---------------------------------------------------------------- relationships

  private indexRelations(): void {
    const add = (map: Map<number, number[]>, key: number | null, value: number | null) => {
      if (key === null || value === null) return;
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const id of this.file.idsOfType('IFCRELASSOCIATESMATERIAL')) {
      const rel = this.file.get(id);
      const material = refId(rel?.args[5]);
      for (const object of list(rel?.args[4])) add(this.objectMaterials, refId(object), material);
    }
    for (const id of this.file.idsOfType('IFCRELDEFINESBYTYPE')) {
      const rel = this.file.get(id);
      const type = refId(rel?.args[5]);
      for (const object of list(rel?.args[4])) {
        const o = refId(object);
        if (o !== null && type !== null) this.objectType.set(o, type);
      }
    }
    for (const id of this.file.idsOfType('IFCRELVOIDSELEMENT')) {
      const rel = this.file.get(id);
      add(this.voids, refId(rel?.args[4]), refId(rel?.args[5]));
    }
    if (this.options.properties) {
      for (const id of this.file.idsOfType('IFCRELDEFINESBYPROPERTIES')) {
        const rel = this.file.get(id);
        const definition = refId(rel?.args[5]);
        for (const object of list(rel?.args[4])) add(this.properties, refId(object), definition);
      }
    }
  }

  /** Entities that are products: IfcObject attributes with a placement and a product shape. */
  private findProducts(): number[] {
    const out: number[] = [];
    for (const [type, count] of this.file.typeCounts()) {
      if (count === 0 || !type.startsWith('IFC')) continue;
      if (/^IFC(OPENINGELEMENT|OPENINGSTANDARDCASE|VOIDINGFEATURE)$/.test(type) && !this.options.openingElements) continue;
      if (type === 'IFCSPACE' && !this.options.spaces) continue;
      const ids = this.file.idsOfType(type);
      // Products have GlobalId first, ObjectPlacement sixth and Representation seventh.
      const sample = this.file.get(ids[0]!);
      if (!sample || sample.args.length < 7 || typeof unwrap(sample.args[0]) !== 'string') continue;
      const placement = refId(sample.args[5]), shape = refId(sample.args[6]);
      const placementOk = placement === null || PLACEMENT_TYPES.has(this.file.typeOf(placement) ?? '');
      const shapeOk = shape === null || this.file.typeOf(shape) === 'IFCPRODUCTDEFINITIONSHAPE';
      if (!placementOk || !shapeOk || (placement === null && shape === null)) continue;
      out.push(...ids);
    }
    return out;
  }

  // ---------------------------------------------------------------- objects

  private bareObject(e: StepEntity): IfcObject {
    return {
      expressId: e.id,
      type: typeName(e.type),
      globalId: str(e.args[0]),
      name: str(e.args[2]),
      description: str(e.args[3]),
      objectType: str(e.args[4]),
      spatial: SPATIAL.test(e.type),
      meshes: [],
      children: [],
      properties: this.propertiesOf(e.id),
      materials: this.materialNames(e.id),
      typeObject: str(this.file.get(this.objectType.get(e.id) ?? -1)?.args[2]),
    };
  }

  private object(e: StepEntity): IfcObject | null {
    const object = this.bareObject(e);
    const shape = deref(this.file, e.args[6]);
    if (!shape) return object;
    const placement = this.geometry.objectPlacement(deref(this.file, e.args[5]));
    const fallback = this.elementStyle(e);
    const meshes = this.productMeshes(e, shape, placement, fallback);
    object.meshes = meshes;
    return object;
  }

  /** Style for items without their own: the element's material, its type's material, or a default. */
  private elementStyle(e: StepEntity): IfcStyle {
    for (const owner of [e.id, this.objectType.get(e.id)]) {
      if (owner === undefined) continue;
      for (const material of this.objectMaterials.get(owner) ?? []) {
        const style = this.materialStyle(material);
        if (style) return style;
      }
    }
    return defaultStyle(e.type);
  }

  /** Style of a material select: material, list, layer set (usage), profile set (usage) or constituent set. */
  private materialStyle(id: number, depth = 0): IfcStyle | null {
    if (depth > 6) return null;
    const direct = this.materialStyles.get(id);
    if (direct) return direct;
    const e = this.file.get(id);
    if (!e) return null;
    for (const child of this.materialChildren(e)) {
      const style = this.materialStyle(child, depth + 1);
      if (style) return style;
    }
    return null;
  }

  private materialChildren(e: StepEntity): number[] {
    const refs = (value: unknown) => list(value as never).map(refId).filter((v): v is number => v !== null);
    switch (e.type) {
      case 'IFCMATERIALLIST': return refs(e.args[0]);
      case 'IFCMATERIALLAYERSETUSAGE': return [refId(e.args[0])].filter((v): v is number => v !== null);
      case 'IFCMATERIALLAYERSET': return refs(e.args[0]);
      case 'IFCMATERIALLAYER':
      case 'IFCMATERIALLAYERWITHOFFSETS': return [refId(e.args[0])].filter((v): v is number => v !== null);
      case 'IFCMATERIALPROFILESETUSAGE':
      case 'IFCMATERIALPROFILESETUSAGETAPERING': return [refId(e.args[0])].filter((v): v is number => v !== null);
      case 'IFCMATERIALPROFILESET': return refs(e.args[2]);
      case 'IFCMATERIALPROFILE':
      case 'IFCMATERIALPROFILEWITHOFFSETS': return [refId(e.args[2])].filter((v): v is number => v !== null);
      case 'IFCMATERIALCONSTITUENTSET': return refs(e.args[2]);
      case 'IFCMATERIALCONSTITUENT': return [refId(e.args[2])].filter((v): v is number => v !== null);
      default: return [];
    }
  }

  private materialNames(id: number): string[] {
    const names: string[] = [];
    const visit = (materialId: number, depth: number) => {
      if (depth > 6) return;
      const e = this.file.get(materialId);
      if (!e) return;
      if (e.type === 'IFCMATERIAL') {
        const name = str(e.args[0]);
        if (name && !names.includes(name)) names.push(name);
        return;
      }
      for (const child of this.materialChildren(e)) visit(child, depth + 1);
    };
    for (const material of this.objectMaterials.get(id) ?? []) visit(material, 0);
    return names;
  }

  /** The representation to draw: Body, else other 3D shape representations. */
  private bodyRepresentations(shape: StepEntity): StepEntity[] {
    const representations = derefList(this.file, shape.args[2]).filter(r => r.type === 'IFCSHAPEREPRESENTATION' || r.type === 'IFCTOPOLOGYREPRESENTATION');
    const identifier = (r: StepEntity) => (str(r.args[1]) ?? '').toLowerCase();
    const body = representations.filter(r => identifier(r) === 'body');
    if (body.length) return body;
    const fallback = representations.filter(r => ['body-fallback', 'facetation', 'mesh', ''].includes(identifier(r)));
    if (fallback.length) return fallback;
    const skip = new Set(['axis', 'footprint', 'box', 'annotation', 'profile', 'clearance', 'reference', 'lighting', 'cog', 'surface', 'plan']);
    return representations.filter(r => !skip.has(identifier(r)));
  }

  private productMeshes(e: StepEntity, shape: StepEntity, placement: Mat4, fallback: IfcStyle): IfcMesh[] {
    // Items in the product's coordinates, grouped by style; mapped items are kept shareable.
    const groups = new Map<string, { style: IfcStyle; mesh: TriangleMesh }>();
    const mapped: { key: string; matrix: Mat4; style: IfcStyle; build: () => TriangleMesh | null }[] = [];
    const addItem = (item: StepEntity, matrix: Mat4 | null, inherited: IfcStyle | null, depth: number) => {
      if (depth > 8) return;
      const own = this.itemStyle(item);
      const style = own ?? inherited;
      if (item.type === 'IFCMAPPEDITEM') {
        const { matrix: mapMatrix, representation, map } = this.geometry.mappedItemTransform(item);
        const total = matrix ? multiply(matrix, mapMatrix) : mapMatrix;
        for (const inner of derefList(this.file, representation?.args[3])) {
          const innerStyle = this.itemStyle(inner) ?? style ?? fallback;
          if (inner.type === 'IFCMAPPEDITEM') {
            addItem(inner, total, style, depth + 1);
            continue;
          }
          mapped.push({ key: `${map?.id}:${inner.id}:${styleKey(innerStyle)}`, matrix: total, style: innerStyle, build: () => this.geometry.item(inner) });
        }
        return;
      }
      const mesh = this.geometry.item(item);
      if (!mesh || mesh.triangleCount === 0) return;
      const used = style ?? fallback;
      const key = styleKey(used) + (mesh.colors ? ':vc' : '');
      let group = groups.get(key);
      if (!group) {
        group = { style: used, mesh: new TriangleMesh() };
        groups.set(key, group);
      }
      group.mesh.append(mesh, matrix ?? undefined);
    };
    for (const representation of this.bodyRepresentations(shape)) {
      for (const item of derefList(this.file, representation.args[3])) addItem(item, null, null, 0);
    }
    const openings = this.options.openings ? this.openingMesh(e, placement) : null;
    const out: IfcMesh[] = [];
    const push = (data: MeshData, matrix: Mat4, style: IfcStyle) => {
      if (data.indices.length === 0) return;
      this.triangles += data.indices.length / 3;
      this.meshCount++;
      out.push({ data, matrix, style, vertexColors: data.colors !== null });
    };
    const crease = (this.options.creaseAngle * Math.PI) / 180;
    const cutOpenings = (mesh: TriangleMesh): TriangleMesh => {
      if (!openings) return mesh;
      if (mesh.triangleCount * openings.triangleCount > BOOLEAN_LIMIT) {
        this.warnings.add('Openings in very detailed geometry were not cut');
        return mesh;
      }
      return subtract(mesh, openings);
    };
    for (const { style, mesh } of groups.values()) {
      const cut = cutOpenings(mesh);
      push(toMeshData(cut, crease), placement, style);
    }
    for (const m of mapped) {
      if (openings) {
        // Openings cut through shared geometry, so this instance gets its own copy.
        const mesh = m.build();
        if (mesh) push(toMeshData(cutOpenings(mesh.transformed(m.matrix)), crease), placement, m.style);
        continue;
      }
      let cached = this.mappedCache.get(m.key);
      if (cached === undefined) {
        const mesh = m.build();
        cached = mesh && mesh.triangleCount > 0 ? { data: toMeshData(mesh, crease), colors: mesh.colors !== null } : null;
        this.mappedCache.set(m.key, cached);
      }
      if (cached) push(cached.data, multiply(placement, m.matrix), m.style);
    }
    return out;
  }

  private itemStyle(item: StepEntity): IfcStyle | null {
    const own = this.itemStyles.get(item.id);
    if (own) return own;
    // A boolean result is often styled through its first operand.
    if (item.type === 'IFCBOOLEANRESULT' || item.type === 'IFCBOOLEANCLIPPINGRESULT') {
      const first = deref(this.file, item.args[1]);
      return first ? this.itemStyle(first) : null;
    }
    return null;
  }

  /** The openings of an element as one mesh in the element's coordinates. */
  private openingMesh(e: StepEntity, placement: Mat4): TriangleMesh | null {
    const openingIds = this.voids.get(e.id);
    if (!openingIds?.length) return null;
    const toElement = invert(placement);
    const all = new TriangleMesh();
    for (const id of openingIds) {
      const opening = this.file.get(id);
      const shape = opening ? deref(this.file, opening.args[6]) : null;
      if (!opening || !shape) continue;
      const openingPlacement = this.geometry.objectPlacement(deref(this.file, opening.args[5]));
      const matrix = multiply(toElement, openingPlacement);
      for (const representation of this.bodyRepresentations(shape)) {
        for (const item of derefList(this.file, representation.args[3])) {
          if (item.type === 'IFCMAPPEDITEM') {
            const { matrix: mapMatrix, representation: inner } = this.geometry.mappedItemTransform(item);
            for (const innerItem of derefList(this.file, inner?.args[3])) {
              const mesh = this.geometry.item(innerItem);
              if (mesh) all.append(mesh, multiply(matrix, mapMatrix));
            }
            continue;
          }
          const mesh = this.geometry.item(item);
          if (mesh) all.append(mesh, matrix);
        }
      }
    }
    return all.triangleCount ? all : null;
  }

  // ---------------------------------------------------------------- properties and structure

  private propertiesOf(id: number): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    if (!this.options.properties) return out;
    const definitions = [...(this.properties.get(id) ?? [])];
    // Type objects carry property sets too (HasPropertySets).
    const type = this.file.get(this.objectType.get(id) ?? -1);
    if (type && Array.isArray(unwrap(type.args[5]))) for (const r of list(type.args[5])) { const v = refId(r); if (v !== null) definitions.push(v); }
    for (const definitionId of definitions) {
      const definition = this.file.get(definitionId);
      if (!definition) continue;
      const setName = str(definition.args[2]) ?? definition.type;
      const values: Record<string, unknown> = out[setName] ?? {};
      if (definition.type === 'IFCPROPERTYSET') {
        for (const property of derefList(this.file, definition.args[4])) {
          const name = str(property.args[0]);
          if (!name) continue;
          if (property.type === 'IFCPROPERTYSINGLEVALUE') values[name] = plainValue(property.args[2]);
          else if (property.type === 'IFCPROPERTYENUMERATEDVALUE') values[name] = plainValue(property.args[2]);
          else if (property.type === 'IFCPROPERTYLISTVALUE') values[name] = plainValue(property.args[2]);
          else if (property.type === 'IFCPROPERTYBOUNDEDVALUE') values[name] = { upper: plainValue(property.args[2]), lower: plainValue(property.args[3]) };
        }
      } else if (definition.type === 'IFCELEMENTQUANTITY') {
        for (const quantity of derefList(this.file, definition.args[5])) {
          const name = str(quantity.args[0]);
          if (name) values[name] = plainValue(quantity.args[3]);
        }
      } else {
        continue;
      }
      out[setName] = values;
    }
    return out;
  }

  /** Arranges objects by IfcRelAggregates, IfcRelNests and IfcRelContainedInSpatialStructure. */
  private buildTree(objects: Map<number, IfcObject>): IfcObject[] {
    const parentOf = new Map<number, number>();
    const link = (parent: number | null, child: number | null) => {
      if (parent === null || child === null || parent === child || parentOf.has(child)) return;
      if (!objects.has(parent) || !objects.has(child)) return;
      parentOf.set(child, parent);
    };
    for (const id of this.file.idsOfType('IFCRELAGGREGATES')) {
      const rel = this.file.get(id);
      for (const child of list(rel?.args[5])) link(refId(rel?.args[4]), refId(child));
    }
    for (const id of this.file.idsOfType('IFCRELNESTS')) {
      const rel = this.file.get(id);
      for (const child of list(rel?.args[5])) link(refId(rel?.args[4]), refId(child));
    }
    for (const id of this.file.idsOfType('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
      const rel = this.file.get(id);
      for (const child of list(rel?.args[4])) link(refId(rel?.args[5]), refId(child));
    }
    // Guard against cycles in malformed files.
    for (const child of [...parentOf.keys()]) {
      const seen = new Set<number>([child]);
      let p = parentOf.get(child);
      while (p !== undefined) {
        if (seen.has(p)) {
          parentOf.delete(child);
          break;
        }
        seen.add(p);
        p = parentOf.get(p);
      }
    }
    const roots: IfcObject[] = [];
    for (const [id, object] of objects) {
      const parent = parentOf.get(id);
      if (parent !== undefined) objects.get(parent)!.children.push(object);
      else roots.push(object);
    }
    // Drop empty branches: objects with neither geometry nor descendants that have some,
    // apart from the spatial structure itself.
    const prune = (o: IfcObject): boolean => {
      o.children = o.children.filter(prune);
      return o.meshes.length > 0 || o.children.length > 0 || o.spatial;
    };
    const kept = roots.filter(prune);
    kept.sort((a, b) => (a.type === 'IfcProject' ? -1 : b.type === 'IfcProject' ? 1 : 0));
    return kept;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function styleKey(style: IfcStyle): string {
  return `${style.name}|${style.color.map(c => c.toFixed(4)).join(',')}|${style.opacity.toFixed(4)}`;
}

/** Whether a matrix mirrors, which flips triangle winding. */
export function mirrors(m: Mat4): boolean {
  return determinant3(m) < 0;
}

export { identity };
