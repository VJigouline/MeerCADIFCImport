import { describe, expect, it } from 'vitest';
import { findObject, ifcFile, objectBounds, objectVolume, product, read } from './helpers.js';

const box = (id: number, x: number, y: number, z: number, placement = '#5') => `#${id}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,${x},${y});
#${id + 1}=IFCEXTRUDEDAREASOLID(#${id},${placement},#3,${z});`;

describe('swept solids and profiles', () => {
  it('extrudes a rectangle, centred on its position, to its depth', () => {
    const r = read(ifcFile('IFC4', `${box(200, 2000, 300, 3000)}
${product(100, 'IFCWALL', '#201')}`));
    const wall = findObject(r, 'Element');
    expect(objectVolume(wall)).toBeCloseTo(2000 * 300 * 3000, -3);
    expect(objectBounds(wall).map(v => Math.round(v))).toEqual([-1000, -150, 0, 1000, 150, 3000]);
    expect(r.lengthUnit).toBe(0.001);
  });

  it('extrudes along a slanted direction', () => {
    const r = read(ifcFile('IFC4', `#199=IFCDIRECTION((0.,0.6,0.8));
#200=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);
#201=IFCEXTRUDEDAREASOLID(#200,#5,#199,10.);
${product(100, 'IFCMEMBER', '#201')}`));
    const member = findObject(r, 'Element');
    // A slanted prism keeps base area times height: 1 x 1 x 8.
    expect(objectVolume(member)).toBeCloseTo(8, 6);
    expect(objectBounds(member)[4]).toBeCloseTo(6.5, 6);
  });

  it('builds parameterised profiles with the right area', () => {
    const shapes: [string, number][] = [
      ['IFCISHAPEPROFILEDEF(.AREA.,$,$,200.,300.,10.,20.,$,$,$)', 2 * 200 * 20 + 10 * 260],
      ['IFCLSHAPEPROFILEDEF(.AREA.,$,$,100.,80.,10.,$,$,$,$,$)', 100 * 10 + 70 * 10],
      ['IFCUSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,15.,$,$,$)', 2 * 80 * 15 + 10 * 170],
      ['IFCTSHAPEPROFILEDEF(.AREA.,$,$,200.,100.,10.,20.,$,$,$,$,$)', 100 * 20 + 10 * 180],
      ['IFCZSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,10.,15.,$,$)', 2 * 80 * 15 + 10 * 170 - 2 * 10 * 15 + 2 * 10 * 15],
      ['IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,$,100.,50.,5.,$,$)', 100 * 50 - 90 * 40],
      ['IFCCSHAPEPROFILEDEF(.AREA.,$,$,200.,80.,5.,20.,$)', 200 * 5 + 2 * 75 * 5 + 2 * 15 * 5],
    ];
    for (const [profile, area] of shapes) {
      const r = read(ifcFile('IFC2X3', `#200=${profile};
#201=IFCEXTRUDEDAREASOLID(#200,#5,#3,1.);
${product(100, 'IFCBEAM', '#201')}`));
      expect([profile, objectVolume(findObject(r, 'Element'))]).toEqual([profile, expect.closeTo(area, 3)]);
    }
  });

  it('approximates circles with the requested number of segments', () => {
    const text = ifcFile('IFC4', `#200=IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.);
#201=IFCEXTRUDEDAREASOLID(#200,#5,#3,1.);
${product(100, 'IFCCOLUMN', '#201')}`);
    const n = 64;
    const r = read(text, { circleSegments: n });
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo((n / 2) * Math.sin((2 * Math.PI) / n), 6);
    const hollow = read(ifcFile('IFC4', `#200=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,1.,0.5);
#201=IFCEXTRUDEDAREASOLID(#200,#5,#3,1.);
${product(100, 'IFCPIPESEGMENT', '#201')}`), { circleSegments: n });
    expect(objectVolume(findObject(hollow, 'Element'))).toBeCloseTo(0.75 * (n / 2) * Math.sin((2 * Math.PI) / n), 6);
  });

  it('reads arbitrary profiles with voids, from polylines and IFC4 indexed curves with arcs', () => {
    const r = read(ifcFile('IFC4', `#200=IFCCARTESIANPOINTLIST2D(((0.,0.),(4.,0.),(4.,4.),(2.,6.),(0.,4.)));
#201=IFCINDEXEDPOLYCURVE(#200,(IFCLINEINDEX((1,2,3)),IFCARCINDEX((3,4,5)),IFCLINEINDEX((5,1))),$);
#202=IFCCARTESIANPOINT((1.,1.));
#203=IFCCARTESIANPOINT((2.,1.));
#204=IFCCARTESIANPOINT((2.,2.));
#205=IFCCARTESIANPOINT((1.,2.));
#206=IFCPOLYLINE((#202,#203,#204,#205,#202));
#207=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#201,(#206));
#208=IFCEXTRUDEDAREASOLID(#207,#5,#3,1.);
${product(100, 'IFCSLAB', '#208')}`), { circleSegments: 256 });
    // A 4 x 4 square, a half disc of radius 2 on top through (2, 6), less a 1 x 1 hole.
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo(16 + Math.PI * 2 - 1, 2);
  });

  it('revolves profiles by the plane angle unit: degrees as well as radians', () => {
    const solid = (angle: string) => `#200=IFCRECTANGLEPROFILEDEF(.AREA.,$,#210,1.,2.);
#210=IFCAXIS2PLACEMENT2D(#211,$);
#211=IFCCARTESIANPOINT((2.5,0.));
#212=IFCDIRECTION((0.,1.,0.));
#213=IFCAXIS1PLACEMENT(#2,#212);
#201=IFCREVOLVEDAREASOLID(#200,#5,#213,${angle});
${product(100, 'IFCMEMBER', '#201')}`;
    // A 1 x 2 rectangle 2 to 3 from the axis, turned a quarter: (3^2 - 2^2) * pi / 4 * 2.
    const expected = ((9 - 4) * Math.PI) / 4 * 2;
    const radians = read(ifcFile('IFC4', solid(`${Math.PI / 2}`)), { circleSegments: 512 });
    expect(objectVolume(findObject(radians, 'Element'))).toBeCloseTo(expected, 2);
    const degrees = read(ifcFile('IFC2X3', solid('90.'), {
      angleUnit: `#11=IFCCONVERSIONBASEDUNIT(#13,.PLANEANGLEUNIT.,'DEGREE',#14);
#13=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#14=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#15);
#15=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`,
    }), { circleSegments: 512 });
    expect(degrees.angleUnit).toBeCloseTo(Math.PI / 180, 12);
    expect(objectVolume(findObject(degrees, 'Element'))).toBeCloseTo(expected, 2);
  });

  it('sweeps a disk along a polyline, with an inner radius', () => {
    const r = read(ifcFile('IFC4', `#200=IFCCARTESIANPOINT((0.,0.,0.));
#201=IFCCARTESIANPOINT((0.,0.,10.));
#202=IFCPOLYLINE((#200,#201));
#203=IFCSWEPTDISKSOLID(#202,0.5,0.25,$,$);
${product(100, 'IFCPIPESEGMENT', '#203')}`), { circleSegments: 1024 });
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo(Math.PI * (0.25 - 0.0625) * 10, 2);
  });

  it('reads feet as a conversion-based length unit', () => {
    const r = read(ifcFile('IFC2X3', box(200, 1, 1, 1), {
      lengthUnit: `#10=IFCCONVERSIONBASEDUNIT(#13,.LENGTHUNIT.,'FOOT',#14);
#13=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#14=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#15);
#15=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`,
    }) + '');
    expect(r.lengthUnit).toBeCloseTo(0.3048, 12);
  });
});

describe('B-reps and tessellations', () => {
  const cube = `#200=IFCCARTESIANPOINT((0.,0.,0.));
#201=IFCCARTESIANPOINT((1.,0.,0.));
#202=IFCCARTESIANPOINT((1.,1.,0.));
#203=IFCCARTESIANPOINT((0.,1.,0.));
#204=IFCCARTESIANPOINT((0.,0.,1.));
#205=IFCCARTESIANPOINT((1.,0.,1.));
#206=IFCCARTESIANPOINT((1.,1.,1.));
#207=IFCCARTESIANPOINT((0.,1.,1.));
#210=IFCPOLYLOOP((#200,#203,#202,#201));
#211=IFCPOLYLOOP((#204,#205,#206,#207));
#212=IFCPOLYLOOP((#200,#201,#205,#204));
#213=IFCPOLYLOOP((#201,#202,#206,#205));
#214=IFCPOLYLOOP((#202,#203,#207,#206));
#215=IFCPOLYLOOP((#203,#200,#204,#207));
#220=IFCFACEOUTERBOUND(#210,.T.);
#221=IFCFACEOUTERBOUND(#211,.T.);
#222=IFCFACEOUTERBOUND(#212,.T.);
#223=IFCFACEOUTERBOUND(#213,.T.);
#224=IFCFACEOUTERBOUND(#214,.T.);
#225=IFCFACEOUTERBOUND(#215,.T.);
#230=IFCFACE((#220));
#231=IFCFACE((#221));
#232=IFCFACE((#222));
#233=IFCFACE((#223));
#234=IFCFACE((#224));
#235=IFCFACE((#225));
#240=IFCCLOSEDSHELL((#230,#231,#232,#233,#234,#235));
#241=IFCFACETEDBREP(#240);`;

  it('reads faceted B-reps (the common IFC2X3 form)', () => {
    const r = read(ifcFile('IFC2X3', `${cube}
${product(100, 'IFCBUILDINGELEMENTPROXY', '#241')}`));
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo(1, 9);
    expect(r.warnings).toEqual([]);
  });

  it('reads faces with holes', () => {
    const r = read(ifcFile('IFC2X3', `#200=IFCCARTESIANPOINT((0.,0.,0.));
#201=IFCCARTESIANPOINT((4.,0.,0.));
#202=IFCCARTESIANPOINT((4.,4.,0.));
#203=IFCCARTESIANPOINT((0.,4.,0.));
#204=IFCCARTESIANPOINT((1.,1.,0.));
#205=IFCCARTESIANPOINT((1.,3.,0.));
#206=IFCCARTESIANPOINT((3.,3.,0.));
#207=IFCCARTESIANPOINT((3.,1.,0.));
#210=IFCPOLYLOOP((#200,#201,#202,#203));
#211=IFCPOLYLOOP((#204,#205,#206,#207));
#220=IFCFACEOUTERBOUND(#210,.T.);
#221=IFCFACEBOUND(#211,.T.);
#230=IFCFACE((#220,#221));
#240=IFCOPENSHELL((#230));
#241=IFCSHELLBASEDSURFACEMODEL((#240));
${product(100, 'IFCSLAB', '#241')}`));
    const slab = findObject(r, 'Element');
    // Area of the face: the sum of its triangles.
    const d = slab.meshes[0]!.data;
    let area = 0;
    for (let t = 0; t < d.indices.length; t += 3) {
      const p = (i: number) => [d.positions[d.indices[t + i]! * 3]!, d.positions[d.indices[t + i]! * 3 + 1]!];
      const [a, b, c] = [p(0), p(1), p(2)];
      area += Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)) / 2;
    }
    expect(area).toBeCloseTo(12, 9);
  });

  const triangulatedCube = (fifth: string) => `#200=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));
#201=IFCTRIANGULATEDFACESET(#200,$,.T.,((1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)),${fifth});
${product(100, 'IFCBUILDINGELEMENTPROXY', '#201')}`;

  it('reads IfcTriangulatedFaceSet in its IFC4 2013 form, with NormalIndex', () => {
    const r = read(ifcFile('IFC4', triangulatedCube('((1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1),(1,1,1))')));
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo(1, 9);
  });

  it('reads IfcTriangulatedFaceSet in its IFC4 ADD2 form, with PnIndex', () => {
    // PnIndex reverses the point list, so the cube's coordinates come out mirrored: still volume 1.
    const r = read(ifcFile('IFC4', triangulatedCube('(8,7,6,5,4,3,2,1)')));
    const element = findObject(r, 'Element');
    expect(Math.abs(objectVolume(element))).toBeCloseTo(1, 9);
    const plain = read(ifcFile('IFC4', triangulatedCube('$')));
    expect(objectVolume(findObject(plain, 'Element'))).toBeCloseTo(1, 9);
  });

  it('reads IfcPolygonalFaceSet faces, including faces with voids', () => {
    const r = read(ifcFile('IFC4X3_ADD2', `#200=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4.,0.,0.),(4.,4.,0.),(0.,4.,0.),(1.,1.,0.),(1.,3.,0.),(3.,3.,0.),(3.,1.,0.)));
#201=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,6,7,8)));
#202=IFCPOLYGONALFACESET(#200,.F.,(#201),$);
${product(100, 'IFCSLAB', '#202')}`));
    expect(findObject(r, 'Element').meshes[0]!.data.indices.length / 3).toBe(8);
  });

  it('colours tessellated faces with IfcIndexedColourMap', () => {
    const r = read(ifcFile('IFC4', `${triangulatedCube('$')}
#300=IFCCOLOURRGBLIST(((1.,0.,0.),(0.,0.,1.)));
#301=IFCINDEXEDCOLOURMAP(#201,0.5,#300,(1,1,2,2,1,1,1,1,1,1,1,1));`));
    const mesh = findObject(r, 'Element').meshes[0]!;
    expect(mesh.vertexColors).toBe(true);
    const colours = new Set<string>();
    for (let i = 0; i < mesh.data.colors!.length; i += 4) colours.add([...mesh.data.colors!.slice(i, i + 4)].join(','));
    expect([...colours].sort()).toEqual(['0,0,1,0.5', '1,0,0,0.5']);
  });
});

describe('booleans, openings and mapped items', () => {
  it('subtracts openings in IFC2X3, with the opening placed relative to the wall', () => {
    const r = read(ifcFile('IFC2X3', `${box(200, 4000, 200, 3000)}
#300=IFCCARTESIANPOINT((0.,0.,1000.));
#301=IFCAXIS2PLACEMENT3D(#300,$,$);
#302=IFCLOCALPLACEMENT(#6,#301);
#310=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1000.,1000.);
#311=IFCCARTESIANPOINT((0.,-500.,-500.));
#312=IFCAXIS2PLACEMENT3D(#311,#313,#4);
#313=IFCDIRECTION((0.,1.,0.));
#314=IFCEXTRUDEDAREASOLID(#310,#312,#3,1000.);
#320=IFCOPENINGELEMENT('0000000000000000000320',$,'Opening',$,$,#302,#321,$);
#321=IFCPRODUCTDEFINITIONSHAPE($,$,(#322));
#322=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#314));
#330=IFCRELVOIDSELEMENT('0000000000000000000330',$,$,$,#100,#320);
${product(100, 'IFCWALLSTANDARDCASE', '#201')}`));
    const wall = findObject(r, 'Element');
    // The opening is 1000 x 1000 through the 200 thick wall.
    expect(objectVolume(wall)).toBeCloseTo(4000 * 200 * 3000 - 1000 * 1000 * 200, -4);
    expect(r.roots.flatMap(o => o.children).some(o => o.type === 'IfcOpeningElement')).toBe(false);
    const kept = read(ifcFile('IFC2X3', `${box(200, 4000, 200, 3000)}
${product(100, 'IFCWALL', '#201')}`), { openings: false });
    expect(objectVolume(findObject(kept, 'Element'))).toBeCloseTo(4000 * 200 * 3000, -4);
  });

  it('clips by half-spaces, keeping the side AgreementFlag says is material', () => {
    const clip = (agreement: string) => read(ifcFile('IFC4', `${box(200, 2, 2, 2)}
#300=IFCCARTESIANPOINT((0.,0.,1.5));
#301=IFCAXIS2PLACEMENT3D(#300,#3,#4);
#302=IFCPLANE(#301);
#303=IFCHALFSPACESOLID(#302,${agreement});
#304=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#201,#303);
${product(100, 'IFCWALL', '#304')}`));
    // Agreement .F.: the material is above z = 1.5, so subtracting it leaves the lower 1.5.
    expect(objectVolume(findObject(clip('.F.'), 'Element'))).toBeCloseTo(2 * 2 * 1.5, 6);
    expect(objectVolume(findObject(clip('.T.'), 'Element'))).toBeCloseTo(2 * 2 * 0.5, 6);
  });

  it('clips by polygonal bounded half-spaces only within their boundary', () => {
    const r = read(ifcFile('IFC4', `${box(200, 2, 2, 2)}
#300=IFCCARTESIANPOINT((0.,0.,1.));
#301=IFCAXIS2PLACEMENT3D(#300,#3,#4);
#302=IFCPLANE(#301);
#305=IFCCARTESIANPOINT((0.,-5.));
#306=IFCCARTESIANPOINT((5.,-5.));
#307=IFCCARTESIANPOINT((5.,5.));
#308=IFCCARTESIANPOINT((0.,5.));
#309=IFCPOLYLINE((#305,#306,#307,#308,#305));
#303=IFCPOLYGONALBOUNDEDHALFSPACE(#302,.F.,#5,#309);
#304=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#201,#303);
${product(100, 'IFCWALL', '#304')}`));
    // Only the x > 0 half loses its top half: 8 - 2 * 1 * 2.
    expect(objectVolume(findObject(r, 'Element'))).toBeCloseTo(8 - 2, 6);
  });

  it('combines CSG primitives with boolean results', () => {
    const r = read(ifcFile('IFC4', `#200=IFCBLOCK(#5,2.,2.,2.);
#201=IFCCARTESIANPOINT((1.,1.,1.));
#202=IFCAXIS2PLACEMENT3D(#201,$,$);
#203=IFCBLOCK(#202,2.,2.,2.);
#204=IFCBOOLEANRESULT(.UNION.,#200,#203);
#205=IFCBOOLEANRESULT(.INTERSECTION.,#200,#203);
#206=IFCCSGSOLID(#204);
${product(100, 'IFCBUILDINGELEMENTPROXY', '#206', '#6', 'Union')}
${product(110, 'IFCBUILDINGELEMENTPROXY', '#205', '#6', 'Intersection')}`));
    expect(objectVolume(findObject(r, 'Union'))).toBeCloseTo(15, 6);
    expect(objectVolume(findObject(r, 'Intersection'))).toBeCloseTo(1, 6);
  });

  it('shares mapped geometry between instances, transformed by their operators', () => {
    const r = read(ifcFile('IFC4', `${box(200, 1, 1, 1)}
#210=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#201));
#211=IFCREPRESENTATIONMAP(#5,#210);
#212=IFCCARTESIANPOINT((10.,0.,0.));
#213=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#212,2.,$);
#214=IFCMAPPEDITEM(#211,#213);
#215=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#2,1.,$);
#216=IFCMAPPEDITEM(#211,#215);
${product(100, 'IFCFURNITURE', '#214', '#6', 'Big')}
${product(110, 'IFCFURNITURE', '#216', '#6', 'Small')}`));
    const big = findObject(r, 'Big'), small = findObject(r, 'Small');
    expect(big.meshes[0]!.data).toBe(small.meshes[0]!.data);
    expect(objectVolume(big)).toBeCloseTo(8, 9);
    expect(objectBounds(big)[0]).toBeCloseTo(9, 9);
    expect(objectVolume(small)).toBeCloseTo(1, 9);
  });
});
