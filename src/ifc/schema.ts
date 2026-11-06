// Detects the IFC schema of a file from its FILE_SCHEMA header, and describes what differs
// between the schema versions the importer reads.

/** The schema versions the importer distinguishes. */
export type IfcSchemaId = 'IFC2X3' | 'IFC4' | 'IFC4X1' | 'IFC4X2' | 'IFC4X3';

export interface IfcSchemaInfo {
  /** The version the importer treats the file as. */
  id: IfcSchemaId;
  /** IFC2X3, or IFC4 for every schema of the IFC4 line (IFC2X4 drafts to IFC4X3). */
  family: 'IFC2X3' | 'IFC4';
  /** The identifier as written in FILE_SCHEMA, such as IFC4X3_ADD2. */
  identifier: string;
  /** Human-readable release, such as "IFC 4.3 ADD2 (4.3.2.0)". */
  release: string;
  /** The identifier wasn't recognised exactly; the importer guessed from its prefix. */
  guessed: boolean;
}

export class UnsupportedSchemaError extends Error {
  constructor(readonly identifier: string) {
    super(`IFC schema '${identifier}' is not supported. Supported: IFC2X3 and the IFC4 line (IFC2X4, IFC4, IFC4X1, IFC4X2, IFC4X3).`);
    this.name = 'UnsupportedSchemaError';
  }
}

const KNOWN: Record<string, { id: IfcSchemaId; release: string }> = {
  IFC2X3: { id: 'IFC2X3', release: 'IFC 2x3 TC1 (2.3.0.1)' },
  IFC2X3_TC1: { id: 'IFC2X3', release: 'IFC 2x3 TC1 (2.3.0.1)' },
  IFC2X3_FINAL: { id: 'IFC2X3', release: 'IFC 2x3 (2.3.0)' },
  IFC2X4: { id: 'IFC4', release: 'IFC 2x4 draft, released as IFC4' },
  IFC2X4_RC1: { id: 'IFC4', release: 'IFC 2x4 RC1, released as IFC4' },
  IFC2X4_RC2: { id: 'IFC4', release: 'IFC 2x4 RC2, released as IFC4' },
  IFC2X4_RC3: { id: 'IFC4', release: 'IFC 2x4 RC3, released as IFC4' },
  IFC2X4_RC4: { id: 'IFC4', release: 'IFC 2x4 RC4, released as IFC4' },
  IFC4: { id: 'IFC4', release: 'IFC 4 (4.0, including ADD1, ADD2 and TC1)' },
  IFC4_ADD1: { id: 'IFC4', release: 'IFC 4 ADD1 (4.0.1)' },
  IFC4_ADD2: { id: 'IFC4', release: 'IFC 4 ADD2 (4.0.2)' },
  IFC4_ADD2_TC1: { id: 'IFC4', release: 'IFC 4 ADD2 TC1 (4.0.2.1)' },
  IFC4X1: { id: 'IFC4X1', release: 'IFC 4.1 (4.1.0.0)' },
  IFC4X2: { id: 'IFC4X2', release: 'IFC 4.2 (4.2.0.0)' },
  IFC4X3: { id: 'IFC4X3', release: 'IFC 4.3' },
  IFC4X3_RC1: { id: 'IFC4X3', release: 'IFC 4.3 RC1' },
  IFC4X3_RC2: { id: 'IFC4X3', release: 'IFC 4.3 RC2' },
  IFC4X3_RC3: { id: 'IFC4X3', release: 'IFC 4.3 RC3' },
  IFC4X3_RC4: { id: 'IFC4X3', release: 'IFC 4.3 RC4' },
  IFC4X3_ADD1: { id: 'IFC4X3', release: 'IFC 4.3 ADD1 (4.3.1.0)' },
  IFC4X3_ADD2: { id: 'IFC4X3', release: 'IFC 4.3 ADD2 (4.3.2.0)' },
  IFC4X3_TC1: { id: 'IFC4X3', release: 'IFC 4.3 TC1' },
};

/**
 * Works out the schema from FILE_SCHEMA identifiers. Exact identifiers are matched first, then
 * prefixes (IFC4X3_..., IFC4X2..., IFC4X1..., IFC4..., IFC2X4..., IFC2X3...), so new addenda
 * are still read. Throws UnsupportedSchemaError for other schemas, such as IFC2X2.
 */
export function detectSchema(identifiers: readonly string[]): IfcSchemaInfo {
  const ifc = identifiers.map(s => s.trim().toUpperCase()).filter(s => s.startsWith('IFC'));
  if (ifc.length === 0) throw new UnsupportedSchemaError(identifiers.join(', ') || '(none)');
  for (const identifier of ifc) {
    // Strip a version suffix some tools append, such as IFC4 {1.0}.
    const key = identifier.replace(/\s*\{.*\}$/, '');
    const known = KNOWN[key];
    if (known) return make(known.id, identifier, known.release, false);
  }
  const identifier = ifc[0]!;
  const prefixes: [RegExp, IfcSchemaId][] = [
    [/^IFC4X3/, 'IFC4X3'], [/^IFC4X2/, 'IFC4X2'], [/^IFC4X1/, 'IFC4X1'], [/^IFC4(?!X)/, 'IFC4'],
    [/^IFC2X4/, 'IFC4'], [/^IFC2X3/, 'IFC2X3'],
  ];
  for (const [pattern, id] of prefixes) {
    if (pattern.test(identifier)) return make(id, identifier, `${identifier}, read as ${id}`, true);
  }
  throw new UnsupportedSchemaError(identifier);
}

function make(id: IfcSchemaId, identifier: string, release: string, guessed: boolean): IfcSchemaInfo {
  return { id, family: id === 'IFC2X3' ? 'IFC2X3' : 'IFC4', identifier, release, guessed };
}

/**
 * Representation item and resource types introduced after IFC2X3. Seeing one in an IFC2X3 file
 * means the file doesn't follow its schema; the importer still reads it, with a warning.
 */
export const IFC4_ONLY_TYPES = new Set([
  'IFCTRIANGULATEDFACESET', 'IFCTRIANGULATEDIRREGULARNETWORK', 'IFCPOLYGONALFACESET', 'IFCINDEXEDPOLYGONALFACE',
  'IFCINDEXEDPOLYGONALFACEWITHVOIDS', 'IFCCARTESIANPOINTLIST2D', 'IFCCARTESIANPOINTLIST3D', 'IFCINDEXEDPOLYCURVE',
  'IFCINDEXEDCOLOURMAP', 'IFCCOLOURRGBLIST', 'IFCADVANCEDBREP', 'IFCADVANCEDBREPWITHVOIDS', 'IFCEXTRUDEDAREASOLIDTAPERED',
  'IFCREVOLVEDAREASOLIDTAPERED', 'IFCSWEPTDISKSOLIDPOLYGONAL', 'IFCFIXEDREFERENCESWEPTAREASOLID', 'IFCMIRROREDPROFILEDEF',
]);

/** Types introduced in IFC4X1 to IFC4X3, mainly for alignments and infrastructure. */
export const IFC4X3_ONLY_TYPES = new Set([
  'IFCLINEARPLACEMENT', 'IFCAXIS2PLACEMENTLINEAR', 'IFCALIGNMENT', 'IFCGRADIENTCURVE', 'IFCSEGMENTEDREFERENCECURVE',
  'IFCCURVESEGMENT', 'IFCSECTIONEDSOLIDHORIZONTAL', 'IFCDIRECTRIXCURVESWEPTAREASOLID', 'IFCSECTIONEDSURFACE',
]);

/** Whether a type is part of a schema, for the types the importer knows to be version-specific. */
export function typeInSchema(type: string, schema: IfcSchemaId): boolean {
  if (schema === 'IFC2X3') return !IFC4_ONLY_TYPES.has(type) && !IFC4X3_ONLY_TYPES.has(type);
  if (schema === 'IFC4') return !IFC4X3_ONLY_TYPES.has(type);
  return true;
}
