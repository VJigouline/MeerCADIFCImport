import type * as THREE from 'three';
import { readIfc, type IfcImportOptions, type IfcImportResult } from './ifc/importer.js';
import { toThree, type IfcThreeOptions } from './three.js';

export { readIfc } from './ifc/importer.js';
export type { IfcImportOptions, IfcImportResult, IfcObject, IfcMesh, IfcStyle } from './ifc/importer.js';
export { toThree } from './three.js';
export type { IfcThreeOptions, IfcUserData } from './three.js';
export { detectSchema, UnsupportedSchemaError, typeInSchema } from './ifc/schema.js';
export type { IfcSchemaId, IfcSchemaInfo } from './ifc/schema.js';
export { StepFile, StepRef, StepEnum, StepTyped, StepSyntaxError, DERIVED, decodeStepString, stepText } from './step/step.js';
export type { StepEntity, StepHeader, StepValue } from './step/step.js';
export type { MeshData } from './geometry/mesh.js';

export interface IfcLoadResult extends IfcImportResult {
  /** The model for three.js. */
  group: THREE.Group;
}

/**
 * Reads an IFC file (IFC2X3, or any schema of the IFC4 line up to IFC4X3), detecting its schema
 * version, and returns the model as a three.js group together with the plain import result.
 */
export function loadIfc(input: string | ArrayBuffer | Uint8Array, options: IfcImportOptions & IfcThreeOptions = {}): IfcLoadResult {
  const result = readIfc(input, options);
  return { ...result, group: toThree(result, options) };
}
