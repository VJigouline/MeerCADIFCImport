# Geometry and schema support

## Representations

For each product, the importer draws its `Body` shape representations. If there are none, it uses `Body-FallBack`, `Facetation`, `Mesh` or unnamed representations, and then any others except `Axis`, `FootPrint`, `Box`, `Annotation`, `Profile`, `Clearance`, `Reference`, `Lighting`, `CoG`, `Surface` and `Plan`.

Placements are `IfcLocalPlacement` chains of `IfcAxis2Placement3D` and `2D`. IFC4X1+ `IfcLinearPlacement` uses its `CartesianPosition`. `IfcGridPlacement` falls back to its parent, with a warning.

## Representation items

| Kind | Entities | Notes |
|---|---|---|
| Extrusions | `IfcExtrudedAreaSolid`, `IfcExtrudedAreaSolidTapered` | Any direction. Tapered extrusions need end profiles with the same number of points. |
| Revolutions | `IfcRevolvedAreaSolid`, `IfcRevolvedAreaSolidTapered` | Partial revolutions are capped. The taper is ignored. |
| Sweeps | `IfcSweptDiskSolid`, `IfcSweptDiskSolidPolygonal`, `IfcSurfaceCurveSweptAreaSolid`, `IfcFixedReferenceSweptAreaSolid` | Along the directrix's points, with frames carried by parallel transport or the fixed reference. Start and end parameters are ignored. |
| B-reps | `IfcFacetedBrep`, `IfcFacetedBrepWithVoids`, `IfcAdvancedBrep`, `IfcAdvancedBrepWithVoids` | Faces with holes. In advanced B-reps, only faces on planes are drawn; faces on B-spline, cylindrical and other curved surfaces are left out, with a warning. |
| Surface models | `IfcShellBasedSurfaceModel`, `IfcFaceBasedSurfaceModel`, open and closed shells | |
| Tessellations | `IfcTriangulatedFaceSet`, `IfcTriangulatedIrregularNetwork`, `IfcPolygonalFaceSet` | With `PnIndex`, faces with voids and `IfcIndexedColourMap` colours. |
| CSG | `IfcCsgSolid`, `IfcBlock`, `IfcRectangularPyramid`, `IfcRightCircularCylinder`, `IfcRightCircularCone`, `IfcSphere`, `IfcBooleanResult`, `IfcBooleanClippingResult` | Union, difference and intersection on meshes (BSP trees). |
| Half-spaces | `IfcHalfSpaceSolid`, `IfcBoxedHalfSpace`, `IfcPolygonalBoundedHalfSpace` | On planes. |
| Reuse | `IfcMappedItem` | With uniform and non-uniform transformation operators. The mesh is shared between instances, unless openings cut it. |
| Ignored | `IfcBoundingBox`, `IfcGeometricSet`, `IfcGeometricCurveSet`, curves, points, annotations, text | Not volumes. |

Other items, such as IFC4X3 `IfcSectionedSolidHorizontal` and `IfcDirectrixCurveSweptAreaSolid`, are skipped with a warning.

## Curves

`IfcPolyline`, `IfcIndexedPolyCurve` (with line and arc segments), `IfcCircle`, `IfcEllipse`, `IfcTrimmedCurve` (on circles, ellipses and lines, by parameter or point, either sense), `IfcCompositeCurve`, and `IfcLine` within trimmed curves. B-spline curves are approximated by their control polygons, with a warning. IFC4X3 alignment curves (`IfcGradientCurve`, `IfcSegmentedReferenceCurve`, clothoids) are not evaluated.

## Profiles

Rectangle, rounded rectangle, rectangle hollow, circle, circle hollow, ellipse, I, asymmetric I, L, U, T, C, Z and trapezium shapes, all centred on their position. Fillet and edge radii and slopes are ignored. Arbitrary closed profiles, with voids, and derived, mirrored and composite profiles are read. Open and centre-line profiles are not.

## Openings

Each element's openings and voiding features (`IfcRelVoidsElement`) are subtracted from its body, in the element's coordinates. The openings themselves are left out of the model unless `openingElements` is set. Booleans on very large meshes, over 4 million triangle pairs, are skipped with a warning to keep imports quick.

## Colours

1. **Item style:** the `IfcStyledItem` on the representation item, or on a boolean's first operand, with colour and transparency from its surface style.
2. **Material style:** the element's material, or failing that its type's, through `IfcMaterialDefinitionRepresentation`.
3. **Default by type:** for example, light blue and see-through for windows, grey for slabs, off-white for walls.

IFC colours are taken as sRGB.

## Not supported

- Texture maps (`IfcSurfaceStyleWithTextures`, `IfcIndexedTextureMap`).
- Lighting, reflectance and specular style attributes.
- Grids, annotations and 2D drawings.
- IfcSpace boundaries.
- Geographic reference (`IfcMapConversion`): models stay in their engineering coordinates.
- Files with several data sections referencing each other.
