# API

## loadIfc(input, options?)

```ts
loadIfc(input: string | ArrayBuffer | Uint8Array, options?: IfcImportOptions & IfcThreeOptions): IfcLoadResult
```

Reads an IFC file and builds a three.js group. Returns everything `readIfc` returns, plus `group`. Throws `UnsupportedSchemaError` for schemas other than IFC2X3 and the IFC4 line, and `StepSyntaxError` for text that isn't an ISO 10303-21 file.

## readIfc(input, options?)

```ts
readIfc(input: string | ArrayBuffer | Uint8Array, options?: IfcImportOptions): IfcImportResult
```

Reads an IFC file into plain data, without three.js.

### IfcImportOptions

| Option | Default | Meaning |
|---|---|---|
| `circleSegments` | 24 | Segments for a full circle; arcs use their share. |
| `openings` | `true` | Subtract openings and voiding features (IfcRelVoidsElement) from the elements they void. |
| `spaces` | `false` | Include IfcSpace volumes. |
| `openingElements` | `false` | Include IfcOpeningElement volumes as objects of their own. |
| `creaseAngle` | 30 | Degrees. Adjacent faces closer than this are shaded smoothly; sharper edges stay sharp. |
| `properties` | `true` | Read property and quantity sets. |
| `onProgress` | none | Called with 0 to 1 as products are converted. |

### IfcImportResult

| Field | Meaning |
|---|---|
| `schema` | `{ id, family, identifier, release, guessed }`: the detected schema. See [Schemas](Schemas.md). |
| `header` | The STEP header: file name, time stamp, author, organisation, originating system, schemas. |
| `lengthUnit` | Metres per file length unit, such as 0.001 for millimetres. |
| `angleUnit` | Radians per file plane angle unit. |
| `roots` | Top-level `IfcObject`s: the project, then anything outside its spatial structure. |
| `warnings` | Messages about anything skipped or guessed, each once, with a count. |
| `statistics` | `{ entities, products, meshes, triangles, milliseconds }`. |

### IfcObject

| Field | Meaning |
|---|---|
| `expressId` | The entity's number in the file, `#123`. |
| `type` | Schema spelling of the entity type, such as `IfcWallStandardCase`. |
| `globalId`, `name`, `description`, `objectType` | The IfcRoot and IfcObject attributes. |
| `spatial` | True for projects, sites, buildings, storeys, spaces and IFC4X3 facilities. |
| `meshes` | `IfcMesh[]`, one per colour. |
| `children` | Objects it aggregates, nests or contains. |
| `properties` | `{ [setName]: { [propertyName]: value } }` for property sets and quantity sets, including the type object's sets. |
| `materials` | Names of the associated materials, through material lists, layer sets, profile sets and constituent sets. |
| `typeObject` | Name of the type object (IfcWallType and so on). |

### IfcMesh

| Field | Meaning |
|---|---|
| `data` | `{ positions, normals, indices, colors }` typed arrays. Shared between objects that reuse mapped geometry. |
| `matrix` | Column-major 4 x 4 from the mesh's coordinates to the model's, in file units. |
| `style` | `{ name, color, opacity, source }`; `color` is sRGB 0 to 1, `source` is `'style'`, `'material'` or `'default'`. |
| `vertexColors` | `data.colors` holds per-vertex RGBA from an IfcIndexedColourMap. |

## toThree(result, options?)

Builds the THREE.Group from an `IfcImportResult`.

| Option | Default | Meaning |
|---|---|---|
| `metres` | `true` | Scale to metres. |
| `yUp` | `true` | Rotate IFC's Z up to three.js's Y up. |
| `doubleSided` | `true` | Render both sides of faces. |

Materials are `MeshStandardMaterial`s with the style's colour (converted from sRGB to three.js's linear working space), roughness 0.8, and transparency when the style has any. Equal colours share one material, and shared mesh data shares one `BufferGeometry`.

## Lower-level exports

| Export | Use |
|---|---|
| `detectSchema(identifiers)` | Schema info from FILE_SCHEMA identifiers. |
| `typeInSchema(type, schemaId)` | Whether a version-specific entity type belongs to a schema. |
| `StepFile` | ISO 10303-21 reader: `header`, `get(id)`, `idsOfType(type)`, `typeOf(id)`, `typeCounts()`. Entities are parsed on first use. |
| `StepRef`, `StepEnum`, `StepTyped`, `DERIVED` | STEP attribute value classes. |
| `decodeStepString`, `stepText` | String escape decoding, and bytes to text. |
