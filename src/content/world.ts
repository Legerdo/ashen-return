import type { TimePhaseDef, TravelDestinationDef, WeatherDef } from './types';

/** Weather multipliers (TUNABLE start values from spec §4). */
export const WEATHERS: WeatherDef[] = [
  { id: 'Clear', nameKey: 'weather.clear', vision: 1.0, aiVision: 1.0, sound: 1.0, ambience: 'wind' },
  { id: 'Cloudy', nameKey: 'weather.cloudy', vision: 0.95, aiVision: 0.95, sound: 1.0, ambience: 'wind' },
  { id: 'Rain', nameKey: 'weather.rain', vision: 0.85, aiVision: 0.85, sound: 0.85, ambience: 'rain' },
  { id: 'Storm', nameKey: 'weather.storm', vision: 0.7, aiVision: 0.75, sound: 0.7, ambience: 'storm' },
];

export const TIME_PHASES: TimePhaseDef[] = [
  { id: 'Day', nameKey: 'time.day', vision: 1.0, aiVision: 1.0, darkness: 0 },
  { id: 'Dusk', nameKey: 'time.dusk', vision: 0.85, aiVision: 0.85, darkness: 0.38 },
  { id: 'Night', nameKey: 'time.night', vision: 0.6, aiVision: 0.6, darkness: 0.72 },
];

export const DESTINATIONS: TravelDestinationDef[] = [
  {
    id: 'core.dest.quarantine_main',
    mapId: 'core.map.quarantine_main',
    nameKey: 'map.quarantine_main.name',
    descKey: 'map.quarantine_main.desc',
    unlockFlag: 'deploy_allowed',
    risk: 2,
    cost: 0,
    durationHintKey: 'dest.duration.main',
    timeWeights: { Day: 0.55, Dusk: 0.25, Night: 0.2 },
    weatherWeights: { Clear: 0.4, Cloudy: 0.3, Rain: 0.2, Storm: 0.1 },
  },
  {
    id: 'core.dest.outer_supply_route',
    mapId: 'core.map.outer_supply_route',
    nameKey: 'map.outer_supply_route.name',
    descKey: 'map.outer_supply_route.desc',
    unlockFlag: 'outer_route_unlocked',
    risk: 3,
    cost: 0,
    durationHintKey: 'dest.duration.outer',
    timeWeights: { Day: 0.35, Dusk: 0.3, Night: 0.35 },
    weatherWeights: { Clear: 0.25, Cloudy: 0.25, Rain: 0.3, Storm: 0.2 },
  },
];
