import type { WebSocket } from "@fastify/websocket";
import type { Actor } from "../services/types.js";

export type ServerEvent =
  | { type: "task.created"; userId: string; task: unknown }
  | { type: "task.progress"; userId: string; taskId: string; patch: Record<string, unknown> }
  | { type: "task.done"; userId: string; taskId: string }
  | { type: "task.failed"; userId: string; taskId: string; error: string }
  | { type: "shelf.updated"; userId: string; shelfId: string }
  | { type: "workspace.updated"; userId: string }
  | { type: "settings.updated"; userId: string }
  | { type: "account.updated"; userId: string }
  | { type: "permission.updated"; userId?: string }
  | { type: "roots.updated" }
  | { type: "apps.updated"; userId?: string }
  | { type: "share.updated"; userId: string };

type ClientContext = Pick<Actor, "id" | "role">;
type SessionValidator = () => ClientContext | null;
type ClientSubscription = { userId: string; validateSession: SessionValidator };

export type EventPublisher = {
  publish(event: ServerEvent): void;
};

export class EventHub implements EventPublisher {
  private readonly clients = new Map<WebSocket, ClientSubscription>();

  add(client: WebSocket, validateSession: SessionValidator): void {
    const actor = this.readCurrentActor(validateSession);
    if (!actor) {
      this.closeRevokedClient(client);
      return;
    }
    this.clients.set(client, { userId: actor.id, validateSession });
    client.on("close", () => this.clients.delete(client));
  }

  publish(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const [client, subscription] of this.clients) {
      const actor = this.readCurrentActor(subscription.validateSession);
      if (!actor || actor.id !== subscription.userId) {
        this.clients.delete(client);
        this.closeRevokedClient(client);
        continue;
      }
      if (!canReceive(actor, event)) continue;
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  close(): void {
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
  }

  private readCurrentActor(validateSession: SessionValidator): ClientContext | null {
    try {
      return validateSession();
    } catch {
      // Treat a failed session lookup as revoked so a store error cannot preserve old privileges.
      return null;
    }
  }

  private closeRevokedClient(client: WebSocket): void {
    if (client.readyState !== client.OPEN) return;
    try {
      client.close(1008, "Authentication expired");
    } catch {
      // The connection may close between checking its state and sending the close frame.
    }
  }
}

function canReceive(actor: ClientContext, event: ServerEvent): boolean {
  // Which locations there are is no secret among those signed in; each still sees only the ones it may list.
  if (event.type === "roots.updated") return true;
  // A shortcut with no owner is on everyone's desktop.
  if (event.type === "apps.updated" && !event.userId) return true;
  if (actor.role === "ADMIN") return true;
  if ("userId" in event) return event.userId === actor.id;
  return false;
}
