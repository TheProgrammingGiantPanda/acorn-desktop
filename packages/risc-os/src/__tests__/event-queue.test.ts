import { describe, it, expect, vi } from "vitest";
import { WimpEventQueue } from "../wimp/event-queue.js";
import { WimpEvent } from "../wimp/types.js";

describe("WimpEventQueue", () => {

  it("popSync returns null event when empty", () => {
    const q = new WimpEventQueue();
    const ev = q.popSync(0);
    expect(ev.code).toBe(WimpEvent.Null);
  });

  it("push then popSync returns the pushed event", () => {
    const q = new WimpEventQueue();
    q.push({ code: WimpEvent.Click, data: [1, 2] });
    const ev = q.popSync(0);
    expect(ev.code).toBe(WimpEvent.Click);
    expect(ev.data).toEqual([1, 2]);
  });

  it("popSync respects event mask (masked events are skipped)", () => {
    const q = new WimpEventQueue();
    q.push({ code: WimpEvent.Click, data: [] });   // bit 6 masked
    const mask = 1 << WimpEvent.Click;
    const ev = q.popSync(mask);
    expect(ev.code).toBe(WimpEvent.Null); // Click is masked
    // The event should still be in the queue
    const ev2 = q.popSync(0);
    expect(ev2.code).toBe(WimpEvent.Click);
  });

  it("FIFO order is preserved", () => {
    const q = new WimpEventQueue();
    q.push({ code: WimpEvent.Open,  data: [1] });
    q.push({ code: WimpEvent.Close, data: [2] });
    q.push({ code: WimpEvent.Click, data: [3] });
    expect(q.popSync(0).code).toBe(WimpEvent.Open);
    expect(q.popSync(0).code).toBe(WimpEvent.Close);
    expect(q.popSync(0).code).toBe(WimpEvent.Click);
  });

  it("waitAsync resolves immediately when event is already queued", async () => {
    const q = new WimpEventQueue();
    q.push({ code: WimpEvent.KeyPressed, data: [65] });
    const ev = await q.waitAsync(0);
    expect(ev.code).toBe(WimpEvent.KeyPressed);
  });

  it("waitAsync waits then resolves when event is pushed later", async () => {
    const q = new WimpEventQueue();
    const prom = q.waitAsync(0);
    q.push({ code: WimpEvent.Redraw, data: [42] });
    const ev = await prom;
    expect(ev.code).toBe(WimpEvent.Redraw);
    expect(ev.data[0]).toBe(42);
  });

  it("sendNull unblocks a waiting poll with a null event", async () => {
    const q = new WimpEventQueue();
    const prom = q.waitAsync(0);
    q.sendNull();
    const ev = await prom;
    expect(ev.code).toBe(WimpEvent.Null);
  });

  it("length reflects queued events", () => {
    const q = new WimpEventQueue();
    expect(q.length).toBe(0);
    q.push({ code: WimpEvent.Click, data: [] });
    expect(q.length).toBe(1);
    q.push({ code: WimpEvent.Click, data: [] });
    expect(q.length).toBe(2);
    q.popSync(0);
    expect(q.length).toBe(1);
  });

  it("multiple sequential pushes and pops work correctly", () => {
    const q = new WimpEventQueue();
    for (let i = 0; i < 10; i++) {
      q.push({ code: WimpEvent.Click, data: [i] });
    }
    for (let i = 0; i < 10; i++) {
      const ev = q.popSync(0);
      expect(ev.data[0]).toBe(i);
    }
    expect(q.popSync(0).code).toBe(WimpEvent.Null);
  });
});
