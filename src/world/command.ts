import type { EquipSlot } from '../content/types';
import type { AimInput } from '../combat/aim';
import type { Placement } from '../inventory/store';
import type { WeaponSlot } from './state';

/** One simulation tick worth of player intent, produced by the input layer (never by rendering). */
export interface PlayerCommand {
  moveX: number;
  moveY: number;
  sprint: boolean;
  crouchToggle: boolean;
  aim: AimInput;
  fireHeld: boolean;
  firePressed: boolean;
  adsHeld: boolean;
  reload: boolean;
  /** R held past RELOAD_HOLD_TIME (once per hold): top up the inserted magazine from loose rounds. */
  reloadHold: boolean;
  fireMode: boolean;
  interact: boolean;
  weaponSlot: WeaponSlot | null;
  quickslot: number | null;
  melee: boolean;
  throwPressed: boolean;
  /** Dodge roll toward the move input (or the aim direction when standing still). */
  dodge: boolean;
  cancel: boolean;
}

export function idleCommand(): PlayerCommand {
  return {
    moveX: 0,
    moveY: 0,
    sprint: false,
    crouchToggle: false,
    aim: { x: 0, y: 0, z: 1, actorId: null, viewDistPx: 0 },
    fireHeld: false,
    firePressed: false,
    adsHeld: false,
    reload: false,
    reloadHold: false,
    fireMode: false,
    interact: false,
    weaponSlot: null,
    quickslot: null,
    melee: false,
    throwPressed: false,
    dodge: false,
    cancel: false,
  };
}

/** Inventory / loot operations issued by the UI; applied inside the next simulation tick with validation. */
export type RaidOp =
  | { op: 'move'; itemId: string; target: Placement }
  | { op: 'equip'; itemId: string; slot: EquipSlot }
  | { op: 'unequip'; slot: EquipSlot }
  | { op: 'use'; itemId: string }
  | { op: 'drop'; itemId: string }
  | { op: 'split'; itemId: string; qty: number; target: Placement }
  | { op: 'merge'; fromId: string; toId: string }
  | { op: 'loadMag'; magId: string; ammoDefId: string }
  | { op: 'unloadMag'; magId: string }
  | { op: 'quickslot'; index: number; itemId: string | null }
  | { op: 'takeAll' }
  | { op: 'closeLoot' }
  | { op: 'readNote'; noteId: string }
  | { op: 'rangePreset'; preset: string }
  | { op: 'rangeWeapon'; defId: string }
  | { op: 'abandon' };
