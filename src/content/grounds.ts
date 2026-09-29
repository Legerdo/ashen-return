import type { GroundDef } from './mapTypes';

/** Ground tiles: movement multiplier, footstep noise multiplier and footstep material. TUNABLE. */
export const GROUNDS: GroundDef[] = [
  { id: 'grass', moveMult: 1, noiseMult: 0.9, footstep: 'grass', color: 0x4f6b3a },
  { id: 'grass_dry', moveMult: 1, noiseMult: 1.0, footstep: 'grass', color: 0x6b6b3e },
  { id: 'dirt', moveMult: 1, noiseMult: 1.0, footstep: 'dirt', color: 0x6e5a3f },
  { id: 'mud', moveMult: 0.85, noiseMult: 1.3, footstep: 'mud', color: 0x4a3b2a },
  { id: 'water', moveMult: 0.7, noiseMult: 1.6, footstep: 'water', color: 0x2f5560 },
  { id: 'asphalt', moveMult: 1, noiseMult: 1.05, footstep: 'concrete', color: 0x3c3d40 },
  { id: 'concrete', moveMult: 1, noiseMult: 1.1, footstep: 'concrete', color: 0x6a6a66 },
  { id: 'wood_floor', moveMult: 1, noiseMult: 1.15, footstep: 'wood', color: 0x7a5a3a },
  { id: 'gravel', moveMult: 0.95, noiseMult: 1.25, footstep: 'gravel', color: 0x77736a },
  { id: 'rail', moveMult: 0.92, noiseMult: 1.25, footstep: 'gravel', color: 0x5d5850 },
  { id: 'forest', moveMult: 0.97, noiseMult: 0.85, footstep: 'grass', color: 0x3c4a33 },
  { id: 'tile', moveMult: 1, noiseMult: 1.1, footstep: 'concrete', color: 0x8a8f8c },
  { id: 'metal', moveMult: 1, noiseMult: 1.3, footstep: 'metal', color: 0x5a6068 },
  { id: 'field', moveMult: 0.95, noiseMult: 0.95, footstep: 'dirt', color: 0x5e5634 },
  { id: 'snow', moveMult: 0.92, noiseMult: 0.8, footstep: 'snow', color: 0xb9c3c6 },
];
