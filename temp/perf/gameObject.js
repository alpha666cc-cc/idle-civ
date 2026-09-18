"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameObject = void 0;
class GameObject {
    constructor(id, description) {
        this.seen = false;
        this.id = id;
        this.description = description;
    }
}
exports.GameObject = GameObject;
