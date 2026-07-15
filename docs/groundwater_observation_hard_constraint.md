# Groundwater Observation Hard Constraint

## Status

This document defines a permanent, design-authoritative invariant. It is not a
visual preference, interpolation option, or temporary implementation detail.

## Absolute Invariant

For every valid groundwater observation selected into an authoritative
groundwater surface:

```text
observed_head_elevation =
  borehole_collar_elevation - groundwater_depth_below_ground_level

surface(borehole_x, borehole_y) = observed_head_elevation
```

Required numeric assertion:

```text
abs(surface(borehole_x, borehole_y) - observed_head_elevation) <= 1e-6 m
```

The displayed diagnostic may round this value, but the raw value must be
retained for automated validation.

## Rules That Must Never Change

1. Groundwater is an independent hydraulic surface, not a `strata_group`.
2. A borehole observation is an immutable interpolation anchor.
3. Smoothing and regularization may change only the surface between anchors.
4. Grid density and off-grid bilinear sampling must not control whether an
   anchor is honored.
5. Terrain clipping is display-only. It must not overwrite the authoritative
   groundwater elevation.
6. Vertical exaggeration applies only to model-space rendering. Diagnostics and
   export use real-world elevation.
7. Extrapolation, confidence masks, contour generation and transparency must
   not alter anchor elevations.
8. Conflicting selected values at the same XY must cause validation failure or
   explicit user selection. Silent averaging is prohibited.
9. A surface with fewer than three distinct valid XY anchors may show markers
   or a line, but must not be presented as an authoritative area surface.
10. Exports must run the same hard-constraint diagnostic before completion.
11. Any additional trend/covariate term (e.g. terrain elevation, used to
    extend the surface past borehole coverage) must cancel out exactly at
    anchor coordinates. The exact-match branch must be evaluated before any
    trend term is applied, and must never be blended with it.

## Implementation Contract

The authoritative surface must be represented by a continuous evaluator:

```ts
elevation = evaluateGroundwaterSurface(longitude, latitude)
```

At an anchor coordinate, the evaluator returns the stored observation value
directly. Rendering grids are samples of this evaluator; they are not the
source of truth.

If a constrained mesh is generated, each observation XY must be inserted as an
explicit mesh vertex or the mesh must use an equivalent constrained
triangulation. A regular grid that merely has nearby corrected nodes is
insufficient for an authoritative rendered/exported surface.

## Required Diagnostics

Every generated surface reports:

```text
observation_count
max_abs_observation_error_m
mean_abs_observation_error_m
constraint_passed
tolerance_m
```

`constraint_passed=false` must block authoritative export and show a visible
error in the viewer.

## Required Regression Tests

- Observation exactly on a grid node.
- Observation between four grid nodes.
- Several observations within one grid cell.
- Non-flat observations with large elevation differences.
- Duplicate XY with the same value.
- Duplicate XY with conflicting values.
- Terrain clipping above an observation.
- Different vertical-exaggeration values.
- Surface regeneration after interpolation-setting changes.
- Export-time constraint validation.

## Related Files

- `sites/viewer-3d/src/lib/groundwaterSurface.ts`
- `sites/viewer-3d/src/lib/groundwaterGeometry.ts`
- `sites/viewer-3d/src/hooks/useGroundwaterModel.ts`
- `sites/viewer-3d/src/lib/terrain.ts` (optional `trendAt` input — terrain elevation trend, rule 11)
- `sites/viewer-3d/tests/groundwaterSurface.test.ts`
- `docs/stratum_contact_hard_constraint.md`
