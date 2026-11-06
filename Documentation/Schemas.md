# Schema versions and how each is read

## Detection

The schema comes from the file header's `FILE_SCHEMA`. Exact identifiers are matched first:

| Identifiers | Read as | Family |
|---|---|---|
| `IFC2X3`, `IFC2X3_TC1`, `IFC2X3_FINAL` | IFC2X3 | IFC2X3 |
| `IFC2X4`, `IFC2X4_RC1` to `_RC4` | IFC4 (IFC 2x4 was renamed IFC4 on release) | IFC4 |
| `IFC4`, `IFC4_ADD1`, `IFC4_ADD2`, `IFC4_ADD2_TC1` | IFC4 | IFC4 |
| `IFC4X1` | IFC4X1 | IFC4 |
| `IFC4X2` | IFC4X2 | IFC4 |
| `IFC4X3`, `IFC4X3_RC1` to `_RC4`, `IFC4X3_ADD1`, `IFC4X3_ADD2`, `IFC4X3_TC1` | IFC4X3 | IFC4 |

An identifier that isn't listed but starts like one of these, such as a future `IFC4X3_ADD3`, is read as that version, `schema.guessed` is true, and a warning says so. Anything else, including IFC2X2 and older, throws `UnsupportedSchemaError`.

Note that every IFC4 addendum writes plain `IFC4` in its header. So differences between IFC4 releases are told apart by the data itself, as described below.

## What differs between versions, and how the importer handles it

The importer reads entity attributes by position. The positions it uses agree across the versions, with these exceptions:

| Difference | IFC2X3 | IFC4 line | How it is read |
|---|---|---|---|
| Styles of a styled item | `IfcStyledItem.Styles` holds `IfcPresentationStyleAssignment`s wrapping the styles | Holds the styles directly; assignments are deprecated but allowed | Both forms are unwrapped. |
| Transparency | Only on `IfcSurfaceStyleRendering` | Also on `IfcSurfaceStyleShading` | The second attribute of either is read. |
| Optional profile and solid positions | Required | `Position` of parameterised profiles and swept solids may be `$` | `$` means the identity placement. |
| Extra profile parameters | L, U, T and C shapes end with centre-of-gravity attributes | These are removed, and I-shapes gain edge radii and slopes | Only the leading dimensions, at the same positions, are used. |
| Asymmetric I-shape | A subtype of `IfcIShapeProfileDef` | A separate parameterised profile | Bottom width, depth, web, bottom flange, then top width and flange, are at the same positions in both. |
| Tessellated geometry | Not available | `IfcTriangulatedFaceSet`, `IfcPolygonalFaceSet`, `IfcCartesianPointList`, `IfcIndexedPolyCurve`, `IfcIndexedColourMap` | Read in IFC4 files. Seen in an IFC2X3 file, they're read with a warning. |
| `IfcTriangulatedFaceSet`'s fifth attribute | n/a | `NormalIndex` (index triples) in the 2013 release; `PnIndex` (point indices) from ADD2 | Told apart by its shape: a flat list is `PnIndex`, and `CoordIndex` refers to points through it. |
| Material definitions | `IfcMaterial(Name)` | `IfcMaterial(Name, Description, Category)`, plus profile and constituent sets | Name is first in both; all set kinds are followed. |
| Placements along alignments | n/a | IFC4X1 to IFC4X3: `IfcLinearPlacement` | Placed by its `CartesianPosition` where the file gives one. |
| Infrastructure entities | n/a | IFC4X3: facilities, bridges, roads, railways, alignments and their parts | Spatial elements are recognised; alignment curves and sectioned solids are not evaluated. |

Entity types that only exist in a later schema are listed in `IFC4_ONLY_TYPES` and `IFC4X3_ONLY_TYPES`. When a file uses one that its declared schema lacks, the import warns, for example: "IFCTRIANGULATEDFACESET is not part of IFC2X3 but appears 1 times; it is read anyway".

## Plane angle units

IFC2X3 files often measure angles in degrees, through a conversion-based unit. The importer reads the project's `PLANEANGLEUNIT` and converts revolution angles and circle trimming parameters with it. A revolution angle above 2π with no angle unit is taken to be degrees.
