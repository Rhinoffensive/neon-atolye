import type { Vec, Bounds } from '../geom/vec';

export type { Vec, Bounds };

/** Physical description of one neon flex product (one colour). All lengths in mm. */
export interface StripProfile {
  id: string;
  name: string;
  /** emitted light colour, hex */
  color: string;
  /** silicone jacket colour when switched off, hex */
  jacketColor: string;
  /** distance between cut marks */
  cutUnit: number;
  /** LEDs in one cut unit (they sit evenly, half a pitch from each cut) */
  ledsPerUnit: number;
  /** derived: cutUnit / ledsPerUnit, kept in sync for convenience */
  ledPitch: number;
  /** the blind (unwired) end may be cut between marks; that last part segment stays dark */
  blindCutAnywhere: boolean;
  /** lit face width */
  width: number;
  /** strip height (perpendicular to the board) */
  height: number;
  /** bends tighter than this get a warning */
  rMinWarn: number;
  /** bends tighter than this are errors */
  rMinHard: number;
  /** length the feed (wired) end cap adds beyond the cut */
  capFeed: number;
  /** length the blind end cap adds beyond the cut */
  capBlind: number;
  cableExit: 'bottom' | 'end';
  wattPerM: number;
  voltage: number;
  /** longest run that may be fed from one end */
  maxRunMm: number;
  /** diffuser quality q = sigma / ledPitch (0.35 dotty .. 0.6 seamless) */
  diffusion: number;
  /** material on hand */
  stockMm: number;
}

interface ItemBase {
  id: string;
  profileId: string;
  /** position of the item origin in mm (text: baseline-left of the first line) */
  x: number;
  y: number;
  /** degrees, clockwise */
  rotation: number;
  /** items inserted together (a template) move and scale together */
  groupId?: string;
}

export interface TextItem extends ItemBase {
  kind: 'text';
  text: string;
  fontId: string;
  /** height of capital letters, mm */
  capHeight: number;
  /** extra spacing between letters, in % of cap height (may be negative) */
  letterSpacing: number;
  /** line distance as multiple of cap height */
  lineSpacing: number;
}

export interface PathItem extends ItemBase {
  kind: 'path';
  /** SVG path data in mm, relative to (x, y) */
  d: string;
  /** visible name in the layers panel */
  name: string;
}

export type Item = TextItem | PathItem;

export interface PlanSettings {
  /** min gap between strip bodies, mm */
  clearance: number;
  /** 'lit': free ends are extended so the LIGHT ends where drawn; 'physical': the cap tip ends where drawn */
  freeEndMode: 'lit' | 'physical';
  /** a localized turn larger than this (deg, within ~2 strip widths) is treated as a corner */
  cornerAngle: number;
  /** max distance the rounded corner may move away from the drawn corner, mm */
  maxFilletDeviation: number;
  /** longest piece we want to handle in one go, mm */
  maxPieceLength: number;
  /** stroke endpoints closer than this are joined, mm */
  joinTolerance: number;
  /** where the power cable comes in (mm); null = below the bottom centre */
  entry: Vec | null;
  /** distance between sign plane and wall (simulation + light spread), mm */
  standoff: number;
}

export interface Doc {
  version: 1;
  name: string;
  profiles: StripProfile[];
  items: Item[];
  settings: PlanSettings;
}

/** A design centreline in world mm, produced from items before planning. */
export interface DesignStroke {
  id: string;
  itemId: string;
  profileId: string;
  pts: Vec[];
  closed: boolean;
}

// ---------------------------------------------------------------- plan output

export type EndKind = 'free' | 'corner' | 'cross' | 'abut' | 'seam' | 'split';

export interface BendStep {
  kind: 'line' | 'arc';
  /** position along the strip measured from the feed-end cut (mm). May be negative inside the cap. */
  sStrip: number;
  length: number;
  /** arc only */
  dir?: 'L' | 'R';
  angleDeg?: number;
  radius?: number;
  /** cut mark index (0 = feed-end cut) and offset after it, for the instruction text */
  mark: number;
  markOffset: number;
  warning?: string;
}

export interface Piece {
  id: string;
  /** 1-based number printed on the template */
  no: number;
  profileId: string;
  strokeId: string;
  itemId: string;
  /** physical footprint centreline, feed end first, cap tips included */
  pts: Vec[];
  length: number;
  /** whole cut units that light up */
  units: number;
  /** strip between the feed cut and the blind cut (>= units * cutUnit) */
  stripLength: number;
  /** cut units taken from the roll (a part unit at the blind end is used up too) */
  consumedUnits: number;
  /** unlit strip after the last whole unit (blind end cut between marks) */
  darkTail: number;
  capStart: number;
  capEnd: number;
  /** arc-length positions along pts where the light reaches ~50 % */
  litStart: number;
  litEnd: number;
  startKind: EndKind;
  endKind: EndKind;
  /** the piece is a closed letter (o, 0...) opened at a seam */
  loop: boolean;
  /** mm the free ends were moved to hit a whole number of units (+ = extended) */
  residual: number;
  bends: BendStep[];
  hole: Vec | null;
}

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  id: string;
  severity: Severity;
  code:
    | 'tight-bend'
    | 'too-close'
    | 'too-short'
    | 'bend-at-mark'
    | 'stock'
    | 'long-run'
    | 'cross'
    | 'corner-split'
    | 'seam'
    | 'empty';
  message: string;
  at?: Vec;
  pieceId?: string;
}

export interface Hole {
  id: string;
  pieceId: string;
  at: Vec;
  diameter: number;
}

export interface WireEdge {
  a: Vec;
  b: Vec;
  length: number;
  /** amps flowing through this edge */
  current: number;
}

export interface StockUse {
  profileId: string;
  usedMm: number;
  availableMm: number;
  pieces: number;
}

export interface PowerInfo {
  watts: number;
  amps: number;
  psuWatts: number;
  wireMm2: number;
  wireLength: number;
  maxDropV: number;
}

export interface SizeHint {
  /** design scale factor below which bends get too tight / pieces too short (1 = current) */
  minScale: number;
  minReason: string;
  /** design scale factor above which stock runs out */
  maxScale: number;
  maxReason: string;
}

export interface PlanResult {
  pieces: Piece[];
  holes: Hole[];
  wires: WireEdge[];
  entry: Vec;
  issues: Issue[];
  stock: StockUse[];
  power: PowerInfo;
  size: SizeHint;
  bounds: Bounds;
  /** tight-curve heat for the editor overlay: polylines with a severity */
  hotspots: { pts: Vec[]; severity: Severity; radius: number }[];
}
