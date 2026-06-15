import { BaseEvent } from "@vite-vite/shared-lib";

export class CurrentRowChangedEvent extends BaseEvent {}

export function getCurrentRowChangedEventName() {
  return new CurrentRowChangedEvent() instanceof BaseEvent
    ? "CurrentRowChangedEvent"
    : "InvalidEvent";
}
