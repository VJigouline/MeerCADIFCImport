import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { loadIfc } from '../src/index.js';
import { allObjects, findObject, ifcFile, objectBounds, product, read } from './helpers.js';

const solid = `#200=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#201=IFCEXTRUDEDAREASOLID(#200,#5,#3,1.);`;

describe('styles and materials', () => {
  it('reads IFC2X3 styles through IfcPresentationStyleAssignment', () => {
    const r = read(ifcFile('IFC2X3', `${solid}
#210=IFCCOLOURRGB($,0.5,0.25,1.);
#211=IFCSURFACESTYLERENDERING(#210,0.3,$,$,$,$,$,$,.NOTDEFINED.);
#212=IFCSURFACESTYLE('Glass',.BOTH.,(#211));
#213=IFCPRESENTATIONSTYLEASSIGNMENT((#212));
#214=IFCSTYLEDITEM(#201,(#213),$);
${product(100, 'IFCWALL', '#201')}`));
    expect(findObject(r, 'Element').meshes[0]!.style).toEqual({ name: 'Glass', color: [0.5, 0.25, 1], opacity: 0.7, source: 'style' });
  });

  it('reads IFC4 styles referenced directly, including IfcSurfaceStyleShading transparency', () => {
    const r = read(ifcFile('IFC4', `${solid}
#210=IFCCOLOURRGB($,0.1,0.2,0.3);
#211=IFCSURFACESTYLESHADING(#210,0.5);
#212=IFCSURFACESTYLE('Tinted',.BOTH.,(#211));
#214=IFCSTYLEDITEM(#201,(#212),$);
${product(100, 'IFCWINDOW', '#201')}`));
    expect(findObject(r, 'Element').meshes[0]!.style).toEqual({ name: 'Tinted', color: [0.1, 0.2, 0.3], opacity: 0.5, source: 'style' });
  });

  it('falls back to the material style, through layer set usages and the type object', () => {
    const material = `#300=IFCMATERIAL('Brick',$,$);
#301=IFCCOLOURRGB($,0.8,0.3,0.2);
#302=IFCSURFACESTYLERENDERING(#301,0.,$,$,$,$,$,$,.NOTDEFINED.);
#303=IFCSURFACESTYLE('Brick',.BOTH.,(#302));
#304=IFCSTYLEDITEM($,(#303),$);
#305=IFCSTYLEDREPRESENTATION(#20,'Style','Material',(#304));
#306=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#305),#300);
#307=IFCMATERIALLAYER(#300,200.,$,$,$,$,$);
#308=IFCMATERIALLAYERSET((#307),'Wall layers',$);
#309=IFCMATERIALLAYERSETUSAGE(#308,.AXIS2.,.POSITIVE.,0.,$);`;
    const direct = read(ifcFile('IFC4', `${solid}
${material}
#310=IFCRELASSOCIATESMATERIAL('0000000000000000000310',$,$,$,(#100),#309);
${product(100, 'IFCWALL', '#201')}`));
    const wall = findObject(direct, 'Element');
    expect(wall.meshes[0]!.style).toMatchObject({ name: 'Brick', color: [0.8, 0.3, 0.2], source: 'material' });
    expect(wall.materials).toEqual(['Brick']);
    // The same material on the wall's type only.
    const viaType = read(ifcFile('IFC4', `${solid}
${material}
#320=IFCWALLTYPE('0000000000000000000320',$,'Brick wall',$,$,$,$,$,$,.STANDARD.);
#321=IFCRELDEFINESBYTYPE('0000000000000000000321',$,$,$,(#100),#320);
#322=IFCRELASSOCIATESMATERIAL('0000000000000000000322',$,$,$,(#320),#300);
${product(100, 'IFCWALL', '#201')}`));
    const typed = findObject(viaType, 'Element');
    expect(typed.meshes[0]!.style.name).toBe('Brick');
    expect(typed.typeObject).toBe('Brick wall');
  });

  it('gives unstyled elements a colour for their type', () => {
    const r = read(ifcFile('IFC4', `${solid}
${product(100, 'IFCWINDOW', '#201', '#6', 'Window')}
${product(110, 'IFCSLAB', '#201', '#6', 'Slab')}`));
    expect(findObject(r, 'Window').meshes[0]!.style).toMatchObject({ source: 'default', opacity: 0.4 });
    expect(findObject(r, 'Slab').meshes[0]!.style).toMatchObject({ source: 'default', opacity: 1 });
  });
});

describe('model structure', () => {
  const building = `${solid}
#40=IFCBUILDING('0000000000000000000040',$,'House',$,$,#6,$,$,.ELEMENT.,$,$,$);
#41=IFCBUILDINGSTOREY('0000000000000000000041',$,'Ground floor',$,$,#6,$,$,.ELEMENT.,0.);
#42=IFCRELAGGREGATES('0000000000000000000042',$,$,$,#30,(#40));
#43=IFCRELAGGREGATES('0000000000000000000043',$,$,$,#40,(#41));
#100=IFCWALL('0000000000000000000100',$,'Wall A','A wall',$,#6,#101,'TAG',$);
#101=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));
#102=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#201));
#103=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000103',$,$,$,(#100),#41);
#110=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#111=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#112=IFCPROPERTYSET('0000000000000000000112',$,'Pset_WallCommon',$,(#110,#111));
#113=IFCRELDEFINESBYPROPERTIES('0000000000000000000113',$,$,$,(#100),#112);
#114=IFCQUANTITYLENGTH('Length',$,$,4000.,$);
#115=IFCELEMENTQUANTITY('0000000000000000000115',$,'Qto_WallBaseQuantities',$,$,(#114));
#116=IFCRELDEFINESBYPROPERTIES('0000000000000000000116',$,$,$,(#100),#115);`;

  it('builds the spatial structure from aggregation and containment', () => {
    const r = read(ifcFile('IFC4', building));
    expect(r.roots.map(o => o.type)).toEqual(['IfcProject']);
    const path: string[] = [];
    let node = r.roots[0]!;
    for (;;) {
      path.push(`${node.type}:${node.name}`);
      if (!node.children.length) break;
      node = node.children[0]!;
    }
    expect(path).toEqual(['IfcProject:Project', 'IfcSite:Site', 'IfcBuilding:House', 'IfcBuildingStorey:Ground floor', 'IfcWall:Wall A']);
    expect(r.schema.id).toBe('IFC4');
  });

  it('reads attributes, property sets and quantities', () => {
    const wall = findObject(read(ifcFile('IFC4', building)), 'Wall A');
    expect(wall).toMatchObject({ type: 'IfcWall', globalId: '0000000000000000000100', description: 'A wall', expressId: 100 });
    expect(wall.properties).toEqual({
      Pset_WallCommon: { IsExternal: true, FireRating: 'REI60' },
      Qto_WallBaseQuantities: { Length: 4000 },
    });
    expect(findObject(read(ifcFile('IFC4', building), { properties: false }), 'Wall A').properties).toEqual({});
  });

  it('places objects through chains of local placements', () => {
    const r = read(ifcFile('IFC4', `${solid}
#50=IFCCARTESIANPOINT((10.,0.,0.));
#51=IFCAXIS2PLACEMENT3D(#50,$,$);
#52=IFCLOCALPLACEMENT(#6,#51);
#53=IFCCARTESIANPOINT((0.,5.,0.));
#54=IFCDIRECTION((0.,1.,0.));
#55=IFCAXIS2PLACEMENT3D(#53,#3,#54);
#56=IFCLOCALPLACEMENT(#52,#55);
${product(100, 'IFCCOLUMN', '#201', '#56')}`));
    // Rotated 90 degrees about z, then moved to (10, 5, 0): x from 9.5 to 10.5.
    const b = objectBounds(findObject(r, 'Element')).map(v => +v.toFixed(6));
    expect(b).toEqual([9.5, 4.5, 0, 10.5, 5.5, 1]);
  });

  it('reads IFC4X3 linear placements through their Cartesian position', () => {
    const r = read(ifcFile('IFC4X3_ADD2', `${solid}
#50=IFCCARTESIANPOINT((100.,200.,0.));
#51=IFCAXIS2PLACEMENT3D(#50,$,$);
#52=IFCLINEARPLACEMENT(#6,$,#51);
${product(100, 'IFCPILE', '#201', '#52')}`));
    expect(objectBounds(findObject(r, 'Element')).slice(0, 2).map(v => +v.toFixed(6))).toEqual([99.5, 199.5]);
    expect(r.schema).toMatchObject({ id: 'IFC4X3', identifier: 'IFC4X3_ADD2' });
    expect(r.warnings).toEqual([]);
  });

  it('warns about entities outside the detected schema, and about unsupported geometry', () => {
    const r = read(ifcFile('IFC2X3', `#200=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#201=IFCTRIANGULATEDFACESET(#200,$,.F.,((1,2,3)),$);
#202=IFCSECTIONEDSPINE($,$,$);
${product(100, 'IFCSLAB', '#201', '#6', 'Tessellated')}
${product(110, 'IFCSLAB', '#202', '#6', 'Odd')}`));
    expect(r.warnings).toContain('IFCTRIANGULATEDFACESET is not part of IFC2X3 but appears 1 times; it is read anyway');
    expect(r.warnings).toContain('IFCSECTIONEDSPINE geometry is not supported');
    // The tessellated slab is still read.
    expect(findObject(r, 'Tessellated').meshes).toHaveLength(1);
  });

  it('includes spaces and opening elements only when asked', () => {
    const text = ifcFile('IFC4', `${solid}
#100=IFCSPACE('0000000000000000000100',$,'Room',$,$,#6,#101,$,.ELEMENT.,.INTERNAL.,$);
#101=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));
#102=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#201));
#103=IFCRELAGGREGATES('0000000000000000000103',$,$,$,#30,(#100));`);
    expect(allObjects(read(text)).some(o => o.name === 'Room')).toBe(false);
    expect(findObject(read(text, { spaces: true }), 'Room').meshes).toHaveLength(1);
  });
});

describe('three.js output', () => {
  it('builds groups for the structure, meshes in metres with Y up, and userData', () => {
    const r = loadIfc(ifcFile('IFC4', `${solid}
${product(100, 'IFCWALL', '#201', '#6', 'Wall')}
${product(110, 'IFCWALL', '#201', '#6', 'Other wall')}`));
    const group = r.group;
    expect(group.scale.x).toBeCloseTo(0.001);
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2);
    const meshes: THREE.Mesh[] = [];
    group.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.userData.ifc.type).toBe('IfcWall');
    expect(meshes[0]!.material).toBe(meshes[1]!.material);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(meshes[0]!);
    // 1 x 1 x 1 file units of millimetres; Z up becomes Y up.
    expect(box.max.y - box.min.y).toBeCloseTo(0.001, 9);
    expect(box.min.y).toBeCloseTo(0, 9);
    const material = meshes[0]!.material as THREE.MeshStandardMaterial;
    // The default wall colour is sRGB, so three.js stores it linear.
    expect(material.color.r).toBeCloseTo(new THREE.Color().setRGB(0.9, 0.9, 0.88, THREE.SRGBColorSpace).r, 6);
  });

  it('can keep file units and Z up', () => {
    const r = loadIfc(ifcFile('IFC4', `${solid}
${product(100, 'IFCWALL', '#201')}`), { metres: false, yUp: false });
    expect(r.group.scale.x).toBe(1);
    expect(r.group.rotation.x).toBe(0);
  });
});
