import { ActorContext } from "../types";

export function sameMemoryScope(left: Partial<ActorContext>, right?: Partial<ActorContext>): boolean {
  return (left.memoryScope || undefined) === (right?.memoryScope || undefined);
}

// Scope identity also includes the user and transport. A project name or path
// is never an identity, and absence of a scope always means legacy memory.
export function scopedActorIdentity(actor: Partial<ActorContext>): string | undefined {
  return actor.memoryScope
    ? `workspace:${JSON.stringify([actor.memoryScope, actor.channel ?? "system", actor.userId ?? ""])}`
    : undefined;
}
