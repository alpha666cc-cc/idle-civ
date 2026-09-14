import { ResourceDefinition, type ProductionResourceKey } from "./resources";
import { ExpNumber } from "./expNumber";

export class WorkerProduction extends ResourceDefinition {
  readonly workers: number;
  readonly autoClicksPerSecond: number;
  readonly productionPerClick: number;

  constructor(
    key: ProductionResourceKey,
    label: string,
    workers = 0,
    productionPerWorker = 1,
    autoClicksPerSecond = 0,
    productionPerClick = 1,
  ) {
    super(key, label, productionPerWorker);
    this.workers = workers;
    this.autoClicksPerSecond = autoClicksPerSecond;
    this.productionPerClick = productionPerClick;
  }

  assignWorker(): WorkerProduction {
    return new WorkerProduction(
      this.key as ProductionResourceKey,
      this.label,
      this.workers + 1,
      this.productionPerWorker,
      this.autoClicksPerSecond,
      this.productionPerClick,
    );
  }

  unassignWorker(): WorkerProduction {
    return new WorkerProduction(
      this.key as ProductionResourceKey,
      this.label,
      Math.max(0, this.workers - 1),
      this.productionPerWorker,
      this.autoClicksPerSecond,
      this.productionPerClick,
    );
  }

  get workerProduction(): ExpNumber {
    return ExpNumber.fromNumber(this.workers * this.productionPerWorker);
  }

  get autoClickProduction(): ExpNumber {
    return ExpNumber.fromNumber(
      this.autoClicksPerSecond * this.productionPerClick,
    );
  }

  get totalProduction(): ExpNumber {
    return this.workerProduction.add(this.autoClickProduction);
  }
}
