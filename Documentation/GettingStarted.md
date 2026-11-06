# Getting started

## Install

```sh
npm install three github:VJigouline/MeerCADIFCImport
```

## Load a file into a three.js scene

```ts
import * as THREE from 'three';
import { loadIfc, UnsupportedSchemaError } from 'meercad-ifc-import';

async function open(file: File, scene: THREE.Scene) {
  try {
    const result = loadIfc(await file.arrayBuffer());
    scene.add(result.group);
    console.log(`${result.schema.release}: ${result.statistics.products} products, ${result.statistics.triangles} triangles`);
    for (const warning of result.warnings) console.warn(warning);
  } catch (error) {
    if (error instanceof UnsupportedSchemaError) alert(error.message);
    else throw error;
  }
}
```

`loadIfc` accepts the file as an `ArrayBuffer`, a `Uint8Array` or a string. It works in browsers and in Node.js.

The group is in metres with Y up, so it sits in a three.js scene like any other model. Pass `{ metres: false }` to keep the file's length unit, or `{ yUp: false }` to keep IFC's Z up.

## Find elements and their data

Each IFC object becomes a `THREE.Group` named after it, nested as in the file's spatial structure:

```
IfcProject "Project"
└─ IfcSite "Site"
   └─ IfcBuilding "House"
      └─ IfcBuildingStorey "Ground floor"
         ├─ IfcWall "Wall A"        meshes: one per colour
         └─ IfcWindow "Window 1"
```

Groups and their meshes carry the object's data in `userData.ifc`:

```ts
scene.traverse(object => {
  const ifc = object.userData.ifc;
  if (object instanceof THREE.Mesh && ifc?.type === 'IfcWall') {
    console.log(ifc.name, ifc.globalId, ifc.materials, ifc.properties['Pset_WallCommon']?.IsExternal);
  }
});
```

## Options

```ts
loadIfc(data, {
  circleSegments: 32,    // smoother curves (default 24)
  openings: true,        // subtract openings from walls and slabs (default true)
  spaces: true,          // include IfcSpace volumes (default false)
  properties: false,     // skip property sets for speed (default true)
  onProgress: f => bar.value = f,
});
```

## Without three.js

`readIfc` returns the same model as plain data: objects with mesh arrays (positions, normals, indices, colours), matrices, styles and properties. Use it to process IFC files in Node.js, or to build meshes for another engine.

```ts
import { readIfc } from 'meercad-ifc-import';

const result = readIfc(text);
for (const root of result.roots) console.log(root.type, root.name, root.children.length);
```
