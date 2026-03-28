export type ViewerGridReference = {
  units: "m";
  primaryCellSize: number;
  secondaryCellSize: number;
  primaryInstruction: string;
};

export const VIEWER_GRID_REFERENCE: ViewerGridReference = {
  units: "m",
  primaryCellSize: 1,
  secondaryCellSize: 10,
  primaryInstruction:
    "Use the visible viewer grid as the primary dimensional reference whenever it is present: 1 primary cell = 1 m x 1 m, 1 major cell = 10 m x 10 m.",
};