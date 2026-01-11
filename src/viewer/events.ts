// src/viewer/events.ts
// simple event bus (modelLoaded, selectionChanged, etc.)

export type ViewerEvents = {
  modelLoaded: { modelId: string; model: any };
  modelUnloaded: {};
};

type EventName = keyof ViewerEvents;
type Listener<K extends EventName> = (payload: ViewerEvents[K]) => void;

class SimpleEventBus {
  private listeners = new Map<string, Set<Function>>();

  on<K extends EventName>(event: K, cb: Listener<K>) {
    const key = String(event);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb);
    return () => this.off(event, cb);
  }

  off<K extends EventName>(event: K, cb: Listener<K>) {
    this.listeners.get(String(event))?.delete(cb);
  }

  emit<K extends EventName>(event: K, payload: ViewerEvents[K]) {
    for (const cb of this.listeners.get(String(event)) ?? []) {
      try { (cb as Listener<K>)(payload); }
      catch (e) { console.error(`[events] ${String(event)} listener error`, e); }
    }
  }
}

export const viewerEvents = new SimpleEventBus();
