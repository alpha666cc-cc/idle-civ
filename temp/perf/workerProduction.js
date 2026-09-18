"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerProduction = void 0;
const attributes_1 = require("./attributes");
const expNumber_1 = require("./expNumber");
class WorkerProduction extends attributes_1.AttributeDefinition {
    constructor(key, label, workers = expNumber_1.ExpNumber.ZERO, productionPerWorker = 1, autoClicksPerSecond = 0, productionPerClick = 1) {
        super(key, label, "amount", undefined, productionPerWorker);
        this.workers = workers;
        this.autoClicksPerSecond = autoClicksPerSecond;
        this.productionPerClick = productionPerClick;
    }
    assignWorker() {
        return new WorkerProduction(this.key, this.label, this.workers.add(expNumber_1.ExpNumber.ONE), this.productionPerWorker, this.autoClicksPerSecond, this.productionPerClick);
    }
    unassignWorker() {
        return new WorkerProduction(this.key, this.label, expNumber_1.ExpNumber.max(expNumber_1.ExpNumber.ZERO, this.workers.sub(expNumber_1.ExpNumber.ONE)), this.productionPerWorker, this.autoClicksPerSecond, this.productionPerClick);
    }
    get workerProduction() {
        return this.workers.mul(expNumber_1.ExpNumber.fromNumber(this.productionPerWorker));
    }
    get autoClickProduction() {
        return expNumber_1.ExpNumber.fromNumber(this.autoClicksPerSecond * this.productionPerClick);
    }
    get totalProduction() {
        return this.workerProduction.add(this.autoClickProduction);
    }
}
exports.WorkerProduction = WorkerProduction;
