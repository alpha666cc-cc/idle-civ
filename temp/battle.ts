export type Domain = 'ground' | 'air' | 'naval';
export type Resource = 'food'|'wood'|'stone'|'gold'|'science'|'military'|'metal';

export interface UnitDef {
  id: string; name: string; age: number;
  hp: number; power: number; armor: number; 
  range: number; speed: number; accuracy: number;
  domain: Domain;
  tags: string[];
  canHit: Domain[];
  cost: Partial<Record<Resource, number>>;
  bonusVs?: string[];
}

interface BattleUnit extends UnitDef {
  currentHp: number; team: 0|1; count: number; x: number;
}

function canAttack(attacker: BattleUnit, target: BattleUnit, distance: number): boolean {
  if (!attacker.canHit.includes(target.domain)) return false;
  if (distance > attacker.range) return false;
  if (attacker.domain === 'naval' && target.domain === 'ground' && attacker.range < 7) return false;
  if (attacker.domain === 'ground' && target.domain === 'naval' && attacker.range < 7) return false;
  if (target.domain === 'air' && attacker.range === 1) return false; // melee can't hit air
  return true;
}

export function simulateBattleWithDomains(
  armyA: {id: string, count: number}[],
  armyB: {id: string, count: number}[],
  unitsDb: Record<string, UnitDef>
) {
  const makeTeam = (army: {id:string,count:number}[], team:0|1): BattleUnit[] =>
    army.flatMap(entry => {
      const def = unitsDb[entry.id];
      return Array.from({length: entry.count}, () => ({
        ...def, currentHp: def.hp, team, count: 1, x: team===0?0:20
      }));
    });

  let teamA = makeTeam(armyA, 0);
  let teamB = makeTeam(armyB, 1);
  let all = [...teamA, ...teamB];
  let distance = 15;
  let turn = 0;

  while (teamA.some(u=>u.currentHp>0) && teamB.some(u=>u.currentHp>0) && turn < 200) {
    all.sort((a,b) => b.speed - a.speed);
    for (const attacker of all.filter(u=>u.currentHp>0)) {
      const enemies = all.filter(u=>u.team!==attacker.team && u.currentHp>0);
      const target = enemies.find(e => canAttack(attacker, e, distance));
      if (!target) { distance = Math.max(1, distance - attacker.speed*0.2); continue; }

      const hitChance = attacker.accuracy * (1 - (distance/attacker.range)*0.3);
      if (Math.random() > hitChance) continue;

      let dmg = attacker.power * (1 - target.armor);
      if (attacker.bonusVs?.some(t => target.tags.includes(t))) dmg *= 1.5;
      if (target.domain === 'air' && attacker.range === 1) dmg *= 0.3;
      if (attacker.domain === 'air' && target.domain === 'naval') dmg *= 1.2;
      if (attacker.domain === 'naval' && target.domain === 'ground') dmg *= 0.8;
      dmg *= 0.8 + Math.random()*0.4;
      target.currentHp -= dmg;
    }
    turn++;
    if (turn % 5 === 0) distance = Math.max(1, distance - 1);
  }
  return {
    winner: teamA.some(u=>u.currentHp>0) && !teamB.some(u=>u.currentHp>0) ? 'A' : 'B',
    survivorsA: teamA.filter(u=>u.currentHp>0).length,
    survivorsB: teamB.filter(u=>u.currentHp>0).length,
    turns: turn
  };
}

// WATERLOO EXAMPLE with your numbers:
// simulateBattleWithDomains(
//   [{id:'line_infantry',count:5}, {id:'dragon_ind',count:2}, {id:'cannon',count:3}], // 50k + 14k dragons + 7k artillery
//   [{id:'line_infantry',count:7}, {id:'cavalry_ind',count:1}, {id:'cannon',count:2}],
//   UNITS
// )