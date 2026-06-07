import type { WebSocket } from "@fastify/websocket";

export type ServerEvent =
  | { type: "task.created"; task: unknown }
  | { type: "task.progress"; taskId: string; patch: Record<string, unknown> }
  | { type: "task.done"; taskId: string }
  | { type: "task.failed"; taskId: string; error: string }
  | { type: "shelf.updated"; shelfId: string }
  | { type: "permission.updated" }
  | { type: "share.updated" };

export class EventHub {
  private readonly clients = new Set<WebSocket>();

  add(client: WebSocket): void {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
  }

  publish(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }
}
