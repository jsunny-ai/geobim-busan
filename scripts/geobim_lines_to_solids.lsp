; GeoBIM Civil 3D helper
; Converts selected vertical LINE entities into native cylindrical 3D solids.
;
; Usage:
;   1. APPLOAD this file in Civil 3D / AutoCAD.
;   2. Run GEOBIM_LINES_TO_SOLIDS.
;   3. Select strata LINE entities exported from GeoBIM.
;   4. Enter radius.

(vl-load-com)

(defun geobim-3dpoint (p)
  (vlax-3d-point (car p) (cadr p) (caddr p))
)

(defun geobim-layer-color (layer-name / layer)
  (if (tblsearch "LAYER" layer-name)
    (progn
      (setq layer (vla-item
                    (vla-get-Layers (vla-get-ActiveDocument (vlax-get-acad-object)))
                    layer-name))
      (vla-get-Color layer)
    )
    256
  )
)

(defun geobim-copy-solid-display (solid source layer-name / color)
  (vla-put-Layer solid layer-name)
  (setq color (vla-get-Color source))
  (if (= color 256)
    (setq color (geobim-layer-color layer-name))
  )
  (if (/= color 256)
    (vla-put-Color solid color)
    (vla-put-Color solid 256)
  )
)

(defun geobim-line-to-cylinder (line radius / doc ms p1 p2 x1 y1 z1 x2 y2 z2 height center solid layer-name)
  (setq p1 (vlax-safearray->list (vlax-variant-value (vla-get-StartPoint line))))
  (setq p2 (vlax-safearray->list (vlax-variant-value (vla-get-EndPoint line))))
  (setq x1 (car p1) y1 (cadr p1) z1 (caddr p1))
  (setq x2 (car p2) y2 (cadr p2) z2 (caddr p2))
  (if (and
        (< (abs (- x1 x2)) 0.001)
        (< (abs (- y1 y2)) 0.001)
        (> (abs (- z2 z1)) 0.001)
      )
    (progn
      (setq doc (vla-get-ActiveDocument (vlax-get-acad-object)))
      (setq ms (vla-get-ModelSpace doc))
      (setq height (abs (- z2 z1)))
      (setq center (list x1 y1 (/ (+ z1 z2) 2.0)))
      (setq solid (vla-AddCylinder ms (geobim-3dpoint center) radius height))
      (setq layer-name (vla-get-Layer line))
      (geobim-copy-solid-display solid line layer-name)
      solid
    )
    nil
  )
)

(defun c:GEOBIM_LINES_TO_SOLIDS (/ ss radius idx ent obj made skipped oldcmdecho)
  (setq radius (getreal "\nCylinder radius <1.5>: "))
  (if (not radius) (setq radius 1.5))
  (if (<= radius 0.0)
    (progn
      (princ "\nRadius must be greater than zero.")
      (princ)
    )
    (progn
      (prompt "\nSelect vertical strata LINE entities: ")
      (setq ss (ssget '((0 . "LINE"))))
      (if (not ss)
        (progn
          (princ "\nNo LINE entities selected.")
          (princ)
        )
        (progn
          (setq oldcmdecho (getvar "CMDECHO"))
          (setvar "CMDECHO" 0)
          (setq idx 0 made 0 skipped 0)
          (while (< idx (sslength ss))
            (setq ent (ssname ss idx))
            (setq obj (vlax-ename->vla-object ent))
            (if (geobim-line-to-cylinder obj radius)
              (setq made (1+ made))
              (setq skipped (1+ skipped))
            )
            (setq idx (1+ idx))
          )
          (setvar "CMDECHO" oldcmdecho)
          (princ (strcat "\nGeoBIM solids created: " (itoa made)))
          (if (> skipped 0)
            (princ (strcat " / skipped non-vertical lines: " (itoa skipped)))
          )
          (princ)
        )
      )
    )
  )
)

(princ "\nGeoBIM loaded. Run GEOBIM_LINES_TO_SOLIDS to convert vertical lines to 3D solids.")
(princ)
