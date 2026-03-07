/**
 * Thread-safe(ish) event queue for Wimp_Poll.
 *
 * Events are pushed from the native host (IPC callbacks) and consumed
 * by the ARM CPU thread via Wimp_Poll.
 */

import { type WimpPollEvent, WimpEvent } from "./types.js";

export class WimpEventQueue {
  private queue: WimpPollEvent[] = [];
  private waiter: ((ev: WimpPollEvent) => void) | null = null;

  /** Push an event from the host side */
  push(event: WimpPollEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(event);
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Pop the next event, filtered by mask.
   * If the queue is empty, returns a null event (code 0).
   */
  popSync(mask: number): WimpPollEvent {
    for (let i = 0; i < this.queue.length; i++) {
      const ev = this.queue[i]!;
      if (!((mask >> ev.code) & 1)) {
        this.queue.splice(i, 1);
        return ev;
      }
    }
    return { code: WimpEvent.Null, data: [] };
  }

  /** Async wait for the next non-masked event */
  waitAsync(mask: number): Promise<WimpPollEvent> {
    // Check queue first
    const ev = this.popSync(mask);
    if (ev.code !== WimpEvent.Null) return Promise.resolve(ev);

    return new Promise(resolve => {
      this.waiter = (e) => {
        if ((mask >> e.code) & 1) {
          // Masked — put back and keep waiting
          this.queue.push(e);
          this.waiter = (e2) => resolve(e2);
        } else {
          resolve(e);
        }
      };
    });
  }

  /** Push a null event to unblock any waiter */
  sendNull(): void {
    this.push({ code: WimpEvent.Null, data: [] });
  }

  get length(): number { return this.queue.length; }
}
