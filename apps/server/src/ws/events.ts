import type { WebSocket } from "@fastify/websocket";
import type { Actor } from "../services/types.js";

export type ServerEvent =
  | { type: "task.created"; userId: string; task: unknown }
  | { type: "task.progress"; userId: string; taskId: string; patch: Record<string, unknown> }
  | { type: "task.done"; userId: string; taskId: string }
  | { type: "task.failed"; userId: string; taskId: string; error: string }
  | { type: "shelf.updated"; userId: string; shelfId: string }
  | { type: "workspace.updated"; userId: string }
  | { type: "permission.updated"; userId?: string }
  | { type: "roots.updated" }
  | { type: "share.updated"; userId: string };

type ClientContext = Pick<Actor, "id" | "role">;

export type EventPublisher = {
  publish(event: ServerEvent): void;
};

export class EventHub implements EventPublisher {
  private readonly clients = new Map<WebSocket, ClientContext>();

  add(client: WebSocket, actor: ClientContext): void {
    this.clients.set(client, actor);
    client.on("close", () => this.clients.delete(client));
  }

  publish(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const [client, actor] of this.clients) {
      if (!canReceive(actor, event)) continue;
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }
}

function canReceive(actor: ClientContext, event: ServerEvent): boolean {
  // Which locations there are is no secret among those signed in; each still sees only the ones it may list.
  if (event.type === "roots.updated") return true;
  if (actor.role === "ADMIN") return true;
  if ("userId" in event) return event.userId === actor.id;
  return false;
}
