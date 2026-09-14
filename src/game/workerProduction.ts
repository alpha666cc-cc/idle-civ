import { ResourceDefinition, type ProductionResourceKey } from "./resources";
import { ExpNumber } from "./expNumber";

export class WorkerProduction extends ResourceDefinition {
  readonly workers: ExpNumber;
  readonly autoClicksPerSecond: number;
  readonly productionPerClick: number;

  constructor(
    key: ProductionResourceKey,
    label: string,
    workers = ExpNumber.ZERO,
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
      this.workers.add(ExpNumber.ONE),
      this.productionPerWorker,
      this.autoClicksPerSecond,
      this.productionPerClick,
    );
  }

  unassignWorker(): WorkerProduction {
    return new WorkerProduction(
      this.key as ProductionResourceKey,
      this.label,
      ExpNumber.max(ExpNumber.ZERO, this.workers.sub(ExpNumber.ONE)),
      this.productionPerWorker,
      this.autoClicksPerSecond,
      this.productionPerClick,
    );
  }

  get workerProduction(): ExpNumber {
    return this.workers.mul(ExpNumber.fromNumber(this.productionPerWorker));
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
