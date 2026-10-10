import type { Doc, PlanSettings, StripProfile, TextItem } from './types';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 6x12 mm side-bend silicone neon, 12 V, 120 LED/m, cut every 25 mm. */
export function defaultProfile(over: Partial<StripProfile> = {}): StripProfile {
  return {
    id: uid('prof'),
    name: 'Kırmızı 6 mm',
    color: '#ff2a3a',
    jacketColor: '#f5e1e3',
    cutUnit: 25,
    ledPitch: 25 / 3,
    width: 6,
    height: 12,
    rMinWarn: 30,
    rMinHard: 12,
    capFeed: 8,
    capBlind: 4,
    cableExit: 'bottom',
    wattPerM: 8,
    voltage: 12,
    maxRunMm: 5000,
    diffusion: 0.6,
    stockMm: 10000,
    ...over,
  };
}

export const PRESET_COLORS: { name: string; color: string; jacket: string }[] = [
  { name: 'Buz mavisi', color: '#3aa0ff', jacket: '#e8f1fb' },
  { name: 'Mavi', color: '#2f6bff', jacket: '#dfe8ff' },
  { name: 'Kırmızı', color: '#ff2a3a', jacket: '#f5e1e3' },
  { name: 'Altın sarısı', color: '#ffb31a', jacket: '#f7edd9' },
  { name: 'Pembe', color: '#ff3fb4', jacket: '#f8e2f0' },
  { name: 'Mor', color: '#a64dff', jacket: '#ece2f8' },
  { name: 'Yeşil', color: '#2dff6a', jacket: '#e2f5e8' },
  { name: 'Sıcak beyaz', color: '#ffd9a0', jacket: '#f4f1ea' },
  { name: 'Soğuk beyaz', color: '#e8f4ff', jacket: '#f2f4f6' },
];

export function defaultSettings(): PlanSettings {
  return {
    clearance: 2,
    freeEndMode: 'lit',
    cornerAngle: 35,
    maxFilletDeviation: 3,
    maxPieceLength: 1500,
    joinTolerance: 1.5,
    entry: null,
    standoff: 20,
  };
}

export function defaultText(profileId: string, over: Partial<TextItem> = {}): TextItem {
  return {
    id: uid('txt'),
    kind: 'text',
    profileId,
    x: 0,
    y: 0,
    rotation: 0,
    text: 'eczane',
    fontId: 'HersheySans1',
    capHeight: 120,
    letterSpacing: 0,
    lineSpacing: 1.6,
    ...over,
  };
}

export function newDoc(): Doc {
  const p = defaultProfile();
  return {
    version: 1,
    name: 'Yeni tabela',
    profiles: [p],
    items: [defaultText(p.id)],
    settings: defaultSettings(),
  };
}
