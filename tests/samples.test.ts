// Regression tests on buildingSMART's certification samples (CC BY 4.0), which hold the same
// scenes written as IFC2X3, IFC4 ADD2 TC1 and IFC4X3 ADD2.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readIfc } from '../src/index.js';
import { allObjects, findObject, objectBounds, objectVolume } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/buildingSMART/${name}`, import.meta.url));

function modelBounds(result: ReturnType<typeof readIfc>): number[] {
  const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const object of allObjects(result)) {
    if (!object.meshes.length) continue;
    const b = objectBounds(object);
    for (let k = 0; k < 3; k++) {
      all[k] = Math.min(all[k]!, b[k]!);
      all[k + 3] = Math.max(all[k + 3]!, b[k + 3]!);
    }
  }
  return all.map(v => Math.round(v));
}

describe('buildingSMART samples', () => {
  for (const scene of ['Building-Architecture', 'Building-Structural']) {
    it(`reads ${scene} the same from IFC2X3, IFC4 and IFC4X3`, () => {
      const results = (['ifc2x3', 'ifc4', 'ifc4x3'] as const).map(prefix => readIfc(fixture(`${prefix}-${scene}.ifc`)));
      expect(results.map(r => r.schema.id)).toEqual(['IFC2X3', 'IFC4', 'IFC4X3']);
      for (const r of results) {
        expect(r.warnings).toEqual([]);
        expect(r.lengthUnit).toBe(0.001);
        expect(r.statistics.meshes).toBeGreaterThan(10);
        expect(r.roots[0]!.type).toBe('IfcProject');
      }
      // The same scene: the same overall extent, and the same named elements with geometry.
      const bounds = results.map(modelBounds);
      expect(bounds[1]).toEqual(bounds[0]);
      expect(bounds[2]).toEqual(bounds[0]);
      const names = results.map(r => allObjects(r).filter(o => o.meshes.length).map(o => o.name).sort());
      expect(names[2]).toEqual(names[1]);
      for (const name of names[0]!) expect(names[1]).toContain(name);
    });
  }

  it('cuts the opening of the IFC4 reference wall', () => {
    const r = readIfc(fixture('ifc4-reference-wall-with-opening-and-window.ifc'));
    const wall = findObject(r, 'Wall for Test Example');
    expect(objectVolume(wall)).toBeCloseTo(3000 * 300 * 2000 - 1000 * 300 * 1000, -4);
    expect(wall.materials).toEqual(['Name of the material used for the wall']);
    expect(allObjects(r).some(o => o.type === 'IfcWindow' && o.meshes.length > 0)).toBe(true);
  });

  it('reads every IFC4 reference example without warnings', () => {
    for (const name of ['basin-tessellation', 'column-straight-rectangle-tessellation', 'tessellated-item', 'tessellation-with-individual-colors']) {
      const r = readIfc(fixture(`ifc4-reference-${name}.ifc`));
      expect([name, r.warnings]).toEqual([name, []]);
      expect(r.statistics.triangles).toBeGreaterThan(0);
    }
    const coloured = readIfc(fixture('ifc4-reference-tessellation-with-individual-colors.ifc'));
    expect(allObjects(coloured).flatMap(o => o.meshes).some(m => m.vertexColors)).toBe(true);
  });
});
