import type { AmmoSpec, ArmorSpec, AttachmentSlot, Caliber, FireMode, ItemDef, ItemKind, WeaponClass, WeaponSpec } from './types';

/** Localized strings contributed by this content module (merged into the central ko table). */
export const itemStrings: Record<string, string> = {};

function def(d: Omit<ItemDef, 'nameKey' | 'descKey'> & { name: string; desc: string }): ItemDef {
  const { name, desc, ...rest } = d;
  const nameKey = `${d.id}.name`;
  const descKey = `${d.id}.desc`;
  itemStrings[nameKey] = name;
  itemStrings[descKey] = desc;
  return { ...rest, nameKey, descKey };
}

const P9_PRICE = 1000;

interface WeaponRow {
  key: string;
  name: string;
  desc: string;
  cls: WeaponClass;
  cal: Caliber;
  dmg: number;
  pellets?: number;
  rpm: number;
  cap: number;
  reload: [number, number] | null;
  range: [number, number];
  modes: FireMode[];
  spread: number;
  recoil: number;
  stab: number;
  adsMove: number;
  kg: number;
  priceMult: number;
  family: string | null;
  size: [number, number];
  slots: AttachmentSlot[];
  tags: string[];
}

const CLASS_VELOCITY: Record<WeaponClass, number> = { pistol: 100, smg: 120, carbine: 180, ar: 180, lmg: 180, dmr: 220, bolt: 260, shotgun: 90 };
const CLASS_BLOOM: Record<WeaponClass, number> = { smg: 0.1, carbine: 0.16, ar: 0.16, lmg: 0.2, pistol: 0.12, dmr: 0.12, bolt: 0.12, shotgun: 0.12 };
const CLASS_NOISE: Record<WeaponClass, number> = { pistol: 30, smg: 40, carbine: 60, ar: 60, shotgun: 65, lmg: 65, dmr: 70, bolt: 70 };
const CLASS_MINFACTOR: Record<WeaponClass, number> = { carbine: 0.5, ar: 0.5, dmr: 0.5, bolt: 0.5, lmg: 0.5, pistol: 0.4, smg: 0.4, shotgun: 0.15 };
const CLASS_MUZZLE: Record<WeaponClass, number> = { pistol: 0.55, smg: 0.7, carbine: 0.85, ar: 0.95, shotgun: 0.95, dmr: 1.1, bolt: 1.15, lmg: 1.05 };
const CLASS_EQUIP: Record<WeaponClass, number> = { pistol: 0.35, smg: 0.5, carbine: 0.55, ar: 0.6, shotgun: 0.6, dmr: 0.7, bolt: 0.7, lmg: 0.9 };

const WEAPON_ROWS: WeaponRow[] = [
  { key: 'p9', name: 'P9 경량 권총', desc: '가볍고 저렴한 9mm 보조 권총. 탄이 싸고 다루기 쉽다.', cls: 'pistol', cal: '9', dmg: 24, rpm: 360, cap: 15, reload: [1.4, 1.8], range: [9, 20], modes: ['semi'], spread: 0.8, recoil: 1.0, stab: 0.12, adsMove: 0.95, kg: 1.0, priceMult: 1.0, family: 'p9', size: [2, 2], slots: ['muzzle'], tags: ['pistol', 'sidearm'] },
  { key: 'h45', name: 'H45 대구경 권총', desc: '한 발 한 발이 묵직한 .45 권총. 반동이 크다.', cls: 'pistol', cal: '45', dmg: 42, rpm: 220, cap: 8, reload: [1.8, 2.2], range: [10, 24], modes: ['semi'], spread: 0.7, recoil: 2.0, stab: 0.16, adsMove: 0.93, kg: 1.4, priceMult: 1.4, family: 'h45', size: [2, 2], slots: ['muzzle'], tags: ['pistol', 'sidearm'] },
  { key: 'sm9', name: 'SM9 속사 기관단총', desc: '분당 900발의 9mm 기관단총. 근거리에서 탄을 쏟아붓는다.', cls: 'smg', cal: '9', dmg: 18, rpm: 900, cap: 30, reload: [1.7, 2.2], range: [9, 20], modes: ['auto', 'semi'], spread: 0.7, recoil: 0.55, stab: 0.16, adsMove: 0.9, kg: 2.0, priceMult: 2.2, family: 'sm9', size: [3, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['smg', 'automatic'] },
  { key: 'sm45', name: 'SM45 중량 기관단총', desc: '위력과 연사 사이를 절충한 .45 기관단총.', cls: 'smg', cal: '45', dmg: 26, rpm: 600, cap: 25, reload: [2.0, 2.5], range: [10, 22], modes: ['auto', 'semi'], spread: 0.85, recoil: 0.9, stab: 0.18, adsMove: 0.88, kg: 2.5, priceMult: 2.6, family: 'sm45', size: [3, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['smg', 'automatic'] },
  { key: 'c556', name: 'C556 경량 카빈', desc: '짧고 가벼운 5.56 카빈. 움직이며 싸우기 좋다.', cls: 'carbine', cal: '556', dmg: 26, rpm: 650, cap: 20, reload: [1.8, 2.3], range: [14, 28], modes: ['auto', 'semi'], spread: 0.55, recoil: 0.75, stab: 0.18, adsMove: 0.9, kg: 2.4, priceMult: 2.8, family: 'c556', size: [4, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['rifle', 'carbine', 'automatic'] },
  { key: 'ar556', name: 'AR556 표준 돌격소총', desc: '어느 거리에서도 무난한 5.56 돌격소총.', cls: 'ar', cal: '556', dmg: 30, rpm: 720, cap: 30, reload: [2.2, 2.7], range: [18, 38], modes: ['auto', 'semi'], spread: 0.45, recoil: 1.0, stab: 0.22, adsMove: 0.83, kg: 3.2, priceMult: 3.8, family: 'ar556', size: [4, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['rifle', 'assault', 'automatic'] },
  { key: 'ar762', name: 'AR762 강습 돌격소총', desc: '강력한 7.62R 탄을 쓰는 돌격소총. 반동을 다스려야 한다.', cls: 'ar', cal: '762r', dmg: 40, rpm: 550, cap: 25, reload: [2.5, 3.0], range: [20, 40], modes: ['auto', 'semi'], spread: 0.55, recoil: 1.5, stab: 0.28, adsMove: 0.78, kg: 4.0, priceMult: 4.2, family: 'ar762', size: [4, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['rifle', 'assault', 'automatic'] },
  { key: 'sgp', name: 'SG-P 펌프 산탄총', desc: '근거리에서 산탄 8발을 한 번에 쏟아내는 튜브식 산탄총.', cls: 'shotgun', cal: '12g', dmg: 14, pellets: 8, rpm: 75, cap: 6, reload: null, range: [5, 12], modes: ['pump'], spread: 4.0, recoil: 3.0, stab: 0.25, adsMove: 0.82, kg: 3.4, priceMult: 2.0, family: null, size: [4, 2], slots: ['stock'], tags: ['shotgun'] },
  { key: 'sga', name: 'SG-A 반자동 산탄총', desc: '탄창식 반자동 산탄총. 빠른 후속 사격이 가능하다.', cls: 'shotgun', cal: '12g', dmg: 12, pellets: 8, rpm: 240, cap: 8, reload: [2.8, 3.4], range: [5, 12], modes: ['semi'], spread: 4.5, recoil: 2.7, stab: 0.3, adsMove: 0.76, kg: 4.2, priceMult: 4.5, family: 'sga', size: [4, 2], slots: ['stock'], tags: ['shotgun'] },
  { key: 'dmr', name: 'DMR 지정사수소총', desc: '정밀한 7.62D 반자동 소총. 먼 거리의 머리를 노린다.', cls: 'dmr', cal: '762d', dmg: 58, rpm: 300, cap: 15, reload: [2.4, 2.9], range: [28, 56], modes: ['semi'], spread: 0.18, recoil: 2.3, stab: 0.35, adsMove: 0.7, kg: 4.8, priceMult: 5.5, family: 'dmr', size: [5, 2], slots: ['muzzle', 'grip', 'stock'], tags: ['rifle', 'precision'] },
  { key: 'bolt', name: 'BOLT 볼트액션', desc: '한 발에 모든 것을 거는 7.62D 볼트액션 소총.', cls: 'bolt', cal: '762d', dmg: 82, rpm: 55, cap: 5, reload: [3.0, 3.6], range: [36, 72], modes: ['bolt'], spread: 0.08, recoil: 3.8, stab: 0.45, adsMove: 0.65, kg: 5.3, priceMult: 6.0, family: 'bolt', size: [5, 2], slots: ['muzzle', 'stock'], tags: ['rifle', 'precision'] },
  { key: 'lmg', name: 'LMG 경기관총', desc: '75발 박스 탄창의 5.56 경기관총. 지속 화력의 핵심.', cls: 'lmg', cal: '556', dmg: 28, rpm: 750, cap: 75, reload: [4.8, 5.5], range: [22, 44], modes: ['auto', 'semi'], spread: 0.8, recoil: 1.1, stab: 0.45, adsMove: 0.6, kg: 6.5, priceMult: 6.5, family: 'lmg', size: [5, 2], slots: ['grip'], tags: ['lmg', 'automatic'] },
];

export const WEAPONS: ItemDef[] = WEAPON_ROWS.map((r) => {
  const spec: WeaponSpec = {
    class: r.cls,
    caliber: r.cal,
    damage: r.dmg,
    pellets: r.pellets ?? 1,
    rpm: r.rpm,
    magazineFamily: r.family,
    capacity: r.cap,
    reloadTactical: r.reload ? r.reload[0] : 0,
    reloadEmpty: r.reload ? r.reload[1] : 0,
    effectiveRange: r.range[0],
    maxRange: r.range[1],
    minRangeFactor: CLASS_MINFACTOR[r.cls],
    modes: r.modes,
    precisionSpreadDeg: r.spread,
    recoilDeg: r.recoil,
    stabilizeSec: r.stab,
    adsMove: r.adsMove,
    muzzleVelocity: CLASS_VELOCITY[r.cls],
    bloomPerShot: CLASS_BLOOM[r.cls],
    gunshotRadius: CLASS_NOISE[r.cls],
    attachmentSlots: r.slots,
    muzzleLength: r.key === 'ar762' ? 0.95 : CLASS_MUZZLE[r.cls],
    equipTime: CLASS_EQUIP[r.cls],
    soundProfile: r.key,
  };
  if (r.reload === null) spec.tube = { open: 0.4, perRound: 0.55, close: 0.35, chamber: 0.4 };
  return def({
    id: `core.weapon.${r.key}`,
    kind: 'weapon',
    name: r.name,
    desc: r.desc,
    size: { w: r.size[0], h: r.size[1] },
    stackMax: 1,
    weightKg: r.kg,
    basePrice: Math.round(P9_PRICE * r.priceMult),
    tags: [...r.tags, `class:${r.cls}`, `cal:${r.cal}`],
    icon: `weapon:${r.key}`,
    weapon: spec,
    dismantle: r.cls === 'pistol' ? [{ itemId: 'core.mat.metal', qty: 1 }, { itemId: 'core.mat.scrap', qty: 1 }] : [{ itemId: 'core.mat.scrap', qty: 2 }, { itemId: 'core.mat.part', qty: 1 }],
  });
});

// --- Ammo ---------------------------------------------------------------------------------------------------
const CAL_NAME: Record<Caliber, string> = { '9': '9mm', '45': '.45', '556': '5.56', '762r': '7.62R', '762d': '7.62D', '12g': '12G' };
const CAL_PRICE: Record<Caliber, number> = { '9': 4, '45': 6, '556': 8, '762r': 10, '762d': 14, '12g': 8 };
const CAL_WEIGHT: Record<Caliber, number> = { '9': 0.008, '45': 0.012, '556': 0.012, '762r': 0.016, '762d': 0.018, '12g': 0.04 };

function ammoDef(cal: Caliber, variant: AmmoSpec['variant'], spec: Omit<AmmoSpec, 'caliber' | 'variant'>, price: number, label: string, desc: string): ItemDef {
  return def({
    id: `core.ammo.${cal}.${variant}`,
    kind: 'ammo',
    name: `${CAL_NAME[cal]} ${label}`,
    desc,
    size: { w: 1, h: 1 },
    stackMax: cal === '12g' ? 30 : 60,
    weightKg: 0,
    unitWeightKg: CAL_WEIGHT[cal],
    basePrice: price,
    tags: [`cal:${cal}`, `ammo:${variant}`],
    icon: `ammo:${variant}`,
    ammo: { caliber: cal, variant, ...spec },
  });
}

const STD_CALS: Caliber[] = ['9', '45', '556', '762r', '762d'];
export const AMMO: ItemDef[] = [];
for (const cal of STD_CALS) {
  const p = CAL_PRICE[cal];
  AMMO.push(ammoDef(cal, 'fmj', { fleshMult: 1.0, penetration: 30, armorDamage: 1.0, envEnergy: 20, headMult: 2.0, bleedChance: 0, tracer: 0xffe08a }, p, '일반탄(FMJ)', '가장 흔한 범용 탄. 값이 싸다.'));
  AMMO.push(ammoDef(cal, 'ap', { fleshMult: 0.9, penetration: 60, armorDamage: 1.25, envEnergy: 45, headMult: 2.0, bleedChance: 0, tracer: 0x9ad7ff }, Math.round(p * 2.8), '철갑탄(AP)', '방어구와 얇은 엄폐물을 뚫는 비싼 탄.'));
  AMMO.push(ammoDef(cal, 'hp', { fleshMult: 1.15, penetration: 10, armorDamage: 0.7, envEnergy: 5, headMult: 2.0, bleedChance: 0.25, tracer: 0xff9a7a }, Math.round(p * 1.5), '연조직탄(HP)', '무방어 표적에 강하지만 방어구에는 약하다. 출혈을 일으킬 수 있다.'));
}
// Relief-kit rounds: identical to 9mm FMJ in combat, but a separate definition so they stay worthless even after being
// loaded into (or unloaded from) any magazine — rounds inside magazines are stored by definition id only.
AMMO.push(
  def({
    id: 'core.ammo.9.relief',
    kind: 'ammo',
    name: '9mm 구호탄',
    desc: '구호 장비로 받은 9mm 탄. 일반탄과 성능이 같지만 팔거나 분해할 수 없다.',
    size: { w: 1, h: 1 },
    stackMax: 60,
    weightKg: 0,
    unitWeightKg: CAL_WEIGHT['9'],
    basePrice: CAL_PRICE['9'],
    tags: ['cal:9', 'ammo:fmj', 'relief'],
    icon: 'ammo:fmj',
    noValue: true,
    ammo: { caliber: '9', variant: 'fmj', fleshMult: 1.0, penetration: 30, armorDamage: 1.0, envEnergy: 20, headMult: 2.0, bleedChance: 0, tracer: 0xffe08a },
  }),
);
AMMO.push(ammoDef('12g', 'buck', { fleshMult: 1.0, penetration: 8, armorDamage: 1.0, envEnergy: 0, headMult: 1.35, bleedChance: 0.1, tracer: 0xffd27a }, CAL_PRICE['12g'], '벅샷', '8개의 산탄이 퍼진다. 근거리 전용.'));
AMMO.push(
  ammoDef(
    '12g',
    'slug',
    { fleshMult: 1.0, penetration: 25, armorDamage: 1.0, envEnergy: 25, headMult: 2.0, bleedChance: 0, pelletsOverride: 1, damageOverride: 68, spreadOverrideDeg: 0.6, rangeOverride: { effective: 10, max: 24, minFactor: 0.5 }, velocityMult: 1.2, tracer: 0xfff2b0 },
    12,
    '슬러그',
    '산탄총으로 쏘는 무거운 단일탄. 정밀하고 강하다.',
  ),
);

// --- Magazines ----------------------------------------------------------------------------------------------
interface MagRow {
  family: string;
  cal: Caliber;
  cap: number;
  ext?: number;
  kg: number;
  price: number;
  label: string;
}
const MAG_ROWS: MagRow[] = [
  { family: 'p9', cal: '9', cap: 15, ext: 22, kg: 0.12, price: 60, label: 'P9' },
  { family: 'h45', cal: '45', cap: 8, kg: 0.14, price: 70, label: 'H45' },
  { family: 'sm9', cal: '9', cap: 30, ext: 45, kg: 0.2, price: 110, label: 'SM9' },
  { family: 'sm45', cal: '45', cap: 25, kg: 0.22, price: 120, label: 'SM45' },
  { family: 'c556', cal: '556', cap: 20, ext: 30, kg: 0.2, price: 110, label: 'C556' },
  { family: 'ar556', cal: '556', cap: 30, ext: 45, kg: 0.25, price: 130, label: 'AR556' },
  { family: 'ar762', cal: '762r', cap: 25, ext: 37, kg: 0.3, price: 150, label: 'AR762' },
  { family: 'sga', cal: '12g', cap: 8, kg: 0.35, price: 150, label: 'SG-A' },
  { family: 'dmr', cal: '762d', cap: 15, ext: 22, kg: 0.3, price: 180, label: 'DMR' },
  { family: 'bolt', cal: '762d', cap: 5, kg: 0.15, price: 140, label: 'BOLT' },
  { family: 'lmg', cal: '556', cap: 75, kg: 0.9, price: 450, label: 'LMG' },
];

export const MAGAZINES: ItemDef[] = [];
for (const m of MAG_ROWS) {
  MAGAZINES.push(
    def({
      id: `core.mag.${m.family}`,
      kind: 'magazine',
      name: `${m.label} 탄창 (${m.cap}발)`,
      desc: `${m.label} 전용 ${CAL_NAME[m.cal]} 탄창. 최대 ${m.cap}발.`,
      size: { w: 1, h: 2 },
      stackMax: 1,
      weightKg: m.kg,
      basePrice: m.price,
      tags: [`cal:${m.cal}`, `family:${m.family}`],
      icon: `mag:${m.family}`,
      magazine: { family: m.family, caliber: m.cal, capacity: m.cap, reloadMult: 1 },
      dismantle: [{ itemId: 'core.mat.metal', qty: 1 }],
    }),
  );
  if (m.ext) {
    MAGAZINES.push(
      def({
        id: `core.mag.${m.family}_ext`,
        kind: 'magazine',
        name: `${m.label} 대용량 탄창 (${m.ext}발)`,
        desc: `용량이 1.5배인 대용량 탄창. 무겁고 장전이 20% 느리다.`,
        size: { w: 1, h: 2 },
        stackMax: 1,
        weightKg: m.kg + 0.5,
        basePrice: Math.round(m.price * 2.2),
        tags: [`cal:${m.cal}`, `family:${m.family}`, 'extended'],
        icon: `mag:${m.family}`,
        magazine: { family: m.family, caliber: m.cal, capacity: m.ext, reloadMult: 1.2 },
        dismantle: [{ itemId: 'core.mat.metal', qty: 1 }],
      }),
    );
  }
}

// --- Attachments --------------------------------------------------------------------------------------------
export const ATTACHMENTS: ItemDef[] = [
  def({ id: 'core.att.suppressor', kind: 'attachment', name: '소음기', desc: '총성이 AI에게 들리는 반경을 0.55배로 줄인다. 조준이 약간 느려진다.', size: { w: 2, h: 1 }, stackMax: 1, weightKg: 0.3, basePrice: 1400, tags: ['muzzle'], icon: 'att:suppressor', attachment: { slot: 'muzzle', noiseMult: 0.55, recoilMult: 1, adsTimeMult: 1.08, adsMoveSpreadMult: 1 }, dismantle: [{ itemId: 'core.mat.part', qty: 1 }, { itemId: 'core.mat.metal', qty: 1 }] }),
  def({ id: 'core.att.compensator', kind: 'attachment', name: '보정기', desc: '반동을 0.8배로 줄이지만 총성이 더 멀리 퍼진다.', size: { w: 1, h: 1 }, stackMax: 1, weightKg: 0.15, basePrice: 700, tags: ['muzzle'], icon: 'att:compensator', attachment: { slot: 'muzzle', noiseMult: 1.15, recoilMult: 0.8, adsTimeMult: 1, adsMoveSpreadMult: 1 }, dismantle: [{ itemId: 'core.mat.metal', qty: 1 }] }),
  def({ id: 'core.att.grip', kind: 'attachment', name: '전방 손잡이', desc: '반동 0.9배, 조준 시간 0.95배.', size: { w: 1, h: 1 }, stackMax: 1, weightKg: 0.1, basePrice: 450, tags: ['grip'], icon: 'att:grip', attachment: { slot: 'grip', noiseMult: 1, recoilMult: 0.9, adsTimeMult: 0.95, adsMoveSpreadMult: 1 }, dismantle: [{ itemId: 'core.mat.metal', qty: 1 }] }),
  def({ id: 'core.att.stock', kind: 'attachment', name: '개머리판', desc: '조준 이동 산포 0.9배. 조준 시간이 약간 늘어난다.', size: { w: 2, h: 1 }, stackMax: 1, weightKg: 0.2, basePrice: 550, tags: ['stock'], icon: 'att:stock', attachment: { slot: 'stock', noiseMult: 1, recoilMult: 1, adsTimeMult: 1.05, adsMoveSpreadMult: 0.9 }, dismantle: [{ itemId: 'core.mat.scrap', qty: 1 }] }),
];

// --- Armor --------------------------------------------------------------------------------------------------
const VEST_DUR = [60, 80, 100, 120];
const HELM_DUR = [40, 55, 70, 85];
const RATING = [20, 40, 60, 80];
const VEST_NAMES = ['천 방탄조끼', '경찰용 방탄조끼', '군용 판 조끼', '중장갑 조끼'];
const HELM_NAMES = ['작업용 안전모', '경량 헬멧', '전술 헬멧', '중헬멧'];
const VEST_KG = [2.5, 4.5, 7.0, 9.5];
const HELM_KG = [0.8, 1.2, 1.6, 2.3];
const VEST_PRICE = [900, 2000, 4200, 7800];
const HELM_PRICE = [450, 1300, 3000, 5600];

export const ARMOR: ItemDef[] = [];
for (let t = 1; t <= 4; t++) {
  const vest: ArmorSpec = { slot: 'vest', tier: t, rating: RATING[t - 1]!, maxDurability: VEST_DUR[t - 1]! };
  ARMOR.push(def({ id: `core.armor.vest${t}`, kind: 'armor', name: `${VEST_NAMES[t - 1]} (${t}등급)`, desc: `몸통만 보호한다. 방어값 ${vest.rating}, 최대 내구도 ${vest.maxDurability}.`, size: { w: 3, h: 3 }, stackMax: 1, weightKg: VEST_KG[t - 1]!, basePrice: VEST_PRICE[t - 1]!, tags: ['armor', 'vest', `tier:${t}`], icon: `vest:${t}`, armor: vest, dismantle: [{ itemId: 'core.mat.cloth', qty: 2 }, { itemId: 'core.mat.scrap', qty: 1 }] }));
  const helm: ArmorSpec = { slot: 'helmet', tier: t, rating: RATING[t - 1]!, maxDurability: HELM_DUR[t - 1]! };
  ARMOR.push(def({ id: `core.armor.helmet${t}`, kind: 'armor', name: `${HELM_NAMES[t - 1]} (${t}등급)`, desc: `머리만 보호한다. 방어값 ${helm.rating}, 최대 내구도 ${helm.maxDurability}.`, size: { w: 2, h: 2 }, stackMax: 1, weightKg: HELM_KG[t - 1]!, basePrice: HELM_PRICE[t - 1]!, tags: ['armor', 'helmet', `tier:${t}`], icon: `helmet:${t}`, armor: helm, dismantle: [{ itemId: 'core.mat.scrap', qty: 1 }, { itemId: 'core.mat.metal', qty: 1 }] }));
}

// --- Consumables, gear, materials ---------------------------------------------------------------------------
function simple(id: string, kind: ItemKind, name: string, desc: string, w: number, h: number, kg: number, price: number, stackMax = 1, tags: string[] = [], extra: Partial<ItemDef> = {}): ItemDef {
  return def({ id, kind, name, desc, size: { w, h }, stackMax, weightKg: kg, basePrice: price, tags, icon: `${kind}:${id.split('.').pop()}`, ...extra });
}

export const MEDICAL: ItemDef[] = [
  simple('core.med.bandage', 'medical', '붕대', '2초 동안 감으면 출혈을 멈춘다. 체력은 회복하지 않는다.', 1, 1, 0.05, 60, 5, ['medical'], { medical: { type: 'bandage', useTime: 2 } }),
  simple('core.med.firstaid', 'medical', '구급품', '치료 잔량 40. 4초 동안 초당 최대 10 체력을 회복한다. 중간에 멈추면 쓴 만큼만 줄어든다.', 1, 2, 0.45, 380, 1, ['medical'], { medical: { type: 'firstaid', useTime: 4, pool: 40, healPerSec: 10 } }),
  simple('core.med.painkiller', 'medical', '진통제', '2초 후 60초 동안 통증으로 인한 이동 저하를 무시한다. 체력은 회복하지 않는다.', 1, 1, 0.1, 220, 3, ['medical'], { medical: { type: 'painkiller', useTime: 2, painkillerDuration: 60 } }),
];

export const THROWABLES: ItemDef[] = [
  simple('core.throw.frag', 'throwable', '파편 수류탄', '2.8초 후 폭발. 1u 안에서 80 피해, 4u까지 감소. 엄폐물 뒤는 안전하다.', 1, 1, 0.4, 480, 3, ['throwable', 'explosive'], { throwable: { type: 'frag', fuse: 2.8, throwSpeed: 11, damage: 80, innerRadius: 1, outerRadius: 4, noiseRadius: 70 } }),
  simple('core.throw.smoke', 'throwable', '연막탄', '15초 동안 시야를 가린다. 총탄은 막지 못한다.', 1, 1, 0.35, 260, 3, ['throwable'], { throwable: { type: 'smoke', fuse: 1.2, throwSpeed: 11, smokeDuration: 15, smokeRadius: 2.6, noiseRadius: 12 } }),
  simple('core.throw.flash', 'throwable', '섬광탄', '거리·차폐·바라보는 방향에 따라 적을 잠시 무력화한다.', 1, 1, 0.3, 320, 3, ['throwable'], { throwable: { type: 'flash', fuse: 1.6, throwSpeed: 11, flashRadius: 9, noiseRadius: 60 } }),
];

export const MELEE: ItemDef[] = [
  simple('core.melee.knife', 'melee', '전투용 칼', '빠른 근접 공격. 피해 28, 0.5초, 사거리 0.8u. 출혈을 일으킬 수 있다.', 1, 2, 0.3, 300, 1, ['melee'], { melee: { damage: 28, cycle: 0.5, reach: 0.8, stamina: 8, penetration: 15, bleedChance: 0.4 }, dismantle: [{ itemId: 'core.mat.metal', qty: 1 }] }),
  simple('core.melee.crowbar', 'melee', '쇠지렛대', '묵직한 둔기. 피해 42, 0.85초, 사거리 1.0u.', 1, 3, 1.4, 400, 1, ['melee'], { melee: { damage: 42, cycle: 0.85, reach: 1.0, stamina: 14, penetration: 25, bleedChance: 0 }, dismantle: [{ itemId: 'core.mat.scrap', qty: 2 }] }),
];

export const BACKPACKS: ItemDef[] = [
  simple('core.bag.basic', 'backpack', '기본 가방', '8×6 칸의 낡은 배낭. 쓰러져도 가방 자체는 잃어버리지 않는다 (안의 물건은 사망 가방으로).', 3, 3, 0.8, 350, 1, ['backpack', 'keep_on_death'], { backpack: { w: 8, h: 6 }, dismantle: [{ itemId: 'core.mat.cloth', qty: 2 }] }),
  simple('core.bag.hiker', 'backpack', '등산 가방', '8×8 칸. 오래 걸어도 어깨가 덜 아프다.', 3, 4, 1.3, 2400, 1, ['backpack'], { backpack: { w: 8, h: 8 }, dismantle: [{ itemId: 'core.mat.cloth', qty: 3 }] }),
  simple('core.bag.military', 'backpack', '군용 배낭', '10×8 칸의 튼튼한 군용 배낭.', 4, 4, 2.0, 5200, 1, ['backpack'], { backpack: { w: 10, h: 8 }, dismantle: [{ itemId: 'core.mat.cloth', qty: 3 }, { itemId: 'core.mat.scrap', qty: 1 }] }),
];

export const ACCESSORIES: ItemDef[] = [
  simple('core.acc.nvg', 'accessory', '야간 투시경', '밤과 해질녘에 시야가 넓어진다. AI 감지 규칙은 바뀌지 않는다.', 2, 1, 0.5, 3500, 1, ['accessory', 'night'], { accessory: { nightVision: 0.6 }, dismantle: [{ itemId: 'core.mat.part', qty: 1 }, { itemId: 'core.mat.wire', qty: 1 }] }),
  simple('core.acc.feather', 'accessory', '행운의 깃털', '누군가의 오래된 부적. 상자를 조금 더 빨리 뒤진다.', 1, 1, 0.01, 900, 1, ['accessory'], { accessory: { searchSpeed: 1.1 } }),
];

export const MATERIALS: ItemDef[] = [
  simple('core.mat.scrap', 'material', '고철', '녹슨 금속 조각. 수리 키트와 건설에 쓰인다.', 1, 1, 0.5, 60, 10, ['material']),
  simple('core.mat.part', 'material', '기계 부품', '쓸 만한 톱니와 베어링. 정비공이 늘 찾는다.', 1, 1, 0.3, 200, 5, ['material']),
  simple('core.mat.cloth', 'material', '천', '깨끗한 천 조각. 붕대와 구급품의 재료.', 1, 1, 0.1, 25, 10, ['material']),
  simple('core.mat.antiseptic', 'material', '소독약', '구급품 제작에 필요하다.', 1, 1, 0.2, 110, 5, ['material']),
  simple('core.mat.metal', 'material', '금속편', '작은 금속 조각. 탄약과 투척물 제작에 쓰인다.', 1, 1, 0.2, 30, 10, ['material']),
  simple('core.mat.powder', 'material', '화약', '탄약 제작용 화약 한 봉지.', 1, 1, 0.1, 35, 10, ['material']),
  simple('core.mat.chem', 'material', '화학 재료', '연막 성분이 섞인 화학 약품.', 1, 1, 0.2, 60, 10, ['material']),
  simple('core.mat.wire', 'material', '전선', '구리 전선 뭉치.', 1, 1, 0.1, 70, 10, ['material']),
  simple('core.mat.power_unit', 'material', '전원 장치', '아직 살아 있는 산업용 전원 장치. 중계 모듈의 핵심 부품.', 2, 2, 2.5, 900, 1, ['material', 'power']),
  simple('core.mat.battery', 'material', '배터리', '반쯤 충전된 배터리.', 1, 1, 0.4, 150, 5, ['material'], { dismantle: [{ itemId: 'core.mat.chem', qty: 1 }] }),
  simple('core.mat.fuel', 'material', '연료통', '보급창 수송 트럭을 움직일 만큼의 연료.', 2, 2, 3.0, 300, 1, ['material', 'fuel']),
];

export const VALUABLES: ItemDef[] = [
  simple('core.val.spoon', 'valuable', '은수저', '누군가의 집에서 나온 은수저.', 1, 1, 0.1, 300, 5, ['valuable']),
  simple('core.val.ring', 'valuable', '금반지', '작지만 값비싼 금반지.', 1, 1, 0.02, 900, 5, ['valuable']),
  simple('core.val.watch', 'valuable', '손목시계', '아직 가는 기계식 시계.', 1, 1, 0.1, 600, 3, ['valuable']),
  simple('core.val.radio', 'valuable', '구형 라디오', '통신 담당자가 좋아할 만한 부품이 들어 있다.', 2, 2, 1.2, 700, 1, ['valuable'], { dismantle: [{ itemId: 'core.mat.wire', qty: 2 }, { itemId: 'core.mat.part', qty: 1 }] }),
  simple('core.val.lens', 'valuable', '카메라 렌즈', '흠집 없는 광학 렌즈.', 1, 1, 0.3, 1100, 3, ['valuable']),
  simple('core.val.sample', 'valuable', '의료 표본', '밀봉된 혈액 표본. 의무관이 연구에 쓴다.', 1, 1, 0.1, 800, 5, ['valuable', 'medical_sample']),
  simple('core.val.chip', 'valuable', '암호화 메모리 칩', '블랙마켓에서 비싸게 팔린다.', 1, 1, 0.01, 1800, 5, ['valuable']),
  simple('core.val.market_note', 'valuable', '암시장 좌표 쪽지', '무전 주파수와 좌표가 적힌 쪽지. 시장 단서.', 1, 1, 0.01, 250, 5, ['valuable', 'market_clue']),
];

export const QUEST_ITEMS: ItemDef[] = [
  simple('core.quest.relief_package', 'quest', '구호품 상자', '농장 창고에 남겨진 구호품. 의무관에게 가져가야 한다.', 2, 2, 2.0, 0, 1, ['quest', 'q02'], { noValue: true }),
  simple('core.quest.relay_module', 'quest', '중계 모듈', '전원 장치와 전선으로 만든 중계 모듈. 발전·통신 모듈 복구에 쓰인다.', 2, 1, 1.0, 0, 1, ['quest', 'q07'], { noValue: true }),
  simple('core.quest.cipher_module', 'quest', '암호 모듈', '시설 지휘관이 지니고 있던 암호 모듈. 끊긴 신호의 열쇠.', 2, 2, 1.5, 0, 1, ['quest', 'q08'], { noValue: true }),
];

export const KEY_ITEMS: ItemDef[] = [
  simple('core.keyitem.farm_backroom', 'key', '농장 창고 열쇠', '농장 창고 뒷방 자물쇠에 맞는 열쇠. 거점에서 등록하면 영구 접근권이 된다.', 1, 1, 0.02, 400, 1, ['key'], { keyId: 'core.key.farm_backroom' }),
  simple('core.keyitem.pump_cage', 'key', '펌프실 철창 열쇠', '수로 펌프실 안쪽 철창을 여는 열쇠.', 1, 1, 0.02, 450, 1, ['key'], { keyId: 'core.key.pump_cage' }),
  simple('core.keyitem.cargo_office', 'key', '화물창고 사무실 열쇠', '폐쇄 화물창고 사무실 열쇠.', 1, 1, 0.02, 500, 1, ['key'], { keyId: 'core.key.cargo_office' }),
];

export const TOOLS: ItemDef[] = [
  simple('core.tool.repair_kit', 'tool', '수리 키트', '무기나 방어구의 내구도를 40 회복한다. (작업대 개선 시 50)', 1, 2, 0.6, 420, 1, ['tool', 'repair'], { dismantle: [{ itemId: 'core.mat.scrap', qty: 1 }] }),
];

export const ALL_ITEMS: ItemDef[] = [
  ...WEAPONS,
  ...AMMO,
  ...MAGAZINES,
  ...ATTACHMENTS,
  ...ARMOR,
  ...MEDICAL,
  ...THROWABLES,
  ...MELEE,
  ...BACKPACKS,
  ...ACCESSORIES,
  ...MATERIALS,
  ...VALUABLES,
  ...QUEST_ITEMS,
  ...KEY_ITEMS,
  ...TOOLS,
];
