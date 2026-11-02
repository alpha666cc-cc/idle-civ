import { buildingDefinitions } from './src/game/buildings.js';
import { attributeDefinitions } from './src/game/attributes.js';

const house = buildingDefinitions.find(b => b.key === 'house');
const townHall = buildingDefinitions.find(b => b.key === 'townHall');

console.log('House power:', house?.power?.toString());
console.log('Town Hall power:', townHall?.power?.toString());

const housePowerAttr = attributeDefinitions.find(a => a.key === 'housePower');
const townHallPowerAttr = attributeDefinitions.find(a => a.key === 'townHallPower');

console.log('housePower attribute exists:', !!housePowerAttr);
console.log('townHallPower attribute exists:', !!townHallPowerAttr);

if (housePowerAttr) {
  console.log('housePower attribute family:', housePowerAttr.family);
  console.log('housePower attribute description:', housePowerAttr.description);
}
