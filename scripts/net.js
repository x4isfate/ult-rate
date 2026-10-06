/**
 * ULT's Session Rating — talking to the GM.
 *
 * A player cannot write a world setting or a GM-only journal, so a vote travels
 * over the module socket to the GM, who validates and stores it and answers
 * with an acknowledgement. Both directions are addressed (`recipients`), never
 * broadcast: a broadcast would show every player everybody else's scores.
 *
 * Messages (all carry `type`):
 *   submit   player -> GM(s)      { requestId, roundId, userId, token, scores, good, bad }
 *   ack      GM -> that player    { requestId, ok, reason, token }
 *   remind   GM -> some players   { roundId, userIds }
 *
 * The socket does not authenticate `userId`; on a table of friends that is an
 * accepted limit, and the GM still checks that the id is a listed participant.
 */

import { MODULE_ID, SOCKET, bus, getActiveRound, isResponsibleGM } from "./settings.js";
import { handleSubmit } from "./store.js";

const ACK_TIMEOUT_MS = 7000;

function activeGMIds() {
  return (game.users?.filter?.((u) => u.isGM && u.active) ?? []).map((u) => u.id);
}

function send(message, recipients) {
  game.socket.emit(SOCKET, message, { recipients });
}

/**
 * Send this player's vote. Resolves to `{ ok, reason?, token? }`; `reason` is
 * one of closed, forbidden, invalid, locked, no-token (from the GM) or
 * offline, timeout (found here).
 */
export function submitVote(payload) {
  const message = { type: "submit", ...payload, userId: game.user.id };

  // A GM voting (test mode) needs no round trip.
  if (game.user.isGM) return handleSubmit(message);

  const gms = activeGMIds();
  if (gms.length === 0) return Promise.resolve({ ok: false, reason: "offline" });

  return new Promise((resolve) => {
    const requestId = foundry.utils.randomID(12);
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      bus.removeEventListener("ack", onAck);
      window.clearTimeout(timer);
      resolve(result);
    };
    const onAck = (event) => {
      if (event.detail?.requestId === requestId) finish(event.detail);
    };
    const timer = window.setTimeout(() => finish({ ok: false, reason: "timeout" }), ACK_TIMEOUT_MS);

    bus.addEventListener("ack", onAck);
    send({ ...message, requestId }, gms);
  });
}

/** Ask the players who have not voted yet to open their window again. */
export function remindPlayers(userIds) {
  const round = getActiveRound();
  if (!round || userIds.length === 0) return;
  send({ type: "remind", roundId: round.id, userIds }, userIds);
}

/** Wire the incoming side. Call once, on `ready`. */
export function registerSocket() {
  game.socket.on(SOCKET, async (message) => {
    try {
      if (!message || typeof message !== "object") return;

      if (message.type === "submit") {
        if (!isResponsibleGM()) return;
        const result = await handleSubmit(message);
        send(
          { type: "ack", requestId: message.requestId, ok: result.ok, reason: result.reason ?? null, token: result.token ?? null },
          [String(message.userId)]
        );
        return;
      }

      if (message.type === "ack") {
        bus.dispatchEvent(new CustomEvent("ack", { detail: message }));
        return;
      }

      if (message.type === "remind") {
        if (Array.isArray(message.userIds) && message.userIds.includes(game.user.id)) {
          bus.dispatchEvent(new CustomEvent("remind", { detail: message }));
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | socket message failed`, err);
    }
  });
}
