import assert from "node:assert/strict";
import { test } from "node:test";
import { requestWakeWordPause } from "./wakeWordPause.js";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send(message: string) { this.sent.push(message); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
const id = "11111111-1111-4111-8111-111111111111";

test("wake-word pause accepts only an exact acknowledgement for its own request", async () => {
  const socket = new FakeSocket();
  const result = requestWakeWordPause(socket as unknown as WebSocket, id);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "pause_wake_word", requestId: id });
  socket.message({ type: "wake_word_paused", requestId: "other", ok: true });
  socket.message({ type: "wake_word_paused", requestId: id, ok: "true" });
  socket.message({ type: "wake_word_paused", requestId: id, ok: true });
  assert.equal(await result, "paused");
});

test("a busy voice session refuses pause; disconnects and timeouts stay unconfirmed", async () => {
  const busy = new FakeSocket();
  const pending = requestWakeWordPause(busy as unknown as WebSocket, id);
  busy.message({ type: "wake_word_paused", requestId: id, ok: false });
  assert.equal(await pending, "busy");
  const closed = new FakeSocket();
  const disconnected = requestWakeWordPause(closed as unknown as WebSocket, id);
  closed.dispatchEvent(new Event("close"));
  assert.equal(await disconnected, "unconfirmed");
  const timed = new FakeSocket();
  assert.equal(await requestWakeWordPause(timed as unknown as WebSocket, id, 5), "unconfirmed");
});
