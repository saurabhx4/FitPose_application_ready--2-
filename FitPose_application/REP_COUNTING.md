# A01-A10 Rep Counting Update

Each A01-A10 exercise now has a dedicated rep-counting state machine.

- A01 Deep Squat: knee-angle depth cycle.
- A02 Hurdle Step: per-leg normalized ankle lift + knee flexion, with return-to-floor completion.
- A03 Inline Lunge: controlled bilateral knee-depth cycle.
- A04 Side Lunge: knee-depth cycle gated by lateral stance width.
- A05 Sit to Stand: hip-height drop + knee bend, then full standing return.
- A06 Straight Leg Raise: per-leg ankle lift gated by a straight knee.
- A07 Shoulder Abduction: bilateral arm elevation cycle.
- A08 Shoulder Extension: sagittal/depth-aware arm extension rather than generic shoulder raise.
- A09 Shoulder Internal/External Rotation: requires the external -> internal -> neutral sequence.
- A10 Shoulder Scaption: bilateral diagonal arm-elevation cycle.

Counting is debounced, requires a stable pose, and will not count when the required landmarks are poorly visible.

The application passes the exercise ID into the analyzer, preventing A01-A10 from accidentally inheriting the old generic `target` aliases.
