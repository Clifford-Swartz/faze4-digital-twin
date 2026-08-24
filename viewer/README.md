# FAZE4 Arm Assembly Viewer

Interactive local 3D viewer for the FAZE4 6-axis arm: the URDF kinematic chain
articulated with sliders, the ~60 print STLs placed inside it, and a staggered
explode view.

## Run

```
cd C:\Users\cliff\Desktop\Projects\ARM
python viewer\serve.py
```

Then open **http://localhost:8347/viewer/** in a browser (Chrome/Edge/Firefox).
The server must be started from this project because it serves the project root
(so `/viewer/` and `/Faze4/` STL meshes both resolve). Stop with Ctrl+C.

Everything is local — three.js r160 is vendored in `viewer/lib/`, no CDN.

## Controls

- **Mouse**: left-drag orbit, right-drag pan, wheel zoom (OrbitControls).
- **Joint sliders J1–J6**: articulate the URDF chain. The exported URDF has no
  joint limits (all `continuous`), so sliders run -180°..+180°.
- **Explode slider**: pulls each print part along its documented explode
  direction, staggered by assembly order (0 = assembled, 1 = fully exploded).
- **Reset pose**: all joints and explode back to 0.
- **Explode 0/1**: toggle between assembled and fully exploded.
- **Wireframe**: wireframe rendering of print parts.
- **Link skins**: toggle the 7 semi-transparent URDF link meshes that overlay
  the print parts (useful as a "ground truth" envelope; also the only geometry
  for regions whose print-part transforms are not yet derived, e.g. wrist).
- **Tree panel**: checkboxes show/hide whole groups or single parts; click a
  part name (or a part in the 3D view) to highlight it and read its placement
  notes and confidence. Parts whose STL fails to load are tagged `missing`.

## Data

- `viewer/data/urdf_assembly.json` — kinematic chain, joint origins/axes, link
  mesh list (converted to mm; meshes themselves authored in metres, scaled
  x1000 at load).
- `viewer/data/viewer_transforms.json` — per-print-part placements (mm, in the
  attach link's frame; `rotate_deg` is URDF-style fixed-axis XYZ, rotation
  applied before translation), explode direction/order, confidence and notes.

## Known gaps

- The wrist/gripper print parts (Wrist case/cover, Joint 6 output shaft) and a
  few forearm parts (Joint 5 output shaft/spacers/pulley, Joint 4 shaft, switch
  trigger, some cosmetic lids, rework parts) have no derived transforms yet —
  the source transform data was truncated; the link skins cover those regions.
- Parts that kinematically ride a different link than their group's attach
  link are re-parented at load (world-preserving, at zero pose) so they follow
  the correct joint: `Joint 1 output shaft`, `Shaft blocker`, `Rotating base
  wires/motor` -> `rotary_base`; `Joint 2 output shaft` -> `rotary_base`
  (stays put when J2 pitches); `Joint 4 pulley 28 teeth` -> `podlaktica`.
  These rows are marked "(rides <link>)" in the selection info. The `REPARENT`
  map in `app.js` mirrors `open_issues` inside `viewer_transforms.json`.
- Cyclo disc/eccentric phases and bolt-circle clocking are arbitrary; no belts
  or purchased hardware (motors, bearings, screws) are modelled.
