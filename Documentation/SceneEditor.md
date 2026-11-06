# Using it in SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) opens IFC files with MeerCADIFCImport. Drop an `.ifc` file on the view, or choose one with **Open files** on the Scene tab.

`ThreeSceneService.addIfcFile` reads the file as bytes and calls `loadIfc`. It adds the resulting group to the scene, then refits the view.

- **Errors:** a schema it can't read, or a damaged file, shows a **Failure** message with the reason, and the scene is unaffected.
- **Warnings:** these go to the browser console.
- **Model in the editor:** the model comes in metres with Y up, like the other formats, and its MeshStandardMaterials can be edited and reassigned on the Materials tab like any other.
- **Ray tracing:** the model can be ray traced on the Photorealistic tab.

The import runs in the page. Typical building models of a few megabytes take under a second; very large models hold the page for longer while they load.
