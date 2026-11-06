# MeerCADIFCImport

An IFC importer for [three.js](https://threejs.org/), written in TypeScript with no WebAssembly. It reads **IFC2X3** and every schema of the **IFC4 line**: the IFC2X4 drafts, IFC4 with its addenda (ADD1, ADD2, TC1), IFC4X1, IFC4X2 and IFC4X3. It detects the schema version of each file and reads it the way that version defines.

It produces meshes with the file's colours, the spatial structure (project, site, building, storey, element) and each element's attributes, materials and property sets.

```ts
import { loadIfc } from 'meercad-ifc-import';

const result = loadIfc(await file.arrayBuffer());
scene.add(result.group);             // THREE.Group, in metres, Y up
console.log(result.schema.release);  // "IFC 4.3 ADD2 (4.3.2.0)"
console.log(result.warnings);        // anything that couldn't be read
```

## What it reads

- **Schemas:** IFC2X3, IFC2X4, IFC4 (incl. ADD1, ADD2, TC1), IFC4X1, IFC4X2 and IFC4X3 (incl. ADD1, ADD2, TC1), detected from `FILE_SCHEMA`. Unknown addenda are read by their prefix, with a warning; other schemas, such as IFC2X2, are refused.
- **Geometry:**
  - Extruded, revolved and swept solids, including tapered extrusions, swept disks (pipes and bars) and curve sweeps.
  - Parameterised profiles: rectangle, circle, I, L, U, T, C, Z, hollow and trapezium. Arbitrary, derived, mirrored and composite profiles.
  - Faceted and planar advanced B-reps, shell- and face-based surface models.
  - IFC4 triangulated and polygonal face sets, with per-face colours.
  - CSG primitives and boolean results.
  - Half-space and polygonal-bounded half-space clippings.
  - Mapped items, shared between instances.
  - Openings, subtracted from the elements they void.
- **Colours:** surface styles on representation items, then the element's or its type's material style, then a default per element type.
- **Units:** SI units with prefixes, and conversion-based units (feet, inches, degrees).
- **Data:** the spatial structure from aggregation, nesting and containment; attributes, property sets, quantities, materials and type objects, in `userData.ifc`.

See [Geometry and schema support](Documentation/Support.md) for the details and the limits.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/MeerCADIFCImport
```

`three` (r160 or later) is a peer dependency. The package builds itself on install.

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [Schema versions and how each is read](Documentation/Schemas.md)
- [Geometry and schema support](Documentation/Support.md)
- [Using it in SceneEditor](Documentation/SceneEditor.md)

## Development

```sh
npm install
npm test           # vitest: unit tests and buildingSMART sample files
npm run typecheck
npm run build      # emits dist/
```

Requirements: Node.js 22 or later.

## Licence

MIT. The sample files in `tests/fixtures/buildingSMART` are (C) buildingSMART International Ltd., licensed under CC BY 4.0; see the README there.
