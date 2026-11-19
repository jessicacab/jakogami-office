import { OFFICE_TZ } from '../config/office.js';
import { phaseName } from '../sim/day.js';
import { live } from '../sim/live.js';
import { sim } from '../sim/state.js';
import { $ } from './dom.js';
import { fmt, renderPerson } from './person.js';
function renderUI() {
  $('clock').textContent = fmt(sim.t);
  $('phase').innerHTML = `${new Date().toLocaleDateString('en-US', { timeZone: OFFICE_TZ, weekday: 'short', month: 'short', day: 'numeric' })} · <b class="live">Live</b><br>${phaseName(sim.t)}`;
  renderPerson();
}

export { renderUI };
