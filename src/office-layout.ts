export const MAX_TEAMMATES = 8;
export const MAX_DETAILED_OFFICES = 2;

// One project district: the local office at its center, eight surrounding lots.
const lots = [[50,0],[-50,0],[0,-50],[50,-50],[-50,-50],[0,50],[50,50],[-50,50]];
export function officePosition(index: number) {
  const lot = lots[index];
  if (!Number.isInteger(index) || !lot) throw new Error('Project districts support eight teammate offices.');
  return {x:lot[0], z:lot[1]};
}
