import type { ControllerPluginContext } from "@clusterio/controller";
import { MinimapDataEvent } from "./messages.js";

/** A stub until Plan B's store (spec §8, §20 B): the instances' batches are accepted and dropped. */
export default async function loadControllerPlugin(context: ControllerPluginContext) {
	context.controller.handle(MinimapDataEvent, async () => { });
}
