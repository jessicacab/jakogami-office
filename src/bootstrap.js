import { initCamera } from './camera/controller.js';
import { initInput } from './camera/input.js';
import { initGrid } from './nav/grid.js';
import { initLabels } from './render/labels.js';
import { initLighting } from './render/lighting.js';
import { initMovie } from './render/screens.js';
import { initDay } from './sim/day.js';
import { initState, people } from './sim/state.js';
import { applyEquipmentSnapshot, equipPerson } from './people/equipment.js';
import { initControls } from './ui/controls.js';
import { initAttendance } from './ui/attendance.js';
import { initMarketplace } from './ui/marketplace.js';
import { initJira } from './ui/jira.js';
import { initControl } from './player/control.js';
import { initPlayer, setSelfEquipment } from './player/player.js';
import { initDuel } from './ui/duel.js';
import { initPerson } from './ui/person.js';
import { initSearch } from './ui/search.js';
import { buildBake } from './world/bake.js';
import { buildDoors } from './world/doors.js';
import { buildEntrance } from './world/entrance.js';
import { buildFloor } from './world/floor.js';
import { initChannels } from './world/furniture/channels.js';
import { buildDesks } from './world/furniture/desks.js';
import { buildGame } from './world/furniture/game.js';
import { buildKitchen } from './world/furniture/kitchen.js';
import { buildLounge } from './world/furniture/lounge.js';
import { buildWalls } from './world/walls.js';

// The order below is the order the scene is assembled in. It matters: furniture registers interactables and
// the obstacle list, the nav grid reads those obstacles, and people are seated at the desks.
export function bootstrap(profile) {
  // world: building shell, then furniture, then bake static meshes into few draw calls
  buildFloor();
  buildWalls();
  buildDoors();
  buildDesks();
  buildLounge();
  buildGame();
  buildKitchen();
  buildEntrance();
  buildBake();
  initChannels(); // every TV screen, for changing channels
  initLabels();
  initMovie();
  // navigation reads the obstacles registered by the world
  initGrid();
  // simulation; your own look (your employee's) is set before anything could spawn you
  initPlayer(profile);
  initState();
  initDay();
  initLighting();
  // input and UI
  initCamera();
  initInput();
  initPerson();
  initControls();
  initSearch();
  initControl();
  initAttendance();
  // your own character (walking, duels) wears your gear too, also when you are not in the office's people
  const snapshot = entries => {
    applyEquipmentSnapshot(entries);
    const mine = entries.find(e => e.userId === profile?.id); if (mine) setSelfEquipment(mine.equipped);
  };
  initMarketplace(profile, { people, applyEquipmentSnapshot: snapshot, equipPerson, equipSelf: setSelfEquipment });
  initJira(profile);
  initDuel(profile);
}
