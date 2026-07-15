# Stratum Contact Hard Constraint

## Decision

Observed borehole contact elevations are design-authoritative hard constraints.

For each valid borehole, the modeled stratum boundary at the borehole XY location must equal:

```text
contact_elevation = modeled_surface_elevation_at_borehole - measured_depth_to_contact
```

This is not a visual preference. In design review, if a modeled stratum surface misses the borehole contact height, the result is considered a stratigraphic design error.

## Current Risk

The current 3D viewer pipeline builds stratum boundary surfaces on a regular XY grid and samples them with bilinear interpolation. Even when an exact interpolator or snap-to-data correction is used, the final grid can still miss a borehole contact when the borehole XY location does not coincide with a grid node.

This is the same limitation described by grid-based tools such as Surfer: exact interpolation at grid nodes does not guarantee that all off-node data points are honored by the gridded surface.

Therefore, the authoritative model must not rely only on gridded-node snapping.

## Required Invariant

For the authoritative smooth stratum surface:

```text
max_abs_borehole_contact_error <= floating_point_tolerance
```

Recommended tolerance:

```text
1e-6 m to 1e-4 m for model-space numeric checks
```

Display diagnostics may round this to `0.000 m`.

Voxel mode may remain approximate because of vertical discretization, but it must not be presented as the authoritative design surface unless it is changed to preserve the same contact constraint.

## Implementation Options

### Option A: Evaluate Surfaces from Continuous Constraint Functions

Keep the regular grid for rendering performance, but store the interpolation model as a continuous function:

```ts
z = boundarySurface(layer, lng, lat)
```

Use that same function for:

- borehole contact diagnostics,
- mesh vertex height generation,
- borehole column alignment,
- any exported design surface.

The function must evaluate exactly at control points. For RBF/TPS, this means no smoothing lambda for observed contacts, or a constrained solve that enforces observed contacts exactly.

Pros:

- Mathematically clean.
- Contact accuracy does not depend on grid density.
- Export and diagnostics can share the same source of truth.

Cons:

- Mesh generation needs a function evaluator instead of only grid arrays.
- Pinch-out and layer ordering constraints still need careful handling.

### Option B: Insert Borehole Locations into the Mesh as Constraint Vertices

Keep the grid but add every borehole XY location as an explicit vertex in the surface mesh. Triangulate the grid plus borehole points, and set the borehole vertex Z exactly to the observed contact elevation.

Pros:

- Directly guarantees the rendered mesh contains the contact point.
- Works even if the surrounding grid remains coarse.

Cons:

- Requires constrained triangulation or local mesh patching.
- Multiple layers and pinch-out edges become more complex.
- The grid value sampled at the borehole may still be wrong unless diagnostics evaluate the mesh or constraint vertex.

### Option C: Grid Warping / Local Correction with Exact Off-Node Constraints

After gridding, apply a correction field that is evaluated continuously rather than baked only into grid nodes:

```ts
correctedBoundary(lng, lat) =
  bilinearGridBoundary(lng, lat) + continuousResidualCorrection(lng, lat)
```

Solve residual correction weights so every borehole contact residual is exactly zero at the borehole XY location. Render vertices by evaluating `correctedBoundary`.

Pros:

- Smaller change from the current worker pipeline.
- Retains existing grids and Wendland/RBF snap concept.

Cons:

- Exactness is lost again if correction is baked back into grid nodes only.
- Needs careful monotonic clamping after correction without breaking exact contacts.

## Recommended Direction

Use Option C as the lowest-risk near-term change, then move toward Option A.

Near-term:

1. Replace `snapGridToPoints` usage for stratum contacts with a continuous correction model.
2. Keep grid arrays for fast rendering, but provide an evaluator for each corrected boundary.
3. Generate smooth mesh vertices by evaluating corrected top and bottom surfaces at vertex XY positions.
4. Clamp layer ordering with a contact-preserving pass:
   - observed contacts at boreholes are immutable anchors,
   - non-anchor grid/mesh vertices may be adjusted to maintain monotonic order.
5. Update `boundarySnapDiagnostics` to evaluate the authoritative surface function, not only bilinear grid values.
6. Fail or visibly warn when max contact error exceeds tolerance.

Medium-term:

1. Make boundary surfaces first-class objects instead of plain `number[][]` grids.
2. Add tests with off-grid boreholes to prove exact contact preservation.
3. Add export-time checks so DXF/LandXML/mesh exports cannot silently violate borehole contacts.

## Test Cases Required

At minimum, add synthetic tests for:

- a borehole exactly on a grid node,
- a borehole between four grid nodes,
- multiple boreholes in one cell with different layer contacts,
- pinch-out near a borehole,
- all layers present in all boreholes,
- missing layers in adjacent boreholes,
- terrain elevation correction plus stratum contact correction together.

Each test should assert:

```text
abs(surface(layer, borehole.xy) - expected_contact_elevation) <= tolerance
```

and also assert layer monotonicity:

```text
surface >= soil_bottom >= weathered_bottom >= soft_bottom >= normal_bottom >= hard_bottom >= model_bottom
```
