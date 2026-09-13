export abstract class GameObject {
  readonly id: string;
  readonly description: string;
  seen:boolean = false;

  protected constructor(id: string, description: string) {
    this.id = id;
    this.description = description;
  }
}
