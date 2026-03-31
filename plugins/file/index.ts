import { FileTool } from "../../src/tools/FileTool";
import { SystemPlugin } from "../../src/plugins/types";

const plugin: SystemPlugin = {
  register(context) {
    context.toolRegistry.register(new FileTool(context.config.outputDir));
  }
};

export default plugin;
