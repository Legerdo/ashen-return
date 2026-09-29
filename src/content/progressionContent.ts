import type { BuildingDef, ChapterDef, ContractTemplateDef, FacilityDef, KeyDef, MarketDef, NoteDef, PerkDef, QuestDef, QuestLineDef, RecipeDef, TraderDef } from './types';

export const progressionStrings: Record<string, string> = {};
const S = (key: string, text: string): string => {
  progressionStrings[key] = text;
  return key;
};

// --- Chapter / quests -------------------------------------------------------------------------------------------

export const CHAPTER: ChapterDef = {
  id: 'core.chapter.1',
  nameKey: S('chapter.1.name', 'Chapter 1 — 끊긴 신호'),
  acts: [
    { id: 0, nameKey: S('act.0.name', '프롤로그 — 돌아갈 곳'), descKey: S('act.0.desc', '물자가 바닥난 지하 대피소. 누군가는 밖으로 나가야 한다.') },
    { id: 1, nameKey: S('act.1.name', '1막 — 살아 돌아오기'), descKey: S('act.1.desc', '농장과 수로를 뒤져 의료품과 부품을 모은다. 조직적인 순찰대의 흔적이 보인다.') },
    { id: 2, nameKey: S('act.2.name', '2막 — 불을 다시 켜다'), descKey: S('act.2.desc', '작업대와 발전기를 복구해 제작과 상점, 더 깊은 지역을 연다.') },
    { id: 3, nameKey: S('act.3.name', '3막 — 끊긴 신호'), descKey: S('act.3.desc', '통신이 살아나자 격리구역 밖에서 반복되는 암호 신호가 잡힌다.') },
    { id: 4, nameKey: S('act.4.name', '4막 — 마지막 신호'), descKey: S('act.4.desc', '산업 시설의 지휘관을 쓰러뜨리고 암호 모듈을 가지고 살아 돌아온다.') },
    { id: 5, nameKey: S('act.5.name', '에필로그 — 신호의 바깥'), descKey: S('act.5.desc', '신호는 격리구역 밖을 가리킨다. 대피소는 오늘도 불을 켠다.') },
  ],
  mainLine: ['core.quest.q01_ready', 'core.quest.q02_first_haul', 'core.quest.q03_remember_road', 'core.quest.q06_scrap', 'core.quest.q07_restore_power', 'core.quest.q08_last_signal'],
  finalQuest: 'core.quest.q08_last_signal',
};

export const QUEST_LINES: QuestLineDef[] = [
  { id: 'core.line.main', nameKey: S('line.main', '주 임무'), quests: CHAPTER.mainLine },
  { id: 'core.line.training', nameKey: S('line.training', '선택 훈련'), quests: ['core.quest.q04_headshots', 'core.quest.q05_cover'] },
];

export const QUESTS: QuestDef[] = [
  {
    id: 'core.quest.q01_ready',
    lineId: 'core.line.main',
    nameKey: S('q01.name', 'Q01 돌아올 준비'),
    descKey: S('q01.desc', '정비공과 이야기한 뒤 사격장에서 장전을 한 번 해 보자. 그래야 출격을 허가해 준다.'),
    giver: 'core.npc.mechanic',
    requires: [],
    // Old saves may still hold progress for a removed 'move' (walk to the hall) objective: unknown objective ids are
    // ignored, so such a Q01 simply becomes ready once talk + reload are done.
    objectives: [
      { id: 'talk', type: 'Interact', descKey: S('q01.o.talk', '정비공과 대화'), count: 1, target: 'npc.mechanic', context: 'base' },
      { id: 'reload', type: 'CustomValidated', descKey: S('q01.o.reload', '사격장에서 장전 1회'), count: 1, target: 'range_reload' },
    ],
    rewards: { exp: 100, flags: ['deploy_allowed'], trust: [{ traderId: 'core.trader.mechanic', amount: 20 }] },
    completeDialogKey: S('q01.done', '좋아, 손은 기억하고 있군. 출격 게이트를 열어 두지. 돌아오는 게 먼저야.'),
    act: 0,
  },
  {
    id: 'core.quest.q02_first_haul',
    lineId: 'core.line.main',
    nameKey: S('q02.name', 'Q02 첫 반입'),
    descKey: S('q02.desc', '버려진 농장 창고에 구호품 상자가 남아 있다는 무전이 있었다. 찾아서 살아 돌아오고, 의무관에게 전해라.'),
    giver: 'core.npc.medic',
    requires: ['core.quest.q01_ready'],
    objectives: [
      { id: 'find', type: 'Retrieve', descKey: S('q02.o.find', '농장 창고에서 구호품 상자 획득'), count: 1, target: 'core.quest.relief_package' },
      { id: 'extract', type: 'ExtractWith', descKey: S('q02.o.extract', '구호품 상자를 가지고 탈출'), count: 1, target: 'core.quest.relief_package' },
      { id: 'deliver', type: 'Deliver', descKey: S('q02.o.deliver', '의무관에게 구호품 상자 제출'), count: 1, target: 'core.quest.relief_package', npcId: 'core.npc.medic' },
    ],
    rewards: { credits: 600, exp: 250, flags: ['medical_stock'], trust: [{ traderId: 'core.trader.medic', amount: 80 }], items: [{ itemId: 'core.med.firstaid', qty: 1 }] },
    completeDialogKey: S('q02.done', '붕대와 약이 이만큼이면 한동안 버틸 수 있어요. 의료 재고를 풀어 둘게요. 다치면 꼭 먼저 오세요.'),
    act: 1,
  },
  {
    id: 'core.quest.q03_remember_road',
    lineId: 'core.line.main',
    nameKey: S('q03.name', 'Q03 길을 기억하라'),
    descKey: S('q03.desc', '통신 담당자가 옛 지형 기록을 맞춰 보려 한다. 기울어진 급수탑과 수로의 붉은 배수 펌프를 직접 확인하고 돌아와라.'),
    giver: 'core.npc.comms',
    requires: ['core.quest.q02_first_haul'],
    objectives: [
      { id: 'tower', type: 'Visit', descKey: S('q03.o.tower', '기울어진 급수탑 방문'), count: 1, target: 'poi.water_tower' },
      { id: 'canal', type: 'Visit', descKey: S('q03.o.canal', '수로의 붉은 배수 펌프 방문'), count: 1, target: 'poi.red_pump' },
      { id: 'survive', type: 'Survive', descKey: S('q03.o.survive', '방문 후 살아서 귀환'), count: 1, mapId: 'core.map.quarantine_main' },
    ],
    rewards: { credits: 400, exp: 300, flags: ['outer_route_unlocked', 'carbine_stock'], trust: [{ traderId: 'core.trader.comms', amount: 80 }], perkPoints: 0 },
    completeDialogKey: S('q03.done', '지도와 딱 맞아. 급수탑 너머로 외곽 보급로가 이어져 있어. 정비공에게도 카빈을 들여 놓으라고 해 두지.'),
    act: 1,
  },
  {
    id: 'core.quest.q04_headshots',
    lineId: 'core.line.training',
    nameKey: S('q04.name', 'Q04 머리를 노려라 (선택)'),
    descKey: S('q04.desc', '사격장 표적의 머리를 세 번 맞혀라. 확률이 아니라 탄도가 머리를 지나야 머리다.'),
    giver: 'core.npc.mechanic',
    requires: ['core.quest.q01_ready'],
    optional: true,
    objectives: [{ id: 'head', type: 'HitPart', descKey: S('q04.o.head', '사격장 표적 머리 명중 3회'), count: 3, part: 'head', context: 'range' }],
    rewards: { exp: 120, items: [{ itemId: 'core.ammo.9.fmj', qty: 30 }] },
    completeDialogKey: S('q04.done', '그 정도면 됐어. 실전에서는 머리가 늘 엄폐물 위에 있다는 걸 잊지 마.'),
    act: 1,
  },
  {
    id: 'core.quest.q05_cover',
    lineId: 'core.line.training',
    nameKey: S('q05.name', 'Q05 몸을 숨겨라 (선택)'),
    descKey: S(
      'q05.desc',
      '사격장 남서쪽 구석, 바닥에 노란 선으로 표시된 "엄폐 훈련 구역"에 들어가면 높은 콘크리트 벽 너머의 훈련 포탑이 1.2초마다 무해한 훈련탄을 쏜다. 구역 안에 서 있기만 하면 벽이 탄을 막아 준다 — 3발이 벽에 막히면 첫 목표 완료. 그다음 사수석 바로 앞 낮은 모래주머니 뒤에 서서 표적을 쏘면 총구가 저절로 모래주머니 위로 들린다. 그 상태로 한 번 맞히면 된다.',
    ),
    giver: 'core.npc.mechanic',
    requires: ['core.quest.q01_ready'],
    optional: true,
    objectives: [
      { id: 'wall', type: 'CustomValidated', descKey: S('q05.o.wall', '엄폐 훈련 구역(노란 선) 안, 벽 뒤에 서서 포탑 훈련탄 3발을 벽으로 막기'), count: 3, target: 'range_wall_block' },
      { id: 'low', type: 'CustomValidated', descKey: S('q05.o.low', '낮은 모래주머니 바로 뒤에서 총구를 들어 표적 명중'), count: 1, target: 'range_low_cover' },
    ],
    rewards: { exp: 120, items: [{ itemId: 'core.med.bandage', qty: 2 }] },
    completeDialogKey: S('q05.done', '낮은 엄폐는 몸만 가려 줘. 머리까지 숨겨 주진 않아. 기억해 둬.'),
    act: 1,
  },
  {
    id: 'core.quest.q06_scrap',
    lineId: 'core.line.main',
    nameKey: S('q06.name', 'Q06 쓸모 있는 고철'),
    descKey: S('q06.desc', '정비공이 작업대를 제대로 세우려면 고철 4개와 기계 부품 1개가 필요하다. 가져와서 넘기고, 직접 수리 키트를 하나 만들어 봐라.'),
    giver: 'core.npc.mechanic',
    requires: ['core.quest.q03_remember_road'],
    objectives: [
      { id: 'scrap', type: 'Deliver', descKey: S('q06.o.scrap', '고철 4개 제출'), count: 4, target: 'core.mat.scrap', npcId: 'core.npc.mechanic' },
      { id: 'part', type: 'Deliver', descKey: S('q06.o.part', '기계 부품 1개 제출'), count: 1, target: 'core.mat.part', npcId: 'core.npc.mechanic' },
      { id: 'craft', type: 'Craft', descKey: S('q06.o.craft', '수리 키트 제작'), count: 1, target: 'core.recipe.repair_kit' },
    ],
    rewards: { credits: 300, exp: 400, flags: ['workbench_unlocked'], trust: [{ traderId: 'core.trader.mechanic', amount: 100 }], perkPoints: 1 },
    completeDialogKey: S('q06.done', '이제 작업대 모듈을 세울 수 있어. 건설 단말에서 자리를 잡아 줘. 첫 설치 비용은 내가 치르지.'),
    act: 2,
  },
  {
    id: 'core.quest.q07_restore_power',
    lineId: 'core.line.main',
    nameKey: S('q07.name', 'Q07 전력을 되찾다'),
    descKey: S('q07.desc', '산업 시설이나 수로 펌프실에서 살아 있는 전원 장치를 가져오고, 중계 모듈을 만든 뒤 발전·통신 모듈을 세워 발전기를 되살려라.'),
    giver: 'core.npc.comms',
    requires: ['core.quest.q06_scrap'],
    objectives: [
      { id: 'power', type: 'ExtractWith', descKey: S('q07.o.power', '전원 장치를 가지고 탈출'), count: 1, target: 'core.mat.power_unit' },
      { id: 'relay', type: 'Craft', descKey: S('q07.o.relay', '중계 모듈 제작'), count: 1, target: 'core.recipe.relay_module' },
      { id: 'build', type: 'WorldFlag', descKey: S('q07.o.build', '발전·통신 모듈 건설'), count: 1, target: 'building:core.building.power_comms' },
      { id: 'restore', type: 'WorldFlag', descKey: S('q07.o.restore', '발전기에 중계 모듈을 연결해 복구'), count: 1, target: 'generator_restored' },
    ],
    rewards: { credits: 800, exp: 700, flags: ['power_restored', 'facilities_unlocked', 'ap_stock', 'black_market_unlocked'], trust: [{ traderId: 'core.trader.comms', amount: 150 }, { traderId: 'core.trader.mechanic', amount: 60 }], perkPoints: 1 },
    completeDialogKey: S('q07.done', '불이 들어왔어! …잠깐, 무전기에 이상한 반복 신호가 잡혀. 산업 시설 통제실 쪽이야. 전력이 돌아왔으니 그 문도 열릴 거야.'),
    act: 3,
  },
  {
    id: 'core.quest.q08_last_signal',
    lineId: 'core.line.main',
    nameKey: S('q08.name', 'Q08 마지막 신호'),
    descKey: S('q08.desc', '신호의 근원은 산업 시설 통제실의 지휘관이 가진 암호 모듈이다. 지휘관을 쓰러뜨리고, 암호 모듈을 가지고 살아 돌아와 통신 담당자에게 넘겨라.'),
    giver: 'core.npc.comms',
    requires: ['core.quest.q07_restore_power'],
    objectives: [
      { id: 'kill', type: 'Kill', descKey: S('q08.o.kill', '시설 지휘관 처치'), count: 1, target: 'boss' },
      { id: 'extract', type: 'ExtractWith', descKey: S('q08.o.extract', '암호 모듈을 가지고 탈출'), count: 1, target: 'core.quest.cipher_module' },
      { id: 'deliver', type: 'Deliver', descKey: S('q08.o.deliver', '통신 담당자에게 암호 모듈 제출'), count: 1, target: 'core.quest.cipher_module', npcId: 'core.npc.comms' },
    ],
    rewards: { credits: 2000, exp: 1200, flags: ['chapter1_complete', 'free_roam'], trust: [{ traderId: 'core.trader.comms', amount: 200 }, { traderId: 'core.trader.medic', amount: 100 }, { traderId: 'core.trader.mechanic', amount: 100 }] },
    completeDialogKey: S('q08.done', '해독됐어. 좌표야… 격리구역 바깥. 누군가 아직 저 너머에서 신호를 보내고 있어. 오늘은 불을 켜 두자. 내일은 또 나가야 하니까.'),
    act: 4,
  },
];

// --- NPC traders ------------------------------------------------------------------------------------------------

export const TRADERS: TraderDef[] = [
  {
    id: 'core.trader.mechanic',
    nameKey: S('npc.mechanic.name', '정비공 부엉'),
    roleKey: S('npc.mechanic.role', '무기·탄약·부착물·수리'),
    buysKinds: ['weapon', 'ammo', 'magazine', 'attachment', 'armor', 'material', 'tool', 'melee', 'backpack', 'accessory', 'throwable', 'valuable', 'key', 'medical'],
    stock: [
      { itemId: 'core.weapon.p9', qty: 3, minTrust: 0, always: true },
      { itemId: 'core.weapon.h45', qty: 2, minTrust: 0 },
      { itemId: 'core.weapon.sgp', qty: 2, minTrust: 0 },
      { itemId: 'core.weapon.c556', qty: 2, minTrust: 0, requiresFlag: 'carbine_stock' },
      { itemId: 'core.weapon.sm9', qty: 2, minTrust: 100 },
      { itemId: 'core.weapon.ar556', qty: 2, minTrust: 100 },
      { itemId: 'core.weapon.sm45', qty: 1, minTrust: 250 },
      { itemId: 'core.weapon.sga', qty: 1, minTrust: 250 },
      { itemId: 'core.weapon.dmr', qty: 1, minTrust: 250 },
      { itemId: 'core.weapon.ar762', qty: 1, minTrust: 250 },
      { itemId: 'core.weapon.bolt', qty: 1, minTrust: 500 },
      { itemId: 'core.weapon.lmg', qty: 1, minTrust: 500 },
      { itemId: 'core.ammo.9.fmj', qty: 240, minTrust: 0, always: true },
      { itemId: 'core.ammo.45.fmj', qty: 120, minTrust: 0 },
      { itemId: 'core.ammo.556.fmj', qty: 180, minTrust: 0, always: true },
      { itemId: 'core.ammo.12g.buck', qty: 60, minTrust: 0, always: true },
      { itemId: 'core.ammo.762r.fmj', qty: 90, minTrust: 100 },
      { itemId: 'core.ammo.762d.fmj', qty: 60, minTrust: 100 },
      { itemId: 'core.ammo.12g.slug', qty: 30, minTrust: 100 },
      { itemId: 'core.ammo.9.hp', qty: 90, minTrust: 100 },
      { itemId: 'core.ammo.556.hp', qty: 90, minTrust: 250 },
      { itemId: 'core.ammo.556.ap', qty: 60, minTrust: 100, requiresFlag: 'ap_stock' },
      { itemId: 'core.ammo.762r.ap', qty: 40, minTrust: 250, requiresFlag: 'ap_stock' },
      { itemId: 'core.ammo.762d.ap', qty: 30, minTrust: 250, requiresFlag: 'ap_stock' },
      { itemId: 'core.ammo.9.ap', qty: 60, minTrust: 100, requiresFlag: 'ap_stock' },
      { itemId: 'core.mag.p9', qty: 6, minTrust: 0, always: true },
      { itemId: 'core.mag.h45', qty: 4, minTrust: 0 },
      { itemId: 'core.mag.c556', qty: 4, minTrust: 0, requiresFlag: 'carbine_stock' },
      { itemId: 'core.mag.sm9', qty: 4, minTrust: 100 },
      { itemId: 'core.mag.ar556', qty: 4, minTrust: 100 },
      { itemId: 'core.mag.sm45', qty: 3, minTrust: 250 },
      { itemId: 'core.mag.sga', qty: 3, minTrust: 250 },
      { itemId: 'core.mag.dmr', qty: 3, minTrust: 250 },
      { itemId: 'core.mag.ar762', qty: 3, minTrust: 250 },
      { itemId: 'core.mag.bolt', qty: 3, minTrust: 500 },
      { itemId: 'core.mag.lmg', qty: 2, minTrust: 500 },
      { itemId: 'core.mag.p9_ext', qty: 2, minTrust: 100, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.mag.ar556_ext', qty: 2, minTrust: 250, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.att.grip', qty: 2, minTrust: 0, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.att.stock', qty: 2, minTrust: 0, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.att.compensator', qty: 2, minTrust: 100, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.att.suppressor', qty: 1, minTrust: 250, requiresFlag: 'workbench_unlocked' },
      { itemId: 'core.armor.vest1', qty: 2, minTrust: 0 },
      { itemId: 'core.armor.helmet1', qty: 2, minTrust: 0 },
      { itemId: 'core.armor.vest2', qty: 2, minTrust: 100 },
      { itemId: 'core.armor.helmet2', qty: 2, minTrust: 100 },
      { itemId: 'core.armor.vest3', qty: 1, minTrust: 250 },
      { itemId: 'core.armor.helmet3', qty: 1, minTrust: 250 },
      { itemId: 'core.armor.vest4', qty: 1, minTrust: 500 },
      { itemId: 'core.armor.helmet4', qty: 1, minTrust: 500 },
      // TUNABLE: kits are priced above the resale value a full repair can restore (A17: no repair-for-profit loop).
      { itemId: 'core.tool.repair_kit', qty: 2, minTrust: 0, priceMult: 1.25 },
      { itemId: 'core.melee.knife', qty: 2, minTrust: 0, always: true },
      { itemId: 'core.melee.crowbar', qty: 1, minTrust: 0 },
      { itemId: 'core.bag.basic', qty: 2, minTrust: 0, always: true },
      { itemId: 'core.bag.hiker', qty: 1, minTrust: 100 },
      { itemId: 'core.bag.military', qty: 1, minTrust: 500 },
      { itemId: 'core.throw.frag', qty: 3, minTrust: 100 },
      { itemId: 'core.throw.smoke', qty: 3, minTrust: 0 },
      { itemId: 'core.throw.flash', qty: 2, minTrust: 100 },
      { itemId: 'core.mat.metal', qty: 20, minTrust: 0 },
      { itemId: 'core.mat.powder', qty: 20, minTrust: 0 },
      { itemId: 'core.mat.part', qty: 4, minTrust: 100 },
    ],
  },
  {
    id: 'core.trader.medic',
    nameKey: S('npc.medic.name', '의무관 백로'),
    roleKey: S('npc.medic.role', '의료품·치료·표본 연구'),
    buysKinds: ['medical', 'material', 'valuable'],
    stock: [
      { itemId: 'core.med.bandage', qty: 12, minTrust: 0, always: true },
      { itemId: 'core.med.firstaid', qty: 4, minTrust: 0, requiresFlag: 'medical_stock' },
      { itemId: 'core.med.painkiller', qty: 4, minTrust: 0, requiresFlag: 'medical_stock' },
      { itemId: 'core.mat.cloth', qty: 20, minTrust: 0 },
      { itemId: 'core.mat.antiseptic', qty: 8, minTrust: 100 },
      { itemId: 'core.mat.chem', qty: 10, minTrust: 100 },
    ],
  },
  {
    id: 'core.trader.comms',
    nameKey: S('npc.comms.name', '통신 담당자 까치'),
    roleKey: S('npc.comms.role', '무전·지도·열쇠 등록·전력'),
    buysKinds: ['valuable', 'material', 'key'],
    stock: [
      { itemId: 'core.mat.wire', qty: 10, minTrust: 0 },
      { itemId: 'core.mat.battery', qty: 6, minTrust: 0 },
      { itemId: 'core.acc.nvg', qty: 1, minTrust: 250 },
      { itemId: 'core.acc.feather', qty: 1, minTrust: 100 },
    ],
  },
];

export const MARKETS: MarketDef[] = [
  {
    id: 'core.market.black',
    nameKey: S('market.black.name', '블랙마켓 (무전 주파수 47.3)'),
    unlockFlag: 'black_market_unlocked',
    slots: 6,
    pool: [
      { itemId: 'core.ammo.556.ap', weight: 10, qty: [30, 60], priceMult: 1.6 },
      { itemId: 'core.ammo.762r.ap', weight: 8, qty: [20, 40], priceMult: 1.6 },
      { itemId: 'core.ammo.762d.ap', weight: 8, qty: [15, 30], priceMult: 1.6 },
      { itemId: 'core.ammo.12g.slug', weight: 8, qty: [20, 40], priceMult: 1.4 },
      { itemId: 'core.ammo.45.ap', weight: 5, qty: [20, 40], priceMult: 1.5 },
      { itemId: 'core.att.suppressor', weight: 6, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.att.compensator', weight: 5, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.mag.ar762_ext', weight: 4, qty: [1, 2], priceMult: 1.6 },
      { itemId: 'core.mag.dmr_ext', weight: 4, qty: [1, 2], priceMult: 1.6 },
      { itemId: 'core.mag.sm9_ext', weight: 4, qty: [1, 2], priceMult: 1.6 },
      { itemId: 'core.mag.c556_ext', weight: 4, qty: [1, 2], priceMult: 1.6 },
      { itemId: 'core.armor.vest4', weight: 2, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.armor.helmet4', weight: 2, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.weapon.bolt', weight: 2, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.weapon.lmg', weight: 2, qty: [1, 1], priceMult: 1.5 },
      { itemId: 'core.acc.nvg', weight: 3, qty: [1, 1], priceMult: 1.4 },
      { itemId: 'core.throw.frag', weight: 6, qty: [2, 4], priceMult: 1.4 },
      { itemId: 'core.val.chip', weight: 3, qty: [1, 2], priceMult: 1.8 },
    ],
  },
];

// --- Perks (12: 4 per line) ------------------------------------------------------------------------------------

export const PERKS: PerkDef[] = [
  { id: 'core.perk.survival.stamina_1', line: 'survival', nameKey: S('perk.stamina1', '지구력 I'), descKey: S('perk.stamina1.d', '최대 스태미나 +5'), level: 2, cost: 1, requires: [], effects: { staminaMax: 5 } },
  { id: 'core.perk.survival.stamina_2', line: 'survival', nameKey: S('perk.stamina2', '지구력 II'), descKey: S('perk.stamina2.d', '최대 스태미나 +10 (누적)'), level: 4, cost: 1, requires: ['core.perk.survival.stamina_1'], effects: { staminaMax: 10 } },
  { id: 'core.perk.survival.stamina_3', line: 'survival', nameKey: S('perk.stamina3', '지구력 III'), descKey: S('perk.stamina3.d', '최대 스태미나 +15 (누적)'), level: 6, cost: 1, requires: ['core.perk.survival.stamina_2'], effects: { staminaMax: 15 } },
  { id: 'core.perk.survival.field_medic', line: 'survival', nameKey: S('perk.medic', '야전 응급처치'), descKey: S('perk.medic.d', '치료 사용 시간 -10%, 붕대 감기 -25%, 출혈 피해 -25%'), level: 3, cost: 1, requires: [], effects: { healTimeMult: 0.9, bandageTimeMult: 0.75, bleedRateMult: 0.75 } },
  { id: 'core.perk.carry.pack_1', line: 'carry', nameKey: S('perk.pack1', '짐꾼 I'), descKey: S('perk.pack1.d', '정상 중량 +1kg'), level: 2, cost: 1, requires: [], effects: { carryKg: 1 } },
  { id: 'core.perk.carry.pack_2', line: 'carry', nameKey: S('perk.pack2', '짐꾼 II'), descKey: S('perk.pack2.d', '정상 중량 +2kg (누적)'), level: 4, cost: 1, requires: ['core.perk.carry.pack_1'], effects: { carryKg: 2 } },
  { id: 'core.perk.carry.pack_3', line: 'carry', nameKey: S('perk.pack3', '짐꾼 III'), descKey: S('perk.pack3.d', '정상 중량 +3kg (누적)'), level: 7, cost: 1, requires: ['core.perk.carry.pack_2'], effects: { carryKg: 3 } },
  { id: 'core.perk.carry.scout', line: 'carry', nameKey: S('perk.scout', '정찰병의 눈'), descKey: S('perk.scout.d', '상자 검색 속도 +15%, 지도에 발견한 상자와 탈출 조건 표시'), level: 3, cost: 1, requires: [], effects: { searchSpeedMult: 1.15, mapInfo: true } },
  { id: 'core.perk.combat.steady', line: 'combat', nameKey: S('perk.steady', '안정된 손'), descKey: S('perk.steady.d', '조준 안정화 시간 -15%'), level: 2, cost: 1, requires: [], effects: { stabilizeMult: 0.85 } },
  { id: 'core.perk.combat.gunsmith', line: 'combat', nameKey: S('perk.gunsmith', '총포공'), descKey: S('perk.gunsmith.d', '수리 키트 회복량 +20%'), level: 3, cost: 1, requires: [], effects: { repairMult: 1.2 } },
  { id: 'core.perk.combat.quick_hands', line: 'combat', nameKey: S('perk.quickhands', '빠른 손'), descKey: S('perk.quickhands.d', '장전 시간 -8%'), level: 5, cost: 1, requires: ['core.perk.combat.steady'], effects: { reloadMult: 0.92 } },
  { id: 'core.perk.combat.iron_nerves', line: 'combat', nameKey: S('perk.nerves', '강철 신경'), descKey: S('perk.nerves.d', '반동 회복 +15%, 무기 교체 시간 -15%'), level: 6, cost: 1, requires: ['core.perk.combat.steady'], effects: { recoilRecoveryMult: 1.15, swapTimeMult: 0.85 } },
];

// --- Buildings & facilities -----------------------------------------------------------------------------------

export const BUILDINGS: BuildingDef[] = [
  { id: 'core.building.supply_shelf', nameKey: S('bld.shelf', '보급 선반'), descKey: S('bld.shelf.d', '6×4 칸의 추가 보관 선반. 창고 옆에 두고 자주 쓰는 물자를 둔다.'), footprint: { w: 2, h: 1 }, cost: { credits: 800, items: [{ itemId: 'core.mat.scrap', qty: 4 }] }, unlockFlag: null, effects: ['storage:shelf'], sprite: 'shelf', solid: true },
  { id: 'core.building.workbench_module', nameKey: S('bld.workbench', '작업대 모듈'), descKey: S('bld.workbench.d', '제작 목록 전체와 수리·분해를 연다. 작업대 개선 시설의 전제.'), footprint: { w: 3, h: 2 }, cost: { credits: 1000, items: [{ itemId: 'core.mat.scrap', qty: 6 }, { itemId: 'core.mat.part', qty: 2 }] }, unlockFlag: 'workbench_unlocked', effects: ['station:workbench_full'], sprite: 'workbench', solid: true },
  { id: 'core.building.medical_module', nameKey: S('bld.medical', '의료 모듈'), descKey: S('bld.medical.d', '거점 치료와 구급품 제작을 연다. 의료대 개선 시설의 전제.'), footprint: { w: 2, h: 2 }, cost: { credits: 800, items: [{ itemId: 'core.mat.cloth', qty: 4 }, { itemId: 'core.mat.antiseptic', qty: 2 }] }, unlockFlag: 'medical_stock', effects: ['station:medical_full'], sprite: 'medical', solid: true },
  { id: 'core.building.power_comms', nameKey: S('bld.power', '발전·통신 모듈'), descKey: S('bld.power.d', '발전기와 무전 설비를 잇는 모듈. 전력 복구와 블랙마켓 주파수에 필요하다.'), footprint: { w: 3, h: 2 }, cost: { credits: 1200, items: [{ itemId: 'core.mat.wire', qty: 2 }, { itemId: 'core.mat.scrap', qty: 4 }] }, unlockFlag: 'workbench_unlocked', effects: ['power:grid'], sprite: 'power', solid: true },
];

export const FACILITIES: FacilityDef[] = [
  { id: 'core.facility.stash', nameKey: S('fac.stash', '창고 확장'), descKey: S('fac.stash.d', '창고 12×10 → 12×14'), cost: 2500, requiresBuilding: null, requiresFlag: 'facilities_unlocked', effects: { stashHeight: 14 } },
  { id: 'core.facility.workbench', nameKey: S('fac.workbench', '작업대 개선'), descKey: S('fac.workbench.d', '제작 속도 ×1.25, 수리 키트 회복량 40 → 50'), cost: 2000, requiresBuilding: 'core.building.workbench_module', requiresFlag: 'facilities_unlocked', effects: { craftSpeed: 1.25, repairAmount: 50 } },
  { id: 'core.facility.medical', nameKey: S('fac.medical', '의료대 개선'), descKey: S('fac.medical.d', '거점 기본 치료 무료, 구급품 제작 4초 → 3초'), cost: 1500, requiresBuilding: 'core.building.medical_module', requiresFlag: 'facilities_unlocked', effects: { freeHeal: 1, firstAidCraftTime: 3 } },
];

// --- Recipes (6) ---------------------------------------------------------------------------------------------

export const RECIPES: RecipeDef[] = [
  { id: 'core.recipe.bandage', nameKey: S('rc.bandage', '붕대'), station: 'medical', inputs: [{ itemId: 'core.mat.cloth', qty: 2 }], fee: 10, time: 2, output: { itemId: 'core.med.bandage', qty: 1 }, requiresFlag: null, requiresBuilding: null },
  { id: 'core.recipe.firstaid', nameKey: S('rc.firstaid', '구급품 40'), station: 'medical', inputs: [{ itemId: 'core.mat.cloth', qty: 2 }, { itemId: 'core.mat.antiseptic', qty: 1 }], fee: 30, time: 4, output: { itemId: 'core.med.firstaid', qty: 1 }, requiresFlag: 'medical_stock', requiresBuilding: 'core.building.medical_module' },
  { id: 'core.recipe.repair_kit', nameKey: S('rc.repair', '수리 키트'), station: 'workbench', inputs: [{ itemId: 'core.mat.scrap', qty: 3 }, { itemId: 'core.mat.part', qty: 1 }], fee: 30, time: 4, output: { itemId: 'core.tool.repair_kit', qty: 1 }, requiresFlag: null, requiresBuilding: null },
  { id: 'core.recipe.ammo_9', nameKey: S('rc.ammo9', '9mm 일반탄 30발'), station: 'workbench', inputs: [{ itemId: 'core.mat.metal', qty: 1 }, { itemId: 'core.mat.powder', qty: 2 }], fee: 10, time: 3, output: { itemId: 'core.ammo.9.fmj', qty: 30 }, requiresFlag: null, requiresBuilding: 'core.building.workbench_module' },
  { id: 'core.recipe.smoke', nameKey: S('rc.smoke', '연막탄'), station: 'workbench', inputs: [{ itemId: 'core.mat.metal', qty: 1 }, { itemId: 'core.mat.chem', qty: 2 }], fee: 30, time: 4, output: { itemId: 'core.throw.smoke', qty: 1 }, requiresFlag: null, requiresBuilding: 'core.building.workbench_module' },
  { id: 'core.recipe.relay_module', nameKey: S('rc.relay', '중계 모듈'), station: 'workbench', inputs: [{ itemId: 'core.mat.power_unit', qty: 1 }, { itemId: 'core.mat.wire', qty: 2 }, { itemId: 'core.mat.part', qty: 2 }], fee: 0, time: 5, output: { itemId: 'core.quest.relay_module', qty: 1 }, requiresFlag: null, requiresBuilding: 'core.building.workbench_module' },
];

// --- Contracts (6 templates) -----------------------------------------------------------------------------------

export const CONTRACTS: ContractTemplateDef[] = [
  { id: 'core.contract.supply', nameKey: S('ct.supply', '보급 요청'), descKey: S('ct.supply.d', '{npc}에게 {item} {count}개를 전달한다.'), type: 'supply', giver: 'core.npc.medic', minLevel: 1, rewardCredits: [250, 450], rewardExp: [120, 200], trust: 30 },
  { id: 'core.contract.recon', nameKey: S('ct.recon', '정찰'), descKey: S('ct.recon.d', '{map}의 {poi}를 확인하고 살아 돌아온다.'), type: 'recon', giver: 'core.npc.comms', minLevel: 1, rewardCredits: [300, 500], rewardExp: [150, 250], trust: 30 },
  { id: 'core.contract.hunt', nameKey: S('ct.hunt', '사냥'), descKey: S('ct.hunt.d', '{map}에서 {role} {count}명을 쓰러뜨린다.'), type: 'hunt', giver: 'core.npc.mechanic', minLevel: 2, rewardCredits: [350, 600], rewardExp: [180, 300], trust: 35 },
  { id: 'core.contract.precision', nameKey: S('ct.precision', '정밀 사격'), descKey: S('ct.precision.d', '{tag} 계열 무기로 적의 머리를 {count}회 맞힌다.'), type: 'precision', giver: 'core.npc.mechanic', minLevel: 2, rewardCredits: [400, 650], rewardExp: [200, 320], trust: 35 },
  { id: 'core.contract.retrieve', nameKey: S('ct.retrieve', '회수'), descKey: S('ct.retrieve.d', '{map}에서 {item}을(를) 찾아 가지고 탈출한다.'), type: 'retrieve', giver: 'core.npc.comms', minLevel: 1, rewardCredits: [300, 550], rewardExp: [150, 260], trust: 30 },
  { id: 'core.contract.support', nameKey: S('ct.support', '현장 지원'), descKey: S('ct.support.d', '{map}에서 동적 사건 "{event}"을(를) 해결하고 살아 돌아온다.'), type: 'support', giver: 'core.npc.medic', minLevel: 2, rewardCredits: [450, 700], rewardExp: [220, 350], trust: 40 },
];

// --- Notes (8) & keys (3) --------------------------------------------------------------------------------------

export const NOTES: NoteDef[] = [
  { id: 'core.note.farm_diary', titleKey: S('note.farm_diary.t', '농부의 일기'), bodyKey: S('note.farm_diary.b', '격리 선포 사흘째. 순찰대라는 사람들이 창고 열쇠를 달라고 했다. 뒷방에 남은 건 우리 가족 몫이다. 열쇠는 급수탑 아래 공구함에 숨겼다.'), mapId: 'core.map.quarantine_main', x: 14, y: 64 },
  { id: 'core.note.patrol_orders', titleKey: S('note.patrol.t', '순찰대 명령서'), bodyKey: S('note.patrol.b', '수로 구역 2인 1조 순찰. 붉은 펌프는 절대 재가동하지 말 것 — 소리가 산업 시설까지 들린다. 위반 시 지휘관에게 보고.'), mapId: 'core.map.quarantine_main', x: 58, y: 44 },
  { id: 'core.note.checkpoint_log', titleKey: S('note.checkpoint.t', '검문소 근무 일지'), bodyKey: S('note.checkpoint.b', '통행료를 내면 차단기를 올려 준다는 소문이 돌았다. 사실이다. 원칙은 이미 무너졌다.'), mapId: 'core.map.quarantine_main', x: 84, y: 62 },
  { id: 'core.note.engineer_memo', titleKey: S('note.engineer.t', '기술자 메모'), bodyKey: S('note.engineer.b', '발전기 자체는 멀쩡하다. 끊긴 건 중계부다. 전원 장치 하나와 전선, 부품 몇 개면 중계 모듈을 다시 만들 수 있다.'), mapId: 'core.map.quarantine_main', x: 72, y: 26 },
  { id: 'core.note.commander_letter', titleKey: S('note.commander.t', '지휘관의 편지'), bodyKey: S('note.commander.b', '암호 모듈은 내가 직접 지닌다. 바깥에서 오는 신호가 무엇이든, 이 구역 사람들에게 희망을 줄 수는 없다.'), mapId: 'core.map.quarantine_main', x: 80, y: 14 },
  { id: 'core.note.station_board', titleKey: S('note.station.t', '화물역 게시판'), bodyKey: S('note.station.b', '보급창 수송 트럭은 연료만 있으면 아직 움직인다. 화물창고 사무실 열쇠는 역장이 가지고 있었다.'), mapId: 'core.map.outer_supply_route', x: 14, y: 52 },
  { id: 'core.note.depot_manifest', titleKey: S('note.depot.t', '보급창 적재 목록'), bodyKey: S('note.depot.b', '철갑탄 상자 12, 소음기 4, 암호화 칩 1 — 칩은 주파수 47.3에서 거래됨. 이 목록은 태워 버릴 것.'), mapId: 'core.map.outer_supply_route', x: 42, y: 18 },
  { id: 'core.note.radio_transcript', titleKey: S('note.radio.t', '무전 기록'), bodyKey: S('note.radio.b', '…반복한다, 여기는 바깥이다. 격리구역 안의 생존자는 응답하라. 좌표는 암호로 보낸다…'), mapId: 'core.map.outer_supply_route', x: 50, y: 60 },
];

export const KEYS: KeyDef[] = [
  { id: 'core.key.farm_backroom', nameKey: S('key.farm', '농장 창고 뒷방 접근권'), itemId: 'core.keyitem.farm_backroom', doorIds: ['door.farm_backroom'], containerIds: [] },
  { id: 'core.key.pump_cage', nameKey: S('key.pump', '펌프실 철창 접근권'), itemId: 'core.keyitem.pump_cage', doorIds: ['door.pump_cage'], containerIds: [] },
  { id: 'core.key.cargo_office', nameKey: S('key.cargo', '화물창고 사무실 접근권'), itemId: 'core.keyitem.cargo_office', doorIds: ['door.cargo_office'], containerIds: [] },
];

// --- Misc strings for NPC dialogue -----------------------------------------------------------------------------
S('npc.mechanic.greet1', '총은 닦았고? 탄창은 꽉 채웠고? 그럼 됐어.');
S('npc.mechanic.greet2', '고철이든 부품이든 가져와. 여긴 뭐든 고쳐 쓰는 곳이니까.');
S('npc.medic.greet1', '다친 데는 없어요? 출혈이면 붕대부터예요.');
S('npc.medic.greet2', '표본이 쌓이면 약을 더 만들 수 있어요.');
S('npc.comms.greet1', '잡음 사이로 뭔가 들려. 계속 듣고 있어.');
S('npc.comms.greet2', '열쇠를 가져오면 등록해 둘게. 그럼 다음부턴 문이 알아서 열려.');
S('npc.mechanic.talk', '정비공과 대화');
S('npc.medic.talk', '의무관과 대화');
S('npc.comms.talk', '통신 담당자와 대화');
