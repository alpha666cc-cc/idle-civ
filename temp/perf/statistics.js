"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyStatistics = exports.tickMilliseconds = void 0;
const expNumber_1 = require("./expNumber");
/** One tick is one second: the loop is a 1-second interval with no delta time. */
exports.tickMilliseconds = 1000;
const emptyStatistics = () => ({
    productionClicks: expNumber_1.ExpNumber.ZERO,
    uiClicks: expNumber_1.ExpNumber.ZERO,
    buildingsBuilt: expNumber_1.ExpNumber.ZERO,
    buildingsBuiltByKey: {},
    playTimeMs: 0,
    runTimeMs: 0,
    fastestAgeMs: {},
    fastestBattleMs: {},
    wastedResources: expNumber_1.ExpNumber.ZERO,
});
exports.emptyStatistics = emptyStatistics;
