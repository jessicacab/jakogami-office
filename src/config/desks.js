// Four double-sided cubicle banks plus three individual workstations; the vacant one is omitted.
const DESK_ISLANDS = [
  { id: 'A', name: 'Desk A', rect: [378, 138, 648, 224], cols: 3, sides: ['top', 'bottom'] },
  { id: 'B', name: 'Desk B', rect: [710, 138, 980, 224], cols: 3, sides: ['top', 'bottom'] },
  { id: 'C', name: 'Desk C', rect: [378, 316, 648, 402], cols: 3, sides: ['top', 'bottom'] },
  { id: 'D', name: 'Desk D', rect: [710, 316, 980, 402], cols: 3, sides: ['top', 'bottom'] },
  { id: 'V', name: 'Workstation', rect: [328, 164, 370, 204], cols: 1, sides: ['left'] },
  { id: 'W', name: 'Workstation', rect: [62, 34, 142, 84], cols: 1, sides: ['bottom'] },
  { id: 'X', name: 'Workstation', rect: [158, 34, 238, 84], cols: 1, sides: ['bottom'] },
  { id: 'Y', name: 'Workstation', rect: [254, 34, 334, 84], cols: 1, sides: ['bottom'] },
  { id: 'Z', name: 'Workstation', rect: [350, 34, 430, 84], cols: 1, sides: ['bottom'] },
];

const SEAT_ASSIGNMENTS = new Map([
  ['andre', 'W1'], ['jhon', 'X1'], ['pinky', 'Y1'], ['christian', 'V1'],
  ['gladys', 'A1'], ['panfilo', 'A2'], ['lloyd', 'A3'], ['matthew', 'A4'],
  ['jeff', 'B1'], ['joel', 'B2'], ['bryan', 'B3'], ['juna', 'B4'], ['michael', 'B6'],
  ['kenneth', 'C1'], ['keneth', 'C1'], ['vincent', 'C2'], ['mary jane', 'C3'], ['rica', 'C4'],
  ['morphy', 'D1'], ['mar', 'D2'], ['marc', 'D3'], ['jaylord', 'D4'], ['jihrey', 'D5'], ['alfie', 'D6'],
]);

const DESK_ISLANDS_ACTIVE = DESK_ISLANDS.filter(isl => isl.id !== 'Z').map(isl =>
  isl.id === 'A' || isl.id === 'C' ? { ...isl, activeCols: [0, 1] } : isl);

const HAZEL_DESK = 'A1';
const SEAT_GAP = 12.8;

function deskSeats() {
  return DESK_ISLANDS_ACTIVE.flatMap(isl => {
    const [x1, y1, x2, y2] = isl.rect, cw = (x2 - x1) / isl.cols;
    const activeCols = isl.activeCols ?? Array.from({ length: isl.cols }, (_, i) => i);
    return isl.sides.flatMap((side, si) => activeCols.map((c, i) => {
      const n = si * activeCols.length + i + 1;
      const px = side === 'left' ? x1 - SEAT_GAP : side === 'right' ? x2 + SEAT_GAP : x1 + (c + .5) * cw;
      const py = side === 'top' ? y1 - SEAT_GAP : side === 'bottom' ? y2 + SEAT_GAP : (y1 + y2) / 2;
      return { id: isl.id + n, island: isl, number: n, column: c, label: `${isl.name}${n}`, px, py };
    }));
  });
}
function deskSeat(id) { return deskSeats().find(s => s.id === id) ?? null; }

function assignedDesk(fullName) {
  const name = String(fullName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const match = [...SEAT_ASSIGNMENTS].find(([key]) => name === key || name.startsWith(`${key} `));
  return match?.[1] ?? null;
}

function reservedDeskIds() { return new Set(SEAT_ASSIGNMENTS.values()); }

export { DESK_ISLANDS_ACTIVE as DESK_ISLANDS, HAZEL_DESK, SEAT_GAP, assignedDesk, deskSeat, deskSeats, reservedDeskIds };
