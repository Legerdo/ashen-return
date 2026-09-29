import type { ContainerTypeDef } from './mapTypes';

export const containerStrings: Record<string, string> = {};

function ct(id: string, name: string, gridW: number, gridH: number, w: number, h: number, z1: number, obstacleProfile: string | null, sprite: string): ContainerTypeDef {
  const nameKey = `${id}.name`;
  containerStrings[nameKey] = name;
  return { id, nameKey, gridW, gridH, w, h, z1, obstacleProfile, sprite };
}

export const CONTAINER_TYPES: ContainerTypeDef[] = [
  ct('core.ct.crate', '나무 상자', 4, 3, 1.0, 0.8, 0.9, 'core.ob.counter', 'crate'),
  ct('core.ct.medcab', '의료 캐비닛', 3, 3, 0.9, 0.45, 1.8, 'core.ob.shelf', 'medcab'),
  ct('core.ct.toolbox', '공구함', 3, 2, 0.8, 0.5, 0.6, 'core.ob.counter', 'toolbox'),
  ct('core.ct.ammo', '탄약 상자', 3, 2, 0.9, 0.5, 0.6, 'core.ob.crate_metal', 'ammo_box'),
  ct('core.ct.weapon', '무기 상자', 5, 3, 1.6, 0.6, 0.7, 'core.ob.crate_metal', 'weapon_crate'),
  ct('core.ct.drawer', '서랍장', 3, 2, 1.0, 0.5, 1.0, 'core.ob.counter', 'drawer'),
  ct('core.ct.scrap', '고철 더미', 3, 3, 1.2, 1.0, 0.5, null, 'scrap_pile'),
  ct('core.ct.locker', '사물함', 3, 4, 0.8, 0.5, 2.0, 'core.ob.shelf', 'locker'),
  ct('core.ct.supply', '보급 상자', 5, 4, 1.4, 1.0, 1.0, 'core.ob.crate_metal', 'supply'),
  ct('core.ct.filing', '서류함', 3, 3, 0.7, 0.5, 1.3, 'core.ob.shelf', 'filing'),
  ct('core.ct.fridge', '냉장고', 3, 3, 0.9, 0.7, 1.8, 'core.ob.machine', 'fridge'),
  ct('core.ct.relief', '구호품 더미', 4, 3, 1.2, 0.8, 0.8, 'core.ob.counter', 'relief'),
  ct('core.ct.cart', '보급 수레', 5, 3, 1.2, 0.8, 0.8, null, 'cart'),
  ct('core.ct.flare_crate', '신호탄 보급 상자', 4, 3, 1.0, 0.8, 0.8, null, 'flare_crate'),
  ct('core.ct.pump_crate', '잠긴 부품 상자', 4, 3, 1.0, 0.8, 0.8, 'core.ob.crate_metal', 'pump_crate'),
];
