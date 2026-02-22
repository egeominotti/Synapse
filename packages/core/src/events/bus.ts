import { EventEmitter } from "node:events";
import type { NeoEventMap } from "./types.js";

export class NeoEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof NeoEventMap>(event: K, listener: (payload: NeoEventMap[K]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof NeoEventMap>(event: K, listener: (payload: NeoEventMap[K]) => void): void {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof NeoEventMap>(event: K, payload: NeoEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  off<K extends keyof NeoEventMap>(event: K, listener: (payload: NeoEventMap[K]) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  removeAllListeners(event?: keyof NeoEventMap): void {
    this.emitter.removeAllListeners(event);
  }
}
