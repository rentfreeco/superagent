import type { Store } from "../store/open-store.ts";

/** Marks every input the task's worker hasn't read as delivered and read, so no session gets it. */
export const dropUnreadInputs = (
  store: Pick<Store, "inputs">,
  taskId: string,
): void => {
  const droppedInputIds = store.inputs.unread(taskId).map(({ id }) => id);
  store.inputs.markDelivered(droppedInputIds);
  store.inputs.markRead(droppedInputIds);
};
